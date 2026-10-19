// 整段重写兜底：补丁定位不到时，让模型交回改好的整段，由代码按三级标题替换。
//
// 背景（2026-10-18）：两轮定向修订后**仍有 4–10 个问题没修掉**，日志反复出现
// "修订补丁无法在原文定位，已跳过" —— 补丁机制依赖模型抄对 oldText，
// 一旦改标点/漏字就整条作废，检测出来的问题就此留在成稿里。
const test = require("node:test");
const assert = require("node:assert");
const {
  splitScriptSections, replaceSectionBody, finalRewriteBySection,
} = require("../../src/script/murder-mystery-builder.js");

const SCRIPT = [
  "# 第三部分：角色剧本",
  "",
  "### 玩家角色 1：林修 [凶手]",
  "#### 一、你的背景故事",
  "我是钟表匠。",
  "#### 二、你的时间线",
  "- **10月21日 21:30**：我在维修间调钟。",
  "",
  "### 玩家角色 2：张裁缝",
  "#### 一、你的背景故事",
  "我是裁缝。",
  "#### 二、你的时间线",
  "- **10月21日 21:30**：我在铺子里敲布料，用铜锤砸了他的头。",
  "",
  "### 玩家角色 3：李会计",
  "#### 二、你的时间线",
  "- **10月21日 22:00**：我在对账。",
  "",
].join("\n");

test("按三级标题切段，能认出名字", () => {
  const secs = splitScriptSections(SCRIPT);
  assert.strictEqual(secs.length, 3);
  assert.deepStrictEqual(secs.map((s) => s.name), ["林修", "张裁缝", "李会计"]);
  assert.ok(secs[1].body.includes("铜锤砸了他的头"));
});

test("替换正文：标题行与其它段一字不动", () => {
  const secs = splitScriptSections(SCRIPT);
  const out = replaceSectionBody(SCRIPT, secs[1], "#### 二、你的时间线\n- **10月21日 21:30**：我在铺子里敲布料，没见过他。");
  assert.ok(out.includes("### 玩家角色 2：张裁缝"), "标题行要保留");
  assert.ok(out.includes("没见过他"));
  assert.ok(!out.includes("铜锤砸了他的头"), "旧正文要被换掉");
  assert.ok(out.includes("### 玩家角色 3：李会计"), "后面那段不能丢");
  assert.ok(out.includes("### 玩家角色 1：林修 [凶手]"), "前面那段不能丢");
});

test("只重写被问题点名的角色段，并交回完整新正文", async () => {
  const calls = [];
  const fakeGen = async (sys, user) => {
    calls.push(user);
    // 交回一段"改好的"正文，长度足够
    return { content: "#### 一、你的背景故事\n我是裁缝，案发夜一直在铺子里。\n#### 二、你的时间线\n- **10月21日 21:30**：我在铺子里敲布料，听见维修间有响动，没进去。" };
  };
  const r = await finalRewriteBySection(SCRIPT, ["张裁缝 的时间线与设定集凶手手法冲突：他也在 21:30 杀了人"], fakeGen, null, {});
  assert.strictEqual(r.fixed, 1);
  assert.strictEqual(r.attempts, 1);
  assert.ok(calls.length === 1, "只该为张裁缝调一次模型");
  assert.ok(calls[0].includes("铜锤"), "应把该角色的原文交给模型");
  assert.ok(!r.text.includes("铜锤砸了他的头"), "改后不应再有矛盾句");
  assert.ok(r.text.includes("### 玩家角色 1：林修 [凶手]"), "其它段必须完好");
});

test("整段重写交回的正文太短 → 放弃（防把剧本改瘦）", async () => {
  const fakeGen = async () => ({ content: "太短了。" });
  const r = await finalRewriteBySection(SCRIPT, ["张裁缝 有问题"], fakeGen, null, {});
  assert.strictEqual(r.fixed, 0);
  assert.ok(r.details[0].reason.includes("太短"), "要如实说明放弃原因");
  assert.strictEqual(r.text, SCRIPT, "成稿一字不动");
});

test("没有任何问题点名该角色时，一次模型都不调", async () => {
  let called = 0;
  const fakeGen = async () => { called++; return { content: "x".repeat(500) }; };
  const r = await finalRewriteBySection(SCRIPT, ["线索 B3 的地点不在布局里"], fakeGen, null, {});
  assert.strictEqual(called, 0);
  assert.strictEqual(r.text, SCRIPT);
});

test("确定性体检判红 → 回退这一段", async () => {
  const fakeGen = async () => ({ content: "#### 二、你的时间线\n" + "- **10月21日 21:30**：我在铺子里。".repeat(20) });
  const r = await finalRewriteBySection(SCRIPT, ["张裁缝 有问题"], fakeGen, null, {
    snapshot: () => ({ ok: false }),
    regressions: () => ["死亡后活动变多了"],
  });
  assert.strictEqual(r.fixed, 0);
  assert.ok(r.details[0].reason.includes("变红"));
  assert.strictEqual(r.text, SCRIPT, "改坏的版本不能进成稿");
});
