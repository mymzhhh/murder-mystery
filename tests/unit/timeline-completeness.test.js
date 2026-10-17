// 单元测试：角色剧本时间线完整性校验 + 交叉校验送检覆盖
// 背景：实测最新剧本出现「个人剧本时间线只有 1 条（82 字）」以及「交叉校验只看前 14000 字」两个缺陷。
const test = require("node:test");
const assert = require("node:assert");
const {
  MIN_TIMELINE_POINTS,
  countTimelinePoints,
  extractCharacterTimeline,
  ensureTimelineComplete,
  buildCrossCheckDigest,
  applyPatches,
  buildSectionDigest,
  reviseByCrossCheck,
} = require("../../src/script/murder-mystery-builder");

// ==================== 夹具 ====================

/** 合规：8 个时间点 */
const COMPLIANT = `## 林伟 个人剧本

### 一、你的背景故事
我与张伟有旧怨。

### 二、你的时间线
- **十月十七日 20:30**：抵达庄园，陈叔引我入套房。
- **十月十七日 21:00**：在客厅与张伟交谈。
- **十月十七日 21:30**：晚宴结束，我留在客厅。
- **十月十七日 21:40**：与苏晴争吵。
- **十月十七日 21:45**：停电，我仍在客厅。
- **十月十七日 21:55**：听见楼上响动。
- **十月十七日 22:00**：有人提议查看电路。
- **十月十七日 22:05**：随众人上楼。

### 三、你的任务
1. 找出真凶。
`;

/** 不合格：时间线只有 1 条（复刻实测的 82 字情形） */
const STUB = `## 李娜 个人剧本

### 一、你的背景故事
我是张伟的私人律师。

### 二、你的时间线
- **20:30**：抵达寂静庄园。

### 三、你的任务
1. 找出真凶。
`;

/** 不合格：整段没有章节结构（复刻苏晴的情形） */
const NO_SECTION = `## 苏晴 个人剧本

我是苏晴，张伟的妻子。这是一大段没有任何三级标题的连续叙述，
模型有时会完全忽略章节结构，把整本写成一段散文。
`;

const BETTER = COMPLIANT.replace("林伟", "李娜").replace("- **十月十七日 20:30**：抵达庄园，陈叔引我入套房。", "- **20:30**：抵达寂静庄园。");

// ==================== countTimelinePoints ====================

test("countTimelinePoints：识别 HH:MM 并去重", () => {
  const n = countTimelinePoints("- **20:30**：抵达\n- **20:30**：重复\n- **21:45**：停电");
  assert.strictEqual(n, 2);
});

test("countTimelinePoints：识别中文时辰/时段", () => {
  const n = countTimelinePoints("戌时二刻抵达；晚上八点开宴；深夜十一点离开");
  assert.ok(n >= 3, `期望至少 3 个，实际 ${n}`);
});

test("countTimelinePoints：全角冒号与半角冒号等价", () => {
  assert.strictEqual(countTimelinePoints("20:30 抵达"), countTimelinePoints("20：30 抵达"));
});

test("countTimelinePoints：空值安全", () => {
  assert.strictEqual(countTimelinePoints(""), 0);
  assert.strictEqual(countTimelinePoints(null), 0);
  assert.strictEqual(countTimelinePoints(undefined), 0);
});

// ==================== extractCharacterTimeline ====================

test("extractCharacterTimeline：取出时间线章节正文", () => {
  const body = extractCharacterTimeline(COMPLIANT);
  assert.ok(body && body.includes("20:30"), "应取到时间线正文");
  assert.ok(!body.includes("找出真凶"), "不应越界取到下一章节");
});

test("extractCharacterTimeline：无章节结构时返回 null", () => {
  assert.strictEqual(extractCharacterTimeline(NO_SECTION), null);
});

test("extractCharacterTimeline：排除基准类章节（故事/真实/表面/完整时间线）", () => {
  const text = `## 六、故事时间线
- 20:30 全员抵达

### 二、你的时间线
- **21:45**：停电
`;
  const body = extractCharacterTimeline(text);
  assert.ok(body && body.includes("21:45"), "应跳过基准章节，取到角色时间线");
  assert.ok(!body.includes("全员抵达"), "不应把基准章节当成角色时间线");
});

// ==================== ensureTimelineComplete ====================

test("ensureTimelineComplete：合规剧本原样返回，且不触发补写", async () => {
  let called = 0;
  const out = await ensureTimelineComplete("林伟", COMPLIANT, async () => { called++; return COMPLIANT; });
  assert.strictEqual(out, COMPLIANT);
  assert.strictEqual(called, 0);
});

test("ensureTimelineComplete：时间线只有 1 条时触发补写", async () => {
  let called = 0;
  const out = await ensureTimelineComplete("李娜", STUB, async () => { called++; return BETTER; });
  assert.strictEqual(called, 1, "应触发一次补写");
  assert.ok(countTimelinePoints(extractCharacterTimeline(out)) >= MIN_TIMELINE_POINTS, "应采用补写后的版本");
});

test("ensureTimelineComplete：缺时间线章节时触发补写", async () => {
  let called = 0;
  const out = await ensureTimelineComplete("苏晴", NO_SECTION, async () => { called++; return COMPLIANT; });
  assert.strictEqual(called, 1);
  assert.ok(extractCharacterTimeline(out) !== null, "补写后应有时间线章节");
});

test("ensureTimelineComplete：补写仍不达标时保留原稿", async () => {
  const out = await ensureTimelineComplete("李娜", STUB, async () => STUB);
  assert.strictEqual(out, STUB, "补写没有改善，应保留原稿");
});

test("ensureTimelineComplete：补写抛错时保留原稿（不阻塞主流程）", async () => {
  const out = await ensureTimelineComplete("李娜", STUB, async () => { throw new Error("LLM 挂了"); });
  assert.strictEqual(out, STUB);
});

test("ensureTimelineComplete：补写内容更差时保留更好的那份", async () => {
  const worse = STUB.replace("### 二、你的时间线\n- **20:30**：抵达寂静庄园。", "### 二、你的时间线\n无");
  const out = await ensureTimelineComplete("李娜", STUB, async () => worse);
  assert.strictEqual(out, STUB, "补写更差时应保留原稿");
});

// ==================== buildCrossCheckDigest ====================

test("buildCrossCheckDigest：覆盖全部角色（回归：旧实现只看前 14000 字）", () => {
  // 造一段超过 14000 字的无关叙述，把后面角色的时间线推到 14000 字之外
  const pad = "无关的背景叙述内容。".repeat(1800); // 约 18000 字
  const full = [
    "# 完整剧本",
    "### 玩家角色 1：赵刚",
    pad,
    "### 二、我的时间线",
    "- **20:30**：抵达庄园。",
    "- **21:45**：停电。",
    "### 玩家角色 6：王浩",
    "### 二、你的时间线",
    "- **21:00**：向张伟汇报。",
    "- **22:30**：回套房。",
  ].join("\n");

  // 旧实现的行为：前 14000 字根本看不到最后一个角色
  assert.ok(!full.substring(0, 14000).includes("王浩"), "夹具应能让旧实现漏掉最后一名角色");

  const digest = buildCrossCheckDigest(full, 16000);
  assert.ok(digest.includes("赵刚"), "摘要应包含第一个角色");
  assert.ok(digest.includes("王浩"), "摘要应包含最后一个角色（旧实现会漏掉）");
});

test("buildCrossCheckDigest：无时间线章节时回退为开头片段", () => {
  const digest = buildCrossCheckDigest(NO_SECTION, 4000);
  assert.ok(digest.includes("苏晴"), "回退时至少包含剧本开头内容");
  assert.ok(digest.includes("未能提取角色时间线章节"), "应给出回退说明");
});

test("buildCrossCheckDigest：基准章节被单独标注而非混入待审", () => {
  const full = `### 玩家角色 1：林伟
### 二、你的时间线
- **21:45**：停电。
### 三、完整时间线
- 20:30 全员抵达。
`;
  const digest = buildCrossCheckDigest(full, 8000);
  assert.ok(digest.includes("基准时间线"), "基准章节应单独成块");
});

// ==================== applyPatches（交叉校验定向修订） ====================

test("applyPatches：精确匹配替换", () => {
  const src = "设定：凶手用黄铜地球仪击打。出处：书房。";
  const { text, applied, skipped } = applyPatches(src, [{ oldText: "凶手用黄铜地球仪击打", newText: "凶手用青铜镇纸击打" }]);
  assert.strictEqual(applied, 1);
  assert.strictEqual(skipped, 0);
  assert.ok(text.includes("青铜镇纸"));
  assert.ok(!text.includes("黄铜地球仪"));
});

test("applyPatches：空白天差异时走归一化兜底", () => {
  const src = "第一段。\n\n  主钟比标准时间快了约 15 分钟，而客钟慢了 10 分钟。\n第三段。";
  // oldText 故意去掉换行与多余空格
  const { text, applied } = applyPatches(src, [{
    oldText: "主钟比标准时间快了约15分钟，而客钟慢了10分钟。",
    newText: "主钟比标准时间快了约5分钟。",
  }]);
  assert.strictEqual(applied, 1);
  assert.ok(text.includes("快了约5分钟"));
  assert.ok(text.includes("第一段"), "替换不应破坏其它段落");
});

test("applyPatches：定位失败计入 skipped，不改动原文", () => {
  const src = "原文内容。";
  const { text, applied, skipped } = applyPatches(src, [{ oldText: "这段文字在原文里根本不存在呢", newText: "替换" }]);
  assert.strictEqual(applied, 0);
  assert.strictEqual(skipped, 1);
  assert.strictEqual(text, src);
});

test("applyPatches：过短/缺字段/非对象的补丁被跳过", () => {
  const src = "一段足够长的原文内容用于测试。";
  const { applied, skipped } = applyPatches(src, [
    { oldText: "短", newText: "x" },              // 过短
    { oldText: "一段足够长的原文内容用于测试。", newText: "" }, // newText 为空
    { newText: "只有新文本" },                     // 缺 oldText
    null,
  ]);
  assert.strictEqual(applied, 0);
  assert.strictEqual(skipped, 4);
});

test("applyPatches：多补丁按顺序应用", () => {
  const src = "AAA 第一处描述需要被修正掉 BBB 第二处描述也需要被修正掉 CCC";
  const { text, applied } = applyPatches(src, [
    { oldText: "第一处描述需要被修正掉", newText: "第一处描述已修正" },
    { oldText: "第二处描述也需要被修正掉", newText: "第二处描述已修正" },
  ]);
  assert.strictEqual(applied, 2);
  assert.ok(text.includes("第一处描述已修正") && text.includes("第二处描述已修正"));
});

// ==================== buildSectionDigest ====================

test("buildSectionDigest：覆盖全部标题段（超长剧本的退路）", () => {
  const full = [
    "# 剧本",
    "### 玩家角色 1：林伟",
    "背景".repeat(3000),
    "### 玩家角色 6：王浩",
    "背景".repeat(3000),
  ].join("\n");
  const digest = buildSectionDigest(full, 2000);
  assert.ok(digest.includes("玩家角色 1：林伟"));
  assert.ok(digest.includes("玩家角色 6：王浩"), "每一段都应在摘要中占位");
});

// ==================== reviseByCrossCheck ====================

test("reviseByCrossCheck：无问题时原样返回且不调用 LLM", async () => {
  const src = "剧本内容";
  assert.strictEqual(await reviseByCrossCheck(src, [], null), src);
  assert.strictEqual(await reviseByCrossCheck(src, ["   ", null], null), src);
});
