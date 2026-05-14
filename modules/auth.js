// 用户认证系统 — 复用统一 Redis 客户端 + Token 存 Redis（含 TTL）
const crypto = require("crypto");
const { getRedis, scanKeys } = require("./redis-client");

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
  const r = getRedis();
  const raw = await r.get(`token:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
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

async function setRole(username, role) {
  const r = getRedis();
  if (!(await r.exists(`user:${username}`))) return false;
  await r.hset(`user:${username}`, "role", role);
  return true;
}

async function deleteUser(username) {
  const r = getRedis();
  await r.del(`user:${username}`);
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
