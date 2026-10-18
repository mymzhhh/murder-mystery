// 剧本正文清洗：去掉混在角色本里的"元指令"（给人类玩家/组织者看的流程说明）。
//
// 为什么必须有这一步：印刷版分幕本会在每幕之间插入这类句子 ——
//   此阶段为闲聊环节，请了解其他人的目的，尽量不要透露自己之前来过这里的事情，否则可能会引起怀疑
//   组织者允许前不许翻开下一页
//   （请找组织者领取你的睡梦内容）
//   此阶段为公聊环节，所有玩家不可进行私聊
// 它们对"AI 玩家 + 系统控流程"的模式是**有害**的：
//   · 组织者/翻页/私聊这些机制在系统里根本不存在 → 模型会误以为受限于某个纸面流程；
//   · "此阶段"没有对应阶段 → 让提示词里多出一段无法兑现的上下文；
//   · 玩家端读起来像机关说明，破坏沉浸感。
// 但**任务清单（「你的任务」及其条目）是真内容，必须保留** —— 那是玩家的行动目标。
//
// 这里只做纯字符串处理（无 IO），可被单测直接钉住。

/** 逐行删除的元指令规则（行级，容忍全角空格与任意空白） */
const LINE_PATTERNS = [
  // 翻页门禁：「组织者允许前不许翻开下一页」「未经组织者允许前不许翻开下一页」「在组织者允许 之前不许翻开下一页」
  /组织者\s*允许[^\n]{0,12}?不(许|得)\s*翻开/,
  /未经\s*组织者\s*允许/,
  // 阶段说明：「此阶段为闲聊环节…」「此阶段公聊环节不可私聊…」
  /^\s*此阶段/,
  // 私聊限制（可能单独成行）
  /不(可|得)(进行|参与)?\s*私聊/,
  // 领取道具：「（请找组织者领取你的睡梦内容）」
  /[（(]\s*请找\s*组织者/,
  // 主持人口吻的翻页/朗读指令
  /^\s*(请\s*)?(翻到|翻开)\s*第?\s*\d*\s*页/,
];

/** 整段删除的括号内提示（出现在行中时） */
const INLINE_PATTERNS = [
  /[（(]\s*请找\s*组织者[^）)]*[）)]/g,
];

/**
 * 去掉角色本里的元指令，保留剧情与「你的任务」。
 * @param {string} text
 * @returns {{text:string, removed:string[]}} removed 用于导入报告（让"删了什么"可复核）
 */
function stripMetaInstructions(text) {
  const raw = String(text === null || text === undefined ? "" : text);
  if (!raw.trim()) return { text: "", removed: [] };
  const removed = [];

  // Word 转换来的文本段落之间是 \r，统一成 \n 再按行处理
  const normalized = raw.replace(/\r\n?/g, "\n");
  const kept = [];
  for (const line of normalized.split("\n")) {
    const t = line.trim();
    if (!t) { kept.push(""); continue; }
    let hit = null;
    for (const rx of LINE_PATTERNS) {
      if (rx.test(t)) { hit = t; break; }
    }
    if (hit) { removed.push(t.slice(0, 80)); continue; }
    kept.push(line);
  }

  let out = kept.join("\n");
  for (const rx of INLINE_PATTERNS) {
    out = out.replace(rx, (m) => { removed.push(String(m).slice(0, 80)); return ""; });
  }

  // 收拢多余空行（删除门禁行后会留下连续空行）
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, removed };
}

/** 门禁行是否出现在原文（用于判定"这本是不是印刷版分幕本"） */
function hasMetaInstructions(text) {
  return stripMetaInstructions(text).removed.length > 0;
}

module.exports = { stripMetaInstructions, hasMetaInstructions, LINE_PATTERNS, INLINE_PATTERNS };
