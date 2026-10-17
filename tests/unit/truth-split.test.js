// 谜底隔离：角色提示词不得携带"凶手是谁/动机/手法"。
//
// 背景（代码审查发现的单点隐患）：角色与 NPC 提示词此前把**整份含谜底的设定集**塞给每一个角色——
// `### 凶手\n沈砚清，动机：…，手法：…`、`### 核心诡计说明书`（运作原理/隐藏方式/破绽方向）、
// 凶手真实与伪装双时间线、人物表里的【凶手】标记，全都在里面，只靠一句
// "不要直接读出真凶名字"维持。模型一旦漏嘴，扮演该角色的 AI 玩家就直接拿到答案，整局作废；
// 更隐蔽的代价是"知道答案却要装作不知道"会污染角色行为（下意识避开真凶、不敢自由怀疑）。
//
// ⚠️ 判据必须精确：**真凶的姓名本身是可以出现的**——他就在人物名单里，所有人互为嫌疑人，
// "名单里有他""他被人目击出现在某处"都是核心玩法材料（与 nameAccuses 的"提及≠指控"同一个道理）。
// 不可泄漏的是"**他就是凶手**"这件事本身，以及动机/手法/诡计原理/双时间线。
// 所以下面的断言分两层：① 谜底字符串不出现；② 公共材料（含他的名字）仍在。
//
// 每个"不出现"的断言都有对应的**阳性对照**（DM 版必须出现同一字符串），
// 否则断言可能因为拼接方式变化而变成空转。
const test = require("node:test");
const assert = require("node:assert");
const {
  outlineToText,
  buildCharacterPrompt,
  buildStructuredSummary,
} = require("../../src/script/murder-mystery-builder");

// 谜底：这些字符串只存在于"真相"里，公共事实里不会出现
const MURDERER = "沈砚清";
const MOTIVE_TEXT = "侵吞账款被死者发现，即将被送官";
const METHOD_TEXT = "在醒酒汤里下乌头碱，再把书房从内侧反锁";
const TRICK_MECH = "凶手把座钟拨慢四十分钟，制造 20:00 后才进入书房的假象。";
const REAL_LINE = "19:20 潜入后厨下毒；20:10 进书房反锁房门";
const FAKE_LINE = "整晚在大厅陪客打牌，从未离开";

const OUTLINE = {
  genre: "本格",
  coreTrick: "书房从内侧反锁，凶手从未进入",
  duration: "3小时",
  murdererCanLie: true,
  storyBackground: "民国二十六年的上海，荣氏商会会长在自己的书房中毒身亡。",
  layout: ["书房", "大厅", "后院"],
  victim: { name: "荣宗耀", identity: "商会会长", gender: "男", causeOfDeath: "乌头碱中毒", deathPlace: "书房" },
  trickSpec: {
    trick: "凶手先下毒再反锁书房",
    type: "时间诡计",
    mechanism: TRICK_MECH,
    conceal: "对外声称整晚在大厅打牌",
    breakPoint: "座钟机芯有新鲜拨动痕迹，与怀表读数相差四十分钟",
  },
  players: [
    { name: "白凤", gender: "女", identity: "二姨太", personality: "语速很快，爱抢话", goal: "隐瞒你当晚去过书房", isMurderer: false },
    { name: MURDERER, gender: "男", identity: "账房先生", personality: "慢条斯理，惯用反问", goal: "不被投出去", isMurderer: true },
  ],
  npcs: [{ name: "老王", identity: "门房" }],
  relations: [{ a: "白凤", b: MURDERER, link: "主仆", tension: "白凤发现他私改账目" }],
  murderer: {
    name: MURDERER,
    motive: MOTIVE_TEXT,
    method: METHOD_TEXT,
    realLine: REAL_LINE,
    fakeLine: FAKE_LINE,
  },
  timeline: [
    { time: "19:20", desc: "凶手在后厨往醒酒汤里下毒" },
    { time: "21:00", desc: "老王发现书房门从内侧反锁，撞门后发现尸体" },
  ],
};

/** 角色版里**不该**出现的东西（每一条都在 DM 版里有阳性对照） */
function assertNoSecrets(text, label) {
  assert.ok(!text.includes(MOTIVE_TEXT), `${label}：不得出现动机原文`);
  assert.ok(!text.includes(METHOD_TEXT), `${label}：不得出现手法原文`);
  assert.ok(!text.includes(TRICK_MECH), `${label}：不得出现诡计运作原理`);
  assert.ok(!text.includes(REAL_LINE), `${label}：不得出现凶手真实时间线`);
  assert.ok(!text.includes(FAKE_LINE), `${label}：不得出现凶手伪装时间线`);
  assert.ok(!text.includes("【凶手】"), `${label}：不得标出谁是凶手`);
  assert.ok(!text.includes("### 核心诡计说明书"), `${label}：不得有诡计说明书章节`);
  // "动机：" 只出现在凶手章节（角色的个人任务是"个人任务："，不会误伤）
  assert.ok(!text.includes("动机："), `${label}：不得出现"动机："标注`);
}

test("outlineToText：DM/成稿版保留全部谜底（同时充当下面各断言的阳性对照）", () => {
  const t = outlineToText(OUTLINE);
  assert.ok(t.includes(MOTIVE_TEXT) && t.includes(METHOD_TEXT), "DM 版必须有动机与手法");
  assert.ok(t.includes(TRICK_MECH), "DM 版必须有诡计原理");
  assert.ok(t.includes(REAL_LINE) && t.includes(FAKE_LINE), "DM 版必须有双时间线");
  assert.ok(t.includes("### 核心诡计说明书"), "DM 版必须有诡计说明书");
  assert.ok(t.includes("【凶手】"), "DM 版人物表要标出凶手");
});

test("outlineToText：角色版不含任何谜底", () => {
  assertNoSecrets(outlineToText(OUTLINE, { includeTruth: false }), "outlineToText");
});

test("outlineToText：角色版仍保留公共事实——**包括真凶的姓名**（他就在名单里）", () => {
  const t = outlineToText(OUTLINE, { includeTruth: false });
  assert.ok(t.includes("民国二十六年的上海"), "故事背景要给");
  assert.ok(t.includes("书房、大厅、后院"), "场景布局要给");
  assert.ok(t.includes("荣宗耀") && t.includes("乌头碱中毒"), "死者信息要给（死因是公开事实）");
  assert.ok(t.includes("**白凤**") && t.includes(`**${MURDERER}**`), "人物名单要给——凶手也在名单里，所有人互为嫌疑人");
  assert.ok(t.includes("人物关系网"), "关系网要给（PVP 核心材料）");
  assert.ok(t.includes("时间线骨架"), "时间线骨架要给（事件时刻是公共事实）");
  assert.ok(t.includes("性格语气：慢条斯理"), "性格语气要给（AI 扮演的抓手）");
});

test("buildStructuredSummary：角色版不含谜底，但名单仍在", () => {
  const report = {
    outline: OUTLINE,
    characters: [
      { name: "白凤", type: "player", occupation: "二姨太", isMurderer: false },
      { name: MURDERER, type: "player", occupation: "账房先生", isMurderer: true },
    ],
  };
  const full = buildStructuredSummary(report);
  assert.ok(full.includes("### 凶手手法") && full.includes(METHOD_TEXT), "阳性对照：DM 版摘要含手法");
  assert.ok(full.includes(`- 凶手：${MURDERER}`), "阳性对照：DM 版摘要点名凶手");

  assertNoSecrets(buildStructuredSummary(report, { includeTruth: false }), "buildStructuredSummary");
  assert.ok(buildStructuredSummary(report, { includeTruth: false }).includes(MURDERER), "名单仍要含他");
});

const mkPrompt = (ch, outline) =>
  buildCharacterPrompt(ch, "## 二、死者信息\n姓名与身份：荣宗耀\n", 1, 2, false, outline);

test("buildCharacterPrompt：非凶手角色的提示词不含任何谜底", () => {
  assertNoSecrets(mkPrompt({ name: "白凤", occupation: "二姨太", isMurderer: false }, OUTLINE), "角色提示词");
});

test("buildCharacterPrompt：凶手本人的提示词保留自己的作案经过（他必须知道）", () => {
  const p = mkPrompt({ name: MURDERER, occupation: "账房先生", isMurderer: true }, OUTLINE);
  assert.ok(p.includes(METHOD_TEXT), "凶手必须拿到自己的手法");
  assert.ok(p.includes(MOTIVE_TEXT), "凶手必须拿到自己的动机");
  assert.ok(p.includes(REAL_LINE), "凶手必须拿到自己的真实时间线");
});

test("buildCharacterPrompt：非凶手仍拿到做本必需的公共上下文（不缺料）", () => {
  const p = mkPrompt({ name: "白凤", occupation: "二姨太", isMurderer: false }, OUTLINE);
  assert.ok(p.includes("### 故事背景") && p.includes("民国二十六年的上海"), "背景要给");
  assert.ok(p.includes("### 死者"), "死者要给");
  assert.ok(p.includes("时间线骨架"), "时间线骨架要给");
  assert.ok(p.includes("白凤"), "自己的名字要给");
  assert.ok(p.includes(MURDERER), "真凶作为嫌疑人也应在名单里——玩家才知道要怀疑谁");
});

test("buildCharacterPrompt：PVE 侦探不再被告知真凶姓名", () => {
  const p = buildCharacterPrompt({ name: "陆探员", occupation: "巡捕房探员", isMurderer: false }, "## 二、死者信息\n姓名与身份：荣宗耀\n", 1, 1, true, OUTLINE);
  assert.ok(!/本案真凶在其中一名NPC中（/.test(p), "不得把真凶姓名写在括号里告诉他（那等于直接给答案）");
  assert.ok(/真凶在其中一名NPC中/.test(p), "仍要说明真凶在 NPC 中（游戏模式事实）");
  assertNoSecrets(p, "PVE 侦探提示词");
});

test("includeTruth 缺省为 true：不传 opts 与显式传 true 等价（DM 侧与成稿依赖默认值）", () => {
  assert.strictEqual(outlineToText(OUTLINE), outlineToText(OUTLINE, { includeTruth: true }));
  assert.ok(outlineToText(OUTLINE).includes("### 核心诡计说明书"), "成稿组装依赖默认完整版");
  assert.strictEqual(outlineToText(null, { includeTruth: false }), "");
  assert.strictEqual(outlineToText(null), "");
});
