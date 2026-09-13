// 房间生命周期 — 最大存活时间 + 孤儿房间回收
//
// 为什么需要它：房间在 Redis 里是永久的，唯一的自动清理是"玩家断线 5 分钟后若无真人则删房"，
// 而那个定时器存放在内存里 —— 服务器一重启就全部丢失，房间从此永久孤儿化。
// 实测线上出现过：创建于 9 天前的房间仍可被重连进入；games:index 里堆了 59 条索引、
// 其中 54 条指向早已不存在的房间。
//
// 这里的清理全部基于 Redis 里的持久数据（房间的 createdAt），因此跨重启依然有效。

const { getRedis, scanKeys } = require("./redis-client");

/** 房间最大存活时间（小时）。超过后不再可加入，并由扫描器删除。 */
const MAX_LIFETIME_HOURS = Math.max(0.5, Number(process.env.ROOM_MAX_LIFETIME_HOURS || 6) || 6);
/** 一个玩家都没有的房间，超过这个时间就回收（覆盖"建了房间没玩"和"人全走光"两种情况） */
const ABANDONED_MINUTES = Math.max(5, Number(process.env.ROOM_ABANDONED_MINUTES || 30) || 30);
/** 扫描间隔 */
const SWEEP_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.ROOM_SWEEP_INTERVAL_MIN || 10) * 60 * 1000);

const MAX_LIFETIME_MS = Math.round(MAX_LIFETIME_HOURS * 3600 * 1000);
const ABANDONED_MS = Math.round(ABANDONED_MINUTES * 60 * 1000);

/** 房间是否已超过最大存活时间。createdAt 缺失时按"不过期"处理，避免误杀老数据。 */
function isRoomExpired(room, now = Date.now()) {
  if (!room) return true;
  const created = Number(room.createdAt);
  if (!created) return false;
  return now - created > MAX_LIFETIME_MS;
}

/** 给玩家看的过期说明（用于拒绝加入时的提示） */
function expiryText() {
  return MAX_LIFETIME_HOURS >= 1
    ? `${MAX_LIFETIME_HOURS} 小时`
    : `${Math.round(MAX_LIFETIME_HOURS * 60)} 分钟`;
}

/** 删除房间的全部键 + 索引 + 开放集合标记 */
async function purgeRoom(r, code) {
  const keys = await scanKeys(`game:${code}*`);
  if (keys.length) await r.del(...keys);
  await r.zrem("games:index", code);
  await r.srem("rooms:open", code);
  return keys.length;
}

/**
 * 扫描一轮并回收。
 * @returns {Promise<{expired:number, abandoned:number, staleIndex:number, freedKeys:number, checked:number}>}
 */
async function sweepOnce(now = Date.now()) {
  const r = await getRedis();
  const out = { expired: 0, abandoned: 0, staleIndex: 0, freedKeys: 0, checked: 0 };
  if (!r) return out;

  // 以索引为准枚举房间；索引是唯一能列出"曾经存在过"的集合
  let codes = [];
  try { codes = await r.zrange("games:index", 0, -1); } catch (e) { return out; }
  if (!codes.length) return out;

  for (const code of codes) {
    out.checked++;
    let room = null;
    try { room = await r.hgetall(`game:${code}`); } catch (e) { continue; }

    // 1) 房间已经不存在 —— 只剩索引死引用
    if (!room || !room.roomCode) {
      await r.zrem("games:index", code);
      await r.srem("rooms:open", code);
      out.staleIndex++;
      continue;
    }

    // 2) 超过最大存活时间
    if (isRoomExpired(room, now)) {
      out.freedKeys += await purgeRoom(r, code);
      out.expired++;
      continue;
    }

    // 3) 长期没有任何玩家（覆盖"建了没玩"和"人全走光"）
    const created = Number(room.createdAt) || 0;
    if (created && now - created > ABANDONED_MS) {
      const playerKeys = await scanKeys(`game:${code}:player:*`);
      if (!playerKeys.length) {
        out.freedKeys += await purgeRoom(r, code);
        out.abandoned++;
      }
    }
  }
  return out;
}

/**
 * 启动时的自愈：把所有玩家标记为未连接。
 *
 * 必要性：服务器重启后没有任何 socket 是连着的，但玩家记录里的 connected 仍是 true
 * （它是上一次运行留下的）。这些"幽灵连接"会让"没有真人就删房"的判断永远不成立，
 * 房间就此永久孤儿化。启动瞬间必然没有活跃连接，所以这一步是安全的；
 * 客户端重连时会重新写回 connected=true。
 */
async function markAllPlayersDisconnected() {
  const r = await getRedis();
  if (!r) return 0;
  let keys = [];
  try { keys = await scanKeys("game:*:player:*"); } catch (e) { return 0; }
  if (!keys.length) return 0;
  let n = 0;
  const { updatePlayer } = require("./game-manager");
  for (const k of keys) {
    // game:{code}:player:{playerId}
    const parts = k.split(":");
    if (parts.length < 4) continue;
    const code = parts[1];
    const pid = parts.slice(3).join(":");
    try {
      await updatePlayer(code, pid, { connected: false });
      n++;
    } catch (e) { /* 单条失败不影响整体 */ }
  }
  return n;
}

let timer = null;

/** 启动清理：先做自愈，再扫一遍，之后按间隔重复 */
async function startRoomSweeper() {
  try {
    const healed = await markAllPlayersDisconnected();
    if (healed) console.log(`[rooms] 启动自愈：${healed} 个玩家标记为未连接（上次运行的幽灵连接）`);
  } catch (e) { console.warn("[rooms] 启动自愈失败:", e.message); }

  const run = async () => {
    try {
      const s = await sweepOnce();
      if (s.expired || s.abandoned || s.staleIndex) {
        console.log(`[rooms] 回收：过期 ${s.expired} 个、无人 ${s.abandoned} 个、清理死索引 ${s.staleIndex} 条、释放 ${s.freedKeys} 个键`);
      }
    } catch (e) { console.warn("[rooms] 扫描失败:", e.message); }
  };
  await run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[rooms] 生命周期：最长 ${expiryText()}，无人 ${ABANDONED_MINUTES} 分钟回收，每 ${Math.round(SWEEP_INTERVAL_MS / 60000)} 分钟扫描一次`);
}

function stopRoomSweeper() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  isRoomExpired, expiryText, sweepOnce, startRoomSweeper, stopRoomSweeper,
  markAllPlayersDisconnected, purgeRoom,
  MAX_LIFETIME_MS, MAX_LIFETIME_HOURS, ABANDONED_MS, SWEEP_INTERVAL_MS,
};
