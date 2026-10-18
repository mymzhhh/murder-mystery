// 剧本正文清洗（去元指令）的单测
//
// 这些用例全部来自《麋鹿神社》的真实文本 —— 印刷版分幕本每幕之间都插着这类句子。
// 红线：**只删流程说明，不碰剧情与「你的任务」**。
const test = require("node:test");
const assert = require("node:assert");
const { stripMetaInstructions, hasMetaInstructions } = require("../../src/script/script-clean.js");

test("删掉翻页门禁的三种写法", () => {
  const src = [
    "组织者允许前不许翻开下一页",
    "未经组织者允许前不许翻开下一页",
    "在组织者允许 之前不许翻开下一页",
    "第二天早上你们上山了。",
  ].join("\n");
  const { text, removed } = stripMetaInstructions(src);
  assert.strictEqual(removed.length, 3);
  assert.ok(!/组织者/.test(text), "一条门禁都不能留");
  assert.ok(text.includes("第二天早上你们上山了。"), "剧情必须保留");
});

test("删掉阶段说明（闲聊/公聊/不可私聊）", () => {
  const src = [
    "此阶段为闲聊环节，请了解其他人的目的，尽量不要透露自己之前来过这里的事情，否则可能会引起怀疑",
    "此阶段公聊环节不可私聊，尽量不要向大家透露你回想起来的记忆",
    "此阶段为公聊环节，所有玩家不可参与私聊",
    "你们开始闲聊了起来。",
  ].join("\n");
  const { text } = stripMetaInstructions(src);
  assert.ok(!/此阶段/.test(text));
  assert.ok(!/私聊/.test(text));
  assert.ok(text.includes("你们开始闲聊了起来。"));
});

test("删掉「请找组织者领取」提示", () => {
  const src = "你回到房间睡觉了（请找组织者领取你的睡梦内容）。\n睡梦中你记起了一些事。";
  const { text } = stripMetaInstructions(src);
  assert.ok(!/组织者/.test(text), "领取提示要删掉");
  assert.ok(text.includes("睡梦中你记起了一些事。"), "睡梦内容本身要保留");
});

test("红线：「你的任务」及条目必须原样保留", () => {
  const src = [
    "你的任务",
    "了解清楚刘峰的秘密",
    "搞清楚吴轩为什么盯着雕像一直看来看去",
    "此阶段为公聊环节，不可进行私聊",
  ].join("\n");
  const { text } = stripMetaInstructions(src);
  assert.ok(text.includes("你的任务"), "任务头不能删");
  assert.ok(text.includes("了解清楚刘峰的秘密"), "任务条目不能删");
  assert.ok(text.includes("搞清楚吴轩为什么盯着雕像一直看来看去"));
  assert.ok(!/此阶段/.test(text));
});

test("真实片段：门禁行前后的空行会被收拢，不留大洞", () => {
  const src = "正文一。\n\n\n组织者允许前不许翻开下一页\n\n\n正文二。";
  const { text } = stripMetaInstructions(src);
  assert.ok(!/\n{3,}/.test(text), "不应留下连续 3 个以上空行");
  assert.ok(text.includes("正文一。") && text.includes("正文二。"));
});

test("Word 转换的 \\r 段落也能正确处理", () => {
  const src = "正文一。\r此阶段为闲聊环节，尽量不要透露太多事情\r组织者允许前不许翻开下一页\r正文二。";
  const { text } = stripMetaInstructions(src);
  assert.ok(text.includes("正文一。") && text.includes("正文二。"));
  assert.ok(!/组织者/.test(text) && !/此阶段/.test(text));
});

test("没有元指令的文本原样返回（不误删）", () => {
  const src = "23:10 我在帐篷里占卜。\n24:00 钟声敲响了。";
  const { text, removed } = stripMetaInstructions(src);
  assert.strictEqual(removed.length, 0);
  assert.strictEqual(text, src);
  assert.strictEqual(hasMetaInstructions(src), false);
});

test("空输入不炸", () => {
  assert.deepStrictEqual(stripMetaInstructions(""), { text: "", removed: [] });
  assert.deepStrictEqual(stripMetaInstructions(null), { text: "", removed: [] });
});
