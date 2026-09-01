// 单元测试：游戏引擎纯逻辑层（无需 Redis / PG / 网络）
// 运行：npm test   （node --test tests/）
const test = require("node:test");
const assert = require("node:assert");

const {
  getPhaseConfig, getNextPhase, getPhaseRound,
  validateAction,
  getAvailableCluesForPlayer, pickRandomClue, searchClues,
  tallyVotes, determineOutcome,
} = require("../modules/game-engine");

// ==================== 阶段状态机 ====================

test("getNextPhase 顺序推进", () => {
  assert.equal(getNextPhase("lobby"), "reading");
  assert.equal(getNextPhase("reading"), "intro");
  assert.equal(getNextPhase("intro"), "round1_investigation");
  assert.equal(getNextPhase("round3"), "voting");
  assert.equal(getNextPhase("voting"), "truth_reveal");
  assert.equal(getNextPhase("truth_reveal"), "finished");
  assert.equal(getNextPhase("finished"), null);
  assert.equal(getNextPhase("不存在的阶段"), null);
});

test("getPhaseRound 轮次识别", () => {
  assert.equal(getPhaseRound("round1_investigation"), 1);
  assert.equal(getPhaseRound("round2_discussion"), 2);
  assert.equal(getPhaseRound("round3"), 3);
  assert.equal(getPhaseRound("voting"), 0);
});

test("getPhaseConfig 各阶段行为配置", () => {
  assert.equal(getPhaseConfig("reading").allowChat, false);
  // 开场介绍：可聊天、不可搜证/投票
  assert.equal(getPhaseConfig("intro").label, "开场介绍");
  assert.equal(getPhaseConfig("intro").allowChat, true);
  assert.equal(getPhaseConfig("intro").allowClueReq, false);
  assert.equal(getPhaseConfig("intro").allowVote, false);
  assert.equal(getPhaseConfig("round1_investigation").allowClueReq, true);
  assert.equal(getPhaseConfig("voting").allowVote, true);
  // 未知阶段回退 lobby
  assert.equal(getPhaseConfig("nope").label, "等待开始");
});

// ==================== 行为校验 ====================

function mkPlayer(playerId, extra = {}) {
  return { playerId, characterName: "角色A", connected: true, ...extra };
}

test("validateAction：发言权限随阶段变化", () => {
  const players = [mkPlayer("p1")];
  const ok = validateAction("send_chat", { phase: "round1_discussion", players }, "p1");
  assert.equal(ok.ok, true);
  const fail = validateAction("send_chat", { phase: "reading", players }, "p1");
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "WRONG_PHASE");
});

test("validateAction：投票仅在投票阶段", () => {
  const players = [mkPlayer("p1")];
  assert.equal(validateAction("cast_vote", { phase: "voting", players }, "p1").ok, true);
  assert.equal(validateAction("cast_vote", { phase: "round3", players }, "p1").ok, false);
});

test("validateAction：DM 专属操作非 DM 拒绝", () => {
  const players = [mkPlayer("p1")];
  const r = validateAction("reveal_truth", { phase: "truth_reveal", players }, "p1");
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_DM");
  const dm = validateAction("reveal_truth", { phase: "truth_reveal", players: [mkPlayer("dm1", { isDM: true })] }, "dm1");
  assert.equal(dm.ok, true);
});

test("validateAction：玩家必须存在于房间", () => {
  const r = validateAction("send_chat", { phase: "lobby", players: [] }, "ghost");
  assert.equal(r.ok, false);
  assert.equal(r.error, "PLAYER_NOT_FOUND");
});

// ==================== 线索 ====================

const clues = [
  { id: "A1", content: "书桌抽屉里有把生锈的钥匙", location: "书房", round: 1 },
  { id: "A2", content: "花园里埋着一封信", location: "花园", round: 1 },
  { id: "B1", content: "壁炉里的灰烬", location: "客厅", round: 2 },
];

test("getAvailableCluesForPlayer：按轮次过滤 + 已找到的不可用", () => {
  const round1 = getAvailableCluesForPlayer(clues, "p1", 1);
  assert.equal(round1.length, 2);
  const withFound = [clues[0], { ...clues[1], foundBy: ["p9"] }];
  const available = getAvailableCluesForPlayer(withFound, "p1", 1);
  assert.deepEqual(available.map(c => c.id), ["A1"]);
});

test("pickRandomClue：空列表返回 null", () => {
  assert.equal(pickRandomClue([]), null);
});

test("searchClues：地点精确匹配优先", () => {
  const r = searchClues("书房", clues);
  assert.equal(r.matchLevel, "exact");
  assert.equal(r.clue.id, "A1");
});

test("searchClues：内容关键词部分匹配", () => {
  const r = searchClues("钥匙", clues);
  assert.ok(r.clue && r.clue.id === "A1");
});

test("searchClues：纯停用词查询随机给一条", () => {
  const r = searchClues("调查 搜索 检查", clues);
  assert.equal(r.matchLevel, "random");
  assert.ok(r.clue);
});

test("searchClues：空查询返回 none", () => {
  const r = searchClues("", clues);
  assert.equal(r.matchLevel, "none");
  assert.equal(r.clue, null);
});

test("searchClues：无线索时返回 none", () => {
  const r = searchClues("书房", []);
  assert.equal(r.matchLevel, "none");
  assert.equal(r.clue, null);
});

// ==================== 投票判定 ====================

test("determineOutcome：无人投票", () => {
  const r = determineOutcome({}, "凶手A");
  assert.equal(r.outcome, "no_votes");
});

test("determineOutcome：成功指认真凶", () => {
  const r = determineOutcome({ p1: "凶手A", p2: "凶手A", p3: "路人B" }, "凶手A");
  assert.equal(r.outcome, "true_accusation");
});

test("determineOutcome：误指认", () => {
  const r = determineOutcome({ p1: "路人B", p2: "路人B", p3: "凶手A" }, "凶手A");
  assert.equal(r.outcome, "wrong_accusation");
});

test("determineOutcome：平局", () => {
  const r = determineOutcome({ p1: "凶手A", p2: "路人B" }, "凶手A");
  assert.equal(r.outcome, "tie");
});

test("tallyVotes 聚合票数", () => {
  const t = tallyVotes({ p1: "A", p2: "B", p3: "A" }, []);
  assert.deepEqual(t, { A: 2, B: 1 });
});