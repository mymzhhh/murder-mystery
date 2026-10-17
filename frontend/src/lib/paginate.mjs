// 剧本分页（纯逻辑，不依赖 DOM，便于单元测试）
//
// 原来的实现是 `for (i = 0; i < len; i += 360)` —— 两个问题：
//   1) 不管屏幕多大都只切 360 字。实测在 2149px 宽的窗口里，一页只填满约三分之一，
//      玩家反馈"内容太少"，而屏幕剩下的空间全空着。
//   2) 360 是硬切，句子会被从中间劈开（例如"……厘清命案与周万"就断在这里），
//      下一页才接上，读起来像被截断。
//
// 现在改为：容量按容器实际宽高估算，切分优先在段落、其次在句末标点处断开，
// 只有单句本身超过一页时才硬切（并给出明确的分页语义）。

/** 按空行切段，去掉空白段 */
export function splitBlocks(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 按容器尺寸估算每页可容纳的字数。
 * 中文每字约占 1 个字号宽；行高按 lineHeightRatio 倍字号。
 * @returns {number} 每页字数（有下限，避免极端窄屏切出无法阅读的碎片）
 */
export function estimateBudget({ width, height, fontSize = 15, lineHeightRatio = 1.85, safety = 0.92 } = {}) {
  // 必须显式转成数字：Math.max(0, undefined) 是 NaN，而 NaN 会一路传播，
  // 让预算变成 NaN → 分页算出空页。DOM 万一还没量到尺寸就会走到这里。
  const w = Number(width);
  const h = Number(height);
  const fs = Number(fontSize) || 15;
  const lr = Number(lineHeightRatio) || 1.85;
  const perLine = Math.max(10, Math.floor((Number.isFinite(w) && w > 0 ? w : 0) / fs));
  const lines = Math.max(6, Math.floor((Number.isFinite(h) && h > 0 ? h : 0) / (fs * lr)));
  const raw = Math.floor(perLine * lines * (Number(safety) || 0.92));
  return Math.max(300, Number.isFinite(raw) ? raw : 300);
}

/** 单段过长时，优先在句末标点断开；实在没有标点才硬切 */
function splitLongBlock(block, budget) {
  if (block.length <= budget) return [block];
  const parts = block.split(/(?<=[。！？；!?;])/).filter(s => s.length);
  const out = [];
  let cur = "";
  for (const s of parts) {
    if (s.length > budget) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < s.length; i += budget) out.push(s.slice(i, i + budget));
      continue;
    }
    if (cur && cur.length + s.length > budget) { out.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) out.push(cur);
  return out.length ? out : [block];
}

/**
 * 分页。
 * @param {string} text 剧本正文
 * @param {number} budget 每页字数
 * @returns {string[]} 至少一页
 */
export function paginate(text, budget = 1000) {
  const b = Math.max(100, Math.floor(budget) || 1000);
  const pages = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) { pages.push(cur.join("\n\n")); cur = []; curLen = 0; }
  };
  for (const raw of splitBlocks(text)) {
    for (const block of splitLongBlock(raw, b)) {
      const add = block.length + (curLen ? 2 : 0);
      // 一段本身就占满一页时允许它独占，不要为了凑页把它切碎
      if (curLen && curLen + add > b) flush();
      cur.push(block);
      curLen += add;
    }
  }
  flush();
  return pages.length ? pages : [""];
}

/** 把一段纯文本收进 segments，并清掉"配不成对"的 markdown 标记字符。
 *
 *  模型经常漏写闭合的 `**` —— 例如真相复盘里的 `作案手法**（详细过程）：`，
 *  正则配不到这一对，于是 `**` 被原样显示，看起来像界面坏了。
 *  这里统一收尾：成对的标记已经被上面的正则吃掉了，还会剩下来的基本只有
 *  长度 ≥2 的星号串（** / ***）；单个 `*` 只在紧贴两端时才清，
 *  免得误伤正文里偶尔出现的数学记号。
 */
function pushText(out, raw) {
  const v = String(raw)
    .replace(/\*{2,}/g, "")
    .replace(/^\*+|\*+$/g, "")
    .replace(/_{2,}/g, "");
  if (v) out.push({ t: "text", v });
}

/** 极简 markdown 行内处理：认 **加粗** 与 *斜体* / _斜体_，其余原样。
 *  斜体段用 t:"italic" 返回，渲染层可以照常显示成普通文字 ——
 *  中文正文里"斜体"没有排版意义，重要的是别再让星号漏到屏幕上。 */
export function parseInline(line) {
  const src = String(line === null || line === undefined ? "" : line);
  const out = [];
  const re = /\*\*(.+?)\*\*|\*([^*\n]+?)\*|__([^_\n]+?)__|_([^_\n]+?)_/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) pushText(out, src.slice(last, m.index));
    if (m[1] !== undefined) out.push({ t: "bold", v: m[1] });
    else out.push({ t: "italic", v: m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]) });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushText(out, src.slice(last));
  return out.length ? out : [{ t: "text", v: "" }];
}

/**
 * 把一行判定成结构化的块，供渲染层使用。
 * 剧本正文里 ### / ** 是 markdown 标记，原来被原样打印出来，
 * 既难看又白占行高（一页只能塞更少内容）。
 */
export function classifyLine(line) {
  const raw = String(line || "");
  const t = raw.trim();
  if (!t) return { kind: "blank" };
  const h = t.match(/^(#{1,4})\s+(.*)$/);
  if (h) return { kind: "heading", level: h[1].length, text: h[2].trim() };
  // 整行只有加粗内容 → 当成小标题（模板里 "**一、案发背景**" 就是这种）
  const boldOnly = t.match(/^\*\*(.+?)\*\*[：:]?\s*$/);
  if (boldOnly) return { kind: "subheading", text: boldOnly[1].trim() };
  // 整行只有斜体内容 → 也是小标题。模型写小节名时常写成 "*准备工作：*"，
  // 旧实现认不出来，星号就跟着正文一起打了出来。
  const italicOnly = t.match(/^\*([^*]+?)\*[：:]?\s*$/);
  if (italicOnly) return { kind: "subheading", text: italicOnly[1].trim().replace(/[：:]\s*$/, "") };
  const li = t.match(/^[-*]\s+(.*)$/);
  if (li) return { kind: "list", text: li[1].trim() };
  const ol = t.match(/^(\d+)[.、]\s+(.*)$/);
  if (ol) return { kind: "ordered", index: ol[1], text: ol[2].trim() };
  return { kind: "para", text: t };
}
