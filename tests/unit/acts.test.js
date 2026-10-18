// 分幕剧本：切分 + 按阶段解锁 的单测
//
// 语义（实测修正过一次，别退回旧版）：**切分点由剧本显式声明**，不是"看见第N幕就切"。
// 《吉普赛女郎之死》每个角色本有 4 幕，可案子在**第四幕结尾**才发生 —— 按幕切分会让玩家
// 在搜证阶段"案件还没发生、搜到的证据在剧本里根本没有"。所以：
//   · 没有【延后解锁：…】标记 → 整篇一幕，读本阶段全给（= 不分幕，最常见的情况）；
//   · 有标记 → 标记前=读本（含案发），标记后=后续阶段解锁（新案件/新内容）。
const test = require("node:test");
const assert = require("node:assert");
const acts = require("../../src/script/acts.js");

// 《吉普赛女郎之死》的真实形态：4 幕，案子在第四幕结尾，**没有**延后标记
const GYPSY_4ACTS = [
  "占卜师",
  "【第一幕 初识】",
  "我是塞维利亚的一名占卜师。",
  "【第二幕 惊变】",
  "23:10 我在帐篷里占卜。",
  "【第三幕 决斗前夜】",
  "23:30 米里奥拿出一瓶红酒。",
  "【第四幕 死神】",
  "24:00 我扣动扳机。",
  "00:25 吉普赛人冲进我的住处把我抓了起来。",
].join("\n");

// 真正需要分幕的形态：案发之后还有新内容
const WITH_DEFER = [
  "【第一幕 初识】",
  "我是占卜师。",
  "【第二幕 惊变】",
  "23:10 我在帐篷里占卜。",
  "【延后解锁：第三幕】",
  "【第三幕 调查】",
  "次日 23:00 决斗开始。",
  "【第四幕 死神】",
  "24:00 枪响。",
].join("\n");

test("有幕标记但没有【延后解锁】标记 → 整篇一幕（《吉普赛女郎之死》必须整本给读本阶段）", () => {
  const list = acts.splitActs(GYPSY_4ACTS);
  assert.strictEqual(list.length, 1, "4 幕但案子在最后一幕，不能切开");
  const r = acts.scriptForPhase(GYPSY_4ACTS, "reading");
  assert.ok(r.script.includes("第一幕"), "第一幕要在");
  assert.ok(r.script.includes("第四幕"), "第四幕（案发）也必须在读本阶段就给到，否则玩家搜证时案件还没发生");
  assert.strictEqual(r.unlocked, 1);
  assert.strictEqual(r.nextPhase, null, "没有延后内容就不该提示解锁");
});

test("有【延后解锁：第三幕】→ 读本只到标记前，标记后按幕再分", () => {
  const list = acts.splitActs(WITH_DEFER);
  assert.strictEqual(list.length, 3, "读本 + 第三幕 + 第四幕");
  assert.strictEqual(list[0].title, "读本（含案发）");
  assert.ok(list[0].body.includes("23:10 我在帐篷"), "案发前的内容归读本");
  assert.ok(!list[0].body.includes("枪响"), "案发后的内容不能被塞进读本");
});

test("按 5 个解锁点累计解锁（3 幕 → 1/2/2/3/3），未解锁的幕不下发", () => {
  const expect = { reading: 1, intro: 1, round1: 2, round2: 2, voting: 3, truth_reveal: 3 };
  for (const [ph, n] of Object.entries(expect)) {
    assert.strictEqual(acts.visibleActCount(WITH_DEFER, ph), n, `阶段 ${ph} 应解锁到第 ${n} 段`);
  }
  const atReading = acts.scriptForPhase(WITH_DEFER, "reading");
  assert.ok(!atReading.script.includes("枪响"), "读本阶段不能看到案发后的段落");
  assert.ok(atReading.nextPhase, "应提示下一个解锁阶段");
  const atVoting = acts.scriptForPhase(WITH_DEFER, "voting");
  assert.ok(atVoting.script.includes("枪响"), "投票阶段应能看到案发后内容");
  assert.strictEqual(atVoting.nextPhase, null);
});

test("累计解锁：后一阶段一定包含前一阶段的内容", () => {
  let prev = "";
  for (const ph of ["reading", "round1", "round2", "voting", "truth_reveal"]) {
    const r = acts.scriptForPhase(WITH_DEFER, ph);
    assert.ok(r.script.startsWith(prev), `阶段 ${ph} 的内容应包含上一阶段的内容`);
    prev = r.script;
  }
});

test("延后部分内超过 5 幕时只合并、不裁剪（6 幕 → 读本 + 5 = 6 段）", () => {
  const lines = ["【第一幕 前】", "读本正文。", "【延后解锁：第二幕】"];
  const cn = ["二", "三", "四", "五", "六"];
  for (let i = 0; i < 5; i++) { lines.push(`【第${cn[i]}幕 标题${i}`); lines.push(`第 ${i} 段正文。`); }
  const text = lines.join("\n");
  const list = acts.splitActs(text);
  assert.strictEqual(list.length, 6);
  const all = acts.scriptForPhase(text, "truth_reveal").script;
  for (let i = 0; i < 5; i++) assert.ok(all.includes(`第 ${i} 段正文`), `第 ${i} 段正文不能丢`);
});

test("延后部分里正文行「第 1 幕正文。」不会被误判成幕标题", () => {
  const text = ["【第一幕 a】", "x。", "【延后解锁：第二幕】", "【第二幕 b】", "第 1 幕正文。", "【第三幕 c】", "第 2 幕正文。"].join("\n");
  const list = acts.splitActs(text);
  // 读本 1 段 + 延后 2 段（第二、三幕）
  assert.strictEqual(list.length, 3, "正文行带句号，不能当标题");
});

test("前几段摘要有长度上限，且带上标题（给 AI 省 token 用）", () => {
  const list = acts.splitActs(WITH_DEFER);
  const s = acts.summarizeActs(list, 2, 400);
  assert.ok(s.length <= 401, "摘要不能超过上限");
  assert.ok(s.includes("第一"), "摘要要能指认是哪一段");
  const big = acts.summarizeActs([{ index: 1, title: "X", body: "很长的一段正文。".repeat(500) }], 1, 300);
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

test("空剧本不炸", () => {
  assert.deepStrictEqual(acts.splitActs(""), []);
  assert.deepStrictEqual(acts.splitActs(null), []);
  assert.strictEqual(acts.scriptForPhase("", "reading").script, "");
});
