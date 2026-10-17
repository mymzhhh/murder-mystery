// 游戏引擎 — 纯逻辑层：阶段状态机、线索分配、投票判定

// 阶段顺序。
// 注意：intro（自我介绍）已从流程中移除 —— 玩家不会认真填那个表单，自我介绍本来就该
// 发生在讨论阶段由各人自己开口。AI 的开场白改为在 reading 阶段**预备**、round1 开始时发出
// （见 ai-player.js），这样既不占用玩家的等待时间，也把 LLM 调用挪出了 round1 的拥塞点。
const PHASES = [
  "lobby",
  "reading",
  "round1",
  "round2",
  "voting",
  "truth_reveal",
  "finished",
];

/** 已废弃阶段 → 它的下一站。部署瞬间还停在 intro 的旧房间靠它安全驶出，不会卡死。 */
const LEGACY_NEXT = { intro: "round1" };

/**
 * 阶段兜底时长（超时后由 AI DM 接管推进）。
 * ⚠️ 放在这里而不是留在 socket/game.js：ai-player 要用它算"一轮里 AI 能轮几次"
 * （见 buildTurnPlan），两处各写一份环境变量迟早会漂移，而漂移的后果是
 * "AI 的出手节奏"与"阶段实际长度"对不上（后半段安排的动作根本来不及执行）。
 */
const PHASE_DEADLINE_MS = Math.max(60 * 1000, (Number(process.env.PHASE_MAX_WAIT_MIN || 10) || 10) * 60 * 1000);

const PHASE_CONFIG = {
  lobby:     { label: "等待开始",         allowClueReq: false, allowChat: true,  allowVote: false },
  reading:   { label: "阅读剧本",         allowClueReq: false, allowChat: false, allowVote: false },
  // intro 已不在流程里，但配置必须保留：旧房间的 phase 字段可能仍是 "intro"，
  // getPhaseConfig 一旦回退到 lobby 就会把 allowChat 变成 true，权限判定会前后不一致。
  intro:     { label: "自我介绍",         allowClueReq: false, allowChat: true,  allowVote: false },
  round1:    { label: "第一轮搜证与讨论", allowClueReq: true,  allowChat: true,  allowVote: false },
  round2:    { label: "第二轮搜证与讨论", allowClueReq: true,  allowChat: true,  allowVote: false },
  voting:    { label: "投票阶段",         allowClueReq: false, allowChat: true,  allowVote: true  },
  truth_reveal: { label: "真相揭露",      allowClueReq: false, allowChat: true,  allowVote: false },
  finished:  { label: "游戏结束",         allowClueReq: false, allowChat: true,  allowVote: false },
};

function getPhaseConfig(phase) {
  return PHASE_CONFIG[phase] || PHASE_CONFIG.lobby;
}

/**
 * 哪些阶段必须有"兜底推进"计时器（超时后由 AI DM 接管强制推进）。
 *
 * 为什么把它放这里而不是留在 socket 层的字面量里：这条保证曾经**只写在注释里**
 * （"两者都保留 10 分钟的阶段兜底，确保任何情况下都不会永久卡住"），
 * 而 socket/game.js 的白名单恰好漏了 voting —— 实测就有房间因此**永久**停在投票页：
 * 玩家一个可点对象都没有（AI 补位角色被前端过滤掉），投票阶段又没有任何兜底。
 * 现在它是一条可被单测钉住的规则，而不是一句注释。
 *
 * 判据：凡是"需要等玩家动作才能推进、且没有自动完成条件"的阶段都要在列。
 * lobby 不需要（还没开局）；truth_reveal / finished 是终态，没有下一站也不该被推进。
 */
const PHASES_NEEDING_DEADLINE = ["reading", "intro", "round1", "round2", "voting"];
function needsPhaseDeadline(phase) {
  return PHASES_NEEDING_DEADLINE.includes(phase);
}

function getNextPhase(current) {
  if (LEGACY_NEXT[current]) return LEGACY_NEXT[current];
  const idx = PHASES.indexOf(current);
  if (idx < 0 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

function getPhaseRound(phase) {
  if (phase === "round1") return 1;
  if (phase === "round2") return 2;
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

// ==================== 线索可见性 ====================
//
// 改造前：线索一被发现就 io.to(roomCode) 广播给全场 —— 没有藏线索、没有选择性透露，
// 剧本杀最核心的信息博弈整层塌缩成"六个人合作解题"。
//
// 现在线索默认只有发现者可见，另有两条扩大范围的路：
//   revealed   —— 发现者主动公开给全场
//   sharedWith —— 发现者单独给某个人看
// 这三条是**唯一**的可见来源。AI 知识构建与复盘都复用这里的判定，
// 否则两边口径一旦不一致，就会出现"AI 看到了玩家看不到的线索"这类穿帮。

/**
 * 这条线索对某位玩家是否可见。
 * @param {object} clue 至少含 foundBy / sharedWith / revealed
 * @param {string} playerId
 */
function canSeeClue(clue, playerId) {
  if (!clue || !playerId) return false;
  if (clue.revealed) return true;
  if ((clue.foundBy || []).includes(playerId)) return true;
  if ((clue.sharedWith || []).includes(playerId)) return true;
  return false;
}

/** 该玩家可见的全部线索 */
function visibleClues(clues, playerId) {
  return (clues || []).filter(c => canSeeClue(c, playerId));
}

/**
 * 线索对该玩家的可见类型，供前端分组显示与按钮控制。
 * @returns {"mine"|"public"|"shared"|"hidden"}
 */
function clueVisibilityOf(clue, playerId) {
  if (!clue) return "hidden";
  if ((clue.foundBy || []).includes(playerId)) return "mine";
  if (clue.revealed) return "public";
  if ((clue.sharedWith || []).includes(playerId)) return "shared";
  return "hidden";
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
  getPhaseConfig, getNextPhase, getPhaseRound,
  needsPhaseDeadline, PHASES_NEEDING_DEADLINE, PHASE_DEADLINE_MS,
  validateAction,
  canSeeClue, visibleClues, clueVisibilityOf,
  tallyVotes, determineOutcome,
};
