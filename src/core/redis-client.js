// Redis 连接池 — 读写分离 + 自动重连
// 多连接池分担高并发负载，避免单连接瓶颈
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const POOL_SIZE = parseInt(process.env.REDIS_POOL_SIZE) || 4;

let writeClient = null;     // 写专用连接
let readClients = [];       // 读连接池
let readIndex = 0;
let connectPromises = [];

function createClient() {
  const opts = {
    maxRetriesPerRequest: 3,
    retryStrategy: (t) => Math.min(t * 500, 5000),
    lazyConnect: true,
    // 开启离线队列：启动初期命令先排队，连接建立后自动冲刷。
    // （过度使用会导致内存积压，但 maxRetriesPerRequest 会在重试耗尽后拒绝排队的命令）
    enableOfflineQueue: true,
    connectTimeout: 5000,
    commandTimeout: 10000,
  };
  if (REDIS_URL.startsWith("rediss://")) {
    opts.tls = { rejectUnauthorized: false };
  }
  const client = new Redis(REDIS_URL, opts);
  client.on("error", (err) => console.error("[redis] error:", err.message));
  return client;
}

/** 获取写连接 */
function getRedis() {
  if (!writeClient) {
    writeClient = createClient();
    // 保持一个永久写连接
    writeClient.on("connect", () => console.log("[redis] 写连接就绪"));
    writeClient.on("close", () => {
      console.warn("[redis] 写连接断开，重建中...");
      writeClient = null;
    });
    // 懒连接模式下主动连接，确保启动初期命令不长时间排队
    if (writeClient.status === "wait") {
      writeClient.connect().catch(err => console.error("[redis] 写连接初始连接失败:", err.message));
    }
  }
  return writeClient;
}

/** 获取读连接（轮询） */
function getReadRedis() {
  if (readClients.length === 0) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const c = createClient();
      c.on("connect", () => console.log(`[redis] 读连接 #${i} 就绪`));
      c.on("close", () => {
        // 标记失效，下次自动重建
        const idx = readClients.indexOf(c);
        if (idx >= 0) readClients.splice(idx, 1);
      });
      readClients.push(c);
    }
  }
  // Round-robin
  const client = readClients[readIndex % readClients.length];
  readIndex++;
  if (readIndex > 100000) readIndex = 0;
  return client || getRedis(); // 回退到写连接
}

/**
 * 取**已经存在**的写连接，绝不发起新连接。没有就返回 null。
 *
 * 为什么需要它：`getRedis()` 会主动建连、并带无限重试策略。在没有 Redis 的环境里
 * （单元测试就是）调用它，会留下一个永远重试的连接把进程吊住不退 ——
 * 实测踩过：AI 观测模块无条件调用 getRedis()，整个测试套件挂在那里不结束。
 * 所以"有就记、没有就算了"的旁路写入（可观测性、非关键统计）必须用这个。
 */
function peekRedis() {
  if (writeClient && writeClient.status !== "end") return writeClient;
  return null;
}

/** 确保所有连接就绪 */
async function ensureRedis() {
  const allClients = [getRedis(), ...readClients].filter(Boolean);
  const pending = allClients
    .filter(c => c.status !== "ready" && c.status !== "connecting" && c.status !== "connect")
    .map(c => c.connect().then(() => c).catch(err => { console.error("[redis] 连接失败:", err.message); return null; }));
  await Promise.all(pending);
  // 等待已连接中的就绪
  const connecting = allClients.filter(c => c.status === "connecting" || c.status === "connect");
  if (connecting.length > 0) {
    await Promise.all(connecting.map(c => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { c.disconnect(); resolve(null); }, 5000);
      c.once("ready", () => { clearTimeout(timer); resolve(c); });
      c.once("error", () => { clearTimeout(timer); resolve(null); });
    })));
  }
  return getRedis();
}

/** SCAN 替代 KEYS */
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

module.exports = { getRedis, getReadRedis, ensureRedis, scanKeys, peekRedis };
