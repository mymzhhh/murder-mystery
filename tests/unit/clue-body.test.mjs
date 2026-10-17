// 线索正文取值口径的契约（纯逻辑，无 DOM / 无 Redis / 无 PG）
//
// 这一层是这次"线索里的配图显示不出来"缺口的**入口**：
// 线索正文从服务器到渲染器之间必须先原样取出，图片行才可能被 ScriptBody 认出来。
// 所以这里锁三件事：
//   1) 字段口径（description > content > text > ""）—— 玩家端两处 + 管理端一处共用同一份；
//   2) 只取值、不加工：正文里的 ![说明](img:键名) 必须**一字不动**地传下去；
//   3) 脏输入不许抛（线索字段缺失时不能让整条线索从界面上消失）。
import test from "node:test";
import assert from "node:assert";
import { clueBodyText } from "../../frontend/src/lib/clue-body.mjs";
import { collectImageRefs, buildBodyNodes } from "../../frontend/src/lib/script-body.mjs";

test("字段口径：description > content > text > 空串", () => {
  assert.strictEqual(clueBodyText({ description: "D", content: "C", text: "T" }), "D");
  assert.strictEqual(clueBodyText({ content: "C", text: "T" }), "C", "玩家端/复盘/测试房都是 content");
  assert.strictEqual(clueBodyText({ text: "T" }), "T");
  assert.strictEqual(clueBodyText({}), "");
  assert.strictEqual(clueBodyText({ content: "" }), "", "空串不算取到，继续往下找");
  assert.strictEqual(clueBodyText({ content: "", text: "T" }), "T");
  // 非字符串字段不能冒充正文（否则 [object Object] 会直接打到界面上）
  assert.strictEqual(clueBodyText({ content: { a: 1 }, text: "T" }), "T");
  assert.strictEqual(clueBodyText({ content: 42 }), "");
});

test("脏输入不抛、也不返回非字符串（线索不能因为字段缺失就整条不显示）", () => {
  for (const v of [null, undefined, "", 0, false, [], {}]) {
    const out = clueBodyText(v);
    assert.strictEqual(typeof out, "string", `clueBodyText(${JSON.stringify(v)}) 必须返回字符串`);
  }
  assert.strictEqual(clueBodyText(null), "");
  assert.strictEqual(clueBodyText(undefined), "");
  assert.strictEqual(clueBodyText("已经是正文了"), "已经是正文了", "容错：直接传正文也算");
});

test("红线：图片行必须原样传下去（这一层一旦裁剪，线索里的图就永远看不见）", () => {
  // 这就是《吉普赛女郎之死》B1 的真实形状：一句正文 + 独立成行的图片引用
  const b1 = {
    clueId: "B1",
    location: "卡门尸体",
    round: 2,
    content: "尸体正面左胸有一个伤口，贯穿后背，形状如下：\n![线索·图片1](img:cluedoc-1)",
  };
  const out = clueBodyText(b1);
  assert.strictEqual(out, b1.content, "一字不差（连换行都不能动：图片行必须仍然独立成行）");
  assert.deepStrictEqual([...collectImageRefs(out).keys()], ["cluedoc-1"], "取出来的正文仍能被图片解析认到");

  // 图片行**独立成行**是硬约定：同一个渲染器靠 buildBodyNodes 判行，
  // 若取值这一层把换行吃掉（例如 trim/合并空白），图片就退化成一行文本。
  const nodes = buildBodyNodes(out);
  assert.deepStrictEqual(nodes.map((n) => n.kind), ["line", "image"]);
  assert.strictEqual(nodes[1].alt, "线索·图片1");
});

test("整条线索只有一张图（没有正文）时也要照样传下去，不能被当成空内容丢掉", () => {
  const onlyImg = { content: "![线索·图片2](img:cluedoc-2)" };
  const out = clueBodyText(onlyImg);
  assert.notStrictEqual(out, "", "非空 —— 渲染层靠它决定要不要渲染正文块");
  assert.deepStrictEqual(buildBodyNodes(out).map((n) => n.kind), ["image"]);
});
