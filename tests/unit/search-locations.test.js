// 地点搜证逻辑测试
//
// 这次改造要解决的是"搜证没有失败状态"：改造前 searchClues 匹配不上会随机给一条，
// query 留空也照样出线索 —— 于是"这轮搜哪里"不构成决策。所以这里必须钉死：
//   1) 选错地点就是搜空（返回 null），绝不兜底补一条
//   2) 别人搜过的线索不再可搜
//   3) 地点匹配不能把不同房间串在一起
const test = require("node:test");
const assert = require("node:assert");

const sl = require("../../src/game/search-locations");
const { normalizeLoc, matchLocation, buildSearchLocations, availableClues, cluesAtLocation, pickClueAtLocation, MAX_LOCATIONS } = sl;

const CLUES = [
  { id: "A1", location: "书房", round: "1", content: "书桌抽屉里的信", foundBy: [] },
  { id: "A2", location: "书房", round: "1", content: "打翻的茶盏", foundBy: [] },
  { id: "A3", location: "沈曼青闺房", round: "1", content: "梳妆台暗格", foundBy: [] },
  { id: "A4", location: "厨房", round: "2", content: "灶台边的药渣", foundBy: [] },
  { id: "A5", location: "厨房", round: "2", content: "水井旁的脚印", foundBy: ["p1"] },
];

// ==================== normalizeLoc / matchLocation ====================

test("normalizeLoc 去掉括号注记、空白与标点", () => {
  assert.strictEqual(normalizeLoc("书房（死者专用）"), "书房");
  assert.strictEqual(normalizeLoc(" 厢房 · 东 "), "厢房东");
});

test("matchLocation：完全相同匹配", () => {
  assert.strictEqual(matchLocation("书房", "书房"), true);
});

test("matchLocation：包含关系匹配（书房桌面 → 书房）", () => {
  assert.strictEqual(matchLocation("书房桌面", "书房"), true);
  assert.strictEqual(matchLocation("书房", "书房桌面"), true);
});

test("matchLocation：复合名与核心房间词互认（沈曼青闺房 ↔ 闺房）", () => {
  assert.strictEqual(matchLocation("沈曼青闺房", "闺房"), true);
});

test("matchLocation：东厢房与西厢房绝不能算同一个地方", () => {
  // 这条是刻意不做"核心词归一"的原因：两个不同房间串线索比漏配严重得多
  assert.strictEqual(matchLocation("东厢房", "西厢房"), false);
});

test("matchLocation：无关地点不匹配", () => {
  assert.strictEqual(matchLocation("书房", "厨房"), false);
});

test("matchLocation：空值安全，且不因过短而误配", () => {
  assert.strictEqual(matchLocation("", "书房"), false);
  assert.strictEqual(matchLocation("书房", null), false);
  assert.strictEqual(matchLocation("房", "书房"), false, "单字地点不应参与匹配");
});

// ==================== buildSearchLocations ====================

test("地点列表来自线索发现地点，去重且保持出现顺序", () => {
  const locs = buildSearchLocations(CLUES);
  assert.deepStrictEqual(locs, ["书房", "沈曼青闺房", "厨房"]);
});

test("地点列表剥离括号注记后去重", () => {
  const locs = buildSearchLocations([
    { location: "书房" },
    { location: "书房（案发现场）" },
  ]);
  assert.deepStrictEqual(locs, ["书房"]);
});

test("过短/过长/空地点被丢弃", () => {
  const locs = buildSearchLocations([
    { location: "" }, { location: "房" }, { location: "x".repeat(30) }, { location: "书房" },
  ]);
  assert.deepStrictEqual(locs, ["书房"]);
});

test("线索无地点时退回布局描述", () => {
  const layout = "- **书房**：位于二楼东侧\n- **厨房**：位于一楼北面\n";
  const locs = buildSearchLocations([{ location: "" }], layout);
  assert.ok(locs.includes("书房"), `应能从布局归纳出地点，实际: ${JSON.stringify(locs)}`);
});

test("地点数量有上限", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ location: `房间${i}` }));
  assert.strictEqual(buildSearchLocations(many).length, MAX_LOCATIONS);
});

test("空输入返回空列表", () => {
  assert.deepStrictEqual(buildSearchLocations([]), []);
  assert.deepStrictEqual(buildSearchLocations(null), []);
});

// ==================== cluesAtLocation ====================

test("只返回指定地点的线索", () => {
  const got = cluesAtLocation(CLUES, "书房", 1).map(c => c.id);
  assert.deepStrictEqual(got.sort(), ["A1", "A2"]);
});

test("已被取走的线索不再可搜（线索一旦被发现即全场公开）", () => {
  const got = cluesAtLocation(CLUES, "厨房", 2).map(c => c.id);
  assert.deepStrictEqual(got, ["A4"], "A5 已被 p1 取走，不该再出现");
});

test("按轮次过滤（兼容 Redis 返回的字符串轮次）", () => {
  assert.strictEqual(cluesAtLocation(CLUES, "厨房", 1).length, 0, "厨房的线索在第 2 轮");
  assert.strictEqual(cluesAtLocation(CLUES, "厨房", "2").length, 1, "字符串轮次也要能匹配");
});

test("不传轮次则不限轮次", () => {
  assert.strictEqual(cluesAtLocation(CLUES, "厨房").length, 1);
});

test("复合地点名也能搜到（沈曼青闺房 ↔ 闺房）", () => {
  assert.strictEqual(cluesAtLocation(CLUES, "闺房", 1).length, 1);
});

// ==================== 随机搜证用的池子 ====================

test("availableClues：返回本轮所有尚未被取走的线索（不限地点）", () => {
  const got = availableClues(CLUES, 1).map(c => c.id);
  assert.deepStrictEqual(got.sort(), ["A1", "A2", "A3"], "第1轮里未被取走的全部线索");
});

test("availableClues：已被取走的排除在外", () => {
  const got = availableClues(CLUES, 2).map(c => c.id);
  assert.deepStrictEqual(got, ["A4"], "A5 已被 p1 取走");
});

test("availableClues：不传轮次则不限轮次", () => {
  assert.strictEqual(availableClues(CLUES).length, 4, "1 轮 3 条 + 2 轮 1 条未取走"); 
});

test("availableClues：兼容 Redis 返回的字符串轮次", () => {
  assert.strictEqual(availableClues(CLUES, "2").length, 1);
});

test("availableClues：空输入返回空数组", () => {
  assert.deepStrictEqual(availableClues(null, 1), []);
  assert.deepStrictEqual(availableClues([], 1), []);
});

test("availableClues：全部被取走时为空（这就是随机搜证的\"搜空\"条件）", () => {
  const drained = CLUES.map(c => ({ ...c, foundBy: ["p1"] }));
  assert.deepStrictEqual(availableClues(drained, undefined), []);
});

test("cluesAtLocation 是 availableClues 的地点过滤（两者口径必须一致）", () => {
  const byLoc = cluesAtLocation(CLUES, "书房", 1).map(c => c.id).sort();
  const byAvail = availableClues(CLUES, 1).filter(c => matchLocation(c.location, "书房")).map(c => c.id).sort();
  assert.deepStrictEqual(byLoc, byAvail);
});


test("地点无线索时返回 null —— 这就是搜空的失败状态，绝不兜底补一条", () => {
  assert.strictEqual(pickClueAtLocation(CLUES, "不存在的房间", 1), null);
});

test("地点线索已被搜空时返回 null", () => {
  const drained = [{ id: "X1", location: "书房", round: "1", foundBy: ["p1"] }];
  assert.strictEqual(pickClueAtLocation(drained, "书房", 1), null);
});

test("有线索时返回该地点的线索", () => {
  const got = pickClueAtLocation(CLUES, "书房", 1);
  assert.ok(got && ["A1", "A2"].includes(got.id));
});

test("优先返回非红鲱鱼线索", () => {
  const withHerring = [
    { id: "R1", location: "书房", round: "1", foundBy: [], isRedHerring: true },
    { id: "N1", location: "书房", round: "1", foundBy: [], isRedHerring: false },
  ];
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(pickClueAtLocation(withHerring, "书房", 1).id, "N1");
  }
});

test("只有红鲱鱼时也能拿到（不会卡死）", () => {
  const onlyHerring = [{ id: "R1", location: "书房", round: "1", foundBy: [], isRedHerring: true }];
  assert.strictEqual(pickClueAtLocation(onlyHerring, "书房", 1).id, "R1");
});

// 2026-10-20 纵深防御：即使 hiddenBehind 漏标，子线索也不能进普通搜证池。
// 事故：《回春堂蜜影》写成「通过深入调查B13，残留粉末…」（无括号），旧正则漏标 →
// 这条答案级线索直接进搜证池，玩家一搜就拿到真相。
test("正文写着「通过深入调查X」但 hiddenBehind 漏标 → 仍然不进搜证池", () => {
  const clues = [
    { id: "B13", content: "毛刷上有淡褐色粉末（发现隐藏线索，可深入调查）", round: 2, hiddenBehind: "" },
    { id: "B14", content: "通过深入调查B13，残留粉末经检测为草乌汁痕迹", round: 2, hiddenBehind: "" },
  ];
  const pool = availableClues(clues, 2);
  assert.deepStrictEqual(pool.map((c) => c.id), ["B13"], "只有父线索能搜，子线索不能");
});

test("测试局 includeHidden=true 时仍可全部给出", () => {
  const clues = [{ id: "B14", content: "通过深入调查B13，草乌汁痕迹", round: 2, hiddenBehind: "" }];
  assert.strictEqual(availableClues(clues, 2, { includeHidden: true }).length, 1);
});

test("普通线索（没提深入调查）不受影响", () => {
  const clues = [{ id: "A1", content: "账册上记着一笔短款", round: 1, hiddenBehind: "" }];
  assert.strictEqual(availableClues(clues, 1).length, 1);
});
