// 单元测试：成稿里的「死亡时间」不许是空标签。
//
// 实测（两本真跑出来的稿都有这个问题）：
//   ## 三、死者信息
//   - **姓名与身份**：邱长贵（红星录像厅老板）
//   - **死亡时间**：            ← 后面什么都没有
//   - **死亡地点**：放映室
//
// 根因不是模型没写：框架提示词里确实要求过"死亡时间"，是大纲的 victim 结构
// **没有 deathTime 这个字段**（只有 name/identity/gender/causeOfDeath/deathPlace），
// 于是它在"框架 → 大纲结构"这一步被丢掉了，渲染时又照样把标签打出来。
//
// 这条测试钉两件事：
//   ① 能判得出来时必须回填真实时刻（用 findDeathMoment —— 与"死者死后不得再活动"
//      那层约束同源，不会自相矛盾）；
//   ② 判不出来时**不许写占位语**：script-parser 会把标签后的文本原样当 deathTime 存进
//      结构化数据，占位语会一路流到 AI 玩家提示词里（ai-player-llm 会念"死亡时间 （见…）"）。
const test = require("node:test");
const assert = require("node:assert");
const { assembleScript, findDeathMoment } = require("../../src/script/murder-mystery-builder");
const { parseScript } = require("../../src/script/script-parser");

const CHARACTERS = [
  { name: "阿明", type: "player", occupation: "放映员", isMurderer: true },
  { name: "李叔", type: "npc", occupation: "售票员", isMurderer: false },
];

function build(victim, timeline) {
  const report = {
    isPVE: false,
    outline: {
      title: "红星录像厅",
      era: "2005年",
      location: "南方小城",
      duration: "3小时",
      storyBackground: "拆迁前夜放映室命案",
      layout: ["放映室", "大堂"],
      victim,
      players: [{ name: "阿明", gender: "男", identity: "放映员", isMurderer: true }],
      npcs: [{ name: "李叔", gender: "男", identity: "售票员", isMurderer: false }],
      murderer: { name: "阿明", motive: "讨薪", method: "压片轮击打后脑" },
      timeline,
    },
    characters: CHARACTERS,
    framework: [
      "## 一、基本设定",
      "- **剧本名称**：《红星录像厅》",
      "- **时代背景**：2005年",
      "- **地点场景**：南方小城",
      "- **参与人数**：1",
      "- **游戏时长**：3小时",
      "- **难度等级**：中等",
      "",
      "## 二、故事背景",
      "拆迁前夜，老板死在放映室。",
    ].join("\n"),
    characterScripts: {
      "阿明": "### 一、你的背景故事\n我是放映员。\n\n### 二、你的时间线\n- **10月16日 22:28**：放映室 — 我动了手\n",
      "李叔": "### 一、人物关系\n我是售票员。\n",
    },
    clues: "### A1：压片轮\n线索类型：物证\n发现地点：放映室\n线索内容：金属压片轮上有油性残留。\n",
    layoutText: "放映室在二楼，大堂在一楼。",
  };
  return assembleScript(report, "测试");
}

// 真实形态：大纲 victim 没有 deathTime，而时间线里那一条判得出来
const REAL_VICTIM = { name: "邱长贵", identity: "录像厅老板", gender: "男", causeOfDeath: "钝器击打后脑", deathPlace: "放映室" };
const REAL_TIMELINE = [
  { time: "22:20", desc: "和李叔聊天，讨要工资" },
  { time: "22:28", desc: "用压片轮击打邱长贵后脑" },
  { time: "22:40", desc: "撞开放映室门，发现邱长贵尸体" },
];

test("预习：这一稿的死亡时刻本来就能判出来（否则下面的回填断言没有意义）", () => {
  assert.strictEqual(findDeathMoment({ victim: REAL_VICTIM, timeline: REAL_TIMELINE }), "22:28");
});

test("victim 缺 deathTime 时用权威时间轴回填，不再是空标签", () => {
  const md = build(REAL_VICTIM, REAL_TIMELINE);
  assert.match(md, /- \*\*死亡时间\*\*：22:28/, "死亡时间必须被回填成真实时刻");
});

test("回填的值能真的被 parseScript 解回结构化数据（契约闭环）", () => {
  const md = build(REAL_VICTIM, REAL_TIMELINE);
  const parsed = parseScript(md);
  assert.strictEqual(parsed.victim.deathTime, "22:28",
    "回填必须活到解析层，否则 AI 玩家提示词里拿到的还是空值");
});

test("大纲明确给了 deathTime 时以它为准（不许被回填覆盖）", () => {
  const md = build({ ...REAL_VICTIM, deathTime: "22:30" }, REAL_TIMELINE);
  assert.match(md, /- \*\*死亡时间\*\*：22:30/);
});

test("两头都判不出时留空但不出声编造：既不写占位语，也不编一个时刻", () => {
  const undetectable = [{ time: "20:55", desc: "凶手进书房下毒" }];
  const victim = { name: "陆老板", identity: "东家", gender: "男", causeOfDeath: "砒霜中毒", deathPlace: "书房" };
  assert.strictEqual(findDeathMoment({ victim, timeline: undetectable }), null, "前提：这一稿确实判不出死亡时刻");
  const md = build(victim, undetectable);
  const line = (md.match(/- \*\*死亡时间\*\*：[^\n]*/) || [""])[0];
  assert.strictEqual(line.trim(), "- **死亡时间**：", `判不出时必须留空，实际渲染成「${line}」`);
  assert.strictEqual(parseScript(md).victim.deathTime, "", "占位语会污染结构化数据，必须留空");
});
