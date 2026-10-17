// 剧本圣经（story-bible）：权威表归一化 + 确定性对账的契约测试
//
// 用例直接取材自一次真实生成里 crosscheck 报出的问题（灰雾庄园·密道回声）：
//   · 莫罗 20:00 写"在场有休·格雷" vs 休自述"20:00 后回房"（跨角色）
//   · 莫罗 23:15"发现撬痕" vs 基准时间线 23:15"未察觉异常"（角色 vs 权威）
// 这些是**逐人自审抓不到**的那一类，也是这个模块存在的理由。
const test = require("node:test");
const assert = require("node:assert");
const {
  buildBible, bibleFactsFor, bibleFactsToText,
  checkBibleSelfConsistency, reconcileCharacterScript, findCrossCharacterConflicts,
  checkCluePlan, checkKnowledgeBounds, findObjectStateConflicts, checkTimelineHealth,
  alignCluePlan, clueLocationKind, normalizeClueLocation, findSelfPrefixEntries, findPlaceholderResidues, repairPlaceholderResidues, extractTimeFromText, checkShichenConsistency, fixShichenByClock,
} = require("../../src/script/story-bible");

const OUTLINE = {
  title: "灰雾庄园·密道回声",
  caseDate: "11月9日",
  layout: ["东侧起居室", "二楼西侧藏书室", "锅炉房与后廊", "西侧书房"],
  victim: { name: "老哈罗兰", deathTime: "22:35", deathPlace: "西侧书房" },
  victimLine: { deathTime: "22:35", deathPlace: "西侧书房", lastSeen: "22:20 出现在西侧书房", confirmedBy: ["薇拉·哈罗兰"] },
  players: [{ name: "休·格雷" }, { name: "玛格丽特·伦诺克斯" }],
  npcs: [{ name: "安格斯·莫罗" }, { name: "薇拉·哈罗兰" }],
  murderer: { name: "薇拉·哈罗兰" },
  timeline: [
    { time: "22:35", desc: "老哈罗兰在西侧书房被勒杀" },
    { time: "23:15", desc: "莫罗巡视锅炉房，与薇拉错开，未察觉异常" },
  ],
  publicEvents: [
    { time: "20:00", actor: "休·格雷", place: "东侧起居室", doing: "与众人饮茶", who: ["安格斯·莫罗"] },
    { time: "23:15", actor: "安格斯·莫罗", place: "锅炉房与后廊", doing: "巡视", who: [] },
  ],
  objectStates: [
    { at: "22:00", object: "西侧书房的灯", state: "亮着" },
  ],
  knowledgeMap: [
    { who: "休·格雷", knows: "密道日记的存在", since: "21:00", source: "亲眼所见" },
  ],
  cluePlan: [
    { clueId: "A1", discoverer: "休·格雷", time: "20:30", place: "东侧起居室" },
  ],
};

test("buildBible：容忍日期前缀的时刻写法，并把权威地名汇总出来", () => {
  const b = buildBible(OUTLINE);
  assert.strictEqual(b.caseDate, "11月9日");
  assert.strictEqual(b.victim.deathTime, "22:35");
  assert.deepStrictEqual(b.characters, ["休·格雷", "玛格丽特·伦诺克斯", "安格斯·莫罗", "薇拉·哈罗兰"]);
  assert.ok(b.places.includes("东侧起居室"));
  assert.ok(b.places.includes("锅炉房与后廊"));
  // 容忍"11月17日 23:50"这类写法（历史上曾因此判不出死亡时刻）
  const b2 = buildBible({ timeline: [{ time: "11月17日 23:50", desc: "陈某死亡" }] });
  assert.strictEqual(b2.timeline[0].time, "23:50");
});

test("权威表自洽：缺案发日期 / 缺身亡时刻都要报（后者曾让整层保护静默失效）", () => {
  const bad = buildBible({ victim: { name: "老哈罗兰" }, players: [{ name: "甲" }] });
  const r = checkBibleSelfConsistency(bad);
  const codes = r.issues.map(i => i.code);
  assert.ok(codes.includes("no_case_date"));
  assert.ok(codes.includes("no_death_time"), "缺身亡时刻必须报——否则「死者死后不得再活动」静默失效");
  assert.strictEqual(r.ok, false);
});

test("权威表自洽：同一角色同一时刻两地、同一物件两种状态、陌生人名都要报", () => {
  const b = buildBible({
    ...OUTLINE,
    publicEvents: [
      { time: "20:00", actor: "休·格雷", place: "东侧起居室", doing: "饮茶" },
      { time: "20:00", actor: "休·格雷", place: "二楼西侧藏书室", doing: "翻书" },
      { time: "21:00", actor: "查无此人", place: "锅炉房与后廊", doing: "站着" },
    ],
    objectStates: [
      { at: "22:00", object: "西侧书房的灯", state: "亮着" },
      { at: "22:00", object: "西侧书房的灯", state: "熄灭了" },
    ],
  });
  const r = checkBibleSelfConsistency(b);
  const codes = r.issues.map(i => i.code);
  assert.ok(codes.includes("same_instant_two_places"), "同刻两地必须报");
  assert.ok(codes.includes("object_two_states"), "同刻两状态必须报");
  assert.ok(codes.includes("unknown_actor"), "不在名单里的角色必须报");
});

test("干净的权威表不报错（防误伤）", () => {
  const r = checkBibleSelfConsistency(buildBible(OUTLINE));
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues));
});

test("逐人对账：『移动句』不算同刻两地（同一分钟内先在场、后离开是正常的）", () => {
  const b = buildBible(OUTLINE);
  // "回到房间"是移动：权威说 20:00 在起居室、他写 20:00 回房 —— 不矛盾。
  // 实测复盘：真正矛盾的是**跨角色**（别人说他 20:00 还在场、他自己说已经走了），
  // 那由 findCrossCharacterConflicts 负责；逐人对账在这里报错造成过大量误报。
  const moving = [
    "### 休·格雷的剧本",
    "## 时间线",
    "- 20:00 我休·格雷回到自己房间，整夜未出。",
  ].join("\n");
  assert.strictEqual(reconcileCharacterScript("休·格雷", moving, b).ok, true, "移动句不该判冲突");

  // 但"同一时刻明确写在另一个地点"仍然要判（这才是真冲突）
  const wrong = "## 时间线\n- 20:00 我休·格雷在二楼西侧藏书室翻书。";
  const r2 = reconcileCharacterScript("休·格雷", wrong, b);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.conflicts[0].kind, "place_mismatch");
});

test("逐人对账：同一地点的不同叫法不该判地点不符（权威写灶间、角色写厨房）", () => {
  const b = buildBible({ ...OUTLINE, layout: ["东侧起居室", "灶间"], publicEvents: [{ time: "19:00", actor: "休·格雷", place: "灶间", doing: "添酒" }] });
  const s = "## 时间线\n- 19:00 我休·格雷在厨房里温酒。";
  const r = reconcileCharacterScript("休·格雷", s, b);
  assert.ok(!r.conflicts.some(c => c.level === "error"), "灶间=厨房，不该报硬冲突：" + JSON.stringify(r.conflicts));
});

test("逐人对账：写了权威地名表里的另一个地点 → error 级", () => {
  const b = buildBible(OUTLINE);
  const script = "## 时间线\n- 20:00 我休·格雷在二楼西侧藏书室翻书。";
  const r = reconcileCharacterScript("休·格雷", script, b);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, "place_mismatch");
  assert.strictEqual(r.conflicts[0].level, "error");
  assert.deepStrictEqual(r.conflicts[0].found, ["二楼西侧藏书室"]);
});

test("逐人对账：写对了就不报（防误伤是这条规则的生命线）", () => {
  const b = buildBible(OUTLINE);
  const ok = [
    "## 时间线",
    "- 20:00 我休·格雷在东侧起居室与众人饮茶，莫罗也在。",
  ].join("\n");
  assert.strictEqual(reconcileCharacterScript("休·格雷", ok, b).ok, true);
  // 同一时刻但没写地点 → 不判（宁可漏，不可误伤）
  const vague = "## 时间线\n- 20:00 我休·格雷在喝茶。";
  assert.strictEqual(reconcileCharacterScript("休·格雷", vague, b).ok, true);
});

test("逐人对账：死者身亡后又被写成活动 → 报 victim_after_death", () => {
  const b = buildBible(OUTLINE);
  const script = "## 时间线\n- 23:00 老哈罗兰把我叫到书房交代事情。";
  const r = reconcileCharacterScript("休·格雷", script, b);
  assert.ok(r.conflicts.some(c => c.kind === "victim_after_death"), JSON.stringify(r.conflicts));
});

test("跨角色冲突：同一主体在同一时刻被两个来源放到两个地点才判（复现莫罗 vs 休）", () => {
  const b = buildBible(OUTLINE);
  const pair = {
    // 莫罗目击休在起居室
    "安格斯·莫罗": "## 时间线\n- 20:00 休·格雷在东侧起居室跟我说话。",
    // 休自己说在书房 —— 同一主体「休·格雷」同刻两处，且来源不同 → 冲突
    "休·格雷": "## 时间线\n- 20:00 我休·格雷在西侧书房翻书。",
  };
  const r = findCrossCharacterConflicts(pair, b);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, "subject_two_places_same_time");
  assert.strictEqual(r.conflicts[0].subject, "休·格雷");
  assert.strictEqual(r.conflicts[0].time, "20:00");

  // 两人同一时刻各在不同房间、且没提对方 → 正常情况，不判（第一版在这里刷出大量噪音）
  const normal = {
    "安格斯·莫罗": "## 时间线\n- 20:00 我安格斯·莫罗在锅炉房与后廊巡视。",
    "休·格雷": "## 时间线\n- 20:00 我休·格雷在西侧书房翻书。",
  };
  assert.strictEqual(findCrossCharacterConflicts(normal, b).ok, true);
});

test("跨角色冲突：意图句不判（『打算去某处』不是『我当时在哪』）", () => {
  const b = buildBible(OUTLINE);
  const r = findCrossCharacterConflicts({
    "安格斯·莫罗": "## 时间线\n- 20:00 休·格雷在东侧起居室跟我说话。",
    "休·格雷": "## 时间线\n- 20:00 我休·格雷打算去西侧书房翻书。",
  }, b);
  assert.strictEqual(r.ok, true, JSON.stringify(r.conflicts));
});

test("物件状态冲突：同一物件同一时刻亮/灭矛盾要判（跨来源）", () => {
  const b = buildBible(OUTLINE);
  const two = {
    "安格斯·莫罗": "## 时间线\n- 22:00 西侧书房的灯亮着，我看见了。",
    "休·格雷": "## 时间线\n- 22:00 西侧书房的灯熄灭，一片黑。",
  };
  const r = findObjectStateConflicts(two, b);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflicts[0].kind, "object_state_conflict");
  assert.strictEqual(r.conflicts[0].object, "西侧书房的灯");
  // 同一份剧本内部的自相矛盾不在这里判（归逐人对账）
  assert.strictEqual(findObjectStateConflicts({ "休·格雷": "## 时间线\n- 22:00 西侧书房的灯亮着。\n- 22:00 西侧书房的灯熄灭。" }, b).ok, true);
});

test("线索闭环：三要素缺失报 warn、发现地点不一致报 error", () => {
  const b = buildBible(OUTLINE);
  const r = checkCluePlan([
    { id: "A1", location: "东侧起居室" },              // 与 cluePlan 一致
    { id: "A2", location: "锅炉房与后廊" },            // cluePlan 里没有 → warn
    { id: "A3", location: "锅炉房与后廊" },            // 见下：cluePlan 说东侧起居室 → error
  ], { ...b, cluePlan: [...b.cluePlan, { id: "A3", discoverer: "休·格雷", time: "21:00", place: "东侧起居室" }] });
  const codes = r.issues.map(i => i.code);
  assert.ok(codes.includes("clue_no_plan"));
  assert.ok(codes.includes("clue_place_mismatch"));
  assert.strictEqual(r.ok, false);
});

test("知识越界：在『知道的时间』之前写出该事实才判（保守，且只算 warn 级信号）", () => {
  const b = buildBible(OUTLINE);
  const leak = "## 时间线\n- 20:10 我休·格雷决定去查密道日记的存在。";
  assert.strictEqual(checkKnowledgeBounds("休·格雷", leak, b).ok, false);
  const fine = "## 时间线\n- 21:30 我休·格雷终于知道了密道日记的存在。";
  assert.strictEqual(checkKnowledgeBounds("休·格雷", fine, b).ok, true);
});

test("bibleFactsFor / bibleFactsToText：只给该角色相关的公开行踪，且可注入提示词", () => {
  const b = buildBible(OUTLINE);
  const f = bibleFactsFor(b, "休·格雷");
  assert.strictEqual(f.publicEvents.length, 1);
  assert.strictEqual(f.publicEvents[0].time, "20:00");
  const txt = bibleFactsToText(f);
  assert.ok(txt.includes("20:00"));
  assert.ok(txt.includes("东侧起居室"));
  assert.ok(txt.includes("密道日记"), "该角色自己知道的事也要给出来（含知道的时间）");
});

test("时间线体检：同一时刻同一件事写成两条 → 报重复（实测《云锦庄》crosscheck 就卡在这一类）", () => {
  const script = [
    "## 时间线",
    "- **10月17日 05:50**：晨起咳嗽，在内室窗前咳声可闻，顺口问顾先生可还提旧账。",
    "- **10月16日 20:00**：在前柜对账。",
    "- **10月17日 05:50**：晨起咳嗽，在内室窗前咳声可闻。",
  ].join("\n");
  const r = checkTimelineHealth("白慕堂", script);
  assert.ok(r.issues.some(i => i.code === "timeline_duplicate"), JSON.stringify(r.issues));
  assert.strictEqual(r.ok, false);
});

test("时间线体检：日期倒退只报 warn（真实剧本里大量是合法的倒叙段，硬判会误伤）", () => {
  const script = [
    "## 时间线",
    "- **10月17日 05:50**：晨起咳嗽。",
    "- **10月16日 20:00**：在前柜对账。",
  ].join("\n");
  const r = checkTimelineHealth("白慕堂", script);
  assert.ok(r.issues.some(i => i.code === "timeline_out_of_order" && i.level === "warn"), JSON.stringify(r.issues));
  assert.strictEqual(r.ok, true, "日期倒退不该判成硬错（实测《蜡盘回声》一本就刷 27 处）");
  // 带倒叙标记的段落一律跳过
  const flashback = [
    "## 时间线",
    "- **10月17日 05:50**：晨起咳嗽。",
    "- **10月16日 20:00**：前情回顾：在前柜对账。",
  ].join("\n");
  assert.strictEqual(checkTimelineHealth("白慕堂", flashback).issues.length, 0, "倒叙段不该被判成顺序错乱");
});

test("时间线体检：正常文本不误报（含合法跨午夜）", () => {
  const ok = [
    "## 时间线",
    "- **10月16日 20:00**：在前柜对账。",
    "- **10月16日 23:50**：回房。",
    "- **10月17日 00:30**：听见喊声。",
  ].join("\n");
  assert.strictEqual(checkTimelineHealth("白慕堂", ok).ok, true, JSON.stringify(checkTimelineHealth("白慕堂", ok).issues));
  // 无日期时的合法跨午夜（23:50 → 00:30）不判倒序
  const wrap = "## 时间线\n- 23:50 回房。\n- 00:30 听见喊声。";
  assert.strictEqual(checkTimelineHealth("甲", wrap).issues.length, 0, JSON.stringify(checkTimelineHealth("甲", wrap).issues));
});

test("时间线体检：同刻『两条相近』报提示级；同刻两件无关的事不报", () => {
  // 几乎同一句话（相似度 ≥0.65）→ 判重复（error）：这确实是同一件事写了两遍
  const same = "## 时间线\n- 20:00 我在前柜对账。\n- 20:00 我在前柜核对账目。";
  assert.ok(checkTimelineHealth("甲", same).issues.some(i => i.code === "timeline_duplicate"), "措辞几乎相同=重复");
  // 只共享几个片段（我在/在前/前柜）但不像同一句 → 提示级
  const near = "## 时间线\n- 20:00 我在前柜对账。\n- 20:00 我在前柜等罗四喜。";
  const rn = checkTimelineHealth("甲", near);
  assert.strictEqual(rn.ok, true, "相近但不同的事不该判成硬错（宁可提示，不可误删）");
  assert.ok(rn.issues.some(i => i.code === "timeline_same_time" && i.level === "warn"), JSON.stringify(rn.issues));
  // 无关的两件事同刻是正常的（人在同一分钟可以做/听到不止一件事）→ 不报
  const far = "## 时间线\n- 20:00 我在前柜对账。\n- 20:00 我听见后院有响动。";
  assert.strictEqual(checkTimelineHealth("甲", far).issues.length, 0, JSON.stringify(checkTimelineHealth("甲", far).issues));
});

test("时间线体检：重复条目即使一条在时间线、一条在别的列表里也要抓到（云锦庄实测漏判）", () => {
  const script = [
    "## 时间线",
    "- **10月17日 5:50**：掌柜内室 — 晨起咳嗽，在内室窗前咳声可闻（后院一带可听见）。",
    "## 不在场证明",
    "1. 案发当晨5:50他在内室窗前咳嗽，声音后院可闻——仆侍可作证他整夜未出内室。",
  ].join("\n");
  const r = checkTimelineHealth("白慕堂", script);
  assert.ok(r.issues.some(i => i.code === "timeline_duplicate_cross" && i.level === "warn"), "跨小节同刻同事要抓，但只记提示级（时间线+复盘复述是正常结构）：" + JSON.stringify(r.issues));
});

test("location 归一化：真实值逐条能认出来（层级写法 / 某人身上 / 证词 / 前缀）", () => {
  // 夹具要忠实：location 里出现的 周世奎/谭志强/孙佩兰 必须真的在角色表里
  // （顺带说明一个真实限制：location 指向**名单外的人**（如仆人）时认不出来）
  const b = buildBible({
    ...OUTLINE,
    players: [{ name: "周世奎" }, { name: "谭志强" }, { name: "孙佩兰" }, ...OUTLINE.players],
    layout: ["东侧起居室", "二楼西侧藏书室", "站长办公室", "维修间", "值班宿舍", "站台", "二号修复坑"],
  });
  const t = (loc) => normalizeClueLocation(loc, b);
  assert.deepStrictEqual([t("站长办公室·桌").kind, t("站长办公室·桌").place], ["place", "站长办公室"]);
  assert.deepStrictEqual([t("维修间·水槽下水口").kind, t("维修间·水槽下水口").place], ["place", "维修间"]);
  assert.strictEqual(t("值班宿舍（陈桂香宿舍）").place, "值班宿舍");
  assert.strictEqual(t("站台（案发现场）").place, "站台");
  assert.deepStrictEqual([t("周世奎左手").kind, t("周世奎左手").person], ["person", "周世奎"]);
  assert.deepStrictEqual([t("谭志强工装口袋").kind, t("谭志强工装口袋").person], ["person", "谭志强"]);
  assert.deepStrictEqual([t("孙佩兰证词").kind, t("孙佩兰证词").person], ["person", "孙佩兰"]);
  assert.strictEqual(t("案发地点：二号修复坑").place, "二号修复坑", "前缀要去掉");
  assert.strictEqual(t("认不出的地方").kind, "unknown", "认不出就老实说认不出，不拿房间名充数");
});
test("线索 location 的两种含义要分清：实物线索是房间，证词线索是作证的人", () => {
  const b = buildBible(OUTLINE);
  // 实测：证词线索的 location 就是人名（location=周老栓），不是房间
  assert.strictEqual(clueLocationKind("东侧起居室", b), "place");
  assert.strictEqual(clueLocationKind("休·格雷", b), "person");
  assert.strictEqual(clueLocationKind("锅炉房与后廊", b), "place");
  assert.strictEqual(clueLocationKind("说不清的地方", b), "unknown");
});

test("alignCluePlan：证词线索推 discoverer、实物线索推 place，并按线索纠正计划", () => {
  const b = buildBible({ ...OUTLINE, cluePlan: [
    { clueId: "A1", discoverer: "", time: "05:45", place: "东侧起居室" },   // 与线索 location 冲突
    { clueId: "A2", discoverer: "", time: "", place: "" },
  ] });
  const r = alignCluePlan([
    { id: "A1", location: "东侧起居室" },   // 实物线索：place 由线索推
    { id: "A2", location: "休·格雷" },      // 证词线索：discoverer 由线索推
  ], b);
  const a1 = r.plan.find(p => p.id === "A1"), a2 = r.plan.find(p => p.id === "A2");
  assert.strictEqual(a1.place, "东侧起居室");
  assert.strictEqual(a1.kind, "place");
  assert.strictEqual(a2.discoverer, "休·格雷");
  assert.strictEqual(a2.kind, "person");
  assert.strictEqual(r.derived, 1, "A2 的 discoverer 是推导出来的");
  assert.strictEqual(r.missingTime, 1, "A2 缺发现时间");
});

test("alignCluePlan：计划与线索地点冲突时以**线索**为准（计划是大纲阶段猜的）", () => {
  const b = buildBible({ ...OUTLINE, cluePlan: [{ clueId: "A9", discoverer: "休·格雷", time: "20:30", place: "东侧起居室" }] });
  const r = alignCluePlan([{ id: "A9", location: "二楼西侧藏书室" }], b);
  assert.strictEqual(r.mismatched, 1);
  assert.strictEqual(r.plan[0].place, "二楼西侧藏书室", "以已落地的线索为准");
});

test("时辰换算：改写器默认空转（错误的自动改写比不改更糟）", () => {
  const src = "酉时初（20:30前后）我在灶间添酒。";
  assert.strictEqual(fixShichenByClock(src).text, src, "默认必须原样返回");
  assert.strictEqual(fixShichenByClock(src).fixed, 0);
});

test("时辰换算：显式开启时改对时辰名，且不碰引号内的账册原句", () => {
  // 酉时 17:00–19:00，标 20:30 → 应为戌时
  const r1 = fixShichenByClock("酉时初（20:30前后）我在灶间添酒。", { unsafeApply: true });
  assert.strictEqual(r1.fixed, 1);
  assert.ok(r1.text.includes("戌时（20:30前后）"), r1.text);
  assert.ok(!r1.text.includes("酉时"), r1.text);
  // 引号内是"被引用的文字"（私账原句），不是时间主张 → 一个都不能改
  const quoted = "书匣夹层私账：'万堂欲送官究我亏空三千金，戌时了断。'";
  const r2 = fixShichenByClock(quoted, { unsafeApply: true });
  assert.strictEqual(r2.fixed, 0, "引号内的账册文字不得被改：" + JSON.stringify(r2.changes));
  assert.strictEqual(r2.text, quoted);
});

test("时辰换算：区间写法整段改（戌时末亥时初 → 单个正确时辰），且不吞标点", () => {
  const r = fixShichenByClock("死亡时刻推定在戌时末亥时初之间（约22:30—22:40）。", { unsafeApply: true });
  assert.strictEqual(r.fixed, 1);
  assert.ok(r.text.includes("亥时之间"), r.text);
  assert.ok(!r.text.includes("亥时末亥时初"), "不能只改半句留下废话：" + r.text);
  assert.ok(r.text.includes("（约22:30—22:40）"), "括号与破折号必须原样保留：" + r.text);
});

test("线索计划：按类型要求——证词需时刻，物品只需地点（外部反馈修正了我的模型）", () => {
  const b = buildBible({ ...OUTLINE, cluePlan: [] });
  const r = alignCluePlan([
    { id: "A1", location: "休·格雷" },        // 证词线索：缺发现时刻 → 不齐备
    { id: "A2", location: "东侧起居室" },      // 物品线索：有地点即齐备（不需要故事内时刻）
  ], b);
  const a1 = r.plan.find(p => p.id === "A1"), a2 = r.plan.find(p => p.id === "A2");
  assert.strictEqual(a1.type, "testimony");
  assert.strictEqual(a1.complete, false, "证词缺时刻不算齐备");
  assert.strictEqual(a2.type, "physical");
  assert.strictEqual(a2.complete, true, "物品线索只需要地点");
  assert.strictEqual(r.byType.physical.complete, 1);
  assert.strictEqual(r.byType.testimony.complete, 0);
});

test("证词时刻：能从正文里确定性读出「HH:MM / 中文钟点 / 时辰」", () => {
  assert.strictEqual(extractTimeFromText("周老栓说：五点三刻巡到库房外巷。"), "05:45");
  assert.strictEqual(extractTimeFromText("小厮说：21:35 我看见有人进寝居。"), "21:35");
  assert.strictEqual(extractTimeFromText("桂姨说：下午三点周医生来过灶房。"), "15:00");
  assert.strictEqual(extractTimeFromText("她说：晚上八点半听见响动。"), "20:30");
  assert.strictEqual(extractTimeFromText("他称：戌时三刻听见瓷器落地声。"), "19:45");
  assert.strictEqual(extractTimeFromText("纸包着灰白粉末，一角渗出。"), null, "没有时刻就返回 null，不猜");
});

test("证词时刻：计划缺时刻时由正文补上（并计入 derived）", () => {
  const b = buildBible({ ...OUTLINE, cluePlan: [] });
  const r = alignCluePlan([
    { id: "A1", location: "休·格雷", body: "休·格雷说：20:30 我在起居室听见钟响。" },
  ], b);
  const a1 = r.plan.find(p => p.id === "A1");
  assert.strictEqual(a1.time, "20:30");
  assert.strictEqual(a1.complete, true, "证词有了时刻就算齐备");
});


test("权威表自洽：同刻同一件事、做的人不一样 → 报矛盾（1998 演播楼实测）", () => {
  const b = buildBible({
    ...OUTLINE,
    timeline: [{ id: "T1", time: "18:30", actor: "张伟", place: "导播间", desc: "与李萌核对直播脚本" }],
    publicEvents: [{ time: "18:30", actor: "林晓", place: "导播间", doing: "与李萌核对直播脚本" }],
  });
  const r = checkBibleSelfConsistency(b);
  assert.ok(r.issues.some(i => i.code === "same_instant_two_actors"), JSON.stringify(r.issues).slice(0, 300));
});

test("权威表自洽：同义地名（技术室 / 一楼技术室）不算同刻两地", () => {
  const b = buildBible({
    ...OUTLINE,
    timeline: [{ id: "T1", time: "19:00", actor: "陈默", place: "技术室", desc: "调设备" }],
    publicEvents: [{ time: "19:00", actor: "陈默", place: "一楼技术室", doing: "调设备" }],
  });
  const r = checkBibleSelfConsistency(b);
  assert.ok(!r.issues.some(i => i.code === "same_instant_two_places"), JSON.stringify(r.issues).slice(0, 300));
});

test("死者死后活动：名字作为地名/提及（赵建国办公室、赵建国的尸体）不该误报", () => {
  const b = buildBible({ ...OUTLINE, victim: { name: "赵建国", deathTime: "01:15" }, victimLine: { deathTime: "01:15" } });
  const sc = [
    "## 时间线",
    "- 01:20 我加班整理文件，看到张伟从赵建国办公室出来。",
    "- 01:25 我被带到储藏间，看到赵建国的尸体，吓得说不出话。",
  ].join("\\n");
  const r = reconcileCharacterScript("李梅", sc, b);
  assert.strictEqual(r.conflicts.filter(c => c.kind === "victim_after_death").length, 0, JSON.stringify(r.conflicts));
});

test("时辰换算：双时间脚本优先按'真实'时刻比对（座钟读数不该参与判定）", () => {
  // 真实 19:45 = 戌时三刻 ✓ → 正确，不该报错（旧实现可能取到座钟 19:40 → 误报）
  const good = "## 时间线\n- **10月12日 19:40（真实19:45，戌时三刻）**：主控室 — 领取夜班任务。";
  assert.strictEqual(checkShichenConsistency(good).issues.length, 0, "真实19:45=戌时三刻，不该报错");
  // 真实 23:00 标"亥时三刻"（=21:45）→ 确实错，必须报（这正是交叉校验抓到的那处）
  const bad = "## 时间线\n- **10月12日 23:00（真实23:00，亥时三刻）**：查岗。";
  assert.strictEqual(checkShichenConsistency(bad).issues.length, 1, "真实23:00≠亥时三刻，必须报（此前漏报：m[3] 未剥「刻」）");
});

test("线索地点：容器/随身物/文件算物品线索的地点（17 个未分类值的形状）", () => {
  const b = buildBible(OUTLINE);
  const cases = ["张伟电脑", "赵凯随身", "林哲公文包", "老周红袖章", "赵磊工具袋", "林强更衣柜", "化验室尸检报告", "总经理室转让协议", "法医处（豁免）"];
  for (const c of cases) {
    const k = clueLocationKind(c, b);
    assert.notStrictEqual(k, "unknown", c + " 不该是未分类（实际 " + k + "）");
  }
});

test("线索计划：容器类地点算齐备（物品线索只需地点）", () => {
  const b = buildBible({ ...OUTLINE, cluePlan: [] });
  const r = alignCluePlan([{ id: "A1", location: "林强更衣柜" }], b);
  assert.strictEqual(r.plan[0].complete, true, JSON.stringify(r.plan[0]));
});

test("剧本卫生：自我名字前缀与模板占位符残留都能被确定性抓出（实测样本）", () => {
  const bad1 = "## 时间线\n- 刘芳：**12月25日 19:00（真实）**：时计堂前厅 — 整理打扫工具。";
  assert.strictEqual(findSelfPrefixEntries("刘芳", bad1).length, 1, "带自己名字前缀的条目应被抓出");
  assert.strictEqual(findSelfPrefixEntries("林默", bad1).length, 0, "不是自己的名字不该误报");
  const bad2 = "## 时间线\n- **日期12月5日 23:05（座钟）**：一层车间 — 整理工装。";
  assert.ok(findPlaceholderResidues("王大春", bad2).some((h) => h.word === "日期"), "占位词『日期』应被抓出");
  const bad3 = "## 时间线\n- 李萌：**10月15日 21:30（真实21:30）**：地点 一楼客厅 — 看到刘助理。";
  assert.ok(findPlaceholderResidues("李萌", bad3).some((h) => h.word === "地点"), "占位词『地点』应被抓出");
  assert.strictEqual(findPlaceholderResidues("李萌", "## 时间线\n- 21:30 在一楼客厅整理文件。").length, 0, "正常文本不该误报");
});

// 真因：提示词模板把**字段名**写成了格式样板（`- **日期 时间**：地点 — 事件`），
// 模型分不清"标签"与"示例值"于是照抄标签 → `**日期12月4日 20:10（真实）**：地点一层车间工具房`。
// 真库实测 31 处（顶层壁炉 11 / 糖厂 10 / 老饭店 10），玩家会直接读到。
// 三个真实样本必须能**逐字**修好，且只少标签两个字。
test("占位词残留：无损清理（三个真库形态，逐字只少标签）", () => {
  const cases = [
    ["- **日期12月4日 20:10（真实）**：一层车间工具房 — 帮赵磊整理密封垫片。",
      "- **12月4日 20:10（真实）**：一层车间工具房 — 帮赵磊整理密封垫片。", "形态① `**日期`+数字"],
    ["- **10月12日 18:50（真实18:50）**：地点一楼大厅 — 我坐在大厅角落。",
      "- **10月12日 18:50（真实18:50）**：一楼大厅 — 我坐在大厅角落。", "形态② `**：地点`+房间名"],
    ["- **10月15日 18:20（真实18:20）**：地点 小区3号楼201室 — 收拾了黑色连衣裙。",
      "- **10月15日 18:20（真实18:20）**：小区3号楼201室 — 收拾了黑色连衣裙。", "形态② `**：地点`+空格+房间名"],
  ];
  for (const [src, want, why] of cases) {
    const r = repairPlaceholderResidues("X", src);
    assert.strictEqual(r.script, want, why);
    assert.strictEqual(r.fixed, 1, why + "：应记 1 处");
  }
});

// 误伤测试是这个判据的生命线。第一版写成"占位词后面跟着中文或数字"，
// 在真库上把 `- **地点场景**：…` 改成 `- **场景**：…`（script-parser 还要读这个字段！）、
// 把 `**时间链（三次下毒窗口）**` 改成 `**链…`、把 `：人物角色` 判成残留。
// 真正的边界是**形态**：残留是 `**日期12月4日`（词后跟**数字**）或 `**：地点X`（词前有**冒号**）。
test("占位词残留：正当字段名/章节名/散文一行不动（防误伤，实测三类误报）", () => {
  const keep = [
    "- **地点场景**：沈宅位于镇东河畔，三进院落，青砖黛瓦。",
    "- **地点描述**：一层临街，店堂后接工作间。",
    "**时间链（三次下毒窗口）**：A3+A10（桂姨目击两次进灶房）",
    "1. **时间诡计链**：B3（座钟调时轴划痕）→ B7",
    "# 第二部分：人物角色",
    "| 第三幕：时间的谎言 | 手法推理+集中辩驳 | 60分钟 |",
    "线索对应：人物关系、浅层杀机、公开行踪矛盾",
    "他压低声音问我：地点定了吗？",
    "**日期标注**一律写成 X月X日。",
    "- **人物设定**：林默，管家。",
  ];
  for (const s of keep) {
    const r = repairPlaceholderResidues("X", s);
    assert.strictEqual(r.script, s, "被判残留并改坏了：" + s);
    assert.strictEqual(r.fixed, 0, "不该动手：" + s);
    assert.strictEqual(findPlaceholderResidues("X", s).length, 0, "不该报残留：" + s);
  }
});

// "报得出就必须修得掉"：检出与修复必须同源，否则会留下"报了 N 处、只修 M 处"的黑洞。
test("占位词残留：可修的检出数 = 修掉的数，修后重扫归零；体检也会报出它", () => {
  const bad = "## 时间线\n- **日期12月4日 20:10（真实）**：一层车间。\n- **10月12日 18:50（真实18:50）**：地点一楼大厅 — 坐着核对账目。";
  const before = findPlaceholderResidues("王大春", bad);
  assert.strictEqual(before.length, 2, JSON.stringify(before));
  assert.ok(before.every(h => h.repairable), "这两处都应判为可无损修");
  const { script, fixed, left } = repairPlaceholderResidues("王大春", bad);
  assert.strictEqual(fixed, before.length, "可修的都必须被修掉");
  assert.strictEqual(left.length, 0);
  assert.strictEqual(findPlaceholderResidues("王大春", script).length, 0, "修完不应再有残留");
  const code = (t) => checkTimelineHealth("王大春", t).issues.filter(i => i.code === "placeholder_residue").length;
  assert.strictEqual(code(bad), 2, "兜底网必须报出来");
  assert.strictEqual(code(script), 0, "修完不该再报");
});