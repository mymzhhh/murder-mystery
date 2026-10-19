// 隐藏线索的两条口径必须分得清（用户明确要求，2026-10-19）：
//   · 正常对局：隐藏子线索**不进搜证池**，玩家必须自己「深入调查」才拿到；
//   · 测试局（管理端测试运行，走 game/auto-search）：直接把全部线索摊开，包括隐藏的。
// 这两条口径一旦混了，要么机制形同虚设（不用挖就白拿），要么测试报告永远缺一块。
const test = require("node:test");
const assert = require("node:assert");
const { availableClues, cluesAtLocation } = require("../../src/game/search-locations.js");

const CLUES = [
  { id: "A1", round: 1, location: "大堂", diggable: true },
  { id: "A2", round: 1, location: "大堂", hiddenBehind: "A1" },   // 隐藏子线索
  { id: "A3", round: 1, location: "书房" },
  { id: "B1", round: 2, location: "大堂" },
];

test("正常对局：隐藏子线索不进池", () => {
  const ids = availableClues(CLUES, 1).map((c) => c.id);
  assert.deepStrictEqual(ids, ["A1", "A3"]);
  assert.ok(!ids.includes("A2"));
});

test("正常对局：按地点搜也搜不到隐藏子线索", () => {
  const ids = cluesAtLocation(CLUES, "大堂", 1).map((c) => c.id);
  assert.deepStrictEqual(ids, ["A1"]);
});

test("测试局：includeHidden 时全部摊开", () => {
  const ids = availableClues(CLUES, 1, { includeHidden: true }).map((c) => c.id);
  assert.deepStrictEqual(ids, ["A1", "A2", "A3"]);
  const atHall = cluesAtLocation(CLUES, "大堂", 1, { includeHidden: true }).map((c) => c.id);
  assert.deepStrictEqual(atHall, ["A1", "A2"]);
});

test("includeHidden 不影响轮次过滤", () => {
  const ids = availableClues(CLUES, 1, { includeHidden: true }).map((c) => c.id);
  assert.ok(!ids.includes("B1"), "第二轮线索不该出现在第一轮");
});

test("已发现的线索两种口径下都不再出现", () => {
  const found = CLUES.map((c) => (c.id === "A1" ? { ...c, foundBy: ["p1"] } : c));
  assert.ok(!availableClues(found, 1).map((c) => c.id).includes("A1"));
  assert.ok(!availableClues(found, 1, { includeHidden: true }).map((c) => c.id).includes("A1"));
});

test("auto-search 必须显式开启 includeHidden（否则测试局会漏掉隐藏线索）", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../../src/game/auto-search.js"), "utf8");
  assert.ok(/includeHidden:\s*true/.test(src), "测试局扫证要显式 includeHidden: true");
  const ai = fs.readFileSync(path.join(__dirname, "../../src/game/ai-player.js"), "utf8");
  assert.ok(!/includeHidden/.test(ai), "正常对局的 AI 搜证不得开启 includeHidden");
});
