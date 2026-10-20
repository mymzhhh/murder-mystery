// 线索模板的关键约束（防止改模板时把踩过坑的规则改没）
const test = require("node:test");
const assert = require("node:assert");
const T = require("../../src/templates/murder-mystery/clues.js");

test("隐藏线索必须是「父标记 + 独立编号子线索」的真本写法", () => {
  assert.ok(T.includes("发现隐藏线索，可深入调查"), "要有父线索标记");
  assert.ok(T.includes("通过深入调查"), "要有子线索引用格式");
  assert.ok(T.includes("独立编号"), "子线索必须有自己的编号");
});

test("必须要求「最后一块拼图」式的隐藏线索（2026-10-20 三本自评都丢在这一项）", () => {
  assert.ok(T.includes("最后一块拼图"), "要有这条硬性要求");
  assert.ok(/缩?小到两个人|定不了案/.test(T), "要说清「缺它就定不了案」的具体标准");
});

test("不要退回已废弃的字段式隐藏线索写法", () => {
  assert.ok(T.includes("旧格式，已废弃"), "要明确禁止「- 隐藏线索：」写法");
});
