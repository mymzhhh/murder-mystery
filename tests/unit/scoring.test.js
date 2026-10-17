// 结算给分测试
//
// 关键契约：分数必须完全由可观测事实决定（投票/阵营/线索/发言），同样的局永远同样的分。
// 一旦引入 LLM 判断，玩家会觉得"凭什么"，比没有分更糟 —— 所以这里连"不依赖网络"都要钉住。
const test = require("node:test");
const assert = require("node:assert");

const { computeScores, POINTS } = require("../../src/game/scoring");

const PLAYERS = [
  { playerId: "p1", characterName: "张三", playerName: "alice" },
  { playerId: "p2", characterName: "李四", playerName: "bob" },
  { playerId: "p3", characterName: "王五", playerName: "carol", isAI: true },
];
const MURDERER = "李四";

// ==================== 阵营判定 ====================

test("凶手被投出：玩家阵营获胜", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "李四", p3: "李四" }, murdererName: MURDERER });
  assert.strictEqual(r.murdererEscaped, false);
  assert.strictEqual(r.winner, "players");
});

test("凶手未被投出：凶手脱身", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "张三", p3: "张三" }, murdererName: MURDERER });
  assert.strictEqual(r.murdererEscaped, true);
  assert.strictEqual(r.winner, "murderer");
});

test("平局不算凶手被抓（与 determineOutcome 的口径一致）", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "李四", p2: "张三" }, murdererName: MURDERER });
  assert.strictEqual(r.murdererEscaped, true, "票数平局时凶手趁乱逃脱");
});

// ==================== 个人判定 ====================

test("投中真凶得基础分并标记'指认正确'", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "李四" }, murdererName: MURDERER });
  const p1 = r.board.find(x => x.playerId === "p1");
  assert.strictEqual(p1.verdict, "指认正确");
  assert.strictEqual(p1.breakdown.result, POINTS.VOTE_HIT);
});

test("投错人不得基础分并标记'指认错误'", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "张三" }, murdererName: MURDERER });
  const p1 = r.board.find(x => x.playerId === "p1");
  assert.strictEqual(p1.verdict, "指认错误");
  assert.strictEqual(p1.breakdown.result, 0);
});

test("未投票标记'未投票'且不得基础分", () => {
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER });
  const p1 = r.board.find(x => x.playerId === "p1");
  assert.strictEqual(p1.verdict, "未投票");
  assert.strictEqual(p1.breakdown.result, 0);
});

test("凶手脱身拿凶手分，落网则 0", () => {
  const escaped = computeScores({ players: PLAYERS, votes: { p1: "张三" }, murdererName: MURDERER })
    .board.find(x => x.playerId === "p2");
  assert.strictEqual(escaped.verdict, "凶手脱身");
  assert.strictEqual(escaped.breakdown.result, POINTS.MURDERER_ESCAPE);

  const caught = computeScores({ players: PLAYERS, votes: { p1: "李四", p3: "李四" }, murdererName: MURDERER })
    .board.find(x => x.playerId === "p2");
  assert.strictEqual(caught.verdict, "凶手落网");
  assert.strictEqual(caught.breakdown.result, 0);
});

test("凶手身份被正确标出", () => {
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER });
  assert.strictEqual(r.board.filter(x => x.isMurderer).length, 1);
  assert.strictEqual(r.board.find(x => x.isMurderer).name, "李四");
});

// ==================== 参与分 ====================

test("线索分按条累加并封顶", () => {
  const clues = Array.from({ length: 10 }, (_, i) => ({ id: `C${i}`, foundBy: ["p1"] }));
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER, clues });
  const p1 = r.board.find(x => x.playerId === "p1");
  assert.strictEqual(p1.clueCount, 10);
  assert.strictEqual(p1.breakdown.clue, POINTS.CLUE_CAP, "应封顶而不是无限累加");
});

test("发言分按次累加并封顶", () => {
  const chat = Array.from({ length: 20 }, () => ({ playerId: "p1", content: "x" }));
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER, chatMessages: chat });
  const p1 = r.board.find(x => x.playerId === "p1");
  assert.strictEqual(p1.breakdown.speech, POINTS.SPEECH_CAP);
});

test("线索分归属到发现者，不摊给别人", () => {
  const clues = [{ id: "C1", foundBy: ["p1"] }];
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER, clues });
  assert.strictEqual(r.board.find(x => x.playerId === "p1").clueCount, 1);
  assert.strictEqual(r.board.find(x => x.playerId === "p2").clueCount, 0);
});

// ==================== 排序与容错 ====================

test("按总分降序排列", () => {
  const r = computeScores({
    players: PLAYERS,
    votes: { p1: "李四" },
    murdererName: MURDERER,
    clues: [{ id: "C1", foundBy: ["p3"] }],
  });
  const totals = r.board.map(x => x.total);
  assert.deepStrictEqual(totals, [...totals].sort((a, b) => b - a));
});

test("没有角色的玩家（未选角）不进榜", () => {
  const r = computeScores({
    players: [...PLAYERS, { playerId: "p9", playerName: "dave", characterName: "" }],
    votes: {}, murdererName: MURDERER,
  });
  assert.strictEqual(r.board.length, 3);
});

test("AI/NPC 也进榜并标记 isAI", () => {
  const r = computeScores({ players: PLAYERS, votes: {}, murdererName: MURDERER });
  assert.strictEqual(r.board.find(x => x.playerId === "p3").isAI, true);
});

test("空输入不抛异常", () => {
  assert.doesNotThrow(() => computeScores());
  assert.doesNotThrow(() => computeScores({}));
  const r = computeScores({});
  assert.deepStrictEqual(r.board, []);
  assert.strictEqual(r.winner, "unknown");
});

test("没有凶手名时不误判任何人", () => {
  const r = computeScores({ players: PLAYERS, votes: { p1: "张三" }, murdererName: "" });
  assert.strictEqual(r.board.every(x => !x.isMurderer), true);
  assert.strictEqual(r.winner, "unknown");
});

test("打分是纯函数：同样输入永远同样输出", () => {
  const input = { players: PLAYERS, votes: { p1: "李四" }, murdererName: MURDERER, clues: [{ id: "C1", foundBy: ["p1"] }] };
  assert.deepStrictEqual(computeScores(input), computeScores(input));
});
