/**
 * 上架闸门（publish gate）：把"会让玩家玩不了 / 提前拿到答案"的硬缺陷挡在上架之前。
 *
 * 为什么需要（2026-10-20）：
 *   隐藏线索父子不成对、子线索混进搜证池、凶手没有可挖证据…… 这些在生成期都只是
 *   「进修订队列」或「验收提示」，修订没补上，本子照样能上架 —— 玩家那边直接坏掉。
 *   这里做最后一道确定性检查：**不通过就不许上架**，并把原因原样返回给管理端。
 *
 * 判定全部基于已切分的数据（DB/Redis 里的 clues / characters），不调 LLM、不看正文渲染。
 * 允许 force 覆盖（管理端显式确认"我知道有问题，还是要上架"），但会记审计日志。
 */

const { checkHiddenCluePairs } = require("./outline-fixes");
const { isChildText } = require("./hidden-clue-re");

/** 每条线索是否可被玩家搜到（粗判：有地点、不是隐藏子线索） */
function isReachable(c) {
  const loc = String((c && c.location) || "").trim();
  if (!loc) return false;
  if (c && c.hiddenBehind) return false;
  if (isChildText(String((c && c.content) || ""))) return false;
  return true;
}

/**
 * @param {object} p
 * @param {Array} p.clues       已切分线索（含 id/content/location/round/hiddenBehind）
 * @param {Array} p.characters  角色（含 name/isMurderer）
 * @param {string} p.murderer   凶手名（可空，空则从 characters 里找 isMurderer）
 * @returns {{ok:boolean, blockers:Array<{code:string,text:string}>}}
 */
function checkPublishReady({ clues, characters, murderer } = {}) {
  const list = Array.isArray(clues) ? clues : [];
  const chars = Array.isArray(characters) ? characters : [];
  const killers = chars.filter((c) => c && (c.isMurderer || c.is_murderer)).map((c) => c.name);
  const killerName = String(murderer || killers[0] || "").trim();
  const blockers = [];

  // ① 没有线索 = 玩家无法游戏
  if (!list.length) {
    blockers.push({ code: "no_clues", text: "剧本没有线索：玩家无法搜证，开局即卡死" });
    return { ok: false, blockers };
  }

  // ② 隐藏线索父子必须成对（否则那层内容玩家永远拿不到）
  const hp = checkHiddenCluePairs({ clues: list });
  for (const t of hp.issues) blockers.push({ code: "hidden_pair", text: t });

  // ③ 子线索不能进普通搜证池（标记漏了也算 —— 正文写了"通过深入调查"就是子线索）
  const leaked = list.filter((c) => {
    const byText = isChildText(String((c && c.content) || ""));
    return byText && !c.hiddenBehind;
  });
  if (leaked.length) {
    blockers.push({
      code: "child_leaked",
      text: `子线索有 ${leaked.length} 条没被标成隐藏（${leaked.slice(0, 5).map((c) => c.id).join("、")}）——它们会直接出现在搜证池里，等于剧透答案`,
    });
  }

  // ④ 可搜到的线索太少
  const reachable = list.filter(isReachable);
  if (reachable.length < 10) {
    blockers.push({
      code: "too_few_reachable",
      text: `玩家实际能搜到的线索只有 ${reachable.length} 条（少于 10 条）——搜证阶段会很快无事可做`,
    });
  }

  // ⑤ 凶手不能"零证据"：至少要有一条可搜到的线索点名他
  if (killerName) {
    const againstKiller = reachable.filter((c) => String((c && c.content) || "").includes(killerName));
    if (!againstKiller.length) {
      blockers.push({
        code: "killer_no_evidence",
        text: `没有任何可搜到的线索提到凶手「${killerName}」——玩家不可能推出真相`,
      });
    }
  }

  return { ok: blockers.length === 0, blockers };
}

module.exports = { checkPublishReady, isReachable };
