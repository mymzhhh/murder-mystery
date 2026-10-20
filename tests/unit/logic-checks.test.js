// 逻辑层确定性校验：用**真实生成稿里读出来的缺陷**当回归用例。
//
// 这些缺陷当初全部通过了管道（交叉校验报了凶手手法那条，但修订没修掉；
// 其余三类管道根本查不出来），所以每一条都要有钉子。
const test = require("node:test");
const assert = require("node:assert");
const L = require("../../src/script/logic-checks.js");

// —— 真实片段（《停摆的时针》赵磊 = 凶手）——
const ZHAOLEI_SCRIPT = [
  "### 二、你的时间线",
  "- **10月21日 21:10（真实，座钟20:55）**：我溜进维修间，把挂钟的分针拧下来，用螺丝刀把分针往回调了15分钟，让它停在20:55，然后把调钟的小扳手扔进维修间的暗格里销毁，锁上门。",
  "- **10月21日 21:25（真实，座钟21:10）**：我把掰好的发条藏在维修间的门后，看见苏晴走进维修间，拿着王建国的酒杯，倒了半杯酒。",
  "- **10月21日 21:30（真实，座钟21:15）**：我在维修间翻钟表的抽屉，找粗一点的发条，看见李雯在后院翻旧箱子。",
  "- **10月21日 22:30（真实，座钟22:15）**：我拉着他的胳膊说“就看一眼，很快的”，他跟着我走了。",
  "- **10月21日 22:35（真实，座钟22:20）**：我听见维修间传来一声闷响，赶紧跑过去，看见王建国倒在地上，脖子上缠着发条。",
  "### 四、凶手确认",
  "手法要点：21:10（真实）调慢维修间挂钟15分钟，伪造不在场证明；21:30（真实）用维修间的粗发条制作勒颈陷阱；22:30（真实）借口修钟表把王建国引到维修间，22:35（真实）陷阱触发。",
].join("\n");

const SUQING_SCRIPT = [
  "### 二、你的时间线",
  "- **10月21日 21:10（座钟）**：维修间 — 我去维修间找王建国，看到维修间的挂钟被调慢了，显示20:55，我以为是王建国调的。",
  "- **10月21日 21:15（座钟）**：会计室 — 我整理账本，听到后院有动静。",
].join("\n");

test("① 凶手时间线没落地手法 → 必须报出来（真实缺陷）", () => {
  const issues = L.checkMurdererMethodInTimeline({
    sections: [{ name: "赵磊", text: ZHAOLEI_SCRIPT }], murdererName: "赵磊",
  });
  assert.ok(issues.length >= 1, "21:30 / 22:35 两条手法在时间线里都没落地，必须报");
  assert.ok(issues.some((s) => s.includes("21:30")), "应指出 21:30 那次不一致");
  assert.ok(issues.every((s) => s.includes("【逻辑·凶手手法】")));
});

test("① 手法真的落地了就不报（反例）", () => {
  const ok = [
    "### 二、你的时间线",
    "- **10月21日 21:30**：我用粗发条制作了勒颈陷阱，固定在门后。",
    "### 四、凶手确认",
    "手法要点：21:30 用粗发条制作勒颈陷阱。",
  ].join("\n");
  const issues = L.checkMurdererMethodInTimeline({ sections: [{ name: "甲", text: ok }], murdererName: "甲" });
  assert.deepStrictEqual(issues, []);
});

test("② 同一术语两种含义 → 必须报出来（真实缺陷：座钟）", () => {
  const issues = L.checkTimeBaseConsistency({
    sections: [{ name: "赵磊", text: ZHAOLEI_SCRIPT }, { name: "苏晴", text: SUQING_SCRIPT }],
  });
  assert.ok(issues.some((s) => s.includes("座钟")), "座钟在凶手剧本里是「被调过的钟」、在苏晴剧本里当真实时间用");
  assert.ok(issues.every((s) => s.includes("【逻辑·时间基准】")));
});

test("② 偏差值不唯一 → 报出来", () => {
  const a = "- **10月21日 21:10（真实，座钟20:55）**：x";
  const b = "- **10月21日 21:10（真实，座钟21:05）**：x";
  const issues = L.checkTimeBaseConsistency({ sections: [{ name: "甲", text: a + "\n" + b }] });
  assert.ok(issues.some((s) => s.includes("多个偏差值")), "同一术语 -15 与 -5 两个偏差必须报");
});

test("③ 同一只钟被赋了两个偏差值 → 报出来（真实缺陷：前厅挂钟 +5 又 +10）", () => {
  const t = [
    "线索1：真实时间20:55，前厅挂钟显示21:00，维修间挂钟显示20:55，说明维修间挂钟慢了15分钟。",
    "结论：法医鉴定死亡时间22:35，前厅挂钟显示22:45，维修间挂钟停在22:20。",
  ].join("\n");
  const issues = L.checkTruthArithmetic(t);
  assert.ok(issues.some((s) => s.includes("前厅挂钟") && s.includes("多个偏差值")), "前厅挂钟 +5 与 +10 必须报出来");
});

test("③ 两个时刻 + 差N分钟 的声明要能验算（真实缺陷：说差15、实际25）", () => {
  const t = "前厅挂钟显示22:45，维修间挂钟停在22:20，时间差15分钟。";
  const issues = L.checkTruthArithmetic(t);
  assert.ok(issues.some((s) => /相差 25 分钟/.test(s)), "22:45 与 22:20 实际差 25 分钟");
});

test("③ 不存在的时刻（22:60）→ 报出来，且能确定性修好", () => {
  const t = "线索17：李雯的旧手表（调快了15分钟，真实时间22:45，手表显示22:60）。";
  const issues = L.checkTruthArithmetic(t);
  assert.ok(issues.some((s) => s.includes("22:60")), "必须报非法时刻");
  const r = L.fixIllegalClockTimes(t);
  assert.strictEqual(r.fixed, 1);
  assert.ok(r.text.includes("23:00"), "22:60 应规范成 23:00");
  assert.ok(!L.illegalClocks(r.text).length, "修完不应还有非法时刻");
});

test("③ 自洽的算术不报（反例）", () => {
  const t = "真实时间22:35，维修间挂钟显示22:20，差15分钟。";
  assert.deepStrictEqual(L.checkTruthArithmetic(t), []);
});

test("④ 真相只覆盖一半线索 → 报出来（真实缺陷：22/40）", () => {
  const ids = [...Array.from({ length: 20 }, (_, i) => "A" + (i + 1)), ...Array.from({ length: 20 }, (_, i) => "B" + (i + 1))];
  const truth = "### 2. 全部线索逐条解析（共22条，无遗漏）\n" + Array.from({ length: 22 }, (_, i) => `线索${i + 1}：某物证`).join("\n");
  const issues = L.checkTruthClueCoverage(truth, ids);
  assert.ok(issues.some((s) => s.includes("0/40") || s.includes("条线索")), "应报覆盖率过低");
  assert.ok(issues.some((s) => s.includes("共22条")), "应报「自称共22条、实际40条」");
});

test("④ 覆盖充分且编号正确 → 不报（反例）", () => {
  const ids = ["A1", "A2", "B1"];
  const truth = "全部线索解析：A1 是物证；A2 是证言；B1 是尸体线索。";
  assert.deepStrictEqual(L.checkTruthClueCoverage(truth, ids), []);
});

test("runLogicChecks 汇总四类并给出明细", () => {
  const r = L.runLogicChecks({
    sections: [{ name: "赵磊", text: ZHAOLEI_SCRIPT }, { name: "苏晴", text: SUQING_SCRIPT }],
    murdererName: "赵磊",
    dmText: "法医鉴定死亡时间22:35，前厅挂钟显示22:45，维修间挂钟停在22:20，时间差15分钟。手表显示22:60。",
    clueIds: ["A1", "A2", "B1", "B2"],
  });
  assert.ok(r.issues.length >= 3, "四类里至少三类应命中");
  assert.ok(r.details.method.length && r.details.timeBase.length && r.details.arithmetic.length && r.details.coverage.length);
});

test("空输入不炸", () => {
  assert.deepStrictEqual(L.runLogicChecks({}).issues, []);
  assert.deepStrictEqual(L.checkTruthArithmetic(""), []);
  assert.deepStrictEqual(L.checkTruthClueCoverage("", []), []);
});

test("时间线条目要认得「日期 + 【真实】 + 时刻」这种真实写法", () => {
  // 真实生成稿（《冬至钟影》沈砚）就是这么写的：日期与时刻之间夹了【真实】标注。
  // 第一版正则抽不到这种行，导致"凶手手法落地"校验误报"时间线里没有这个时刻的条目"。
  const text = [
    "### 二、你的时间线",
    "- **12月21日 【真实】19:30**：西厢房 — 我整理待修钟表零件。",
    "- **12月22日 【座钟】21:00**：西厢房 — 我擦拭机芯。",
    "- **10月21日 21:30（真实，座钟21:15）**：维修间 — 我调慢了挂钟。",
  ].join("\n");
  const entries = L.timelineEntries(text);
  assert.strictEqual(entries.length, 3, "三种写法都要能抽到");
  assert.deepStrictEqual(entries.map((e) => L.fmtHM(e.minutes)), ["19:30", "21:00", "21:30"]);
});

test("真实写法：「用……瓶击打其后脑」必须被认成手法声明（不误报）", () => {
  // 真实生成稿（《沪西照相馆除夕谜案》陈阿生）的凶手确认原文。
  // 第一版词表没有"击打/瓶"，校验器误报"找不到带时刻的手法声明"。
  const script = [
    "### 四、凶手确认（仅你可见）",
    "我是本案真凶陈阿生，真实作案时间为1月29日22:42，趁周福根背对门冲洗照片时，用暗房架子上的厚玻璃显影液瓶击打其后脑致其当场死亡。擦拭凶器表面指纹，因手抖留下半枚拇指印；22:55将大堂公共挂钟拨快15分钟，统一所有人的时间认知，制造不在场证明。",
    "### 二、你的时间线",
    "- **1月29日 【真实】22:42**：暗房 — 我用暗房架子上的厚玻璃显影液瓶击打周福根后脑。",
    "- **1月29日 【真实】22:55**：大堂 — 我把公共挂钟拨快了15分钟。",
  ].join("\n");
  const issues = L.checkMurdererMethodInTimeline({ sections: [{ name: "陈阿生", text: script }], murdererName: "陈阿生" });
  assert.deepStrictEqual(issues, [], "手法声明能认出来、时间线也确实落地了，不该报问题");
});

test("手法声明认出来了、但时间线没落地 → 仍然要报", () => {
  const script = [
    "### 四、凶手确认",
    "我是真凶，真实作案时间22:42，用厚玻璃显影液瓶击打其后脑。",
    "### 二、你的时间线",
    "- **1月29日 22:42**：暗房 — 我在冲洗照片，听见外面有人说话。",
  ].join("\n");
  const issues = L.checkMurdererMethodInTimeline({ sections: [{ name: "甲", text: script }], murdererName: "甲" });
  assert.ok(issues.some((s) => s.includes("22:42")), "时间线没写手法，必须报");
});

test("「共N条」按轮次核对，不能拿总数误报（真实误报）", () => {
  // 真实真相原文：「#### A类线索（第一轮搜证，共22条…）」，而总数是 46、第一轮正好 22。
  // 旧实现拿总数比 → 误报"自称共22条、实际46条"。
  const ids = [
    ...Array.from({ length: 22 }, (_, i) => "A" + (i + 1)),
    ...Array.from({ length: 24 }, (_, i) => "B" + (i + 1)),
  ];
  const truth = "#### A类线索（第一轮搜证，共22条，为浅层关系类线索）\n" +
    ids.map((id) => `${id}：某物证`).join("\n");
  const issues = L.checkTruthClueCoverage(truth, ids);
  assert.deepStrictEqual(issues, [], "22 是第一轮的条数，不该报");
});

test("「共N条」跟总数和任何轮次都对不上 → 仍然报", () => {
  const ids = ["A1", "A2", "A3", "B1", "B2"];
  const truth = "全部线索共 40 条，逐条解析如下：" + ids.map((id) => `${id}：内容`).join("\n");
  const issues = L.checkTruthClueCoverage(truth, ids);
  assert.ok(issues.some((s) => s.includes("共40条")), "40 既不是总数也不是任何一轮，必须报");
});

test("时刻后面跟【座钟】的写法必须能解析（2026-10-20 山坳雪夜整本都是这个格式）", () => {
  const t = [
    "### 二、你的时间线",
    "- **1937年1月14日 21:00【座钟】**：一楼大厅 — 我坐在桌边和在场的人寒暄。",
    "- **1937年1月14日 21:15【真实】**：一楼大厅 — 我看见赵大山起身往后厨方向走。",
  ].join("\n");
  const es = L.timelineEntries(t);
  assert.strictEqual(es.length, 2, "两条都要能解析出来");
  assert.deepStrictEqual(es.map((e) => e.minutes), [21 * 60, 21 * 60 + 15]);
});

test("没有「凶手确认」段时，不能把自己的时间线当手法声明（否则连报假问题）", () => {
  // 真实事故形态：凶手本只有背景 + 时间线，没有"凶手确认"章节。
  // 旧实现拿整篇当声明 → 时间线条目被当声明 → 比对失败 → 9 条假问题 → 修订吞角色。
  const script = [
    "### 一、你的背景故事",
    "我叫沈砚，来山区采风。",
    "### 二、你的时间线",
    "- **1937年1月14日 21:00【座钟】**：一楼大厅 — 我把茶碗放在桌上，转身离开。",
    "- **1937年1月14日 22:10【座钟】**：地下室 — 我用铜烛台击打林桂兰后脑。",
  ].join("\n");
  const issues = L.checkMurdererMethodInTimeline({ sections: [{ name: "沈砚", text: script }], murdererName: "沈砚" });
  assert.deepStrictEqual(issues, [], "不该把自己的时间线条目当声明来判自己");
});
