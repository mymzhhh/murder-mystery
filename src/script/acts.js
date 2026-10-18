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
 * 把角色本切成幕。
 * 支持的行形态（实测都出现过）：
 *   `【第一幕 初识】`   `## 第二幕`   `第三幕：真相`
 * @returns {Array<{index:number,title:string,body:string}>} 无标记时返回**单幕**（整篇）
 */
function splitActs(text) {
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
    const m = t.match(/^[#>*\s]*【?\s*第\s*([一二三四五六七八九十\d]+)\s*幕\s*([^】。！？；]*?)】?\s*[】]?$/);
    if (!m) return;
    const n = actNumber(m[1]);
    if (!n) return;
    heads.push({ line: i, index: n, title: (m[2] || "").replace(/^[：:\s-]+/, "").trim() });
  });

  if (heads.length < 2) {
    // 单幕（或只有一个幕标记 —— 视作普通标题）：整篇返回，保持老行为
    return [{ index: 1, title: "", body: raw.trim() }];
  }
  const acts = [];
  heads.forEach((h, k) => {
    const start = h.line;
    const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    // body 从标题行的**下一行**开始（标题本身当 title，避免玩家看到重复文字）
    const body = lines.slice(start + 1, end).join("\n").trim();
    acts.push({ index: h.index, title: h.title, body });
  });
  return acts.filter((a) => a.body || a.title);
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
  actNumber,
  splitActs,
  unlockPointForPhase,
  unlockedActCount,
  visibleActCount,
  scriptForPhase,
  summarizeActs,
  toCn,
};
