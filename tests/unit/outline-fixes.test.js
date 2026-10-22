// 三处确定性补齐（2026-10-20，来自《回春堂蜜影》暴露的真实缺陷）
//   ① 隐藏线索父子成对校验
//   ② 死者身亡时刻推断
//   ③ 关系网有杀机但第一轮没写线索 → 自动补一条证言类线索
const test = require("node:test");
const assert = require("node:assert");
const {
  checkHiddenCluePairs, inferVictimDeathTime, appendMotiveClues,
} = require("../../src/script/outline-fixes.js");

const c = (id, content) => ({ id, content });

// ---------- ① 隐藏线索父子 ----------
test("父有子、子有父 → 通过", () => {
  const clues = [
    c("A10", "抽屉里有一卷钓线（发现隐藏线索，可深入调查）"),
    c("A11", "钓线上有铜锈（通过深入调查A10「抽屉里有一卷钓线」获取）"),
  ];
  const r = checkHiddenCluePairs({ clues });
  assert.strictEqual(r.ok, true, r.issues.join(" | "));
  assert.deepStrictEqual(r.stats.parents, ["A10"]);
});

test("有父无子 → 报「有父无子」并点名", () => {
  const clues = [c("B13", "药柜最下层有个铁盒（发现隐藏线索，可深入调查）")];
  const r = checkHiddenCluePairs({ clues });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some((s) => s.includes("有父无子") && s.includes("B13")), r.issues.join(" | "));
});

test("子线索引用的父不存在 → 报「子线索无主」", () => {
  const clues = [c("A5", "某物（通过深入调查A99「不存在」获取）")];
  const r = checkHiddenCluePairs({ clues });
  assert.ok(r.issues.some((s) => s.includes("子线索无主") && s.includes("A99")), r.issues.join(" | "));
});

test("没有任何隐藏线索 → 不报（这种本可以没有该机制）", () => {
  const clues = [c("A1", "桌上有茶杯"), c("B1", "尸体有创口")];
  assert.strictEqual(checkHiddenCluePairs({ clues }).ok, true);
});

// ---------- ② 身亡时刻推断 ----------
test("显式给了 deathTime → 直接用", () => {
  const r = inferVictimDeathTime({ victim: { name: "周敬山", deathTime: "20:10" } });
  assert.strictEqual(r.deathTime, "20:10");
  assert.strictEqual(r.source, "explicit");
});

test("时间线里「死者 + 死亡词」唯一 → 推断", () => {
  const r = inferVictimDeathTime({
    victim: { name: "周敬山" },
    timeline: [
      { time: "19:40", actor: "周敬山", desc: "吃下涂毒蜜丸" },
      { time: "20:10", actor: "陈守拙", desc: "发现周敬山毒发身亡" },
      { time: "20:30", actor: "王福来", desc: "在柜台对账" },
    ],
  });
  assert.strictEqual(r.deathTime, "20:10");
  assert.strictEqual(r.source, "inferred");
});

test("多个候选 → 不猜，返回 ambiguous", () => {
  const r = inferVictimDeathTime({
    victim: { name: "周敬山" },
    timeline: [
      { time: "20:10", desc: "周敬山毒发死亡" },
      { time: "20:40", desc: "周敬山被发现死亡" },
    ],
  });
  assert.strictEqual(r.deathTime, "");
  assert.strictEqual(r.source, "ambiguous");
  assert.strictEqual(r.candidates.length, 2);
});

test("完全没有线索 → none", () => {
  const r = inferVictimDeathTime({ victim: { name: "周敬山" }, timeline: [] });
  assert.strictEqual(r.deathTime, "");
  assert.strictEqual(r.source, "none");
});

test("真相复盘里的「20:10 毒发」也能推断", () => {
  const r = inferVictimDeathTime({
    victim: { name: "周敬山" },
    timeline: [],
    truthReview: "周敬山于20:10毒发身亡，凶手随即离开。",
  });
  assert.strictEqual(r.deathTime, "20:10");
});

// ---------- ③ 补第一轮动机线索 ----------
const CLUES = [
  "## 第一轮线索",
  "",
  "### A1：柜台账房｜文件",
  "- 线索类型：文件",
  "- 发现地点：柜台账房",
  "- 线索内容：账册上记着一笔短款。",
  "",
  "## 第二轮线索",
  "",
  "### B1：炮制房｜物证",
  "- 线索类型：物证",
  "- 发现地点：炮制房",
  "- 线索内容：桌上有血迹。",
].join("\n");

const RELATIONS = [
  { a: "小栓", b: "周敬山", link: "东家与学徒", tension: "他打碎贵重老山参，要被东家送官赔罪" },
  { a: "王福来", b: "周敬山", link: "掌柜", tension: "他短款一百两被撞见" },
];

test("缺杀机的角色 → 在第一轮补一条证言类线索", () => {
  const r = appendMotiveClues(CLUES, { missing: ["小栓"], relations: RELATIONS });
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.added[0].id, "A2", "编号要接在第一轮最大编号之后");
  assert.ok(r.text.includes("### A2：证言｜证言"));
  assert.ok(r.text.includes("送官赔罪"), "要带关系里的具体冲突事实");
  // 必须插在第一轮里、第二轮之前
  assert.ok(r.text.indexOf("A2") < r.text.indexOf("## 第二轮线索"), "新线索必须落在第一轮");
});

test("没有可用关系事实 → 不编造", () => {
  const r = appendMotiveClues(CLUES, { missing: ["路人"], relations: RELATIONS });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.text, CLUES);
});

test("多人缺杀机 → 依次补，编号不撞", () => {
  const r = appendMotiveClues(CLUES, { missing: ["小栓", "王福来"], relations: RELATIONS });
  assert.strictEqual(r.added.length, 2);
  const ids = r.added.map((a) => a.id);
  assert.deepStrictEqual(ids, ["A2", "A3"]);
  assert.strictEqual(new Set(ids).size, 2);
});

test("空输入安全", () => {
  assert.strictEqual(appendMotiveClues("", { missing: ["x"] }).added.length, 0);
  assert.strictEqual(appendMotiveClues(CLUES, { missing: [] }).added.length, 0);
});

// 切分器的子线索识别（2026-10-20 修）：括号是可选的
test("切分器：无括号的「通过深入调查B13，…」也要认出子线索", () => {
  const re = /[（(]?\s*通过深入调查\s*[:：]?\s*([A-CM]\d{1,3})/;
  assert.strictEqual((re.exec("通过深入调查B13，残留粉末经检测为草乌汁痕迹") || [])[1], "B13");
  assert.strictEqual((re.exec("（通过深入调查 A6「口袋里有一只空瓶。」获取）") || [])[1], "A6");
});
