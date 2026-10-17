// 结算给分 — 一局结束后给每位玩家一个分数与判定
//
// 为什么需要它：改造前只有一句表级结论（"玩家成功指认真凶"/"真凶逍遥法外"），
// 玩家赢了输了都一样，没有"我这局玩得好不好"的反馈。
//
// 设计取舍：**分数完全由可观测的事实算出**（投票、阵营胜负、找到的线索、发言数），
// 不调 LLM。理由是分数一旦不确定，玩家就会觉得"凭什么"，反而比没有分更糟。
// 需要语义判断的部分（个人支线任务是否达成）不在分数里，放到个性化复盘中由 LLM 叙述 ——
// 那里是"解释"，不需要精确，读者也不会拿它跟别人比大小。

/** 分值表 —— 集中在这里便于调整与解释给玩家 */
const POINTS = {
  VOTE_HIT: 30,          // 指认真凶
  MURDERER_ESCAPE: 40,   // 凶手成功脱身（难度更高，给得比"投对"多一点）
  CLUE_EACH: 5,          // 每找到一条线索
  CLUE_CAP: 20,          // 线索分上限
  SPEECH_EACH: 2,        // 每次公开发言
  SPEECH_CAP: 10,        // 发言分上限
};

/**
 * 算出每位玩家的得分与判定文案。纯函数。
 *
 * @param {object} input
 * @param {Array} input.players  房间玩家（含 playerId / characterName / playerName / isAI）
 * @param {object} input.votes   { 投票者playerId: 被投角色名 }
 * @param {string} input.murdererName 真凶角色名
 * @param {Array} [input.clues]  本局线索（含 foundBy: [playerId]）
 * @param {Array} [input.chatMessages] 本局发言（含 playerId）
 * @returns {{ board: Array, winner: string, murdererEscaped: boolean }}
 */
function computeScores({ players = [], votes = {}, murdererName = "", clues = [], chatMessages = [] } = {}) {
  // 凶手是否被投出：看最高票是否落在真凶身上（与 determineOutcome 的口径保持一致）
  const tally = {};
  for (const target of Object.values(votes || {})) {
    if (!target) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  let topCount = -1;
  let topTie = false;
  for (const t of Object.keys(tally)) {
    if (tally[t] > topCount) { topCount = tally[t]; topTie = false; }
    else if (tally[t] === topCount) topTie = true;
  }
  const topName = Object.keys(tally).find(t => tally[t] === topCount && topCount > 0) || "";
  const murdererVotedOut = !!murdererName && topName === murdererName && !topTie;
  const murdererEscaped = !!murdererName && !murdererVotedOut;

  const clueCount = {};
  for (const c of clues || []) {
    for (const pid of (c && c.foundBy) || []) clueCount[pid] = (clueCount[pid] || 0) + 1;
  }
  const speechCount = {};
  for (const m of chatMessages || []) {
    if (m && m.playerId) speechCount[m.playerId] = (speechCount[m.playerId] || 0) + 1;
  }

  const board = (players || [])
    .filter(p => p && p.characterName)
    .map((p) => {
      const isMurderer = !!murdererName && p.characterName === murdererName;
      const myVote = (votes || {})[p.playerId] || "";
      const votedRight = !!myVote && myVote === murdererName;

      const cluePts = Math.min(POINTS.CLUE_CAP, (clueCount[p.playerId] || 0) * POINTS.CLUE_EACH);
      const speechPts = Math.min(POINTS.SPEECH_CAP, (speechCount[p.playerId] || 0) * POINTS.SPEECH_EACH);
      let resultPts = 0;
      if (isMurderer) resultPts = murdererEscaped ? POINTS.MURDERER_ESCAPE : 0;
      else if (votedRight) resultPts = POINTS.VOTE_HIT;

      const verdict = isMurderer
        ? (murdererEscaped ? "凶手脱身" : "凶手落网")
        : (myVote ? (votedRight ? "指认正确" : "指认错误") : "未投票");

      return {
        playerId: p.playerId,
        name: p.characterName,
        playerName: p.playerName || "",
        isAI: !!p.isAI || !!p.isNPC,
        isMurderer,
        vote: myVote,
        verdict,
        clueCount: clueCount[p.playerId] || 0,
        speechCount: speechCount[p.playerId] || 0,
        breakdown: { result: resultPts, clue: cluePts, speech: speechPts },
        total: resultPts + cluePts + speechPts,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return {
    board,
    winner: !murdererName ? "unknown" : (murdererEscaped ? "murderer" : "players"),
    murdererEscaped,
  };
}

module.exports = { POINTS, computeScores };
