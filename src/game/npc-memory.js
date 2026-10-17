// NPC 事实记忆 — 让 NPC 在整局里不会"改口"
//
// 问题：npc-agent 只把最近 12 条对话发进提示词。一局剧本杀里玩家会反复审问，
// 第一轮编的不在场证明到第二轮就滑出了窗口，于是 NPC 会自相矛盾 ——
// 而"抓住凶手改口"恰恰是这类玩法的核心体验，NPC 失忆等于玩法失效。
//
// 解法：把 NPC **自己说过的关键宣称**抽出来，持久化到 Redis，并在每轮提示词里
// 单独注入一段"你此前宣称过的说法"。这段不受对话窗口影响，因此不会被冲掉。
//
// 为什么用确定性抽取而不是再调一次 LLM 做结构化：
//   - 每次 NPC 应答都多一次 LLM 调用，成本和延迟都不划算（审讯是实时交互）
//   - 抽取规则可以测、可预期，行为不会随模型波动
//   代价是它只挑"时间/地点/行踪/关系"这类必须一致的句子，不做语义归一。
//   这对"别改口"这个目标已经够用 —— 原话本身就是需要保持一致的东西。
const { getRedis } = require("../core/redis-client");
const { onRoomDeleted } = require("./room-cleanup-hooks");
const safety = require("../llm/prompt-safety");

/** 每个 NPC 最多保留的条数；超了丢最早的（最早的宣称价值最低） */
const MAX_FACTS = 40;
/** 事实键的存活时间（秒）：略长于房间最长寿命（默认 6h），兜底防泄漏 */
const FACTS_TTL = 8 * 3600;

const keyOf = (roomCode, npcName) => `npc:facts:${roomCode}:${npcName}`;

/**
 * 从 NPC 的一段回答里挑出"必须保持一致"的宣称。
 * 纯函数，便于测试。
 *
 * 只要句子里出现时间点/时段、地点、或行踪动词，就认为它是一条需要记住的宣称。
 * @param {string} answer
 * @returns {string[]}
 */
function extractClaims(answer) {
  const text = String(answer === null || answer === undefined ? "" : answer);
  if (!text.trim()) return [];

  // 按句末标点切句；保留括号里的舞台说明会让句子过碎，这里直接按句切
  const sentences = text
    .split(/(?<=[。！？!?；;])/)
    .map(s => s.trim())
    .filter(Boolean);

  const TIME = /(\d{1,2}\s*[:：]\s*\d{2})|([一二三四五六七八九十百]+点(半|整)?)|([子丑寅卯辰巳午未申酉戌亥]时([初正]|[一二三四]刻)?)|((凌晨|清晨|拂晓|上午|中午|午后|下午|傍晚|黄昏|晚上|夜里|深夜)\s*\d{1,2}\s*[点时刻])|(案发(当晚|那天|时))/;
  const PLACE = /(书房|卧房|卧室|厨房|后厨|客厅|前厅|大厅|院子|后院|花园|天台|阳台|仓库|地窖|走廊|楼梯|门口|街上|客栈|酒楼|诊所|药铺|店铺|公司|办公室|房间|房内|室内|屋外)/;
  const MOVEMENT = /(在|去|去了|到|到了|回|回到|离开|走|走过|上楼|下楼|出门|进门|值班|睡|休息|吃饭|喝酒|见|遇见|碰到)/;

  const claims = [];
  for (const s of sentences) {
    // 太短的多半是"我不知道""记不清了"这类无效回答，记下来只会污染上下文
    if (s.length < 6) continue;
    if (TIME.test(s) || PLACE.test(s) || (MOVEMENT.test(s) && s.length >= 12)) {
      claims.push(s.length > 160 ? s.slice(0, 160) + "…" : s);
    }
  }
  return claims;
}

/**
 * 记下这一轮 NPC 的宣称。失败不影响审讯主流程（记忆是增强，不是必需）。
 * @returns {Promise<number>} 新写入的条数
 */
async function recordNpcTurn(roomCode, npcName, answer) {
  if (!roomCode || !npcName) return 0;
  // 清洗后再入库：这是一条会被**每轮重复注入**的内容，一旦玩家把指令诱导进 NPC 的回答，
  // 它就会被持久化并在此后每一轮提示词里出现 —— 等于把一次性注入变成永久注入。
  // 所以入库前必须走和外部输入同一套清理。
  const claims = extractClaims(answer).map(c => safety.neutralize(c, 200)).filter(Boolean);
  if (!claims.length) return 0;
  try {
    const r = getRedis();
    if (!r) return 0;
    const key = keyOf(roomCode, npcName);
    await r.rpush(key, ...claims);
    await r.ltrim(key, -MAX_FACTS, -1);
    await r.expire(key, FACTS_TTL);
    return claims.length;
  } catch (e) {
    console.warn("[npc-memory] 记录宣称失败:", e.message);
    return 0;
  }
}

/**
 * 取出该 NPC 此前宣称过的说法（按时间顺序，旧→新）。
 * 读不到就返回空数组 —— 记忆缺失只是退化，不能让审讯报错。
 * @returns {Promise<string[]>}
 */
async function getNpcFacts(roomCode, npcName) {
  if (!roomCode || !npcName) return [];
  try {
    const r = getRedis();
    if (!r) return [];
    return (await r.lrange(keyOf(roomCode, npcName), 0, -1)) || [];
  } catch (e) {
    return [];
  }
}

/**
 * 渲染成提示词片段。没有记忆时返回空串，调用方据此跳过拼接。
 *
 * 措辞要点：明确要求"保持一致"，并给出改口的正确做法（补充细节而非否认），
 * 否则模型会为了"一致"而死守到不自然，或者干脆不理会。
 * @param {string[]} facts
 */
function buildFactsBlock(facts) {
  const list = (facts || []).filter(Boolean).map(f => safety.neutralize(f, 200)).filter(Boolean);
  if (!list.length) return "";
  return `
【你此前已经宣称过的说法】（按时间顺序，最早在前）
${list.map(f => "- " + f).join("\n")}

以上是你在本局早前亲口说过的话。玩家会拿它们来对质：
- 你必须与这些说法保持一致。同一件事不要给出互相矛盾的时间、地点或行踪。
- 如果被追问细节，可以补充、可以含糊带过，但**不得推翻自己已经说过的内容**。
- 如果真的需要修正，用符合角色的方式解释（"我之前记错了，其实是……"），不要若无其事地改口。
`.trimEnd();
}

// 房间被删时顺手清掉事实键，避免留下孤儿键
// （scripts/audit-orphans.js 会审计这类残留，这里主动清理）
onRoomDeleted((code) => {
  (async () => {
    try {
      const r = getRedis();
      if (!r) return;
      const keys = await r.keys(`npc:facts:${code}:*`);
      if (keys && keys.length) await r.del(...keys);
    } catch (e) { /* 清理失败不影响删除主流程 */ }
  })();
});

module.exports = {
  MAX_FACTS,
  FACTS_TTL,
  keyOf,
  extractClaims,
  recordNpcTurn,
  getNpcFacts,
  buildFactsBlock,
};
