// 修订补丁的定位策略：逐字 → 去空白 → 前后锚点模糊。
//
// 背景（2026-10-18 实测）：生成《停表的修表铺》时 5 条修订补丁**全部 skipped**，
// 交叉校验报出的"张裁缝也杀了人"这个矛盾原样留在了成稿里。
// 根因是模型抄 oldText 时把引号/逗号/破折号改成了别的写法，逐字匹配必然失败。
// 这里钉住：标点被改过也仍要能定位并替换。
const test = require("node:test");
const assert = require("node:assert");
const { applyPatches } = require("../../src/script/murder-mystery-builder.js");

const TEXT = [
  "### 玩家角色 2：张裁缝 [凶手]",
  "我当时就慌了，所以我只能先下手为强，用我平时敲布料的铜锤砸了他的头，让他再也不能说话。",
  "### 玩家角色 3：李会计",
  "我在对账室里核对了整晚的账目，没有离开过。",
].join("\n");

test("逐字命中：正常替换", () => {
  const r = applyPatches(TEXT, [{
    oldText: "用我平时敲布料的铜锤砸了他的头",
    newText: "看见赵守义倒在维修间，我吓得跑开了",
  }]);
  assert.strictEqual(r.applied, 1);
  assert.ok(r.text.includes("我看见赵守义") || r.text.includes("看见赵守义倒在维修间"));
  assert.ok(!r.text.includes("铜锤砸了他的头"), "原句必须被换掉");
});

test("标点被改动（引号/逗号/破折号）仍能靠锚点定位", () => {
  const r = applyPatches(TEXT, [{
    // 模型抄成：逗号→顿号、句号→感叹号
    oldText: "我当时就慌了、所以我只能先下手为强、用我平时敲布料的铜锤砸了他的头！",
    newText: "我当时吓坏了，只看见赵守义倒在地上。",
  }]);
  assert.strictEqual(r.applied, 1, "标点差异不应导致放弃");
  assert.strictEqual(r.fuzzy, 1, "应走模糊定位");
  assert.ok(r.text.includes("我当时吓坏了"), "替换内容要进正文");
  assert.ok(!r.text.includes("铜锤砸了他的头"), "被替换的段落不能残留");
  // 不能误伤别的角色
  assert.ok(r.text.includes("我在对账室里核对了整晚的账目"), "其它段落必须完好");
});

test("锚点定位只替换目标区间，不会吃掉后面整段", () => {
  const r = applyPatches(TEXT, [{
    oldText: "我在对账室里核对了整晚的账目，没有离开过。",
    newText: "我在对账室里核对了整晚的账目。",
  }]);
  assert.strictEqual(r.applied, 1);
  assert.ok(r.text.includes("### 玩家角色 2：张裁缝"), "前面的内容不能丢");
});

test("完全找不到的补丁仍然跳过（不瞎改）", () => {
  const r = applyPatches(TEXT, [{
    oldText: "这段文字在原稿里根本不存在，纯属编造的内容",
    newText: "替换",
  }]);
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.text, TEXT, "找不到就一字不动");
});

test("结构不合法的补丁（太短/空替换）跳过", () => {
  const r = applyPatches(TEXT, [
    { oldText: "短", newText: "x" },
    { oldText: "用我平时敲布料的铜锤砸了他的头", newText: "" },
  ]);
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(r.skipped, 2);
});
