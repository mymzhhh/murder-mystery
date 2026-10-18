// 线索地点兜底：空 location 的线索在游戏里永远搜不到，必须补上。
const test = require("node:test");
const assert = require("node:assert");
const { fillMissingClueLocations, looksLikeTestimony } = require("../../src/script/clue-locations.js");

test("有地点的线索一律不动（只 trim）", () => {
  const { clues, filled } = fillMissingClueLocations(
    [{ content: "菜刀上有指纹", location: "  厨房/餐厅  " }], {});
  assert.strictEqual(clues[0].location, "厨房/餐厅");
  assert.strictEqual(filled.length, 0);
});

test("空地点 + 内容是『某某说：』→ 补成「证言」", () => {
  const src = [
    { content: "李会计说：21:50 赵守义在对账室跟我说，这个月奖金全扣了。", location: "" },
    { content: "王护士称：22:00 我在铺内客厅。", location: "" },
  ];
  const { clues, filled } = fillMissingClueLocations(src, {});
  assert.deepStrictEqual(clues.map((c) => c.location), ["证言", "证言"]);
  assert.strictEqual(filled.length, 2);
  assert.strictEqual(filled[0].reason, "证言类线索");
});

test("空地点但内容提到布局地点 → 用该地点", () => {
  const { clues } = fillMissingClueLocations(
    [{ content: "维修间的铜锤上有血迹", location: "" }],
    { places: ["铺内客厅", "维修间", "储物间"] });
  assert.strictEqual(clues[0].location, "维修间");
});

test("既无证言特征也无地点线索 → 落到兜底地点（不能留空）", () => {
  const { clues, filled } = fillMissingClueLocations(
    [{ content: "一枚刻着 hb 的纽扣", location: "" }], { fallback: "现场" });
  assert.strictEqual(clues[0].location, "现场");
  assert.strictEqual(filled[0].reason, "无可用依据，用兜底地点");
});

test("真实回归：6 条空地点线索必须全部补上（否则玩家少拿 14% 线索）", () => {
  const src = Array.from({ length: 44 }, (_, i) => ({
    content: i < 6 ? `某人说：${20 + i}:00 我在场` : `第 ${i} 条物证`,
    location: i < 6 ? "" : `地点${i % 5}`,
  }));
  const { clues } = fillMissingClueLocations(src, { places: ["地点1", "地点2"] });
  const empty = clues.filter((c) => !String(c.location || "").trim());
  assert.strictEqual(empty.length, 0, "补完之后不允许还有空地点");
});

test("证言特征识别", () => {
  assert.ok(looksLikeTestimony("张裁缝说：22:10 我已经离开"));
  assert.ok(!looksLikeTestimony("22:10 我已经离开修表铺"));
});

test("空输入不炸", () => {
  assert.deepStrictEqual(fillMissingClueLocations(null, {}).clues, []);
  assert.deepStrictEqual(fillMissingClueLocations([], {}).clues, []);
});
