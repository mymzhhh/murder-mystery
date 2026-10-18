// 分幕剧本：切分 + 按阶段解锁 的单测
//
// 这几条是这一层最容易写坏的地方：
//   1) 没有幕标记的剧本必须**单幕**、行为与改造前完全一致（老剧本不能受影响）；
//   2) 幕数少于解锁点数时不能出现"某阶段倒退"（已解锁的幕不能被收回）；
//   3) 幕数多于解锁点数时只能**合并**、绝不能裁剪内容；
//   4) 摘要必须短（它的存在意义就是省 token）。
const test = require("node:test");
const assert = require("node:assert");
const acts = require("../../src/script/acts.js");

const SCRIPT_4ACTS = [
  "占卜师",
  "【第一幕 初识】",
  "我是塞维利亚的一名占卜师。",
  "【第二幕 案发】",
  "23:10 我在营地附近。",
  "【第三幕 调查】",
  "有人来问过我塔罗牌。",
  "【第四幕 决断】",
  "我决定说出真相。",
].join("\n");

test("没有幕标记的剧本 = 单幕，scriptForPhase 原样返回（不改变老剧本行为）", () => {
  const text = "我是张三，案发当晚我在书房看书。\n23:10 我一直在书房。";
  const list = acts.splitActs(text);
  assert.strictEqual(list.length, 1);
  const r = acts.scriptForPhase(text, "reading");
  assert.strictEqual(r.script, text.trim(), "单幕本必须整篇返回");
  assert.strictEqual(r.totalActs, 1);
  assert.strictEqual(r.nextPhase, null);
});

test("只有一个幕标记时不误切（视作普通标题）", () => {
  const text = "【第一幕 开场】\n我是谁？";
  assert.strictEqual(acts.splitActs(text).length, 1);
});

test("4 幕（《吉普赛女郎之死》的真实形态）按 5 个解锁点一一对应", () => {
  assert.strictEqual(acts.splitActs(SCRIPT_4ACTS).length, 4);
  const expect = { reading: 1, intro: 1, round1: 2, round2: 3, voting: 4, truth_reveal: 4, finished: 4 };
  for (const [ph, n] of Object.entries(expect)) {
    assert.strictEqual(acts.visibleActCount(SCRIPT_4ACTS, ph), n, `阶段 ${ph} 应解锁到第 ${n} 幕`);
  }
  assert.strictEqual(acts.visibleActCount(SCRIPT_4ACTS, "lobby"), 0, "还没开局时一幕都不解锁");
});

test("累计解锁：后一阶段一定包含前一阶段的内容，且不裁剪任何幕", () => {
  const order = ["reading", "round1", "round2", "voting", "truth_reveal"];
  let prev = "";
  for (const ph of order) {
    const r = acts.scriptForPhase(SCRIPT_4ACTS, ph);
    assert.ok(r.script.startsWith(prev) || prev === "", `阶段 ${ph} 的内容应包含上一阶段的内容`);
    prev = r.script;
  }
  const all = acts.scriptForPhase(SCRIPT_4ACTS, "truth_reveal");
  assert.ok(all.script.includes("第四幕"), "最后一幕必须能看到");
  assert.ok(all.script.includes("我是塞维利亚的一名占卜师"), "第一幕正文不能丢");
});

test("幕数多于 5 个解锁点时只合并、不裁剪（8 幕 → 2/4/5/7/8）", () => {
  const lines = [];
  const cn = ["一", "二", "三", "四", "五", "六", "七", "八"];
  for (let i = 0; i < 8; i++) { lines.push(`【第${cn[i]}幕 标题${i + 1}】`); lines.push(`第 ${i + 1} 幕正文。`); }
  const text = lines.join("\n");
  assert.strictEqual(acts.splitActs(text).length, 8);
  const got = ["reading", "round1", "round2", "voting", "truth_reveal"].map((p) => acts.visibleActCount(text, p));
  assert.deepStrictEqual(got, [2, 4, 5, 7, 8]);
  const all = acts.scriptForPhase(text, "truth_reveal").script;
  for (let i = 1; i <= 8; i++) assert.ok(all.includes(`第 ${i} 幕正文`), `第 ${i} 幕正文不能丢`);
});

test("未解锁时给出下一幕的解锁提示", () => {
  const r = acts.scriptForPhase(SCRIPT_4ACTS, "reading");
  assert.strictEqual(r.unlocked, 1);
  assert.ok(r.nextPhase, "应给出下一个解锁阶段");
  assert.ok(!r.script.includes("第四幕"), "未解锁的幕不能出现在正文里");
});

test("前几幕摘要有长度上限，且带上幕标题（给 AI 省 token 用）", () => {
  const list = acts.splitActs(SCRIPT_4ACTS);
  const s = acts.summarizeActs(list, 3, 400);
  assert.ok(s.length <= 401, "摘要不能超过上限");
  assert.ok(s.includes("第一幕"), "摘要要能指认是哪一幕");
  const long = "很长的一段正文。".repeat(500);
  const big = acts.summarizeActs([{ index: 1, title: "X", body: long }], 1, 300);
  assert.ok(big.length <= 301, "超长正文也必须截到上限内");
});

test("中文数字解析：一/四/十/十二/二十", () => {
  assert.strictEqual(acts.actNumber("一"), 1);
  assert.strictEqual(acts.actNumber("四"), 4);
  assert.strictEqual(acts.actNumber("十"), 10);
  assert.strictEqual(acts.actNumber("十二"), 12);
  assert.strictEqual(acts.actNumber("二十"), 20);
  assert.strictEqual(acts.actNumber("3"), 3);
  assert.strictEqual(acts.actNumber("瞎写"), 0);
});
