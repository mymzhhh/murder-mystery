// 用户认证系统 — 复用统一 Redis 客户端 + Token 存 Redis（含 TTL）
const crypto = require("crypto");
const { getRedis, ensureRedis, scanKeys } = require("./redis-client");

const TOKEN_TTL = 24 * 3600; // token 24 小时过期

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === verify;
}

// Token 管理 — 存入 Redis 并设置 TTL，多进程共享 + 自动过期
async function saveToken(token, data) {
  const r = getRedis();
  await r.setex(`token:${token}`, TOKEN_TTL, JSON.stringify(data));
}

async function register(username, password) {
  try {
    const { createUser } = require("./db");
    await createUser(username, hashPassword(password), "player");
  } catch (e) {
    if (e.code === "23505") return { ok: false, message: "用户名已存在" };
    // PG 不可用时回退到 Redis
    const r = getRedis();
    if (await r.exists(`user:${username}`)) return { ok: false, message: "用户名已存在" };
    await r.hset(`user:${username}`, { username, password: hashPassword(password), role: "player", createdAt: new Date().toISOString() });
  }
  const token = crypto.randomBytes(32).toString("hex");
  await saveToken(token, { username, role: "player" });
  return { ok: true, token, role: "player", username };
}

async function login(username, password) {
  let user = null;
  try {
    const { getUser } = require("./db");
    const pgUser = await getUser(username);
    if (pgUser) user = { username: pgUser.username, password: pgUser.password_hash, role: pgUser.role };
  } catch (e) { /* PG 不可用，回退 */ }
  if (!user) {
    const r = getRedis();
    user = await r.hgetall(`user:${username}`);
  }
  if (!user || !user.username) return { ok: false, message: "用户名不存在" };
  if (!verifyPassword(password, user.password)) return { ok: false, message: "密码错误" };
  const token = crypto.randomBytes(32).toString("hex");
  await saveToken(token, { username, role: user.role });
  return { ok: true, token, role: user.role, username };
}

async function verifyToken(token) {
  // 确保 Redis 连接就绪（避免服务刚启动时瞬时 401）
  const r = await ensureRedis();
  const raw = await r.get(`token:${token}`);
  if (!raw) return null;
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { return null; }
  if (!payload || !payload.username) return null;

  // 回源校验：token 内的 role 只是快照，必须与当前用户实际角色一致
  // （否则管理员被降权或删号后，旧 token 仍可在有效期内拥有 admin 权限）
  try {
    let current = null;
    try {
      const { getUser } = require("./db");
      const pgUser = await getUser(payload.username);
      if (pgUser) current = { username: pgUser.username, role: pgUser.role };
    } catch (e) { /* PG 不可用，回退 Redis */ }
    if (!current) {
      const u = await r.hgetall(`user:${payload.username}`);
      if (u && u.username) current = { username: u.username, role: u.role };
    }
    if (!current) {
      // 用户已被删除 → 令牌立即失效
      await r.del(`token:${token}`).catch(() => {});
      return null;
    }
    if (current.role !== payload.role) {
      // 角色已变更 → 以当前角色为准并回写快照
      payload.role = current.role;
      const ttl = await r.ttl(`token:${token}`).catch(() => -1);
      if (ttl > 0) await r.setex(`token:${token}`, ttl, JSON.stringify(payload)).catch(() => {});
    }
  } catch (e) { /* 回源失败时保守放行（保持原行为），不阻断正常请求 */ }

  return payload;
}

async function logout(token) {
  const r = getRedis();
  await r.del(`token:${token}`);
}

async function listUsers() {
  const seen = new Set();
  const users = [];

  // 优先从 PostgreSQL 读取
  try {
    const { listUsers: pgListUsers } = require("./db");
    const pgUsers = await pgListUsers();
    pgUsers.forEach(u => { users.push(u); seen.add(u.username); });
  } catch (e) { console.warn("[auth] PG listUsers failed:", e.message); }

  // Redis 补充（PG 不可用时的回退数据，去重）
  try {
    const keys = await scanKeys("user:*");
    if (keys.length) {
      const r = getRedis();
      const pipe = r.pipeline();
      keys.forEach(k => pipe.hgetall(k));
      const results = await pipe.exec();
      results.forEach(r => {
        const u = r[1];
        if (u && u.username && !seen.has(u.username)) {
          users.push({ username: u.username, role: u.role, createdAt: u.createdAt });
        }
      });
    }
  } catch (e) { console.warn("[auth] Redis listUsers failed:", e.message); }

  return users;
}

/** 撤销某用户的全部登录令牌（降权/删号时调用，使旧 token 立即失效） */
async function revokeUserTokens(username) {
  try {
    const r = getRedis();
    const keys = await scanKeys("token:*");
    if (!keys.length) return 0;
    const pipe = r.pipeline();
    keys.forEach(k => pipe.get(k));
    const results = await pipe.exec();
    const toDel = [];
    results.forEach(([err, raw], i) => {
      if (err || !raw) return;
      try {
        const p = JSON.parse(raw);
        if (p && p.username === username) toDel.push(keys[i]);
      } catch (e) { /* 跳过坏数据 */ }
    });
    if (toDel.length) await r.del(...toDel);
    return toDel.length;
  } catch (e) { console.warn("[auth] revokeUserTokens failed:", e.message); return 0; }
}

async function setRole(username, role) {
  let ok = false;
  // PG 优先
  try {
    const { updateUserRole } = require("./db");
    ok = await updateUserRole(username, role);
  } catch (e) { console.warn("[auth] PG setRole failed:", e.message); }
  // Redis 同步
  const r = getRedis();
  if (await r.exists(`user:${username}`)) {
    await r.hset(`user:${username}`, "role", role);
    ok = true;
  }
  // 角色变更后撤销旧令牌（防止降权用户继续持有 admin 权限）
  if (ok) await revokeUserTokens(username);
  return ok;
}

async function deleteUser(username) {
  let ok = false;
  // PG 优先
  try {
    const { deleteUser: pgDeleteUser } = require("./db");
    ok = await pgDeleteUser(username);
  } catch (e) { console.warn("[auth] PG deleteUser failed:", e.message); }
  // Redis 同步清理
  const r = getRedis();
  await r.del(`user:${username}`);
  if (!ok) ok = true; // Redis 删除也算成功
  // 删号后撤销其全部令牌
  await revokeUserTokens(username);
  return ok;
}

// 初始化默认管理员账号
async function initAdmin() {
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  try {
    const { createUser, getUser } = require("./db");
    const existing = await getUser("admin");
    if (!existing) await createUser("admin", hashPassword(adminPassword), "admin");
  } catch (e) {
    // PG 不可用，Redis 回退
    const r = getRedis();
    if (!(await r.exists("user:admin"))) {
      await r.hset("user:admin", { username: "admin", password: hashPassword(adminPassword), role: "admin", createdAt: new Date().toISOString() });
    }
    console.log("[auth] 默认管理员已就绪");
  }
}

module.exports = { register, login, verifyToken, logout, listUsers, setRole, deleteUser, initAdmin };
