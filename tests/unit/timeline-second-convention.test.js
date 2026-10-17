// 单元测试：时间线的**第二种真实写法**（只用日期、不写时刻）必须被出声拦截，不能静默放过。
//
// 背景（真库实测，294 份角色剧本）：真实剧本里时间线的写法有两种——
//   ① `- 20:30 我在放映厅门口…`（行首或行内带**时刻**）——占多数，也是我们模板强制的写法；
//   ② 只有**日期**、通篇不出现时刻（最典型的是《053-传说中的故事》：整本 0 个时刻、106 行带日期）。
//
// 我们**故意不采纳**写法②，原因是产品约束而不是审美：
//   本项目的回合解锁、座钟显示、跨午夜判定、死后活动校验全都**以时刻为锚**，
//   没有时刻的时间线无法参与这些判定。
//
// 但"不采纳"必须是**出声的**：`countTimelinePoints` 对写法②会返回 0，
// 于是 ensureTimelineComplete 的 `points >= MIN_TIMELINE_POINTS` 不成立 → 触发补写。
// 这个测试就是钉住"它确实出声了"——否则模型真写出写法②时，
// 整份角色剧本会带着一张无法参与判定的时间线静默进入成品。
const test = require("node:test");
const assert = require("node:assert");
const {
  MIN_TIMELINE_POINTS,
  countTimelinePoints,
  extractCharacterTimeline,
  ensureTimelineComplete,
} = require("../../src/script/murder-mystery-builder");

// ⚠️ 事件文字要避开"点/整/半"与"凌晨/傍晚/深夜+数字"这些会被计数的词，
// 否则测的就不是"只有日期"这个性质了。
const DATE_ONLY = [
  "### 一、你的背景故事",
  "",
  "我是红星录像厅的放映员。",
  "",
  "### 二、你的时间线",
  "",
  "- 10月16日：我在放映厅门口听见争吵",
  "- 10月16日：我回到走廊把旧胶片收好",
  "- 10月16日：门缝里能看见他的背影",
  "- 10月16日：我把胶片穿过门缝",
  "- 10月16日：内侧门闩被闩上",
  "- 10月16日：我下楼与李姐说了两句",
  "- 10月16日：我在楼梯口听见机器还在转",
  "- 10月17日：我在后院把剩下的胶片处理掉",
  "- 10月17日：众人发现放映室门反锁",
  "- 10月17日：众人撞门",
  "- 10月17日：警察到场",
  "- 10月17日：我确认灰烬没人动过",
  "",
  "### 三、你的任务",
  "",
  "藏住胶片。",
].join("\n");

// 我们模板强制的写法：`- **月日 时刻**：房间名 — 事件`
const WITH_CLOCK = [
  "### 一、你的背景故事",
  "",
  "我是红星录像厅的放映员。",
  "",
  "### 二、你的时间线",
  "",
  "- **10月16日 20:30**：放映厅 — 我在门口听见争吵",
  "- **10月16日 20:50**：走廊 — 我取走一卷旧胶片",
  "- **10月16日 21:10**：放映室门外 — 门缝里能看见他背影",
  "- **10月16日 21:30**：二楼平台 — 我把胶片穿过门缝",
  "- **10月16日 21:45**：放映室门外 — 闩上了内侧门闩",
  "- **10月16日 22:00**：一楼大堂 — 与李姐说了两句",
  "- **10月16日 22:20**：楼梯口 — 听见楼上机器还在转",
  "- **10月16日 22:40**：后院 — 把剩下的胶片烧掉",
  "- **10月16日 23:05**：大厅 — 众人发现门反锁",
  "- **10月16日 23:20**：放映室门口 — 众人撞门",
  "- **10月16日 23:50**：大堂 — 警察到场",
  "- **10月17日 00:30**：后院 — 确认灰烬没人动过",
  "",
  "### 三、你的任务",
  "",
  "藏住胶片。",
].join("\n");

test("写法②（只有日期、没有时刻）：时间线章节能被抽出，但时间点计为 0", () => {
  const body = extractCharacterTimeline(DATE_ONLY);
  assert.ok(body, "「时间线」章节本身必须能被抽出（否则问题是解析失败，不是写法差异）");
  assert.ok(body.includes("10月16日"), "抽出的正文应含日期行");
  assert.strictEqual(countTimelinePoints(body), 0,
    "只有日期、没有时刻的时间线，时间点必须计为 0 —— 这正是触发补写的依据");
});

test("写法①（我们强制的 `月日 时刻` 写法）：12 条都被计到", () => {
  const body = extractCharacterTimeline(WITH_CLOCK);
  assert.ok(body);
  assert.strictEqual(countTimelinePoints(body), 12);
  assert.ok(12 >= MIN_TIMELINE_POINTS);
});

test("写法②必须**出声拦截**：不含时刻的时间线要触发补写，且纠正说明里点明了问题", async () => {
  let called = 0;
  let noteSeen = "";
  const better = WITH_CLOCK;
  const out = await ensureTimelineComplete("阿明", DATE_ONLY, async (note) => {
    called++;
    noteSeen = note;
    return better;
  });
  assert.strictEqual(called, 1, "时间点计为 0 时必须调用一次补写，不能静默放过");
  assert.match(noteSeen, /0 个时间点/, "纠正说明里必须写出实际时间点数");
  assert.match(noteSeen, new RegExp(`至少 ${MIN_TIMELINE_POINTS} 个时间点`), "纠正说明里必须写出要求值");
  assert.strictEqual(out, better, "补写后时间点更多，应采纳补写稿");
});

test("写法①达标时不得触发补写（避免无谓地多跑一遍角色剧本）", async () => {
  let called = 0;
  const out = await ensureTimelineComplete("阿明", WITH_CLOCK, async () => { called++; return WITH_CLOCK; });
  assert.strictEqual(called, 0);
  assert.strictEqual(out, WITH_CLOCK);
});
