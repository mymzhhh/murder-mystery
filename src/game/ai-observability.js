// AI 行为的可观测性：每局"谁出了几次手"与"出了什么错"。
//
// 为什么单独一个模块：这两份数据**两个方向都要用**——
//   写入方是 game/ai-player（每次 AI 出手、每次回合失败），
//   读取方是 socket/test-run（生成测试报告）。
// 如果让 ai-player 直接 require test-run，就是循环依赖；如果两边各写一份键名，
// 迟早出现"写的是这个键、读的是那个键"（本项目已经因为这类问题踩过坑）。
// 所以键名与读写都钉在这里。
//
// 顺带一个好处：数据在 Redis 里，**进程重启不丢** —— 报告要统计的东西里，
// 只有它（和房间本身）是跨重启的。

const { peekRedis } = require("../core/redis-client");

// ⚠️ 这里必须用 peekRedis（"连接已存在就给我，没有就 null"），**不能**用 getRedis()。
// getRedis() 会主动建连并无限重试 —— 单测环境没有 Redis，调用它会把测试进程吊住不退出
// （实测：整个测试套件挂死）。观测是旁路，有就记、没有就算了。

/** 一个房间的"赛场统计"：字段形如 `{角色名}:{动作}` → 次数 */
const turnKey = (code) => `game:${code}:ai-turns`;
/** 一个房间的 AI 异常（列表，只留最近 N 条） */
const errKey = (code) => `game:${code}:ai-errors`;
/**
 * 每轮的"搜证 vs 发言"配比计数：字段 `<角色名>:search` / `<角色名>:talk`。
 *
 * 为什么必须**按轮**另记一份（ai-turns 已经是整局计数了，不够吗？）：
 * 实测报告 id 15 —— 四个 AI 的 `search` 是 6/10/8/10，而 `speak` **全是 0**
 * （见 ai-player 的 actTurn：先搜证、搜到就 return，加上 actInvestigate 的自我续搜，
 *  一个 AI 能把整轮回合全烧在搜证上）。"搜证与讨论"里的讨论因此从未发生。
 * 修法是按配比交替，而配比要**每轮重置**（否则第 1 轮搜多了，第 2 轮就再也不搜）。
 * 用 ai-turns 做不到这一点：它跨轮累加，读不出"本轮搜了几次、说了几次"。
 */
const mixKey = (code, round) => `game:${code}:ai-mix:${round}`;
const MIX_KINDS = ["search", "talk"];
const MAX_ERRORS = 50;
const ACTIONS = ["intro", "speak", "ask", "vote", "search"];   // search：搜证（此前漏统计 → 报告里永远显示 0，害我误判"AI 从不搜证"）

/** 记一次 AI 出手。action 取 ACTIONS 里的值。失败不抛（观测不该影响主流程）。 */
async function recordTurn(code, name, action) {
  if (!code || !name) return;
  try {
    const r = peekRedis();
    if (!r) return;                       // 没连 Redis（例如单测）：不记，也绝不建连
    await r.hincrby(turnKey(code), `${name}:${action}`, 1);
  } catch (e) { /* 观测失败不影响对局 */ }
}

/**
 * 记一次 AI 异常。这是"管理员判断剧本问题"时必须看见的东西：
 * 一次 LLM 超时会让 AI 整轮不说话，如果只进容器日志，就会被误读成
 * "AI 不按剧本演 / 剧本有问题"。
 */
async function recordError(code, { name, kind, message }) {
  if (!code) return;
  try {
    const r = peekRedis();
    if (!r) return;
    const item = JSON.stringify({ at: Date.now(), name: name || "?", kind: kind || "?", message: String(message || "").slice(0, 300) });
    await r.rpush(errKey(code), item);
    await r.ltrim(errKey(code), -MAX_ERRORS, -1);
  } catch (e) { /* 同上 */ }
}

/** 读"赛场统计"：{ 角色名: { intro, speak, ask, vote, total } } */
async function readTurns(code) {
  const out = {};
  try {
    const r = peekRedis();
    if (!r) return out;
    const raw = await r.hgetall(turnKey(code));
    for (const [field, n] of Object.entries(raw || {})) {
      const i = field.lastIndexOf(":");
      if (i <= 0) continue;
      const name = field.slice(0, i);
      const action = field.slice(i + 1);
      if (!ACTIONS.includes(action)) continue;
      if (!out[name]) out[name] = { intro: 0, speak: 0, ask: 0, vote: 0, total: 0 };
      const v = parseInt(n, 10) || 0;
      out[name][action] = v;
      out[name].total += v;
    }
  } catch (e) { /* 读不到就当没有 */ }
  return out;
}

/** 记一次本轮的"搜证 / 发言"配比计数（kind 取 MIX_KINDS） */
async function bumpRoundAction(code, round, name, kind) {
  if (!code || !round || !name || !MIX_KINDS.includes(kind)) return;
  try {
    const r = peekRedis();
    if (!r) return;
    const key = mixKey(code, round);
    await r.hincrby(key, `${name}:${kind}`, 1);
    await r.expire(key, 24 * 3600);   // 兜底 TTL（房间被删时也会随 game:{code}* 一并清掉）
  } catch (e) { /* 观测失败不影响对局 */ }
}

/** 读本轮配比计数：{ 角色名: { search, talk } }。读不到就当全 0。 */
async function readRoundActions(code, round) {
  const out = {};
  if (!code || !round) return out;
  try {
    const r = peekRedis();
    if (!r) return out;
    const raw = await r.hgetall(mixKey(code, round));
    for (const [field, n] of Object.entries(raw || {})) {
      const i = field.lastIndexOf(":");
      if (i <= 0) continue;
      const name = field.slice(0, i), kind = field.slice(i + 1);
      if (!MIX_KINDS.includes(kind)) continue;
      if (!out[name]) out[name] = { search: 0, talk: 0 };
      out[name][kind] = parseInt(n, 10) || 0;
    }
  } catch (e) { /* 读不到就当没有 */ }
  return out;
}

/** 读 AI 异常列表（新的在前） */async function readErrors(code) {
  try {
    const r = peekRedis();
    if (!r) return [];
    const raw = await r.lrange(errKey(code), 0, -1);
    return (raw || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

/** 清掉一个房间的观测数据（房间删除时由清理钩子调用；键本身也会随房间扫描被带走） */
async function clearObservability(code) {
  try {
    const r = peekRedis();
    if (!r) return;
    await r.del(turnKey(code), errKey(code));
  } catch (e) { /* 忽略 */ }
}

module.exports = { recordTurn, recordError, readTurns, readErrors, clearObservability, bumpRoundAction, readRoundActions, turnKey, errKey, mixKey, ACTIONS, MIX_KINDS, MAX_ERRORS };
