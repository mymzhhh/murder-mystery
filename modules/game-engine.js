// 游戏引擎 — 纯逻辑层：阶段状态机、线索分配、投票判定

const PHASES = [
  "lobby",
  "reading",
  "round1_investigation",
  "round1_discussion",
  "round2_investigation",
  "round2_discussion",
  "round3",
  "voting",
  "truth_reveal",
  "finished",
];

const PHASE_CONFIG = {
  lobby:                { label: "等待开始",         allowClueReq: false, allowChat: true,  allowVote: false },
  reading:              { label: "阅读剧本",         allowClueReq: false, allowChat: false, allowVote: false },
  round1_investigation: { label: "第一轮搜证",       allowClueReq: true,  allowChat: false, allowVote: false },
  round1_discussion:    { label: "第一轮讨论",       allowClueReq: false, allowChat: true,  allowVote: false },
  round2_investigation: { label: "第二轮搜证",       allowClueReq: true,  allowChat: false, allowVote: false },
  round2_discussion:    { label: "第二轮讨论",       allowClueReq: false, allowChat: true,  allowVote: false },
  round3:               { label: "第三轮搜证+讨论",   allowClueReq: true,  allowChat: true,  allowVote: false },
  voting:               { label: "投票阶段",         allowClueReq: false, allowChat: true,  allowVote: true  },
  truth_reveal:         { label: "真相揭露",         allowClueReq: false, allowChat: true,  allowVote: false },
  finished:             { label: "游戏结束",         allowClueReq: false, allowChat: true,  allowVote: false },
};

function getPhaseConfig(phase) {
  return PHASE_CONFIG[phase] || PHASE_CONFIG.lobby;
}

function getNextPhase(current) {
  const idx = PHASES.indexOf(current);
  if (idx < 0 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

function getPhaseRound(phase) {
  if (phase.startsWith("round1")) return 1;
  if (phase.startsWith("round2")) return 2;
  if (phase === "round3") return 3;
  return 0;
}

function canAdvancePhase(gameState) {
  const players = gameState.players || [];
  const connected = players.filter(p => p.connected && p.characterName);
  return connected.length >= 3; // 至少3个有角色的已连接玩家
}

function validateAction(action, gameState, playerId) {
  const { phase, players } = gameState;
  const config = getPhaseConfig(phase);
  const player = players.find(p => p.playerId === playerId);
  if (!player) return { ok: false, error: "PLAYER_NOT_FOUND", message: "玩家不在房间内" };

  switch (action) {
    case "advance_phase":
      if (!player.isDM) return { ok: false, error: "NOT_DM", message: "仅 DM 可以推进阶段" };
      if (phase === "finished") return { ok: false, error: "GAME_ENDED", message: "游戏已结束" };
      if (phase === "voting") {
        // 从投票到揭示需要先关闭投票
        return { ok: false, error: "CLOSE_VOTING_FIRST", message: "请先关闭投票再揭示真相" };
      }
      break;
    case "request_clue":
      if (!config.allowClueReq) return { ok: false, error: "WRONG_PHASE", message: "当前阶段不能申请线索" };
      break;
    case "send_chat":
      if (!config.allowChat) return { ok: false, error: "WRONG_PHASE", message: "当前阶段不能发言" };
      break;
    case "cast_vote":
      if (!config.allowVote) return { ok: false, error: "WRONG_PHASE", message: "当前阶段不能投票" };
      break;
    case "assign_clue":
    case "close_voting":
    case "reveal_truth":
    case "end_game":
      if (!player.isDM) return { ok: false, error: "NOT_DM", message: "仅 DM 可以执行此操作" };
      break;
    case "select_script":
      if (!player.isDM) return { ok: false, error: "NOT_DM", message: "仅 DM 可以选择剧本" };
      if (phase !== "lobby") return { ok: false, error: "WRONG_PHASE", message: "只能在等待阶段选择剧本" };
      break;
    case "assign_character":
      if (!player.isDM) return { ok: false, error: "NOT_DM", message: "仅 DM 可以分配角色" };
      if (phase !== "lobby") return { ok: false, error: "WRONG_PHASE", message: "只能在等待阶段分配角色" };
      break;
    case "start_game":
      if (!player.isDM) return { ok: false, error: "NOT_DM", message: "仅 DM 可以开始游戏" };
      if (phase !== "lobby") return { ok: false, error: "WRONG_PHASE", message: "只能在等待阶段开始" };
      break;
  }
  return { ok: true };
}

function getAvailableCluesForPlayer(allClues, playerId, round) {
  return allClues.filter(c =>
    // 用 == 兼容 Redis 返回的字符串 round 值
    c.round == round && (!c.foundBy || !c.foundBy.includes(playerId))
  );
}

function pickRandomClue(availableClues) {
  if (!availableClues.length) return null;
  const nonRedHerring = availableClues.filter(c => c.isRedHerring !== true);
  const pool = nonRedHerring.length > 0 ? nonRedHerring : availableClues;
  return pool[Math.floor(Math.random() * pool.length)];
}

function tallyVotes(votes, players) {
  const tally = {};
  for (const [voterId, target] of Object.entries(votes)) {
    tally[target] = (tally[target] || 0) + 1;
  }
  return tally;
}

function determineOutcome(votes, murdererName) {
  if (!Object.keys(votes).length) {
    return { outcome: "no_votes", description: "无人投票，真相永远成谜。" };
  }

  const tally = {};
  for (const target of Object.values(votes)) {
    tally[target] = (tally[target] || 0) + 1;
  }

  // 找最高票
  let top = { name: "", count: 0, tie: false };
  for (const [name, count] of Object.entries(tally)) {
    if (count > top.count) { top = { name, count, tie: false }; }
    else if (count === top.count) { top.tie = true; }
  }

  if (top.tie) {
    return { outcome: "tie", description: "票数平局，凶手趁乱逃脱..." };
  }

  if (top.name === murdererName) {
    return { outcome: "true_accusation", description: `玩家成功指认真凶——${murdererName}！正义得以伸张。` };
  } else {
    return {
      outcome: "wrong_accusation",
      description: `玩家指认了 ${top.name}，但真正的凶手是 ${murdererName}。真凶逍遥法外...`,
    };
  }
}

module.exports = {
  PHASES, PHASE_CONFIG,
  getPhaseConfig, getNextPhase, getPhaseRound,
  canAdvancePhase, validateAction,
  getAvailableCluesForPlayer, pickRandomClue,
  tallyVotes, determineOutcome,
};
