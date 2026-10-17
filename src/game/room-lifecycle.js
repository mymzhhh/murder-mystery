// 房间生命周期 — 最大存活时间 + 孤儿房间回收
//
// 为什么需要它：房间在 Redis 里是永久的，唯一的自动清理是"玩家断线 5 分钟后若无真人则删房"，
// 而那个定时器存放在内存里 —— 服务器一重启就全部丢失，房间从此永久孤儿化。
// 实测线上出现过：创建于 9 天前的房间仍可被重连进入；games:index 里堆了 59 条索引、
// 其中 54 条指向早已不存在的房间。
//
// 这里的清理全部基于 Redis 里的持久数据（房间的 createdAt），因此跨重启依然有效。

const { getRedis, scanKeys } = require("../core/redis-client");

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
  // 释放各模块的房级内存态（AI 定时器、阶段计时器、倒计时、语音成员……）。
  // 扫描器这条路径原来是直接删 Redis 键的，绕过了 deleteRoom 的钩子，
  // 于是被扫描器回收的房间会在内存里留下 timers[roomCode] 这类永不释放的条目。
  try { require("./room-cleanup-hooks").runRoomDeleted(code); } catch (e) { /* ignore */ }
  return keys.length;
}

/**
 * 枚举所有"可能有残留"的房间号。
 *
 * 不能只看 games:index —— 曾出现"房间主键已删、却残留 game:{code}:chat / :intro 子键"
 * 的情况（删除与 AI 写入之间的竞态：AI 已通过存在性检查，房间随后被删，它的写入又把子键建了回来）。
 * 这类房间不在索引里，只按索引枚举就永远回收不掉。所以这里把两边取并集。
 */
async function enumerateRoomCodes() {
  const r = await getRedis();
  const codes = new Set();
  try { (await r.zrange("games:index", 0, -1)).forEach(c => codes.add(c)); } catch (e) { /* ignore */ }
  let keys = [];
  try { keys = await scanKeys("game:*"); } catch (e) { /* ignore */ }
  for (const k of keys) {
    const m = k.match(/^game:([A-Z0-9]{6})(?::|$)/);
    if (m) codes.add(m[1]);
  }
  return [...codes];
}

/**
 * 房间里还有没有"连着的真人"？
 *
 * 只看非 NPC 记录：AI 补位玩家的 connected 字段不参与判断，
 * 否则一个只剩 AI 的空房间会被永远认为"有人"，永远回收不掉。
 * @returns {Promise<boolean>} true = 至少有一个真人处于连接状态
 */
async function hasConnectedHuman(r, code) {
  const keys = await scanKeys(`game:${code}:player:*`);
  if (!keys.length) return false;
  let raw = [];
  try { raw = await r.mget(...keys); } catch (e) { return true; } // 读不到就别删，宁可留着
  for (const v of raw) {
    if (!v) continue;
    let p = null;
    try { p = JSON.parse(v); } catch (e) { continue; }
    if (p && !p.isNPC && p.connected === true) return true;
  }
  return false;
}

/**
 * 这个房间是不是"测试剧本"的测试房？（Redis hgetall 返回的是字符串，两种形态都要认）
 */
function isTestRoom(room) {
  const v = room && room.testRun;
  return v === true || v === "true";
}

/**
 * 该不该按"无人"回收？返回原因（"no-players" / "no-humans"）或 null。
 *
 * 抽成纯函数是为了能钉住规则本身 —— 回收写错两个方向都有害：过松房间永久堆积，
 * 过严正在进行的对局被删掉。
 *
 * ⚠️ **测试房例外**：测试房里一个真人玩家都没有（管理员是旁观者，不是玩家），
 * 按"没有真人连着"判它必然被回收。压缩节奏（默认 4 分钟/阶段，一局约 13 分钟）跑不到
 * 30 分钟，所以这个坑一直没暴露；但**按真实节奏测**（10 分钟/阶段）一局 30 分钟以上，
 * 正好落进扫描器的 30 分钟判定里被删掉 —— 而那恰恰是管理员最需要的那种测试。
 * 实测复现：造一个测试房、把 createdAt 改到 40 分钟前、真跑一次 sweepOnce()
 * → `{abandoned:1, freedKeys:57}`，房间没了。
 *
 * 测试房不参与"无人回收"，只受最长存活时间（默认 6 小时）约束；
 * 它的正常回收路径是管理员点「结束测试」或测试跑完。
 */
function abandonedReason(room, { playerCount, hasHuman } = {}, now = Date.now()) {
  const created = Number(room && room.createdAt) || 0;
  if (!created || now - created <= ABANDONED_MS) return null;
  if (isTestRoom(room)) return null;
  if (!playerCount) return "no-players";
  if (!hasHuman) return "no-humans";
  return null;
}

/**
 * 扫描一轮并回收。
 * @returns {Promise<{expired:number, abandoned:number, staleIndex:number, orphanKeys:number, freedKeys:number, checked:number}>}
 */
async function sweepOnce(now = Date.now()) {
  const r = await getRedis();
  const out = { expired: 0, abandoned: 0, staleIndex: 0, orphanKeys: 0, garbage: 0, freedKeys: 0, checked: 0 };
  if (!r) return out;

  let indexed = new Set();
  try { indexed = new Set(await r.zrange("games:index", 0, -1)); } catch (e) { /* ignore */ }
  const codes = await enumerateRoomCodes();
  if (!codes.length) return out;

  for (const code of codes) {
    out.checked++;
    let room = null;
    try { room = await r.hgetall(`game:${code}`); } catch (e) { continue; }

    // 1) 房间主键已不存在 —— 只剩子键或索引死引用。
    //    注意排除 game:{code}:creating（建房时的唯一性占位锁，仍在有效期内不能动）。
    if (!room || !room.roomCode) {
      const leftover = (await scanKeys(`game:${code}*`)).filter(k => !k.endsWith(":creating"));
      if (leftover.length) {
        await r.del(...leftover);
        out.freedKeys += leftover.length;
        out.orphanKeys++;
      }
      await r.zrem("games:index", code);
      await r.srem("rooms:open", code);
      out.staleIndex++;
      continue;
    }

    // 2) 既没有 createdAt、又不在索引里 —— 不可能是 createRoom 建的（它两者都会写），
    //    属于测试或脚本直接 hset 出来的垃圾房间。这类房间原本永远不会被回收：
    //    isRoomExpired 对缺 createdAt 的房间刻意返回 false（避免误杀历史数据），
    //    于是它们既不过期、也不满足"无人回收"的时间条件（created=0 时该判断被跳过）。
    if (!Number(room.createdAt) && !indexed.has(code)) {
      out.freedKeys += await purgeRoom(r, code);
      out.garbage++;
      continue;
    }

    // 3) 超过最大存活时间
    if (isRoomExpired(room, now)) {
      out.freedKeys += await purgeRoom(r, code);
      out.expired++;
      continue;
    }

    // 4/5) 长期没有任何玩家记录（覆盖"建了没玩"）；有记录但一个真人都没连着（人全走光了）。
    //      —— 判据在 abandonedReason 里（纯函数，测试房有例外，见其注释）。
    //      hasConnectedHuman 只在有玩家记录时才查：没有玩家记录时不必多扫一轮键。
    const created = Number(room.createdAt) || 0;
    const playerKeys = (now - created > ABANDONED_MS) ? await scanKeys(`game:${code}:player:*`) : [];
    const hasHuman = playerKeys.length ? await hasConnectedHuman(r, code) : false;
    const reason = abandonedReason(room, { playerCount: playerKeys.length, hasHuman }, now);
    if (reason) {
      out.freedKeys += await purgeRoom(r, code);
      out.abandoned++;
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
      if (s.expired || s.abandoned || s.staleIndex || s.orphanKeys || s.garbage) {
        console.log(`[rooms] 回收：过期 ${s.expired} 个、无人 ${s.abandoned} 个、垃圾房 ${s.garbage} 个、残留子键 ${s.orphanKeys} 处、死索引 ${s.staleIndex} 条、释放 ${s.freedKeys} 个键`);
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
  isRoomExpired, expiryText, sweepOnce, startRoomSweeper, stopRoomSweeper, abandonedReason, isTestRoom,
  markAllPlayersDisconnected, purgeRoom,
  MAX_LIFETIME_MS, MAX_LIFETIME_HOURS, ABANDONED_MS, SWEEP_INTERVAL_MS,
};
