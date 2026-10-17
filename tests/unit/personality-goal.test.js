// personality / goal 全链路契约测试
//
// 这两个字段最容易"看着接完了其实没通"：大纲生成 → outlineToText → assembleScript 写成 markdown
// → parseScript 解析回结构化数据 → 切分数据 → 运行时提示词。中间任何一环漏掉，
// personality 就会变回那个一直是空字符串的死字段。
//
// 所以这里不手写 markdown 样例（那样只能证明"我写的正则能匹配我自己编的文本"），
// 而是**真的调 assembleScript 生成，再真的用 parseScript 解析** —— 验证的是两边真实契约。
const test = require("node:test");
const assert = require("node:assert");

const { assembleScript, outlineToText, extractCharactersFromOutline, buildCharacterPrompt } =
  require("../../src/script/murder-mystery-builder");
const { parseScript } = require("../../src/script/script-parser");

const OUTLINE = {
  title: "测试本",
  genre: "本格",
  coreTrick: "密室",
  duration: "3小时",
  storyBackground: "民国药铺命案",
  layout: ["书房", "厨房"],
  victim: { name: "陆老板", identity: "东家", gender: "男", causeOfDeath: "砒霜中毒", deathPlace: "书房" },
  players: [
    { name: "张三", gender: "男", identity: "医生", personality: "语速很快，爱抢话，常带「我跟你说」", goal: "隐瞒你当晚去过药房", isMurderer: false },
    { name: "李四", gender: "女", identity: "管家", personality: "说话慢条斯理，喜欢用敬语", goal: "不让任何人知道你和死者的旧情", isMurderer: true },
  ],
  npcs: [
    { name: "王五", gender: "男", identity: "仆人", personality: "结巴，一紧张就重复自己的话", goal: "替主人掩饰账本的事", isMurderer: false },
  ],
  murderer: { name: "李四", motive: "夺产", method: "毒入茶中" },
  timeline: [{ time: "20:55", desc: "凶手进书房下毒" }],
};

const CHARACTERS = [
  { name: "张三", type: "player", occupation: "医生", personality: OUTLINE.players[0].personality, goal: OUTLINE.players[0].goal, isMurderer: false },
  { name: "李四", type: "player", occupation: "管家", personality: OUTLINE.players[1].personality, goal: OUTLINE.players[1].goal, isMurderer: true },
  { name: "王五", type: "npc", occupation: "仆人", personality: OUTLINE.npcs[0].personality, goal: OUTLINE.npcs[0].goal, isMurderer: false },
];

/** 用真实 assembleScript 造一份剧本 markdown */
function buildScript() {
  const report = {
    isPVE: false,
    outline: OUTLINE,
    characters: CHARACTERS,
    framework: [
      "## 一、基本设定",
      "- **剧本名称**：《测试本》",
      "- **时代背景**：民国",
      "- **地点场景**：陆宅",
      "- **参与人数**：2",
      "- **游戏时长**：3小时",
      "- **难度等级**：中等",
      "",
      "## 二、故事背景",
      "陆老板在寿宴上中毒身亡。",
    ].join("\n"),
    characterScripts: {
      "张三": "### 一、你的背景故事\n我是陆家的家庭医生。\n\n### 二、你的时间线\n- 19:00 在诊室整理药箱。\n- 20:00 到前厅赴宴。\n\n### 三、你的任务\n1. 你的个人目标：隐瞒你当晚去过药房\n",
      "李四": "### 一、你的背景故事\n我是陆家的管家。\n\n### 二、你的时间线\n- 19:30 在后厨验菜。\n- 20:55 上楼送茶。\n\n### 三、你的任务\n1. 你的个人目标：不让任何人知道你和死者的旧情\n",
      "王五": "### 一、背景\n我是陆家的老仆。\n\n### 二、时间线\n- 19:00 在门房。\n",
    },
    clues: "### A1：茶盏\n线索类型：物证\n发现地点：书房\n线索内容：茶盏内壁有白色粉末残留。\n",
    layoutText: "书房在二楼东侧，厨房在一楼北面。",
  };
  return assembleScript(report, "民国药铺命案");
}

const MARKDOWN = buildScript();
const PARSED = parseScript(MARKDOWN);

// ==================== 大纲层 ====================

test("outlineToText 带上性格语气与个人任务", () => {
  const t = outlineToText(OUTLINE);
  assert.ok(t.includes("性格语气：语速很快"), "设定集必须带上语气，否则生成阶段看不到");
  assert.ok(t.includes("个人任务：隐瞒你当晚去过药房"));
});

test("extractCharactersFromOutline 透传 personality/goal", () => {
  const chars = extractCharactersFromOutline(OUTLINE, {});
  const zhang = chars.find(c => c.name === "张三");
  assert.strictEqual(zhang.personality, OUTLINE.players[0].personality);
  assert.strictEqual(zhang.goal, OUTLINE.players[0].goal);
  const wang = chars.find(c => c.name === "王五");
  assert.strictEqual(wang.goal, OUTLINE.npcs[0].goal, "NPC 也要带上");
});

// ==================== assembleScript 写出的格式 ====================

test("assembleScript 把元数据写成可解析的一行", () => {
  assert.ok(MARKDOWN.includes("职业/身份：医生"), "身份应写进元数据行");
  assert.ok(MARKDOWN.includes("语气：语速很快，爱抢话，常带「我跟你说」"));
  assert.ok(MARKDOWN.includes("个人任务：隐瞒你当晚去过药房"));
});

// ==================== 真实契约：parseScript 能解回来 ====================

test("parseScript 从真实剧本中解出 personality 与 goal", () => {
  const zhang = (PARSED.characters || []).find(c => c.name === "张三");
  assert.ok(zhang, "应解析出角色张三");
  assert.strictEqual(zhang.personality, OUTLINE.players[0].personality, "语气必须在链路中存活");
  assert.strictEqual(zhang.goal, OUTLINE.players[0].goal, "个人任务必须在链路中存活");
});

test("parseScript 解出的 identity 不再被整行吞掉", () => {
  const zhang = (PARSED.characters || []).find(c => c.name === "张三");
  // 元数据行是 "> 职业/身份：医生 ｜ 语气：… ｜ 个人任务：…"
  // 若终止符没处理 ｜，occupation 会变成整行剩余内容
  assert.strictEqual(zhang.occupation, "医生");
  assert.ok(!zhang.occupation.includes("语气"), "身份不该把后面的字段一起吞进来");
});

test("多个角色的 personality 互不串（不是都拿到第一个人的）", () => {
  const li = (PARSED.characters || []).find(c => c.name === "李四");
  assert.strictEqual(li.personality, OUTLINE.players[1].personality);
  assert.strictEqual(li.goal, OUTLINE.players[1].goal);
  assert.notStrictEqual(li.personality, OUTLINE.players[0].personality);
});

test("NPC 的 personality/goal 也能解出来", () => {
  const wang = (PARSED.characters || []).find(c => c.name === "王五");
  assert.ok(wang, "应解析出 NPC 王五");
  assert.strictEqual(wang.personality, OUTLINE.npcs[0].personality);
  assert.strictEqual(wang.goal, OUTLINE.npcs[0].goal);
});

// ==================== 生成提示词 ====================

test("buildCharacterPrompt 用角色自己的 goal 填个人目标，不再是所有人同一句", () => {
  const ch = CHARACTERS[0];
  const p = buildCharacterPrompt(ch, "", 1, 2, false, OUTLINE);
  assert.ok(p.includes(ch.goal), "应填入该角色的 goal");
  assert.ok(!p.includes("{personalGoal}"), "占位符必须被替换，不能泄漏到剧本正文");
});

test("buildCharacterPrompt 带上性格与语气", () => {
  const p = buildCharacterPrompt(CHARACTERS[0], "", 1, 2, false, OUTLINE);
  assert.ok(p.includes("性格与语气"), "角色基本信息里要给出语气抓手");
  assert.ok(p.includes(CHARACTERS[0].personality));
});

test("buildCharacterPrompt：不同角色拿到不同的个人目标", () => {
  // 注意：prompt 里会附带整份设定集（outlineToText），而设定集本来就列出所有角色的
  // personality/goal —— 那是刻意为之，生成阶段需要全局信息保证一致。
  // 所以不能笼统断言"prompt 里不含别人的目标"，要精确检查"个人目标"那个槽位填的是谁的。
  const slotOf = (p) => {
    const i = p.indexOf("你的个人目标");
    assert.ok(i >= 0, "prompt 里应有个人目标槽位");
    return p.slice(i, i + 260);
  };
  const a = buildCharacterPrompt(CHARACTERS[0], "", 1, 2, false, OUTLINE);
  const b = buildCharacterPrompt(CHARACTERS[1], "", 2, 2, false, OUTLINE);
  assert.ok(slotOf(a).includes(CHARACTERS[0].goal), "第一个角色的槽位应是它自己的目标");
  assert.ok(slotOf(b).includes(CHARACTERS[1].goal), "第二个角色的槽位应是它自己的目标");
  assert.ok(!slotOf(a).includes(CHARACTERS[1].goal), "不能把别人的目标填进这个槽位");
  assert.ok(!slotOf(b).includes(CHARACTERS[0].goal), "不能把别人的目标填进这个槽位");
});

test("buildCharacterPrompt：缺 goal 时有兜底且不残留占位符", () => {
  const noGoal = { name: "赵六", type: "player", occupation: "书童", isMurderer: false };
  const p = buildCharacterPrompt(noGoal, "", 1, 1, false, OUTLINE);
  assert.ok(!p.includes("{personalGoal}"), "没有 goal 时也必须清掉占位符");
});

test("buildCharacterPrompt：PVE 侦探模板同样不残留占位符", () => {
  const p = buildCharacterPrompt(CHARACTERS[0], "", 1, 1, true, OUTLINE);
  assert.ok(!p.includes("{personalGoal}"), "PVE 路径也要清干净");
});

// ==================== 运行时提示词接线 ====================
// 数据活到 parseScript 还不够，必须真的进入 NPC / AI 玩家的提示词，否则玩家端感受不到区别。

test("NPC 提示词带上性格与语气", () => {
  const { buildNpcSystemPrompt } = require("../../src/game/npc-agent");
  const npc = {
    name: "王五",
    occupation: "仆人",
    personality: "结巴，一紧张就重复自己的话",
    isMurderer: false,
    script: { story: "我是陆家的老仆。", secret: "我偷了账本。" },
  };
  const sys = buildNpcSystemPrompt(npc, { title: "测试本" });
  assert.ok(sys.includes("结巴，一紧张就重复自己的话"), "性格必须进入提示词，否则 NPC 说话仍是通用腔");
  assert.ok(sys.includes("性格与说话方式"), "要明确告诉模型这是它的语气，而不只是塞一段描述");
});

test("NPC 提示词：没有 personality 时不出现空行噪音", () => {
  const { buildNpcSystemPrompt } = require("../../src/game/npc-agent");
  const npc = { name: "甲", occupation: "仆人", isMurderer: false, script: { story: "x", secret: "y" } };
  const sys = buildNpcSystemPrompt(npc, {});
  assert.ok(!sys.includes("性格与说话方式"), "缺字段时不该留下空标题");
});

test("AI 玩家提示词带上说话方式与个人目标", () => {
  const llm = require("../../src/game/ai-player-llm");
  const p = llm.systemPrompt({
    role: {
      name: "张三", isMurderer: false,
      playerScript: "我是家庭医生",
      secret: "我欠了赌债",
      personality: "语速很快，爱抢话",
      goal: "隐瞒你当晚去过药房",
    },
    name: "张三",
    transcript: "", myStatements: [], myClues: [], otherClues: [], allChars: [],
    room: { title: "测试本", setting: "民国" },
  });
  assert.ok(p.includes("语速很快，爱抢话"), "语气要进 prompt");
  assert.ok(p.includes("隐瞒你当晚去过药房"), "个人目标要进 prompt，AI 才会为其行动");
  assert.ok(p.includes("你的说话方式"));
  assert.ok(p.includes("你的个人目标"));
});

test("AI 玩家提示词：缺 personality/goal 时不留空标题且不抛异常", () => {
  const llm = require("../../src/game/ai-player-llm");
  assert.doesNotThrow(() => llm.systemPrompt({ role: {}, name: "X", room: {} }));
  const p = llm.systemPrompt({ role: {}, name: "X", room: {} });
  assert.ok(!p.includes("你的说话方式"), "缺字段时不出现空标题");
});
