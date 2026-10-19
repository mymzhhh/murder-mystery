// 正文引用配图：真本线索正文里写着 `![线索·图片3](img:cluedoc-3)`，前端会渲染成真图。
// 我们此前是"先随便出几张图再挂上去"，正文一个引用都没有 → 图只是装饰，
// 玩家推不出"弹道示意/账本笔迹"这类信息（审计里"正文引用图 0"就是这条）。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const si = require("../../src/script/script-images.js");

const MD = [
  "## 第二轮线索",
  "### B7：现场2｜营地第二现场（第2轮）",
  "- 线索类型：物证",
  "- 发现地点：大帐",
  "- 线索内容：帐篷门口有一把 0.38 口径转轮手枪，弹匣内子弹分布如图：",
  "![线索·图片1](img:cluedoc-1)",
  "",
  "### B8：现场2",
  "- 线索类型：物证",
  "- 线索内容：桌上有一个水杯。",
  "",
  "### A2：甲｜大堂（第1轮）",
  "- 线索内容：账本上有涂改痕迹。",
  "![线索·图片2](img:cluedoc-2)",
  "",
].join("\n");

test("收集正文里的 img: 引用（键名 + alt + 所在线索上下文）", () => {
  const refs = si.collectImageRefs(MD);
  assert.deepStrictEqual(refs.map((r) => r.key), ["cluedoc-1", "cluedoc-2"]);
  assert.strictEqual(refs[0].alt, "线索·图片1");
  assert.ok(refs[0].context.includes("转轮手枪"), "要带回线索上下文，供出图提示词使用");
  assert.ok(refs[1].context.includes("涂改痕迹"));
});

test("出图提示词从线索内容推，而不是通用模板", () => {
  const refs = si.collectImageRefs(MD);
  const p = si.buildClueImagePrompt(refs[0]);
  assert.ok(p.includes("转轮手枪"), "提示词要带上线索内容，否则出来的图与线索无关");
  assert.ok(p.includes("无文字") || p.includes("不得出现任何文字"));
});

test("按引用出图：引用过的键不再重复生成", () => {
  const jobs = si.planImageJobs({ scriptText: MD, options: { cover: true, clues: 2, characters: false } });
  const keys = jobs.map((j) => j.key);
  assert.strictEqual(keys.filter((k) => k === "cluedoc-1").length, 1, "cluedoc-1 不能出两次");
  assert.ok(keys.includes("cover"));
  assert.ok(keys.includes("cluedoc-1") && keys.includes("cluedoc-2"));
});

test("正文引用的图排在最前（碎图比少几张立绘严重）", () => {
  const jobs = si.planImageJobs({
    scriptText: MD,
    characters: [{ name: "甲" }],
    options: { cover: true, characters: true },
  });
  const keys = jobs.map((j) => j.key);
  assert.ok(keys.indexOf("cluedoc-1") < keys.indexOf("char-1-1"), "引用图要先于立绘生成");
});

test("没有引用时不产出 cluedoc（不凭空造图）", () => {
  const jobs = si.planImageJobs({ scriptText: "### A1：甲\n- 线索内容：普通线索。", options: { cover: true } });
  assert.deepStrictEqual(jobs.map((j) => j.key), ["cover"]);
});

test("clueRefs:false 可以关掉（默认开启）", () => {
  const jobs = si.planImageJobs({ scriptText: MD, options: { cover: true, clueRefs: false } });
  assert.deepStrictEqual(jobs.map((j) => j.key), ["cover"]);
});

test("线索模板必须要求写图片引用（否则模型永远不会产出 img: 引用）", () => {
  const tpl = require("../../src/templates/murder-mystery/clues.js");
  assert.ok(/img:cluedoc-/.test(tpl), "模板里要有 img:cluedoc-N 的写法示例");
  assert.ok(/独立成行/.test(tpl), "要明确要求独立成行");
});
