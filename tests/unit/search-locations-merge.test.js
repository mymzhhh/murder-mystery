// 搜证地点归纳：**不许把线索挤出可搜范围**
//
// 实测缺陷（报告 20 / 房间 XGFQWQ）：地点列表由"每条线索的发现地点"归纳、上限 24，
// 而 36 条线索给出了 26 个不同地点 → slice 截掉最后 2 个 →
//   B4「二层操作平台地面」、B9「二层操作平台尸体旁」**谁都搜不到**（真人玩家也一样），
// 而 AI 侧每轮还报"剩余 0"、报告却是 clueFound 34/36。
// 根因是"兄弟位置"没被并到共同父名：`二层操作平台楼梯口` 与 `二层操作平台地面` 互不包含，
// 而父名「二层操作平台」压根不在列表里。
const test = require("node:test");
const assert = require("node:assert");
const { buildSearchLocations, mergeSublocations, cluesAtLocation, matchLocation, MAX_LOCATIONS } = require("../../src/game/search-locations");

/** 糖厂那本真实的 26 个地点（从库里取的原样字符串，顺序也一样） */
const REAL_26 = ["老黄证词", "陈丽休息室枕头底下", "赵磊工具袋", "王大春证词", "主控室桌面", "老周红袖章", "二层操作平台楼梯口", "陈丽证词", "王大春工装裤内侧", "林强更衣柜", "王大春工装裤口袋", "一层车间工具房维修台账", "老周证词", "林强外套口袋", "一层车间操作台日志", "老黄胶鞋口袋", "化验室尸检报告", "赵磊证词", "化验室资料柜", "一层车间工具房门口", "主控室抽屉", "二层操作平台栏杆", "二层操作平台蒸汽阀室", "主控室墙面", "二层操作平台地面", "二层操作平台尸体旁"];

test("子位置并入父地点：'书房桌面' 与 '书房' 只留一个", () => {
  const r = mergeSublocations(["书房桌面", "书房"]);
  assert.deepStrictEqual(r, ["书房"], "保留更短的（父地点）");
});

test("兄弟位置并到共同前缀：'二层操作平台*' 三个变体合成一个搜证点", () => {
  const r = mergeSublocations(["二层操作平台楼梯口", "二层操作平台地面", "二层操作平台尸体旁"]);
  assert.deepStrictEqual(r, ["二层操作平台"], "并到共同前缀，而不是散着三个互不相配的点");
});

test("安全底线：东厢房/西厢房、一楼大厅/二楼走廊 **不许** 并到一起", () => {
  assert.strictEqual(mergeSublocations(["东厢房", "西厢房"]).length, 2, "没有共同前缀 → 不并");
  assert.strictEqual(mergeSublocations(["一楼大厅", "二楼走廊"]).length, 2, "共同前缀只有 2 字（低于阈值）→ 不并");
  assert.strictEqual(matchLocation("东厢房", "西厢房"), false, "不同房间不能互相匹配");
});

test("真实数据：26 个地点归并后必须 ≤ 上限，且**每一条线索都还在可搜范围内**", () => {
  const merged = mergeSublocations(REAL_26);
  assert.ok(merged.length <= MAX_LOCATIONS, `归并后 ${merged.length} 个地点，必须不触上限 ${MAX_LOCATIONS}`);
  // 两个曾经搜不到的地点：必须能被某个搜证点匹配到
  for (const loc of ["二层操作平台地面", "二层操作平台尸体旁"]) {
    assert.ok(merged.some((x) => matchLocation(loc, x)), `${loc} 必须仍可被搜到`);
  }
  // 端到端的可达性：拿真实地点列表 + 一轮线索，所有线索都要落进某个池子
  const clues = REAL_26.map((loc, i) => ({ id: "C" + i, round: 1, location: loc }));
  const locs = buildSearchLocations(clues, "");
  const reach = new Set();
  for (const loc of locs) for (const c of cluesAtLocation(clues, loc, 1)) reach.add(c.id);
  assert.strictEqual(reach.size, clues.length, `每条线索都要可搜（实际 ${reach.size}/${clues.length}）`);
});

test("空输入不炸；去重后不出现重复项", () => {
  assert.deepStrictEqual(mergeSublocations([]), []);
  assert.deepStrictEqual(mergeSublocations(["厨房", "厨房"]), ["厨房"]);
});
