// 线索地点兜底：把"没有发现地点"的线索补上一个可搜到的地点。
//
// 为什么必须有这一步（2026-10-18 实测）：生成《停表的修表铺》时模型有 6 条线索没写「发现地点」，
// 落库后 location 为空 —— 而**搜证池是按线索的 location 生成的**，这 6 条等于永远搜不到
// （第1轮 22 条里 4 条、第2轮 22 条里 2 条）。页面不会报错，只是玩家少拿 14% 的线索。
//
// 原则：
//   1) 已有的地点**一律不动**（只 trim），避免把作者/模型写对的东西改坏；
//   2) 补的顺序：内容里出现的布局地点 → 证言特征 → 通用兜底；
//   3) 全部改动可复核（返回 filled 列表，写明每条补了什么、依据是什么）。
const TESTIMONY_RE = /^[^\s：:，,。]{2,10}\s*(说|称|回忆|表示|声称|供述|交代|证实)[：:]/;

/** 从"XX说：21:50 …"这类内容里认出这是证言 */
function looksLikeTestimony(content) {
  return TESTIMONY_RE.test(String(content || "").trim());
}

/**
 * @param {Array<{location?:string, content?:string, clueType?:string}>} clues
 * @param {{places?: string[], fallback?: string}} [opts]
 * @returns {{clues: Array, filled: Array<{index:number, location:string, reason:string}>}}
 */
function fillMissingClueLocations(clues, opts) {
  const o = opts || {};
  const places = (o.places || []).map((p) => String(p || "").trim()).filter(Boolean);
  const fallback = String(o.fallback || "现场").trim() || "现场";
  const filled = [];
  const out = (Array.isArray(clues) ? clues : []).map((c, index) => {
    const cur = String((c && c.location) || "").trim();
    if (cur) return { ...c, location: cur };
    const content = String((c && c.content) || "");
    const type = String((c && c.clueType) || "");
    // ① 内容里点到了布局里的地点 —— 最可信
    const hitPlace = places.find((p) => p && content.includes(p));
    if (hitPlace) {
      filled.push({ index, location: hitPlace, reason: "内容提及布局地点" });
      return { ...c, location: hitPlace };
    }
    // ② 证言类（"某某说：…"）—— 统一挂到「证言」
    if (looksLikeTestimony(content) || /人证|证词|口供/.test(type)) {
      filled.push({ index, location: "证言", reason: "证言类线索" });
      return { ...c, location: "证言" };
    }
    // ③ 兜底：至少让它能被搜到，而不是永远消失
    filled.push({ index, location: fallback, reason: "无可用依据，用兜底地点" });
    return { ...c, location: fallback };
  });
  return { clues: out, filled };
}

module.exports = { fillMissingClueLocations, looksLikeTestimony, TESTIMONY_RE };
