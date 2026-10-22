/**
 * 线索正文的净化（2026-10-20 新增）。
 *
 * 实测事故（《临河客栈桐油案》B25）：生成时把「## 推理链说明」整段混进了**最后一条线索**的正文——
 * 那一段写着动机链、手法链、时间链的完整推演（"起点A1→A2→B13→B24"、"木板、脚印、算盘"…），
 * 玩家搜到这一条线索就等于拿到完整答案。属于**玩家可见的剧透泄漏**。
 *
 * 根因：线索是按 `### A12：...` 切块的，最后一条之后的所有内容（包括推理链小结）
 * 都会被并入最后一条线索的正文。
 *
 * 处理原则：
 *   · 推理链小结本身是有价值的（DM 用），**不能删**，但必须从玩家可见的线索正文里剥出去；
 *   · 只剥"从某个标题开始、到结尾"的整段，绝不改动线索正文自身的文字。
 */

// 会被误并进线索的"元信息"小节标题（生成时它们排在线索之后）
// ⚠️ 不能要求标题在行首：实测真实数据是内联的 ——
//   「…其余人员无权限随意开启。 --- ## 推理链说明 1. 动机链：…」
// 所以只认「# 号 + 标题词」，位置不限。
const META_HEAD = /#{1,4}\s*(推理链(?:总结|说明|小结)?|证据链|定案链|线索总结|线索清单)/;

/**
 * 从线索正文里剥掉误并入的"推理链/证据链"小节。
 * @param {string} text 线索正文
 * @returns {string} 净化后的正文（若没有该小节则原样返回）
 */
function stripReasoningChain(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  const m = META_HEAD.exec(s);
  if (!m) return s;
  return s.slice(0, m.index).replace(/[-—\s]+$/, "").trim();
}

/** 整篇线索文本里是否含推理链小节（供校验/日志用） */
function hasReasoningChain(text) {
  return META_HEAD.test(String(text || ""));
}

/**
 * 从整篇线索 markdown 里抽出推理链小结（给 DM 侧留档用，避免净化时把内容丢了）
 * @returns {string} 小结原文；没有则空串
 */
function extractReasoningChain(text) {
  const s = String(text || "");
  const m = META_HEAD.exec(s);
  return m ? s.slice(m.index).trim() : "";
}

module.exports = { stripReasoningChain, hasReasoningChain, extractReasoningChain, META_HEAD };
