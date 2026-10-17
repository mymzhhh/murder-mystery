// 线索正文的取值口径（纯逻辑，不依赖 DOM —— 可被 node --test 直接测）
//
// 为什么单列一个文件：线索对象在不同来源里的字段名并不统一
//   · room_state.myClues（玩家端搜到/公开的线索）与 /api/player/review 的 clues → content
//   · 管理端测试房的旁观数据（spectate_ready 的 state.clues）→ content
//   · 别处构造/更早版本的线索可能只有 description 或 text
// 这段 `description || content || text || ""` 原本在玩家端 JSX 里写了两遍（线索列表 + 复盘），
// 一旦两处漂移，就会出现"列表里有正文、复盘里空着"这种只看一个页面永远发现不了的差异。
//
// ⚠️ 这里**只做取值，绝不做裁剪或去 markdown**：
// 线索正文里可能独立成行地带着 `![说明](img:键名)`，那是玩家能不能推出真相的关键证据
// （实测《吉普赛女郎之死》的 B1/B2/B7 就是两张伤口形状图 + 一张弹道图）。
// 一旦这里顺手 strip 掉图片语法，图上就永远不见了 —— 而"线索文字看起来还在"会让它更难发现。
// 图片行怎么渲染由 components/ScriptBody.jsx 决定（见 lib/script-body.mjs 的约定）。

/**
 * 取一条线索的正文文本。
 * @param {object|string|null|undefined} clue 线索对象（或已经是字符串的正文）
 * @returns {string} 永远返回字符串；取不到时返回 ""（渲染层据此决定要不要渲染正文块）
 */
export function clueBodyText(clue) {
  if (clue === null || clue === undefined) return "";
  if (typeof clue === "string") return clue;         // 容错：调用方直接传了正文
  if (typeof clue !== "object") return String(clue); // 数字等意外类型也别让渲染层抛
  for (const field of ["description", "content", "text"]) {
    const v = clue[field];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

export default clueBodyText;
