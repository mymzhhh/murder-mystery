// 分幕剧本（第一幕/第二幕…）的切分与按阶段解锁。
//
// 为什么需要它：真实剧本多是分幕本（实测《吉普赛女郎之死》每个角色本有 4 幕、
// 另有独立的《第五幕.docx》），而系统现在**一次性把整本 8000 字发给玩家和 AI**：
//   · 玩家开局就看到后面几幕（等于提前剧透"我后来做了什么"），失去分幕本的沉浸感；
//   · AI 每次调用的提示词里塞着整本，token 成本高且会被截断。
// 这里只做纯逻辑（无 IO、无 Redis），可被单测直接钉住。
//
// 两条硬约束：
//   1) **没有幕标记的剧本一律当作单幕** —— 行为与改造前完全一致，不会因为本模块改变老剧本；
//   2) 幕数不等时不能丢内容 —— 分配算法只会"把多幕并到同一个解锁点"，绝不裁剪。

/** 阶段轴上的 5 个解锁点（与前端 phase bar 一致；intro 归入第 1 点） */
const UNLOCK_PHASES = ["reading", "round1", "round2", "voting", "truth_reveal"];

/**
 * 延后解锁标记（切分点由剧本显式声明，而不是"看见第N幕就切"）：
 *   【延后解锁：第三幕】        → 从这里开始的内容延后到后续阶段
 *   【延后解锁 第二案】         → 没有"第N幕"时，标记里的文字当标题
 * 之所以要显式声明：案子通常发生在某一幕的**结尾**（《吉普赛女郎之死》是第四幕），
 * 机械按幕切会让玩家在搜证时"案件还没发生、证据在剧本里没有"。
 */
const DEFER_RE = /^[ \t　]*【\s*延后解锁\s*(?:[：:][ \t]*|[ \t]+)?(?:第\s*([一二三四五六七八九十\d]+)\s*幕)?\s*([^】]*)】[ \t]*$/m;

const CN_NUM = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** "一"/"十二"/"3" → 数字；解析不出返回 0 */
function actNumber(label) {
  const s = String(label || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = s.match(/^十([一二三四五六七八九])$/);        // 十一..十九
  if (m) return 10 + CN_NUM[m[1]];
  const m2 = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])?$/); // 二十..九十九
  if (m2) return CN_NUM[m2[1]] * 10 + (m2[2] ? CN_NUM[m2[2]] : 0);
  return CN_NUM[s] || 0;
}

/**
 * 把角色本切成"读本部分 / 延后部分"。
 *
 * ⚠️ 语义修正（实测踩过的坑）：**不能一看到「第N幕」就切**。
 * 《吉普赛女郎之死》每个角色本有 4 幕，但**案子在第四幕才发生** —— 按幕切分会让玩家
 * 在搜证阶段"案件还没发生、搜到的证据在剧本里根本没有"，完全无从推理。
 * 真实的分幕需求是：读本阶段必须给到**案发结束**，只有案发之后**新的案件/新内容**
 * 才值得单独放到后续阶段解锁。
 *
 * 所以切分点由剧本**显式声明**（人工/导入时判定），标记形如：
 *     【延后解锁：第三幕】
 *     【延后解锁 第二案】
 * 没有这个标记 → **整篇当作一幕**（读本阶段全给），与"不分幕"完全一致。
 * @returns {Array<{index:number,title:string,body:string}>}
 */
function splitActs(text) {
  const raw = String(text === null || text === undefined ? "" : text);
  if (!raw.trim()) return [];

  const m = DEFER_RE.exec(raw);
  if (!m) return [{ index: 1, title: "", body: raw.trim() }];

  const pre = raw.slice(0, m.index).trim();
  let post = raw.slice(m.index + m[0].length).trim();
  // 延后部分里若还带「第N幕」标题，就按标题再分成几幕（否则整段作一幕）
  const inner = splitByActHeads(post);
  const acts = [];
  if (pre) acts.push({ index: 1, title: "读本（含案发）", body: pre });
  if (inner.length > 1) {
    inner.forEach((a) => acts.push({ index: acts.length + 1, title: a.title, body: a.body }));
  } else if (post) {
    acts.push({ index: acts.length + 1, title: (m[2] || "").trim(), body: post });
  }
  return acts.length ? acts : [{ index: 1, title: "", body: raw.trim() }];
}

/** 按「第N幕」标题行把文本切成幕（只用于**延后部分**的内部分节） */
function splitByActHeads(text) {
  const raw = String(text === null || text === undefined ? "" : text);
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.length > 40) return;                       // 幕标题不会很长
    // 正文里可能出现「第 1 幕正文。」这种句子 —— 带句末标点的一律不当标题，
    // 否则 8 幕会被切成 16 段（实测踩过：正文行被误判成幕标题）。
    if (/[。！？；]/.test(t)) return;
    // 必须**以幕标记开头**（允许 # 标题符与【】括号），避免"23:10 我在营地【第二幕】"这种行被误判
    const mm = t.match(/^[#>*\s]*【?\s*第\s*([一二三四五六七八九十\d]+)\s*幕\s*([^】。！？；]*?)】?\s*[】]?$/);
    if (!mm) return;
    const n = actNumber(mm[1]);
    if (!n) return;
    heads.push({ line: i, index: n, title: (mm[2] || "").replace(/^[：:\s-]+/, "").trim() });
  });

  if (heads.length < 2) return [{ index: 1, title: "", body: raw.trim() }];
  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    return { index: h.index, title: h.title, body: lines.slice(h.line + 1, end).join("\n").trim() };
  }).filter((a) => a.body || a.title);
}

/** 阶段 → 解锁点下标（0..4）；lobby 返回 -1（还没开始，什么都不解锁） */
function unlockPointForPhase(phase) {
  const p = String(phase || "").toLowerCase();
  if (p === "lobby" || p === "") return -1;
  if (p === "intro") return 0;                             // 自我介绍归到第 1 个解锁点
  const i = UNLOCK_PHASES.indexOf(p);
  if (i >= 0) return i;
  if (p === "finished") return UNLOCK_PHASES.length - 1;
  return UNLOCK_PHASES.length - 1;                         // 未知阶段：全部解锁（不扣信息）
}

/**
 * 第 point 个解锁点应解锁到第几幕（累计）。
 * 公式 max(1, ceil(总幕数 × (point+1) / 解锁点数))：幕数 ≤5 时一一对应，
 * 幕数 >5 时把多出来的幕并进靠后的解锁点 —— 只合并、不裁剪。
 */
function unlockedActCount(totalActs, point) {
  const n = Math.max(0, Number(totalActs) || 0);
  if (n === 0) return 0;
  if (point < 0) return 0;
  const pts = UNLOCK_PHASES.length;
  return Math.min(n, Math.max(1, Math.ceil((n * (point + 1)) / pts)));
}

/** 当前阶段能看到第几幕（1 起；未开始为 0） */
function visibleActCount(text, phase) {
  const acts = splitActs(text);
  const pt = unlockPointForPhase(phase);
  return unlockedActCount(acts.length, pt);
}

/**
 * 按阶段产出玩家可见的正文：**累计解锁**（前几幕保留，不会忘记），
 * 末尾附一句"下一幕何时解锁"，让玩家知道还有内容。
 * @returns {{script:string, totalActs:number, unlocked:number, nextPhase:string|null, title:string}}
 */
function scriptForPhase(text, phase) {
  const acts = splitActs(text);
  if (acts.length === 0) return { script: "", totalActs: 0, unlocked: 0, nextPhase: null, title: "" };
  if (acts.length === 1) {
    // 单幕本：原样返回（改造前行为）
    return { script: acts[0].body, totalActs: 1, unlocked: 1, nextPhase: null, title: acts[0].title };
  }
  const pt = unlockPointForPhase(phase);
  const unlocked = unlockedActCount(acts.length, pt);
  const shown = acts.slice(0, unlocked);
  const parts = shown.map((a) => `【第${toCn(a.index)}幕${a.title ? " " + a.title : ""}】\n${a.body}`);
  let nextPhase = null;
  if (unlocked < acts.length) {
    const nextPt = UNLOCK_PHASES.findIndex((_, i) => unlockedActCount(acts.length, i) > unlocked);
    nextPhase = nextPt >= 0 ? UNLOCK_PHASES[nextPt] : null;
  }
  return { script: parts.join("\n\n"), totalActs: acts.length, unlocked, nextPhase, title: shown.length ? shown[shown.length - 1].title : "" };
}

/** 前几幕的**规则式摘要**（给 AI 用）：每幕取标题 + 时间线行 + 首句，不调 LLM、无额外成本 */
function summarizeActs(acts, upto, maxChars = 900) {
  const list = (acts || []).slice(0, Math.max(0, upto));
  if (!list.length) return "";
  const chunks = list.map((a) => {
    const body = String(a.body || "");
    const timeLines = (body.match(/[^\n]*\d{1,2}[:：]\d{2}[^\n]*/g) || []).slice(0, 2).map((s) => s.trim());
    const firstLine = (body.split(/\n/).find((s) => s.trim()) || "").trim();
    const picks = [];
    if (firstLine) picks.push(firstLine.slice(0, 80));
    for (const t of timeLines) if (!picks.includes(t)) picks.push(t.slice(0, 80));
    return `· 第${toCn(a.index)}幕${a.title ? "（" + a.title + "）" : ""}：${picks.join("；")}`;
  });
  let out = chunks.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "…";
  return out;
}

function toCn(n) {
  const map = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const v = Number(n) || 0;
  return v >= 0 && v <= 10 ? map[v] : String(n);
}

module.exports = {
  UNLOCK_PHASES,
  DEFER_RE,
  actNumber,
  splitActs,
  splitByActHeads,
  unlockPointForPhase,
  unlockedActCount,
  visibleActCount,
  scriptForPhase,
  summarizeActs,
  toCn,
};
