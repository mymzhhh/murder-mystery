// PG 异步同步队列 — Redis 为主数据源、PostgreSQL 为持久备份
// 切分完成后不再同步等待 PG 写入，而是入队异步落库；
// 失败自动重试（指数退避），多次失败挂起到 Redis sync:failed，可由管理端手动补偿。
const { getRedis } = require("./redis-client");

const MAX_ATTEMPTS = 5;
const FAILED_KEY = "sync:failed";
const MAX_QUEUE = 2000; // 队列上限，防止异常时无限膨胀

// scriptId → { attempts, enqueuedAt }
const queue = new Map();
let workerTimer = null;
let flushing = false;

/** 将剧本 id 加入 PG 同步队列（幂等：已在队列中则计数重试） */
function enqueueSync(scriptId) {
  if (!scriptId) return;
  if (queue.has(scriptId)) {
    queue.get(scriptId).attempts++;
    return;
  }
  if (queue.size >= MAX_QUEUE) {
    console.warn("[pg-sync] 队列已满，跳过:", scriptId);
    return;
  }
  queue.set(scriptId, { attempts: 0, enqueuedAt: Date.now() });
  ensureWorker(1000);
}

/** 队列中的待同步 id */
function pendingIds() {
  return [...queue.keys()];
}

/** 从 Redis 重建脚本数据并写入 PG（队列/手动重试共用） */
async function syncOne(scriptId) {
  const { getSplitData } = require("./script-splitter");
  const data = await getSplitData(scriptId);
  if (!data) throw new Error("split 数据不存在: " + scriptId);
  const { saveSplitScript } = require("./db");
  await saveSplitScript(scriptId, {
    title: data.meta.title || "",
    era: data.meta.era || "",
    location: data.meta.location || "",
    playerCount: parseInt(data.meta.playerCount) || 0,
    npcCount: parseInt(data.meta.npcCount) || 0,
    clueCount: parseInt(data.meta.clueCount) || 0,
    layoutDescription: data.meta.layoutDescription || "",
    gameMode: data.meta.gameMode || "",
    originalMarkdown: data.meta.originalMarkdown || "",
  }, data.characters, data.clues, data.dm);
}

/** 执行一轮队列冲刷 */
async function runWorker() {
  workerTimer = null;
  if (flushing) return;
  flushing = true;
  try {
    const ids = [...queue.keys()];
    let nextBackoff = 0;
    for (const id of ids) {
      const item = queue.get(id);
      if (!item) continue;
      try {
        await syncOne(id);
        queue.delete(id);
        await getRedis().srem(FAILED_KEY, id);
        console.log("[pg-sync] PG 同步成功:", id);
      } catch (e) {
        item.attempts++;
        if (item.attempts >= MAX_ATTEMPTS) {
          queue.delete(id);
          try { await getRedis().sadd(FAILED_KEY, id); } catch (_) {}
          console.warn(`[pg-sync] PG 同步失败 ${item.attempts} 次，已挂起（可在管理端手动重试）:`, id, "-", e.message);
        } else {
          console.warn(`[pg-sync] PG 同步第 ${item.attempts} 次失败，稍后重试:`, id, "-", e.message);
          // 指数退避：2^attempts 秒
          nextBackoff = Math.max(nextBackoff, Math.min(1000 * Math.pow(2, item.attempts), 60000));
        }
      }
    }
    if (queue.size > 0) ensureWorker(nextBackoff || 2000);
  } finally {
    flushing = false;
  }
}

function ensureWorker(delayMs) {
  if (workerTimer) return;
  workerTimer = setTimeout(runWorker, delayMs || 1000);
  if (workerTimer.unref) workerTimer.unref();
}

/** 启动对账：找出 Redis 已切分但 PG 缺失的剧本，以及挂起的失败项，重新入队 */
async function reconcileOnStart() {
  try {
    const r = getRedis();
    const splitIds = await r.smembers("scripts:split");
    // 已挂起失败项，先全部重新入队重试
    const failed = await r.smembers(FAILED_KEY);
    let requeued = 0;
    for (const id of failed) {
      if (!queue.has(id)) { enqueueSync(id); requeued++; }
    }
    // PG 已有 id 集合
    let pgIds = new Set();
    try {
      const { listScripts } = require("./db");
      pgIds = new Set((await listScripts()).map(s => s.id));
    } catch (e) { console.warn("[pg-sync] 启动对账读取 PG 失败:", e.message); }
    let missing = 0;
    for (const id of splitIds) {
      if (!pgIds.has(id) && !queue.has(id)) { enqueueSync(id); missing++; }
    }
    if (missing > 0 || requeued > 0) {
      console.log(`[pg-sync] 启动对账: ${missing} 个缺失 + ${requeued} 个失败项已入队`);
    }
  } catch (e) {
    console.warn("[pg-sync] 启动对账失败:", e.message);
  }
}

module.exports = { enqueueSync, syncOne, pendingIds, reconcileOnStart, FAILED_KEY };