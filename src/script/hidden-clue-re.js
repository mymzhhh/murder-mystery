/**
 * 「隐藏线索」的正则**唯一来源**（2026-10-20）。
 *
 * 为什么单独成文件：同一个判定逻辑此前散落在 4 处（script-parser / search-locations /
 * difficulty-checks / outline-fixes），各处写法略有差异 —— 结果就出了事故：
 *   《回春堂蜜影》子线索写成「通过深入调查B13，残留粉末…」（**没有括号**），
 *   解析器那处要求必须有全角「（」，于是
 *     ① 子线索没被认出来（隐藏机制失效）
 *     ② 它同时落进普通搜证池（玩家一搜就拿到答案 = 剧透）
 * 现在统一到这里，任何一处要判断都调用它，不允许再各写一份。
 *
 * 支持的写法（都已实测/兼容）：
 *   （通过深入调查 A6「口袋里有一只空瓶。」获取）
 *   通过深入调查B13，残留粉末…
 *   通过深入调查：A6
 *   经由深入调查A6 / 需深入调查A6 / 需要深入调查 A6
 *   半角括号、全角冒号、字母大小写、全角数字
 */

/** 子线索标记：命中即说明"这条是别人的深入调查产物"。捕获组 1 = 父线索编号 */
const CHILD_RE = /[（(]?\s*(?:通过|经由|需要|需|经)?\s*深入调查\s*[:：]?\s*([A-Za-zＡ-Ｚａ-ｚ]?\d{1,3})/;

/** 父线索标记：正文里出现这些词就说明"这条可以被深入调查" */
const PARENT_RE = /发现隐藏线索|可深入调查|可深挖|值得深挖/;

/** 把可能含全角字符的编号归一化成半角大写（A6 / ａ６ → A6） */
function normalizeClueId(raw) {
  return String(raw || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .trim()
    .toUpperCase();
}

/** 取子线索的父编号；不是子线索返回 "" */
function parentIdOf(text) {
  const m = CHILD_RE.exec(String(text || ""));
  return m ? normalizeClueId(m[1]) : "";
}

/** 是否父线索（可被深入调查） */
function isParentText(text) {
  const s = String(text || "");
  return PARENT_RE.test(s);
}

/** 是否子线索（别人的深入调查产物） */
function isChildText(text) {
  return CHILD_RE.test(String(text || ""));
}

module.exports = {
  CHILD_RE, PARENT_RE,
  normalizeClueId, parentIdOf, isParentText, isChildText,
};
