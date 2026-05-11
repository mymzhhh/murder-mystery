// 统一的 Redis 客户端单例 — 所有模块共用此实例
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let client = null;

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

/** 使用 SCAN 替代 KEYS，避免生产环境阻塞 */
async function scanKeys(pattern, count = 100) {
  const r = getRedis();
  const results = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", count);
    cursor = nextCursor;
    results.push(...keys);
  } while (cursor !== "0");
  return results;
}

module.exports = { getRedis, scanKeys };
