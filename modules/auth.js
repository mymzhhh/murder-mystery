// 用户认证系统 — Redis 存储

const crypto = require("crypto");
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, retryStrategy(t) { return t > 10 ? null : Math.min(t * 500, 5000); }, enableOfflineQueue: false });
    redis.on("error", function() {});
  }
  return redis;
}
async function ensureConn() {
  const r = getRedis();
  if (r.status !== "ready" && r.status !== "connecting") await r.connect();
  return r;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === verify;
}

const TOKENS = new Map(); // token → { username, role, expiry }

async function register(username, password) {
  const r = await ensureConn();
  const key = `user:${username}`;
  if (await r.exists(key)) return { ok: false, message: "用户名已存在" };

  await r.hset(key, {
    username,
    password: hashPassword(password),
    role: "player",
    createdAt: new Date().toISOString(),
  });

  // 创建 token
  const token = crypto.randomBytes(32).toString("hex");
  TOKENS.set(token, { username, role: "player", expiry: Date.now() + 24 * 3600 * 1000 });
  return { ok: true, token, role: "player", username };
}

async function login(username, password) {
  const r = await ensureConn();
  const key = `user:${username}`;
  const user = await r.hgetall(key);
  if (!user || !user.username) return { ok: false, message: "用户名不存在" };

  if (!verifyPassword(password, user.password)) return { ok: false, message: "密码错误" };

  const token = crypto.randomBytes(32).toString("hex");
  TOKENS.set(token, { username, role: user.role, expiry: Date.now() + 24 * 3600 * 1000 });
  return { ok: true, token, role: user.role, username };
}

function verifyToken(token) {
  const data = TOKENS.get(token);
  if (!data || data.expiry < Date.now()) return null;
  return data;
}

function logout(token) {
  TOKENS.delete(token);
}

async function getUser(username) {
  const r = await ensureConn();
  return await r.hgetall(`user:${username}`);
}

async function listUsers() {
  const r = await ensureConn();
  const keys = await r.keys("user:*");
  if (!keys.length) return [];
  const pipe = r.pipeline();
  keys.forEach(k => pipe.hgetall(k));
  const results = await pipe.exec();
  return results.map(r => r[1]).filter(u => u && u.username).map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt }));
}

async function setRole(username, role) {
  const r = await ensureConn();
  if (!(await r.exists(`user:${username}`))) return false;
  await r.hset(`user:${username}`, "role", role);
  return true;
}

async function deleteUser(username) {
  const r = await ensureConn();
  await r.del(`user:${username}`);
}

// 初始化默认管理员账号
async function initAdmin() {
  const r = await ensureConn();
  if (!(await r.exists("user:admin"))) {
    await r.hset("user:admin", {
      username: "admin",
      password: hashPassword("admin123"),
      role: "admin",
      createdAt: new Date().toISOString(),
    });
    console.log("[auth] 默认管理员已创建: admin / admin123");
  }
}

module.exports = { register, login, verifyToken, logout, getUser, listUsers, setRole, deleteUser, initAdmin };
