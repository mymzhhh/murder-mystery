// 统一的 Redis 客户端单例 — 所有模块共用此实例
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let client = null;
let connectPromise = null;

function getRedis() {
  if (!client) {
    const opts = {
      maxRetriesPerRequest: null,
      retryStrategy: (t) => Math.min(t * 1000, 10000),
      lazyConnect: true,
      enableOfflineQueue: true,
    };
    if (REDIS_URL.startsWith("rediss://")) {
      opts.tls = { rejectUnauthorized: false };
    }
    client = new Redis(REDIS_URL, opts);
    client.on("error", (err) => console.error("Redis:", err.message));
    client.on("connect", () => console.log("Redis 已连接"));
  }
  return client;
}

/** 确保 Redis 已连接（幂等，多次调用只连一次） */
async function ensureRedis() {
  const r = getRedis();
  if (r.status === "ready") return r;
  if (r.status === "connecting" || r.status === "connect") {
    // 正在连接中，等待就绪
    if (!connectPromise) {
      connectPromise = new Promise((resolve, reject) => {
        r.once("ready", () => { connectPromise = null; resolve(r); });
        r.once("error", (err) => { connectPromise = null; reject(err); });
      });
    }
    return connectPromise;
  }
  // 其他状态（wait/close/end），尝试连接
  connectPromise = r.connect().then(() => r);
  return connectPromise;
}

/** 使用 SCAN 替代 KEYS，避免生产环境阻塞 */
async function scanKeys(pattern, count = 100) {
  const r = await ensureRedis();
  const results = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", count);
    cursor = nextCursor;
    results.push(...keys);
  } while (cursor !== "0");
  return results;
}

module.exports = { getRedis, ensureRedis, scanKeys };
