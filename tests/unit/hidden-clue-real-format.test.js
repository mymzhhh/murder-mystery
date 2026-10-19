// 真本格式的隐藏线索：父线索「（发现隐藏线索，可深入调查）」+ 独立编号子线索「（通过深入调查 A6…获取）」
//
// 为什么重做（2026-10-18 核对 344 原文后）：第一版实现成"同一条线索里的附注字段"，
// 而真本的写法是**独立编号的子线索**（344 共 45 条 = 37 普通 + 8 隐藏），
// 且子线索平时不在搜证池里 —— 只有对父线索做「深入调查」才拿到。
// 这直接影响线索总数口径与搜证公平性，必须与真本一致。
const test = require("node:test");
const assert = require("node:assert");
const { parseScript } = require("../../src/script/script-parser.js");
const { availableClues, hiddenChildrenOf } = require("../../src/game/search-locations.js");

// 344 原文的真实片段（结构照抄，内容为示意）
const MD = [
  "## 第三部分：线索系统",
  "## 第一轮线索",
  "### A6：米里奥｜米里奥随身（第1轮）",
  "口袋里有一只空瓶。（发现隐藏线索，可深入调查）",
  "",
  "### A7：米里奥｜米里奥随身（第1轮）",
  "瓶壁上残留着微量红色粉末",
  "（通过深入调查 A6「口袋里有一只空瓶。」获取）",
  "",
  "### A8：米里奥｜米里奥随身（第1轮）",
  "一只破碎的怀表。",
  "",
].join("\n");

const parse = () => {
  const p = parseScript(MD);
  return [...(p.clues.round1 || []), ...(p.clues.round2 || [])];
};

test("父线索标记 diggable", () => {
  const a6 = parse().find((c) => c.id === "A6");
  assert.strictEqual(a6.diggable, true);
  assert.strictEqual(a6.hiddenBehind, "");
});

test("子线索标记 hiddenBehind=父编号", () => {
  const a7 = parse().find((c) => c.id === "A7");
  assert.strictEqual(a7.hiddenBehind, "A6", "A7 必须挂在 A6 下");
  assert.strictEqual(a7.diggable, false);
});

test("子线索不进普通搜证池（否则不用深入调查就白拿）", () => {
  const clues = parse().map((c) => ({ ...c, round: 1 }));
  const pool = availableClues(clues, 1).map((c) => c.id);
  assert.ok(pool.includes("A6"), "父线索正常可搜");
  assert.ok(pool.includes("A8"), "普通线索正常可搜");
  assert.ok(!pool.includes("A7"), "**子线索绝不能出现在搜证池里**");
});

test("hiddenChildrenOf 能按父编号捞出子线索", () => {
  const clues = parse().map((c) => ({ ...c, round: 1 }));
  assert.deepStrictEqual(hiddenChildrenOf(clues, "A6").map((c) => c.id), ["A7"]);
  assert.deepStrictEqual(hiddenChildrenOf(clues, "A1").map((c) => c.id), []);
});

test("没有隐藏标记的线索两个字段都为空/假", () => {
  const a8 = parse().find((c) => c.id === "A8");
  assert.strictEqual(a8.diggable, false);
  assert.strictEqual(a8.hiddenBehind, "");
});

test("旧格式（- 隐藏线索：字段）仍兼容解析", () => {
  const md = [
    "## 第三部分：线索系统",
    "## 第二轮线索",
    "### B3：",
    "- 线索类型：物证",
    "- 发现地点：维修间",
    "- 线索内容：电表箱内部的保险丝被人为切断。",
    "- 隐藏线索：电表箱内还有土制爆炸痕迹。",
    "",
  ].join("\n");
  const p = parseScript(md);
  const b3 = [...(p.clues.round1 || []), ...(p.clues.round2 || [])].find((c) => c.id === "B3");
  assert.ok(b3.hiddenContent.includes("土制爆炸"), "旧格式的隐藏正文仍要能解析出来");
});

test("旧格式（- 隐藏线索：字段）也要标成可挖掘", () => {
  // 有隐藏正文却没有标记的线索，如果不标 diggable，前端就不显示「深入调查」按钮，
  // 玩家永远拿不到那条隐藏线索 —— 实测《冬至钟影》5 条隐藏线索正是这种。
  const md = [
    "## 第三部分：线索系统",
    "## 第一轮线索",
    "### A3：乙｜大堂（第1轮）",
    "- 线索类型：物证",
    "- 发现地点：大堂",
    "- 线索内容：地板上有一道划痕。",
    "- 隐藏线索：划痕下藏着一枚铜钥匙。",
    "",
  ].join("\n");
  const p = parseScript(md);
  const a3 = [...(p.clues.round1 || []), ...(p.clues.round2 || [])].find((c) => c.id === "A3");
  assert.strictEqual(a3.diggable, true, "有隐藏正文就必须可挖掘");
  assert.ok(a3.hiddenContent.includes("铜钥匙"));
});
