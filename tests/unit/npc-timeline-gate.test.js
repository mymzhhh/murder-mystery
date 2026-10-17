// 单元测试：NPC 剧本的时间线也要有生成后校验（2026-10-17 补的结构性漏洞）。
//
// 背景（实测）：`ensureTimelineComplete` 这道门以前**只接在玩家角色循环上**，
// NPC 循环里没有任何人调用它。而 NPC 模板（npcWitness）里更是**连条数都没要求**
// —— 只写了"精确到分钟/时辰，标注在哪些时段目击了什么"。
// 结果：改后那一本里 NPC `阿强` 只写出 **5 个时刻 / 时间线 374 字**，没人出声。
//
// NPC 的目击信息是玩家推理的输入（审讯、对表、交叉验证都靠它），
// 它薄了直接削弱整局可推理度，所以这是结构性漏洞而不是文风问题。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  MIN_TIMELINE_POINTS,
  MIN_NPC_TIMELINE_POINTS,
  ensureTimelineComplete,
  extractCharacterTimeline,
  countTimelinePoints,
} = require("../../src/script/murder-mystery-builder");

/** 造一份 NPC 剧本：`### 三、时间线` 下带 n 条 `- **月日 时刻**：房间 — 事件` */
function npcScript(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const hh = String(19 + Math.floor(i / 4)).padStart(2, "0");
    const mm = String((i % 4) * 15).padStart(2, "0");
    rows.push(`- **10月16日 ${hh}:${mm}**：大堂 — 看见阿明经过，没说话`);
  }
  return [
    "### 一、人物关系",
    "",
    "他与死者是雇佣关系。",
    "",
    "### 二、目击信息与需要隐瞒的事",
    "",
    "- 案发前听见争吵。",
    "",
    "### 三、时间线",
    "",
    ...rows,
    "",
    "注意：他不是凶手。",
  ].join("\n");
}

test("NPC 时间线：达到 6 条时不触发补写", async () => {
  const ok = npcScript(MIN_NPC_TIMELINE_POINTS);
  assert.strictEqual(countTimelinePoints(extractCharacterTimeline(ok)), MIN_NPC_TIMELINE_POINTS, "样本本身要正好 6 条");
  let called = 0;
  const out = await ensureTimelineComplete("老周", ok, async () => { called++; return ok; }, null, {
    min: MIN_NPC_TIMELINE_POINTS, section: "三、时间线", progressStage: "npc_script",
  });
  assert.strictEqual(called, 0, "达标就不该多跑一遍 NPC 剧本");
  assert.strictEqual(out, ok);
});

test("NPC 时间线：只有 5 条（实测真实值）时必须触发补写，且指出的是 NPC 的章节名", async () => {
  const thin = npcScript(5);
  assert.strictEqual(countTimelinePoints(extractCharacterTimeline(thin)), 5);
  let called = 0;
  let noteSeen = "";
  const better = npcScript(9);
  const out = await ensureTimelineComplete("阿强", thin, async (note) => { called++; noteSeen = note; return better; }, null, {
    min: MIN_NPC_TIMELINE_POINTS, section: "三、时间线", progressStage: "npc_script",
    headings: '使用 "### 一、人物关系" / "### 二、目击信息与需要隐瞒的事" / "### 三、时间线" 三个三级标题，顺序不可变。',
  });
  assert.strictEqual(called, 1, "5 条低于下限 6，必须补写一次");
  assert.match(noteSeen, /「三、时间线」只有 5 个时间点/, "纠正说明要点明是 NPC 的「三、时间线」与真实条数");
  assert.match(noteSeen, /至少 6 个时间点/, "纠正说明要写出 NPC 的下限");
  assert.ok(!/「二、你的时间线」/.test(noteSeen), "不得把玩家的章节名塞进 NPC 的纠正说明");
  assert.match(noteSeen, /目击信息与需要隐瞒的事/, "标题约束要用 NPC 自己那一套");
  assert.strictEqual(out, better, "补写后条数更多，应采纳补写稿");
});

test("NPC 下限低于玩家下限（6 < 8），且两个常量都与模板里写的数一致", () => {
  assert.ok(MIN_NPC_TIMELINE_POINTS < MIN_TIMELINE_POINTS, "NPC 篇幅预算更小，下限本就该更低");
  const src = fs.readFileSync(path.join(__dirname, "../../src/templates/murder-mystery/character.js"), "utf8");
  assert.ok(src.includes(`至少列出 ${MIN_NPC_TIMELINE_POINTS} 个时间点`),
    `NPC 模板（npcSuspect）必须写明"至少列出 ${MIN_NPC_TIMELINE_POINTS} 个时间点"`);
  // npcWitness 以前**连条数都没写**，就是 5 条那个漏洞的源头 —— 现在必须两套模板都写。
  const witness = src.slice(src.indexOf("npcWitness:"), src.indexOf("npcSuspect:"));
  assert.ok(new RegExp(`至少列出 ${MIN_NPC_TIMELINE_POINTS} 个时间点`).test(witness),
    "npcWitness 模板也必须写明条数下限（实测漏写导致只剩 5 条）");
  assert.ok(witness.includes(`至少 ${MIN_NPC_TIMELINE_POINTS} 个时间点`), "npcWitness 的格式约束里也要再强调一次");
  assert.ok(src.includes(`下限 ${MIN_TIMELINE_POINTS} 个时间点`), "玩家模板的下限必须与 MIN_TIMELINE_POINTS 一致");
});
