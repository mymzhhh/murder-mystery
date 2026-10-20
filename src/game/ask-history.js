/**
 * AI 提问历史与目标轮转。
 *
 * 为什么需要（2026-10-20 用户实测）：
 *   一局里 AI 几乎**全在问同一个人**（赵帅哥被连问 8 次），而且问的都是同一段
 *   5 分钟窗口（11:25–11:50）。原因是提问调用 `turnLLM(k, candidates)` 拿不到任何
 *   "我问过谁、问过什么"的状态，`turnStrategy` 也只按"是不是凶手"分两档 ——
 *   所有 AI 看到同样的公屏、同样的线索，自然选同一个"最可疑的人"。
 *
 * 设计：
 *   · 按 (房间, 轮次) 记一份提问账本：谁问了谁、问了什么；
 *   · 目标选择用**最少被问优先**（全局公平）+ **我问过的最少优先**（个人多样性）；
 *   · 问题相似度用字符二元组重叠判定，近似重复即视为"重复问"；
 *   · Redis 不可用时全部降级为空账本，绝不影响对局。
 */

const KEY = (code, round) => `game:${code}:asks:${round}`;
const MAX_Q_PER_PAIR = 6;

function peekRedis() {
  try {
    const rc = require("../core/redis-client");
    return typeof rc.peekRedis === "function" ? rc.peekRedis() : null;
  } catch (e) {
    return null;
  }
}

/** 归一化问题文本：去标点空白、去常见疑问词，便于比较 */
function normQuestion(q) {
  return String(q || "")
    .replace(/[\s，。？！、；：""''（）()《》【】,.?!;:]/g, "")
    .replace(/你觉得|请问|我想问|那|呢|吗|吧/g, "")
    .slice(0, 120);
}

/** 抽出并规范化"时刻 token"：11点45 / 11:45 / 11时45分 都规范成 11:45 */
function timeTokens(q) {
  const out = new Set();
  const s = String(q || "");
  // 先处理「N点M分」「N点半」
  for (const m of s.matchAll(/(\d{1,2})\s*[点時时]\s*(半|\d{1,2})?/g)) {
    const h = Number(m[1]);
    const mm = m[2] === "半" ? 30 : (Number(m[2]) || 0);
    if (h >= 0 && h <= 24) out.add(`${h}:${String(mm).padStart(2, "0")}`);
  }
  // 再处理 HH:MM
  for (const m of s.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/g)) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h <= 24 && mm < 60) out.add(`${h}:${String(mm).padStart(2, "0")}`);
  }
  return out;
}

/** 字符二元组集合 */
function bigrams(s) {
  const set = new Set();
  const t = String(s || "");
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/**
 * 两个问题的相似度（0–1）。
 *
 * 用两路取最大：
 *   ① 指向**同一个时刻**就算同一话题 —— 实测最可靠。用户反馈的重复提问正是
 *      "翻来覆去问同一段 5 分钟窗口"，换个说法后 bigram 只有 0.37，但时刻完全一样。
 *   ② 字符二元组重叠（用较小集合做分母，短问题也能比）。
 */
function questionSimilarity(a, b) {
  const ta = timeTokens(a);
  const tb = timeTokens(b);
  if (ta.size && tb.size) {
    let hit = 0;
    for (const x of ta) if (tb.has(x)) hit++;
    const timeSim = hit / Math.min(ta.size, tb.size);
    if (timeSim > 0) return Math.max(timeSim, 0.6);
  }
  const A = bigrams(normQuestion(a));
  const B = bigrams(normQuestion(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.min(A.size, B.size);
}

/**
 * 纯函数：给候选人排序（越靠前越该被问）。
 * 规则：全局被问次数少的优先 → 我问过的次数少的优先 → 候选原序
 */
function rankTargets({ candidates, targetCounts, askedByMe }) {
  const cands = (candidates || []).filter(Boolean);
  const tc = targetCounts || {};
  const mine = askedByMe || {};
  return cands
    .map((name, idx) => ({ name, idx, global: Number(tc[name] || 0), mine: Number(mine[name] || 0) }))
    .sort((a, b) => (a.global - b.global) || (a.mine - b.mine) || (a.idx - b.idx))
    .map((x) => x.name);
}

/**
 * 纯函数：这次提问要不要改目标？
 *
 * 2026-10-20 用户校准（重要）：**可以连续问同一个人，但必须是在它的视角里有很大嫌疑**。
 * 所以这里不是机械轮转 —— 先看"重复问同一时段"（纯浪费，一律拦），
 * 再看嫌疑：嫌疑高就允许追着问，嫌疑低才做轮转。
 *
 * 规则顺序：
 *   ① 问题与问过他的某条高度相似（≥0.5，多为同一时段）→ 一律改（换目标或换话题）
 *   ② 嫌疑 ≥4（我的线索点名他 / 时刻冲突）→ 允许连续追问，不改
 *   ③ 我问过同一人 ≥2 次 → 改
 *   ④ 连续两问都是同一人（且嫌疑不高）→ 改
 *   ⑤ 该目标本轮被问次数 ≥ 最少者 +2（明显扎堆）→ 改
 */
function shouldRotate({ target, askerName, candidates, targetCounts, askedByMe, askedQuestionsOfTarget, lastTarget, suspicion }) {
  if (!target) return false;
  const mine = Number((askedByMe || {})[target] || 0);
  const sim = Number((askedQuestionsOfTarget && askedQuestionsOfTarget.similarity) || 0);
  // ① 同一时段重复问 —— 无论嫌疑多高都拦（只是浪费一次出手）
  if (sim >= 0.5) return true;

  // ② 嫌疑足够高 → 允许追着同一个人问（用户明确要求的行为）
  const susp = Number(suspicion || 0);
  if (susp >= 4) return false;

  // ③④ 低嫌疑下的扎堆/连续
  if (mine >= 2) return true;
  if (mine >= 1 && lastTarget && lastTarget === target) return true;

  // ⑤ 全局扎堆
  const tc = targetCounts || {};
  const counts = Object.values(tc).map(Number);
  const least = counts.length ? Math.min(...counts) : 0;
  if (Number(tc[target] || 0) >= least + 2) return true;
  return false;
}

/** 读账本：{ byAsker: {asker: {target: [q,...]}}, targetCounts: {target: n} } */
async function readAsks(code, round) {
  const empty = { byAsker: {}, targetCounts: {} };
  const r = peekRedis();
  if (!r || !code) return empty;
  try {
    const all = await r.hgetall(KEY(code, round));
    if (!all) return empty;
    const byAsker = {};
    const targetCounts = {};
    const lastByAsker = {};
    for (const [field, raw] of Object.entries(all)) {
      if (String(field).startsWith("last:")) {
        lastByAsker[String(field).slice(5)] = String(raw || "");
        continue;
      }
      const [asker, target] = String(field).split(">");
      if (!asker || !target) continue;
      let list = [];
      try { list = JSON.parse(raw); } catch (e) { list = []; }
      if (!Array.isArray(list)) list = [];
      byAsker[asker] = byAsker[asker] || {};
      byAsker[asker][target] = list;
      targetCounts[target] = (targetCounts[target] || 0) + list.length;
    }
    return { byAsker, targetCounts, lastByAsker };
  } catch (e) {
    return empty;
  }
}

/** 记一次提问 */
async function recordAsk(code, round, askerName, targetName, question) {
  const r = peekRedis();
  if (!r || !code || !askerName || !targetName) return;
  try {
    const field = `${askerName}>${targetName}`;
    const raw = await r.hget(KEY(code, round), field);
    let list = [];
    try { list = JSON.parse(raw || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push(String(question || "").slice(0, 200));
    await r.hset(KEY(code, round), field, JSON.stringify(list.slice(-MAX_Q_PER_PAIR)));
    // 记录"我上一次问的是谁"，用于判"连续两次问同一人"
    await r.hset(KEY(code, round), `last:${askerName}`, String(targetName));
    await r.expire(KEY(code, round), 6 * 3600);
  } catch (e) { /* 记账失败不影响对局 */ }
}

/** 给提示词用的一段话：我已经问过谁、谁被问得最多/最少、哪些时刻已经被问过了 */
function askHintText(ledger, askerName, candidates) {
  const byAsker = (ledger && ledger.byAsker) || {};
  const targetCounts = (ledger && ledger.targetCounts) || {};
  const mine = byAsker[askerName] || {};
  const mineLine = Object.entries(mine)
    .map(([t, qs]) => `${t}×${(qs || []).length}`)
    .join("、") || "（还没问过任何人）";
  const ranked = rankTargets({ candidates, targetCounts, askedByMe: mine });
  const orderLine = ranked.map((n) => `${n}（被问${targetCounts[n] || 0}次）`).join("、");

  // 全场已经问过的时刻（不分提问者）：实测沈砚秋的 20:10 被 6 个人轮流问同一件事，
  // 后面几次纯属重复。这里只做**软提示**，不硬拦 —— 每个人自己还没问过的方面仍有价值。
  const timeLines = [];
  for (const [asker, targets] of Object.entries(byAsker)) {
    for (const [target, qs] of Object.entries(targets || {})) {
      const times = new Set();
      for (const q of qs || []) for (const t of timeTokens(q)) times.add(t);
      if (times.size) timeLines.push(`${target}的 ${[...times].join("/")}`);
    }
  }
  const askedLine = timeLines.length
    ? `- 全场已经问过这些时段（再问同一段多半是重复）：${timeLines.slice(0, 6).join("、")}`
    : "";

  return `- 你已经问过：${mineLine}
- 建议优先问：${orderLine || "（无可问对象）"}${askedLine ? "\n" + askedLine : ""}
- 可以**连续追问同一个人**，但前提是你手上的线索或公屏说法真的指向他（能说出具体矛盾）；
- 没有依据时别盯着一个人问，也不要反复问同一段时间。`;
}


/** 抽出文本里的时刻 token（与 questionSimilarity 同口径） */
function extractTimes(text) {
  return timeTokens(text);
}

/**
 * 从**这个 AI 自己的知识**里给每个嫌疑对象打分。
 *
 * 为什么需要（2026-10-20 用户反馈）：
 *   "可以连续问同一个人，但必须是在它的视角里有很大的嫌疑"。
 *   机械轮转会让"手上明明有证据指向 X"的 AI 被迫去问无关的人，推理质量反而下降。
 *
 * 打分信号（只用 AI 能看到的东西：自己搜到的线索 + 公屏发言）：
 *   +3  我的线索里**点名**了这个人（线索直接指向他）
 *   +2  我的线索里出现的时刻，与这个人在公屏上说过的时刻**重合**（可能是时间线冲突）
 *   +1  这个人几乎没说自己的行踪（没有时刻），无法自证
 * 上限 6 分。≥4 视为"高度可疑"，允许连续追问。
 */
function scoreSuspects({ clueLines, transcript, candidates }) {
  const cands = (candidates || []).filter(Boolean);
  const clues = (clueLines || []).join("\n");
  const transcriptText = String(transcript || "");
  const out = {};
  for (const name of cands) {
    let score = 0;
    const reasons = [];
    // ① 我的线索点名
    if (name && clues.includes(name)) {
      score += 3;
      reasons.push("我手上的线索提到了他");
    }
    // ② 时刻重合
    const clueTimes = extractTimes(clues);
    const hisLines = transcriptText.split("\n").filter((l) => l.includes(name));
    const hisTimes = extractTimes(hisLines.join("\n"));
    let overlap = 0;
    for (const t of hisTimes) if (clueTimes.has(t)) overlap++;
    if (overlap > 0) {
      score += Math.min(2, overlap);
      reasons.push(`他的说法与我的线索在同一时刻（${overlap} 处）`);
    }
    // ③ 没自证行踪
    if (!hisTimes.size && hisLines.length) {
      score += 1;
      reasons.push("他说了很多但没交代具体时刻");
    }
    out[name] = { score: Math.min(6, score), reasons };
  }
  return out;
}

module.exports = {
  KEY, normQuestion, questionSimilarity, rankTargets, shouldRotate,
  readAsks, recordAsk, askHintText, scoreSuspects, extractTimes,
};
