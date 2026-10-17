// 单元测试：时间线小节的**标题形态**识别（后端 timeline-utils）。
//
// 修的真缺口（2026-10-17）：原实现只认 markdown 的 `### ...时间线`，而真实剧本（商业本）
// 普遍用 `【三、时间线（严格遵循全局时间线）】` 或加粗 `**时间线**` —— 于是这一类剧本的
// 时间线对后端完全不可见。实测《吉普赛女郎之死（再见卡门）》4 个角色都有时间线小节，一个都读不到。
// 前端 `frontend/src/lib/player-timeline.mjs` 里有同一套规则，两边必须一致。
const test = require("node:test");
const assert = require("node:assert");
const { extractCharacterTimeline, countTimelinePoints } = require("../../src/script/murder-mystery-builder");

test("markdown 小节：原行为不变（这是本项目自己生成的格式）", () => {
  const s = [
    "### 一、你的背景故事",
    "我是放映员。",
    "### 二、你的时间线",
    "- **10月16日 20:30**：放映厅 — 我在门口听见争吵",
    "- **10月16日 21:00**：走廊 — 有人走过",
    "### 三、你的任务",
    "藏住胶片。",
  ].join("\n");
  const body = extractCharacterTimeline(s);
  assert.ok(body.includes("20:30") && body.includes("21:00"));
  assert.ok(!body.includes("藏住胶片"), "必须在下一个三级标题处结束");
  assert.strictEqual(countTimelinePoints(body), 2);
});

test("真实剧本形态①：【三、时间线（严格遵循全局时间线，精确到分钟）】也要能认出来", () => {
  const s = [
    "### 一、人物关系",
    "他与死者是雇佣关系。",
    "### 三、时间线（严格遵循全局时间线，精确到分钟）",
    "- **10月12日 20:30（座钟）**：大厅 — 看见阿明上楼",
    "- **10月12日 21:15（真实）**：楼梯口 — 听见争吵",
    "### 四、需要隐瞒或可供审讯透露的信息",
    "- 他弄坏了铁门锁芯。",
  ].join("\n");
  const body = extractCharacterTimeline(s);
  assert.ok(body !== null, "带括号注记的【】时间线小节必须能被抽出来");
  assert.strictEqual(countTimelinePoints(body), 2);
  assert.ok(!body.includes("弄坏了铁门"), "必须在下一个【】小节处结束");
});

test("真实剧本形态②：加粗 **时间线** 标题也要能认", () => {
  const s = ["**人物关系**", "同事。", "**时间线**", "- 18:00 在门口", "- 19:30 上楼", "**任务**", "隐瞒。"];
  const body = extractCharacterTimeline(s.join("\n"));
  assert.ok(body !== null);
  assert.strictEqual(countTimelinePoints(body), 2);
  assert.ok(!body.includes("隐瞒"));
});

test("真实剧本形态③：【推荐自我介绍及时间线】里的散文也要能抽出来（占卜师那份的真实形状）", () => {
  // 实测《占卜师》的该节只有一段散文，时刻 23：50 夹在句中 —— 只要标题被认出来，
  // 后端 countTimelinePoints 是**按出现次数**统计时刻的（不要求行首），所以能算出 1 个点。
  const s = [
    "【你的任务】",
    "隐瞒你的身份。",
    "【推荐自我介绍及时间线】",
    "我是塞维利亚德高望重的占卜师，与诸位萍水相逢无冤无仇，23：50之后我目击了一些重要的事，回到住处后就被带来了这里。",
  ].join("\n");
  const body = extractCharacterTimeline(s);
  assert.ok(body, "【推荐自我介绍及时间线】必须被认成时间线小节");
  assert.ok(body.includes("23：50"), "散文里那句要原样在正文里");
  assert.strictEqual(countTimelinePoints(body), 1);
});

test("他人视角/基准类标题不算角色自己的时间线（含加【】的形态）", () => {
  for (const head of ["### 真实时间线", "【完整时间线】", "**故事时间线**", "### 上帝时间线"]) {
    const s = [head, "- 20:00 凶手进书房下毒", "### 三、你的任务", "隐瞒。"].join("\n");
    assert.strictEqual(extractCharacterTimeline(s), null, `${head} 不应被当成角色自己的时间线`);
  }
});

test("完全没有时间线小节 → null（而不是空串：调用方靠这个区分「没这一节」和「这一节是空的」）", () => {
  const s = ["### 一、你的背景故事", "我是医生。", "### 三、你的任务", "隐瞒。"].join("\n");
  assert.strictEqual(extractCharacterTimeline(s), null);
  assert.strictEqual(extractCharacterTimeline(""), null);
  assert.strictEqual(extractCharacterTimeline(null), null);
});
