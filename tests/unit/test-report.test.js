// 测试报告（自动判定）单测
//
// 这个判定最容易写错的地方是**把"没搜完"当成"线索不可达"** ——
// 两件事的后果完全不同：前者是"测试没跑够"，后者是"剧本有缺陷"。
// 机制依据：AI 会一直搜证到**本轮线索池为空**才停（ai-player 的 actInvestigate），
// 所以只有**已搜空**那轮里仍未发现的线索，才配得上"很可能不可达"这个结论。
const test = require("node:test");
const assert = require("node:assert");
const { buildTestReport } = require("../../src/game/test-report");

const clue = (id, round, found) => ({ id, round, location: "档案室", content: `线索内容 ${id}`, foundBy: found ? ["p1"] : [] });
const base = (over = {}) => ({
  roomCode: "AAAAAA", title: "测试剧本", scriptSessionId: "s1",
  startedAt: 1000, endedAt: 61000, phaseMinutes: 1,
  phases: [{ phase: "reading", at: 0 }, { phase: "round1", at: 30000 }],
  clues: [], aiNames: ["甲", "乙"], turns: { 甲: { speak: 2, total: 2 }, 乙: { ask: 1, total: 1 } },
  errors: [], votes: {}, murdererName: "甲", truthRevealed: true, reason: "completed",
  ...over,
});

test("没搜空的轮次不下『不可达』结论；全部搜空且人人出手才是 clean", () => {
  const r = buildTestReport(base({
    clues: [clue("A1", 1, true), clue("A2", 1, true), clue("A3", 1, false)],
  }));
  assert.strictEqual(r.rounds[0].swept, false, "本轮 3 条只找到 2 条，不算搜空");
  // 搜空 = 全部找到；这里没搜空，所以不能下"不可达"的结论
  assert.strictEqual(r.unreachable.length, 0);
  assert.strictEqual(r.verdict, "inconclusive");

  // 反过来：本轮线索**全部找到**时（搜空）不存在"未发现"，也就没有不可达
  const all = buildTestReport(base({ clues: [clue("A1", 1, true), clue("A2", 1, true)] }));
  assert.strictEqual(all.rounds[0].swept, true);
  assert.strictEqual(all.verdict, "clean");
});

test("已搜空那轮里仍未发现的线索才进 unreachable —— 这是唯一会判 issue 的来源", () => {
  // 造一个"搜空"的轮：pool 里被发现的条数 == pool 条数，且另有一条属于该轮但没被发现 —— 不可能同时成立，
  // 所以真实语义是：**只有部分轮搜空**时，未发现的那些属于"没搜空的那一轮"。
  // 因此单轮场景下 unreachable 恒为空；跨轮才可能出现（第 1 轮空了、第 2 轮里没搜到的仍是第 2 轮的事）。
  const r = buildTestReport(base({
    clues: [clue("A1", 1, true), clue("B1", 2, false)],
  }));
  assert.strictEqual(r.rounds.find(x => x.round === 1).swept, true);
  assert.strictEqual(r.rounds.find(x => x.round === 2).swept, false);
  assert.deepStrictEqual(r.notSwept, [2]);
  assert.strictEqual(r.verdict, "inconclusive", "第 2 轮没搜完 → 结论必须是不确定，不能报 issue");
});

test("零出手的 AI：没有异常记录 → error 级；有异常记录 → 降级为 warn（可能是异常导致）", () => {
  const silent = buildTestReport(base({ turns: { 甲: { speak: 1, total: 1 } } }));
  assert.deepStrictEqual(silent.silentAi, ["乙"]);
  assert.strictEqual(silent.verdict, "issue");
  assert.ok(silent.findings.some(f => f.code === "silent_ai" && f.level === "error"));

  const withErr = buildTestReport(base({
    turns: { 甲: { speak: 1, total: 1 } },
    errors: [{ at: 1, name: "乙", kind: "turn", message: "LLM 超时" }],
  }));
  assert.ok(withErr.findings.some(f => f.code === "silent_ai_with_errors" && f.level === "warn"));
  assert.ok(!withErr.findings.some(f => f.code === "silent_ai" && f.level === "error"));
});

test("停在 reading 的一局不算『零出手』（谁都没说话是正常的）", () => {
  const r = buildTestReport(base({
    phases: [{ phase: "reading", at: 0 }], turns: {}, clues: [],
  }));
  assert.deepStrictEqual(r.silentAi, []);
  assert.strictEqual(r.verdict, "clean");
});

test("投票结局用游戏自己的判定函数重算（口径一致）", () => {
  const ok = buildTestReport(base({ votes: { p1: "甲", p2: "甲", p3: "乙" } }));
  assert.strictEqual(ok.voting.outcome, "true_accusation");
  assert.strictEqual(ok.voting.accusedCorrectly, true);

  const wrong = buildTestReport(base({ votes: { p1: "乙", p2: "乙" } }));
  assert.strictEqual(wrong.voting.outcome, "wrong_accusation");
  assert.strictEqual(wrong.voting.accusedCorrectly, false);

  const none = buildTestReport(base({ votes: {} }));
  assert.strictEqual(none.voting.outcome, "no_votes");
});

test("提前结束的局会带上 partial_run 提示，结论只覆盖已跑完的阶段", () => {
  const r = buildTestReport(base({ reason: "stopped" }));
  assert.ok(r.findings.some(f => f.code === "partial_run" && f.level === "info"));
});

test("线索统计与阶段流水都进报告（UI 要用）", () => {
  const r = buildTestReport(base({
    clues: [clue("A1", 1, true), clue("A2", 1, true), clue("B1", 2, false)],
  }));
  assert.strictEqual(r.clueTotal, 3);
  assert.strictEqual(r.clueFound, 2);
  assert.strictEqual(r.durationMs, 60000);
  assert.strictEqual(r.phases.length, 2);
  assert.strictEqual(r.phaseMinutes, 1);
});

test("票型按角色名汇总，不出现内部 playerId（管理员看不懂 ai_XXXX_某某）", () => {
  const r = buildTestReport(base({
    votes: { ai_E7_何秀云: "宋砚生", ai_E7_宋砚生: "陈国斌", ai_E7_文小满: "宋砚生" },
    voters: { ai_E7_何秀云: "何秀云", ai_E7_宋砚生: "宋砚生", ai_E7_文小满: "文小满" },
  }));
  assert.deepStrictEqual(r.voting.tally, { 宋砚生: 2, 陈国斌: 1 });
  // 2026-10-22：byVoter 增加 reason 字段（用户要求报告能说明"每个 AI 为什么投这个人"）
  assert.deepStrictEqual(r.voting.byVoter, [
    { voter: "何秀云", target: "宋砚生", reason: "" },
    { voter: "宋砚生", target: "陈国斌", reason: "" },
    { voter: "文小满", target: "宋砚生", reason: "" },
  ]);
  const shown = JSON.stringify(r.voting.byVoter) + JSON.stringify(r.voting.tally);
  assert.ok(!shown.includes("ai_E7_"), "内部 id 不能出现在给管理员看的字段里");
});