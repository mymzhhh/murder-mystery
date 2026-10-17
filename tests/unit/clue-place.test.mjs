// 线索大地点归组测试
//
// 回归的是一个很隐蔽的坏法：旧实现拿一份写死的房间名清单（书房/卧室/厨房…）去匹配，
// 匹配不到就直接用原始字符串当分组名。而剧本房间是动态生成的 ——
// "御花园凉亭" 不在清单里，于是 "御花园凉亭（地面）" 和 "御花园凉亭（栏杆）"
// 各自成了独立分组。界面上看着有分组，实际每组建只有 1 条，等于没分。
import test from "node:test";
import assert from "node:assert";
import { parseCluePlace, groupCluesByPlace, clueCategoryStats, CATEGORY_ORDER } from "../../frontend/src/lib/clue-place.mjs";

// ==================== parseCluePlace ====================

test("剥掉括号里的细分位置，剩下的就是大地点", () => {
  const r = parseCluePlace("御花园凉亭（地面）");
  assert.strictEqual(r.label, "御花园凉亭");
  assert.strictEqual(r.sub, "地面");
  assert.strictEqual(r.cat, "地点");
});

test("半角括号同样处理", () => {
  const r = parseCluePlace("御花园凉亭(栏杆)");
  assert.strictEqual(r.label, "御花园凉亭");
  assert.strictEqual(r.sub, "栏杆");
});

test("动态生成的房间名（不在任何词表里）也能正确归组", () => {
  // 这正是旧实现失败的地方：没有词表可依赖
  assert.strictEqual(parseCluePlace("核心服务器机房（地面）").label, "核心服务器机房");
  assert.strictEqual(parseCluePlace("内廷采买记录（案头）").label, "内廷采买记录");
});

test("搜身线索按人归组：括号里是随身物件", () => {
  const r = parseCluePlace("赵恒（怀中玉珮）");
  assert.strictEqual(r.cat, "搜身物品");
  assert.strictEqual(r.label, "赵恒", "大地点是那个人，而不是玉珮");
  assert.strictEqual(r.sub, "怀中玉珮");
});

test("搜身线索：袖袋 / 口袋 / 首饰等同样识别", () => {
  for (const loc of ["王铎（袖袋）", "李铁（口袋）", "苏婉（发簪）", "贵妃（手镯）"]) {
    assert.strictEqual(parseCluePlace(loc).cat, "搜身物品", loc);
  }
});

test("证词类线索单独归类", () => {
  for (const loc of ["王锐证词", "李明远目击", "小翠的陈述"]) {
    assert.strictEqual(parseCluePlace(loc).cat, "人物证词", loc);
  }
});

test("没有括号的普通地点原样作为大地点", () => {
  const r = parseCluePlace("书房");
  assert.strictEqual(r.label, "书房");
  assert.strictEqual(r.sub, "");
  assert.strictEqual(r.cat, "地点");
});

test("空值安全，不产生 undefined 分组", () => {
  const r = parseCluePlace("");
  assert.strictEqual(r.label, "未知");
  assert.strictEqual(r.cat, "地点");
  for (const v of [null, undefined]) {
    assert.doesNotThrow(() => parseCluePlace(v));
    assert.strictEqual(parseCluePlace(v).label, "未知");
  }
});

test("括号剥完为空时退回原串（不产生空分组名）", () => {
  const r = parseCluePlace("（地面）");
  assert.ok(r.label.length > 0, "分组名不能是空串");
});

// ==================== groupCluesByPlace ====================

// 取自实际对局截图里的一组线索 —— 旧实现把它们拆成了四个各 1 条的组
const REAL_CLUES = [
  { id: "A7", location: "御花园凉亭（地面）", content: "折断的苏绣扇子" },
  { id: "A21", location: "御花园凉亭（栏杆）", content: "疑似指纹的油污痕迹" },
  { id: "A20", location: "赵恒（怀中玉珮）", content: "蟠龙玉珮" },
  { id: "A22", location: "王铎（袖袋）", content: "一小包药粉" },
  { id: "A23", location: "御花园凉亭（柱础）", content: "刻痕" },
];

test("同一大地点下的不同细分位置必须归到一组（核心回归）", () => {
  const groups = groupCluesByPlace(REAL_CLUES);
  const pavilion = groups.find(g => g.label === "御花园凉亭");
  assert.ok(pavilion, "应存在'御花园凉亭'分组");
  assert.strictEqual(pavilion.items.length, 3, "地面/栏杆/柱础 三条应合并为一组");
});

test("搜身线索按人各自成组，不与人混淆", () => {
  const groups = groupCluesByPlace(REAL_CLUES);
  const zhao = groups.find(g => g.label === "赵恒");
  const wang = groups.find(g => g.label === "王铎");
  assert.ok(zhao && wang, "两个人都应有自己的分组");
  assert.strictEqual(zhao.cat, "搜身物品");
  assert.strictEqual(wang.cat, "搜身物品");
});

test("分组数远小于线索数（旧实现是每组 1 条）", () => {
  const groups = groupCluesByPlace(REAL_CLUES);
  assert.ok(groups.length < REAL_CLUES.length, `分组数 ${groups.length} 应少于线索数 ${REAL_CLUES.length}`);
  assert.strictEqual(groups.length, 3, "凉亭 + 赵恒 + 王铎 = 3 组");
});

test("每个条目保留细分位置，归组不丢信息", () => {
  const groups = groupCluesByPlace(REAL_CLUES);
  const subs = groups.find(g => g.label === "御花园凉亭").items.map(it => it.sub).sort();
  assert.deepStrictEqual(subs, ["地面", "柱础", "栏杆"]);
});

test("排序：地点 → 人物证词 → 搜身物品", () => {
  const clues = [
    { id: "1", location: "王铎（袖袋）" },
    { id: "2", location: "王锐证词" },
    { id: "3", location: "书房" },
  ];
  const cats = groupCluesByPlace(clues).map(g => g.cat);
  assert.deepStrictEqual(cats, CATEGORY_ORDER.filter(c => cats.includes(c)));
  assert.strictEqual(cats[0], "地点");
});

test("同类里线索多的排前面（信息量大的先看到）", () => {
  const clues = [
    { id: "1", location: "小房间" },
    { id: "2", location: "大厅" }, { id: "3", location: "大厅（地面）" }, { id: "4", location: "大厅（柱）" },
  ];
  const groups = groupCluesByPlace(clues).filter(g => g.cat === "地点");
  assert.strictEqual(groups[0].label, "大厅", "3 条的大厅应排在小房间前面");
});

test("空输入返回空数组，不抛异常", () => {
  assert.deepStrictEqual(groupCluesByPlace([]), []);
  assert.deepStrictEqual(groupCluesByPlace(null), []);
  assert.deepStrictEqual(groupCluesByPlace(undefined), []);
});

test("线索缺 location 字段时归入'未知'而不是消失", () => {
  const groups = groupCluesByPlace([{ id: "X1", content: "无地点线索" }]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].label, "未知");
  assert.strictEqual(groups[0].items.length, 1, "线索不能被静默丢弃");
});

test("兼容 discoveryLocation / discoveredAt 备选字段", () => {
  assert.strictEqual(groupCluesByPlace([{ id: "1", discoveryLocation: "书房" }])[0].label, "书房");
  assert.strictEqual(groupCluesByPlace([{ id: "2", discoveredAt: "厨房" }])[0].label, "厨房");
});

// ==================== 前缀归并 ====================
//
// 只剥括号还不够：地点本身是分层的。一局 29 条线索曾拆出 21 个"大地点"，
// 筛选下拉框 22 个选项 —— 筛选粒度比线索粒度还细，等于没筛。
// 所以"名字是别人前缀"的分组要并到更短的那个底下。

const HIERARCHY = [
  { id: "B1", location: "御花园（池边）" },
  { id: "B2", location: "御花园凉亭（地面）" },
  { id: "B3", location: "御花园凉亭（栏杆）" },
  { id: "B4", location: "御花园假山后（石缝）" },
];

test("子地点并进父地点：御花园凉亭 / 御花园假山后 → 御花园", () => {
  const groups = groupCluesByPlace(HIERARCHY);
  assert.strictEqual(groups.length, 1, `应只剩御花园一组，实际 ${groups.map(g => g.label).join("/")}`);
  assert.strictEqual(groups[0].label, "御花园");
  assert.strictEqual(groups[0].items.length, 4);
});

test("归并后条数不能变（线索一条都不能丢）", () => {
  const groups = groupCluesByPlace(HIERARCHY);
  const ids = groups.flatMap(g => g.items.map(it => it.clue.id)).sort();
  assert.deepStrictEqual(ids, ["B1", "B2", "B3", "B4"]);
});

test("被归并掉的原始地点记在 place 上，界面上补小标签，信息不丢", () => {
  const groups = groupCluesByPlace(HIERARCHY);
  const places = groups[0].items.map(it => it.place).sort();
  assert.deepStrictEqual(places, ["御花园", "御花园假山后", "御花园凉亭", "御花园凉亭"]);
  assert.deepStrictEqual([...groups[0].places].sort(), ["御花园", "御花园假山后", "御花园凉亭"]);
});

test("前缀归并只认真正的包含关系：东厢房与西厢房不合并", () => {
  // 这条和 search-locations 的口径一致：绝不能做"核心词"归一，否则东厢房 ≠ 西厢房 会被抹掉
  const groups = groupCluesByPlace([{ id: "1", location: "东厢房" }, { id: "2", location: "西厢房" }]);
  assert.strictEqual(groups.length, 2);
});

test("单字地名不当父节点，避免把无关地点并进来", () => {
  // "东" 只有 1 个字，如果允许它当父节点，"东侧暖阁"就会被并掉
  const groups = groupCluesByPlace([{ id: "1", location: "东" }, { id: "2", location: "东侧暖阁" }]);
  assert.strictEqual(groups.length, 2, `单字前缀不应触发归并，实际 ${groups.map(g => g.label).join("/")}`);
});

test("跨类别不归并：同一个人的证词和搜身物品各自成组", () => {
  const groups = groupCluesByPlace([
    { id: "1", location: "赵恒证词" },
    { id: "2", location: "赵恒（怀中玉珮）" },
  ]);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups.map(g => g.cat).sort(), ["人物证词", "搜身物品"]);
});

test("归并是幂等的：同一份输入两次调用结果一致", () => {
  const a = groupCluesByPlace(HIERARCHY);
  const b = groupCluesByPlace(HIERARCHY);
  assert.deepStrictEqual(a.map(g => g.key), b.map(g => g.key));
});

// ==================== clueCategoryStats ====================

test("类别统计：按类别给出条数与大地点数，用于筛选按钮", () => {
  const stats = clueCategoryStats([...HIERARCHY, { id: "C1", location: "赵恒证词" }, { id: "C2", location: "王铎（袖袋）" }]);
  assert.deepStrictEqual(stats, [
    { cat: "地点", clues: 4, groups: 1 },
    { cat: "人物证词", clues: 1, groups: 1 },
    { cat: "搜身物品", clues: 1, groups: 1 },
  ]);
});

test("类别统计保持 CATEGORY_ORDER，且不含空类别", () => {
  const stats = clueCategoryStats([{ id: "1", location: "书房" }]);
  assert.strictEqual(stats.length, 1, "只有'地点'有线索时不该出现空的证词/搜身按钮");
  assert.deepStrictEqual(stats.map(s => s.cat), CATEGORY_ORDER.slice(0, 1));
});

test("类别统计：空输入返回空数组", () => {
  assert.deepStrictEqual(clueCategoryStats([]), []);
  assert.deepStrictEqual(clueCategoryStats(null), []);
});

test("统计的条数之和等于线索总数（不重不漏）", () => {
  const clues = [...HIERARCHY, { id: "C1", location: "赵恒证词" }, { id: "C2", location: "王铎（袖袋）" }];
  const sum = clueCategoryStats(clues).reduce((n, s) => n + s.clues, 0);
  assert.strictEqual(sum, clues.length);
});

