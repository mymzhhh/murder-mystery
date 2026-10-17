// 单元测试：游戏引擎纯逻辑层（无需 Redis / PG / 网络）
// 运行：npm test   （node --test tests/）
const test = require("node:test");
const assert = require("node:assert");

const {
  getPhaseConfig, getNextPhase, getPhaseRound,
  validateAction,
  tallyVotes, determineOutcome,
  needsPhaseDeadline, PHASES_NEEDING_DEADLINE,
} = require("../../src/game/game-engine");

// ==================== 阶段兜底计时器（防"永久卡住"）====================
// 回归：这条保证曾只写在 socket/game.js 的注释里，而那里的白名单漏了 voting，
// 结果实测有房间因投票页无可投对象而**永久**停在投票阶段。

test("needsPhaseDeadline：投票阶段必须有兜底（回归）", () => {
  assert.equal(needsPhaseDeadline("voting"), true,
    "投票阶段没有自动完成条件（靠全员投完+手动推进），不兜底就会永久卡住");
});

test("needsPhaseDeadline：所有'等玩家动作'的阶段都必须在列", () => {
  // 钉的是不变量而不是列表本身：将来加新阶段时，必须在 needsPhaseDeadline 里做出选择。
  const PHASES = ["lobby", "reading", "intro", "round1", "round2", "voting", "truth_reveal", "finished"];
  const terminal = ["lobby", "truth_reveal", "finished"];   // 未开局 / 终态：没有下一站也不该被推进
  const missing = PHASES.filter((p) => !terminal.includes(p) && !needsPhaseDeadline(p));
  assert.deepEqual(missing, [], `这些阶段没有兜底计时器，会永久卡住：${missing.join("、")}`);
});

test("needsPhaseDeadline：终态与未开局不武装计时器", () => {
  for (const p of ["lobby", "truth_reveal", "finished"]) {
    assert.equal(needsPhaseDeadline(p), false, `${p} 不该被推进`);
  }
  assert.equal(needsPhaseDeadline(undefined), false);
  assert.equal(needsPhaseDeadline("不存在的阶段"), false);
  assert.ok(PHASES_NEEDING_DEADLINE.includes("voting"), "导出常量里也要有 voting，便于复核");
});

// ==================== 阶段状态机 ====================

test("getNextPhase 顺序推进", () => {
  assert.equal(getNextPhase("lobby"), "reading");
  // 自我介绍阶段已移除：阅读完直接进第一轮搜证讨论
  assert.equal(getNextPhase("reading"), "round1");
  // 旧房间可能仍停在已废弃的 intro，必须能安全驶出而不是卡死
  assert.equal(getNextPhase("intro"), "round1");
  assert.equal(getNextPhase("round2"), "voting");
  assert.equal(getNextPhase("voting"), "truth_reveal");
  assert.equal(getNextPhase("truth_reveal"), "finished");
  assert.equal(getNextPhase("finished"), null);
  assert.equal(getNextPhase("不存在的阶段"), null);
});

test("getPhaseRound 轮次识别", () => {
  assert.equal(getPhaseRound("round1"), 1);
  assert.equal(getPhaseRound("round2"), 2);
  assert.equal(getPhaseRound("round2"), 2);
  assert.equal(getPhaseRound("voting"), 0);
});

test("getPhaseConfig 各阶段行为配置", () => {
  assert.equal(getPhaseConfig("reading").allowChat, false);
  // 自我介绍阶段已移除，但配置保留给旧房间用（否则会回退 lobby 造成权限判定前后不一致）
  assert.equal(getPhaseConfig("intro").label, "自我介绍");
  assert.equal(getPhaseConfig("intro").allowChat, true);
  assert.equal(getPhaseConfig("intro").allowClueReq, false);
  assert.equal(getPhaseConfig("intro").allowVote, false);
  assert.equal(getPhaseConfig("round1").allowClueReq, true);
  assert.equal(getPhaseConfig("round1").allowChat, true); // 合并阶段：可搜证也可聊天
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
  const ok = validateAction("send_chat", { phase: "round1", players }, "p1");
  assert.equal(ok.ok, true);
  const fail = validateAction("send_chat", { phase: "reading", players }, "p1");
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "WRONG_PHASE");
});

test("validateAction：投票仅在投票阶段", () => {
  const players = [mkPlayer("p1")];
  assert.equal(validateAction("cast_vote", { phase: "voting", players }, "p1").ok, true);
  assert.equal(validateAction("cast_vote", { phase: "round1", players }, "p1").ok, false);
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

// 线索搜证相关逻辑已从「文字匹配」改为「选地点」，实现在 game/search-locations.js，
// 对应测试见 tests/unit/search-locations.test.js 与 tests/unit/search-quota.test.js
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