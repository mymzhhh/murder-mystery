// 用户认证系统 — 复用统一 Redis 客户端 + Token 存 Redis（含 TTL）
const crypto = require("crypto");
const { getRedis, ensureRedis, scanKeys } = require("./redis-client");

const TOKEN_TTL = 24 * 3600; // token 24 小时过期

// ==================== 口令哈希 ====================
// 历史实现是 pbkdf2Sync(…, 10000, …)：迭代次数偏低（OWASP 对 PBKDF2-HMAC-SHA512 的
// 建议是 210000），而且是同步版本 —— 单进程架构下每次登录都会阻塞整个事件循环，
// 连带所有房间卡住。现在改成异步 + 更高迭代，并且把参数写进哈希串以便逐步升级。
const PBKDF2_DIGEST = "sha512";
const PBKDF2_KEYLEN = 64;
const PBKDF2_ITERATIONS = Math.max(10000, Number(process.env.PBKDF2_ITERATIONS || 210000) || 210000);
// 旧格式（salt:hash）对应的迭代次数，仅用于校验历史数据
const LEGACY_ITERATIONS = 10000;

function pbkdf2(password, salt, iterations, keylen) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, keylen, PBKDF2_DIGEST, (err, dk) => err ? reject(err) : resolve(dk));
  });
}

/**
 * 生成口令哈希。
 * 格式：pbkdf2$<迭代次数>$<盐>$<哈希> —— 把参数写进哈希串，
 * 以后调整迭代次数不会让老用户登不进来（校验时按存储里的次数算）。
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN)).toString("hex");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/**
 * 校验口令。
 * 兼容两种存储格式：新的 pbkdf2$… 与旧的 salt:hash（10000 次）。
 * 比较用 timingSafeEqual，避免逐字节短路比较泄漏信息。
 */
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  let iterations = 0, salt = "", expected = "";
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    iterations = Number(parts[1]) || 0;
    salt = parts[2];
    expected = parts[3];
  } else if (stored.includes(":")) {
    const parts = stored.split(":");
    if (parts.length !== 2) return false;
    iterations = LEGACY_ITERATIONS;
    salt = parts[0];
    expected = parts[1];
  } else {
    return false;
  }
  if (!iterations || !salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
  try {
    const actual = await pbkdf2(password, salt, iterations, expected.length / 2);
    const a = Buffer.from(actual.toString("hex"), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** 这个哈希是否需要用当前参数重算（旧格式或迭代次数偏低） */
function needsRehash(stored) {
  if (!stored || typeof stored !== "string") return false;
  if (!stored.startsWith("pbkdf2$")) return true;
  const it = Number(stored.split("$")[1]) || 0;
  return it < PBKDF2_ITERATIONS;
}

/** 写入新口令哈希（PG 优先，Redis 兜底）。表不存在/连不上时静默失败。 */
async function setUserPassword(username, passwordHash) {
  let ok = false;
  try {
    const { updateUserPassword } = require("./db");
    ok = await updateUserPassword(username, passwordHash);
  } catch (e) { /* PG 不可用 */ }
  try {
    const r = getRedis();
    if (await r.exists(`user:${username}`)) {
      await r.hset(`user:${username}`, "password", passwordHash);
      ok = true;
    }
  } catch (e) { /* Redis 不可用 */ }
  return ok;
}


// Token 管理 — 存入 Redis 并设置 TTL，多进程共享 + 自动过期
async function saveToken(token, data) {
  const r = getRedis();
  await r.setex(`token:${token}`, TOKEN_TTL, JSON.stringify(data));
}

async function register(username, password) {
  try {
    const { createUser } = require("./db");
    await createUser(username, await hashPassword(password), "player");
  } catch (e) {
    if (e.code === "23505") return { ok: false, message: "用户名已存在" };
    // PG 不可用时回退到 Redis
    const r = getRedis();
    if (await r.exists(`user:${username}`)) return { ok: false, message: "用户名已存在" };
    await r.hset(`user:${username}`, { username, password: await hashPassword(password), role: "player", createdAt: new Date().toISOString() });
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
  if (!(await verifyPassword(password, user.password))) return { ok: false, message: "密码错误" };
  // 登录成功且哈希参数已过时（旧格式/迭代次数偏低）→ 顺手升级到当前参数
  if (needsRehash(user.password)) {
    try {
      await setUserPassword(username, await hashPassword(password));
      console.log(`[auth] 已升级 ${username} 的口令哈希到 ${PBKDF2_ITERATIONS} 次迭代`);
    } catch (e) { /* 升级失败不影响本次登录 */ }
  }
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
//
// 加固要点（原来是"没配就静默用 admin123"）：
//   1) 生产环境（NODE_ENV=production）未设置 ADMIN_PASSWORD 时**拒绝启动** ——
//      否则一个绑在 0.0.0.0 的部署，管理员口令就是 admin123，等于没有鉴权。
//   2) 显式配置了 ADMIN_PASSWORD 时，把它当作管理员口令的唯一来源：
//      已存在的 admin 账号会按配置轮换（原实现只在"账号不存在"时创建，
//      所以先被默认口令建出来的 admin 永远改不掉），并撤销其旧令牌。
async function initAdmin() {
  const configured = process.env.ADMIN_PASSWORD || "";
  const isProd = process.env.NODE_ENV === "production";
  if (!configured) {
    if (isProd) {
      console.error("[auth] ✖ 未设置 ADMIN_PASSWORD，生产环境拒绝以默认口令启动。");
      console.error("[auth]   请在 .env 里设置一个强口令，例如： ADMIN_PASSWORD=<32位随机串>");
      process.exit(1);
    }
    console.warn("[auth] ⚠ 未设置 ADMIN_PASSWORD，开发环境暂用默认口令 admin123 —— 切勿用于任何他人可访问的部署");
  }
  const adminPassword = configured || "admin123";

  let existing = null;
  try {
    const { createUser, getUser } = require("./db");
    existing = await getUser("admin");
    if (!existing) {
      await createUser("admin", await hashPassword(adminPassword), "admin");
      console.log(`[auth] 默认管理员已创建（口令来源：${configured ? "ADMIN_PASSWORD" : "内置默认值"}）`);
    }
  } catch (e) {
    // PG 不可用，Redis 回退
    const r = getRedis();
    const cur = await r.hgetall("user:admin");
    if (!cur || !cur.username) {
      await r.hset("user:admin", { username: "admin", password: await hashPassword(adminPassword), role: "admin", createdAt: new Date().toISOString() });
      console.log(`[auth] 默认管理员已创建（Redis 回退，口令来源：${configured ? "ADMIN_PASSWORD" : "内置默认值"}）`);
    } else {
      existing = { username: "admin", password: cur.password };
    }
  }

  // 已存在 + 显式配置了口令 → 按配置轮换
  // 注意字段名：PG 的列是 password_hash，Redis 回退路径写的是 password
  if (existing && configured) {
    const storedHash = existing.password_hash || existing.password || "";
    const same = storedHash ? await verifyPassword(configured, storedHash) : false;
    if (!same) {
      const ok = await setUserPassword("admin", await hashPassword(configured));
      if (ok) {
        await revokeUserTokens("admin");
        console.log("[auth] 管理员口令已按 ADMIN_PASSWORD 轮换，旧登录令牌已撤销");
      }
    }
  }
}

module.exports = { register, login, verifyToken, logout, listUsers, setRole, deleteUser, initAdmin,
  // 导出给单测用（口令哈希的格式兼容与参数升级需要能单独验证）
  hashPassword, verifyPassword, needsRehash, PBKDF2_ITERATIONS, LEGACY_ITERATIONS };
