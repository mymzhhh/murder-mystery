// 隐藏线索解析：`- 隐藏线索：` 必须落在同一线索块的 hiddenContent 里。
//
// 背景（2026-10-18）：真本《吉普赛女郎之死》45 条线索里有 8 条带隐藏层
// （玩家花一次"深入调查"才拿到），而我们的系统此前**完全没有这个机制**。
// 生成端现在会写这种格式，解析端必须认得，否则隐藏内容会被当成普通正文混进线索里 ——
// 那等于不用调查就能看到，机制失效。
const test = require("node:test");
const assert = require("node:assert");
const { parseScript } = require("../../src/script/script-parser.js");

const MD = [
  "## 第三部分：线索系统",
  "## 第二轮线索",
  "### B3：",
  "- 线索类型：物证",
  "- 发现地点：维修间",
  "- 线索内容：电表箱内部的保险丝被人为切断。",
  "- 隐藏线索：电表箱内还有土制爆炸痕迹与隐形摄像机碎片。",
  "",
  "### B4：",
  "- 线索类型：痕迹",
  "- 发现地点：走廊",
  "- 线索内容：地面有拖痕。",
  "",
].join("\n");

test("隐藏线索进 hiddenContent，不混进正文", () => {
  const parsed = parseScript(MD);
  const all = [...(parsed.clues.round1 || []), ...(parsed.clues.round2 || [])];
  const b3 = all.find((c) => c.id === "B3");
  assert.ok(b3, "B3 应被解析出来");
  assert.ok(b3.content.includes("保险丝"), "正文应保留公开部分");
  assert.ok(!b3.content.includes("隐形摄像机"), "隐藏内容不得混进正文");
  assert.ok(b3.hiddenContent.includes("隐形摄像机"), "隐藏内容应在 hiddenContent");
});

test("没有隐藏层的线索 hiddenContent 为空", () => {
  const parsed = parseScript(MD);
  const all = [...(parsed.clues.round1 || []), ...(parsed.clues.round2 || [])];
  const b4 = all.find((c) => c.id === "B4");
  assert.strictEqual(b4.hiddenContent, "");
});

test("隐藏内容支持多行续写", () => {
  const md = [
    "## 第三部分：线索系统",
  "## 第二轮线索",
    "### B1：",
    "- 线索类型：物证",
    "- 发现地点：展厅",
    "- 线索内容：说明牌被换过。",
    "- 隐藏线索：背面还有一行小字，",
    "  记录着原件的入库编号。",
    "",
  ].join("\n");
  const parsed = parseScript(md);
  const b1 = [...(parsed.clues.round1 || []), ...(parsed.clues.round2 || [])].find((c) => c.id === "B1");
  assert.ok(b1.hiddenContent.includes("小字"));
  assert.ok(b1.hiddenContent.includes("入库编号"), "续行应并入隐藏内容");
});
