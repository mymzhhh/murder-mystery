// 单元测试：**本轮**可搜证地点池（buildRoundSearchLocations）。
//
// 背景（2026-10-17）：`buildSearchLocations` 只看"线索的地点"，不知道轮次；
// 于是调用方分裂成两种写法 —— ai-player / auto-search 先按 round 过滤线索（对的），
// 而 routes/player 的地点列表与 socket 里对客户端传参的校验直接把**全部**线索丢进去。
// 后者会把下一轮的地点也摆出来/也认成合法，玩家选了必然空手（白耗一次配额）。
// 实测可复现的形态：导入的真实剧本《吉普赛女郎之死（再见卡门）》
// 第一轮只有 5 个地点（唐·何塞随身/米里奥随身/旅人随身/占卜师随身/卡门帐篷），
// 第二轮另有 2 个（卡门尸体/营地第二现场）—— 旧口径会把 7 个全列进第一轮。
//
// 所以把口径收敛成一个函数，调用方只许用它；本测试钉住它的四条语义。
const test = require("node:test");
const assert = require("node:assert");
const { buildRoundSearchLocations, buildSearchLocations } = require("../../src/game/search-locations");

// 真实剧本的线索分布（按地点与轮次）
const CLUES = [
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: `A${i}`, location: "占卜师随身", round: 1 })),
  ...[1, 2, 3, 4, 5].map((i) => ({ id: `A${i + 10}`, location: "唐·何塞随身", round: 1 })),
  ...[1, 2, 3, 4, 5].map((i) => ({ id: `B${i}`, location: "卡门尸体", round: 2 })),
  ...[1, 2, 3].map((i) => ({ id: `B${i + 10}`, location: "营地第二现场", round: 2 })),
  { id: "B20", location: "卡门帐篷", round: 1 },
];

test("第一轮：只列本轮有货的地点，下一轮的地点不得出现", () => {
  const locs = buildRoundSearchLocations(CLUES, 1);
  assert.deepStrictEqual(locs, ["占卜师随身", "唐·何塞随身", "卡门帐篷"],
    "第一轮的地点池必须只含本轮线索的地点");
  assert.ok(!locs.includes("卡门尸体"), "第二轮的「卡门尸体」不得出现在第一轮");
  assert.ok(!locs.includes("营地第二现场"), "第二轮的「营地第二现场」不得出现在第一轮");
});

test("第二轮：只列第二轮的地点（第一轮地点不再列，因为它们已经没货了）", () => {
  const locs = buildRoundSearchLocations(CLUES, 2);
  assert.deepStrictEqual(locs, ["卡门尸体", "营地第二现场"]);
});

test("回归对照：旧口径（不筛轮次）会把两轮的地点混在一起 —— 这就是当时的 bug", () => {
  const all = buildSearchLocations(CLUES);
  assert.strictEqual(all.length, 5, "全部线索归纳出 5 个地点");
  assert.ok(all.includes("卡门尸体"), "旧口径在第一轮也会列出「卡门尸体」——玩家点了必然空手");
});

test("round <= 0 / 非法值时不筛，保持原行为（非搜证阶段不该把列表清空）", () => {
  const all = buildSearchLocations(CLUES);
  for (const r of [0, -1, null, undefined, NaN, ""]) {
    assert.deepStrictEqual(buildRoundSearchLocations(CLUES, r), all, `round=${String(r)} 时不应筛`);
  }
});

test("脏输入不抛：线索为空/非数组/条目缺字段", () => {
  assert.deepStrictEqual(buildRoundSearchLocations([], 1), []);
  assert.deepStrictEqual(buildRoundSearchLocations(null, 1), []);
  assert.deepStrictEqual(buildRoundSearchLocations(undefined, 2), []);
  assert.deepStrictEqual(buildRoundSearchLocations([{ location: "大堂", round: 1 }, {}, null], 1), ["大堂"]);
});
