// extractSection 的边界规则
//
// 实测事故（2026-10-18）：生成的 DM 手册里「真相复盘」下面是 `### 1. 凶手完整作案过程`
// `### 2. 全部线索逐条解析`、再往下一层是 `#### 第一轮线索`。
// 旧实现用「第[一二三四五六]」当边界启发式，**被 `第一轮线索` 命中了** ——
// 于是 27000 字的成稿里，「真相复盘」只被抠出 718 字落库，长复盘被静默丢掉。
const test = require("node:test");
const assert = require("node:assert");
const { extractSection } = require("../../src/script/script-parser.js");

const DM = [
  "### 三、完整时间线",
  "21:00 王建国在前厅",
  "### 四、真相复盘",
  "#### 1. 凶手完整作案过程",
  "赵磊在 21:10 调慢挂钟。",
  "#### 2. 全部线索逐条解析（共22条，无遗漏）",
  "##### 第一轮线索（10条）",
  "1. 前厅挂钟：对比时间差，是时间诡计的核心。",
  "2. 维修间挂钟：停摆时间即真实死亡时间。",
  "##### 第二轮线索（12条）",
  "1. 死者指甲缝：有发条金属屑。",
  "### 五、QA 问答清单",
  "问：死亡时间？答：22:35。",
].join("\n");

test("深层子标题（#### / #####）不得截断父节", () => {
  const s = extractSection(DM, "真相复盘", 12000);
  assert.ok(s.includes("凶手完整作案过程"), "应包含第一小节");
  assert.ok(s.includes("全部线索逐条解析"), "应包含第二小节");
  assert.ok(s.includes("第一轮线索"), "**这正是旧实现被截断的地方**");
  assert.ok(s.includes("发条金属屑"), "第二轮线索也要在");
  assert.ok(!s.includes("QA 问答清单"), "同级（###）的下一个章节必须排除");
});

test("同级章节边界正确：只取本节", () => {
  const s = extractSection(DM, "完整时间线", 12000);
  assert.ok(s.includes("21:00 王建国在前厅"));
  assert.ok(!s.includes("赵磊在 21:10"), "不能吃到下一节");
});

test("maxLen 仍然生效（超出时截断并加省略号）", () => {
  const long = "### 四、真相复盘\n" + "很长的复盘内容。".repeat(200);
  const s = extractSection(long, "真相复盘", 100);
  // maxLen 是正文上限，末尾会再加 3 个点，所以长度是 103
  assert.ok(s.length <= 103, `必须截到上限内，实际 ${s.length}`);
  assert.ok(s.endsWith("..."));
});

test("找不到该标题时返回空串", () => {
  assert.strictEqual(extractSection("### 一、别的\n内容", "真相复盘", 100), "");
  assert.strictEqual(extractSection("", "真相复盘", 100), "");
});
