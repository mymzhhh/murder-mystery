// 共享事实：死亡时刻禁令 + 角色权威时刻锚点 + 死后活动检测。
//
// 背景（实测）：三次端到端复验里，交叉校验反复报出同一类致命漏洞——
// "基准 19:20 已身亡，某角色却写 20:00 死者还在交代事情"；
// 以及"某角色全程用座钟报时但事件时刻与基准对不上"。
// 根因是角色拿到的只是一张大表，死亡条目在其中没有任何特殊地位，
// 也没有"哪些时刻属于我、不能改"的锚点。
const test = require("node:test");
const assert = require("node:assert");
const {
  findDeathMoment,
  characterAnchors,
  buildSharedFacts,
  checkVictimAfterDeath,
  buildEventTable,
  crossesMidnight,
  nextDayLabel,
  parseCnNum,
  cnNum,
  checkDateLabels,
  parseDateLabel,
  compareDateLabels,
  buildPublicEventTable,
  normalizePublicEvents,
  validatePublicEvents,
  checkPublicEventAnchors,
  rosterNames,
  applyLineRewrites,
  checkDateAgreement,
  dateDiffDays,
  buildObjectStateTable,
  validateObjectStates,
  onCaseNight,
  causeKeywords,
} = require("../../src/script/murder-mystery-builder");

// 取自最后一次端到端（2015 深圳·触电案）的权威时间线
const OUTLINE = {
  victim: { name: "陆峥", identity: "科技公司创始人", cause: "触电" },
  timeline: [
    { time: "19:20", desc: "陆峥在31楼会议室触电身亡（机械表停于19:22）" },
    { time: "19:35", desc: "林晚到31楼送文件" },
    { time: "20:30", desc: "林晚发现陆峥尸体并报警" },
    { time: "20:40", desc: "何嘉树回到宴会厅" },
  ],
};

// ==================== 日期基准必须"每个角色都拿到"（实测根因）====================
// 实测（1996 长沙·湘绣厂，密室诡计）：那条"案发日期统一为「11月8日」"原来写在 buildTimeAxis 内，
// 而 buildTimeAxis 开头是 `if (!off) return ""` —— **非时钟类诡计拿不到这段话**，
// 于是 6 个角色各自编日期（11月19／27／13／17日…），修订要打 37 条补丁去统一。
// 同一天的时钟类诡计那轮（川剧团）拿到了，日期一次就对。
// **指令的作用域应由"这条事实是否普遍成立"决定，而不是由"诡计类型"决定。**

test("buildSharedFacts：必须带案发日期基准（不依赖诡计类型）", () => {
  const outline = {
    caseDate: "11月8日",
    victim: { name: "周世奎" },
    timeline: [{ time: "20:40", desc: "凶手在站台击杀周世奎" }],
    players: [{ name: "甲" }],
  };
  const facts = buildSharedFacts(outline, { name: "甲" });
  assert.ok(facts.includes("案发日期统一为「11月8日」"), "有案发日时必须写明，且要在所有角色都拿到的这段里");
  assert.ok(!facts.includes("座钟"), "不该混入时钟类诡计专属内容");
});

test("buildSharedFacts：没有案发日时退化为『禁止自创日期』的相对表述", () => {
  const outline = {
    victim: { name: "周世奎" },
    timeline: [{ time: "20:40", desc: "凶手在站台击杀周世奎" }],
  };
  const facts = buildSharedFacts(outline, { name: "甲" });
  assert.ok(facts.includes("未设定绝对日期"), "缺日期时也要给出明确约束");
  assert.ok(facts.includes("严禁自创"), "关键禁令要在");
});

test("buildSharedFacts：死亡时刻禁令与日期基准可以并存", () => {
  const outline = {
    caseDate: "11月8日",
    victim: { name: "周世奎" },
    timeline: [{ time: "20:40", desc: "凶手在站台击杀周世奎" }],
  };
  const facts = buildSharedFacts(outline, { name: "甲" });
  assert.ok(facts.includes("死亡时刻是 20:40"), "9.9 修的死亡禁令不能被这次改动挤掉");
  assert.ok(facts.includes("案发日期统一为"));
});

// ==================== 死亡时刻抽取 ====================

test("findDeathMoment：取身亡那一条，不取发现尸体那一条", () => {
  assert.strictEqual(findDeathMoment(OUTLINE), "19:20");
});

test("findDeathMoment：发现/报案行即使含『尸体』也不当作死亡时刻", () => {
  const onlyDiscover = {
    victim: { name: "陆峥" },
    timeline: [{ time: "20:30", desc: "林晚发现陆峥尸体并报警" }],
  };
  assert.strictEqual(findDeathMoment(onlyDiscover), null, "发现时刻不是死亡时刻，混用会把禁令整体推后");
});

test("findDeathMoment：多条死亡行时优先点名死者的那条", () => {
  const outline = {
    victim: { name: "陆峥" },
    timeline: [
      { time: "19:00", desc: "传闻有员工死亡" },
      { time: "19:20", desc: "陆峥触电身亡" },
    ],
  };
  assert.strictEqual(findDeathMoment(outline), "19:20");
});

test("findDeathMoment：没有死亡信息返回 null", () => {
  assert.strictEqual(findDeathMoment({ timeline: [{ time: "21:00", desc: "宾客散去" }] }), null);
  assert.strictEqual(findDeathMoment({}), null);
  assert.strictEqual(findDeathMoment(null), null);
});

// ==================== 死亡时刻：补上「击杀」等致死表述（实测漏判） ====================
// 实测（2003 重庆·缆车调度员那轮的真实时间线）：时间线写「20:40 …在站台击杀周世奎」，
// 而动词表里没有「击杀」→ findDeathMoment **静默返回 null** →
// buildSharedFacts 里"死者死后不得再互动"那条硬约束整条不注入给任何角色、
// ensureDeathConsistent 永不启动。三轮端到端"就地改写"从未触发的根因就在这里：
// **不是修复路径不工作，而是检测压根没跑**。

test("findDeathMoment：真实时间线里的「击杀」必须能识别（回归）", () => {
  const outline = {
    victim: { name: "周世奎" },
    timeline: [
      { time: "18:00", desc: "谭志强到北站替罗大力顶岗，周世奎交班后本应离开但留下核对账目" },
      { time: "20:40", desc: "谭志强从工具架取铁钩，在站台击杀周世奎，左手被抓伤" },
      { time: "11月9日 6:30", desc: "早班交接，周世奎尸体被发现，全员被留在站房" },
    ],
  };
  assert.strictEqual(findDeathMoment(outline), "20:40");
});

test("findDeathMoment：常见致死动词逐个识别", () => {
  const verbs = ["杀死", "击杀", "击毙", "勒死", "毒死", "刺死", "捅死", "砍死", "打死",
    "掐死", "闷死", "淹死", "溺死", "烧死", "电死", "摔死", "砸死", "捂死", "坠亡", "枪杀", "遇刺"];
  for (const v of verbs) {
    const o = { victim: { name: "甲" }, timeline: [{ time: "21:00", desc: `凶手把甲${v}了` }] };
    assert.strictEqual(findDeathMoment(o), "21:00", `「${v}」应被识别为死亡表述`);
  }
});

test("findDeathMoment：结果补语构词（X致死 / X而死）也要识别（第二次实测漏判）", () => {
  // 实测：1998 哈尔滨·冷库那轮时间线写「21:40 …用冻硬铁托盘击头致死，掩门离开」，
  // 当时表里一条"致死构词"都没有 → 又是静默 null。
  const real = {
    victim: { name: "马淑芬", causeOfDeath: "冻硬铁托盘击中头部致颅脑损伤" },
    timeline: [
      { time: "21:05", desc: "周红梅离席去出纳室，实际绕到财务室撕走亏空页" },
      { time: "21:40", desc: "周红梅尾随至三号冷库，以对数为名骗马淑芬入库，用冻硬铁托盘击头致死，掩门离开" },
      { time: "23:55", desc: "撬开门闩，发现马淑芬尸体" },
    ],
  };
  assert.strictEqual(findDeathMoment(real), "21:40");
  const forms = ["中毒致死", "失血过多而死", "被绳索勒住颈部窒息而死", "遭人杀害", "不幸丧生", "当场殒命", "命丧于此"];
  for (const f of forms) {
    const o = { victim: { name: "甲" }, timeline: [{ time: "22:00", desc: `甲${f}` }] };
    assert.strictEqual(findDeathMoment(o), "22:00", `「${f}」应被识别`);
  }
});

test("findDeathMoment：计划行不当作死亡时刻（判错会把写对的内容当违规改掉）", () => {
  const o = {
    victim: { name: "周世奎" },
    timeline: [
      { time: "19:00", desc: "谭志强决定杀死周世奎，为此盘算了两天" },
      { time: "20:40", desc: "谭志强在站台击杀周世奎" },
    ],
  };
  assert.strictEqual(findDeathMoment(o), "20:40", "有真实致死行时，计划行不该被选中");
});

test("findDeathMoment：整条时间线只有计划行 → 返回 null（宁可漏判不可误判）", () => {
  const o = { victim: { name: "甲" }, timeline: [{ time: "19:00", desc: "乙打算毒死甲" }] };
  assert.strictEqual(findDeathMoment(o), null, "把计划时刻当成死亡时刻会让禁令整体提前，危害大于漏判");
});

// ==================== 死亡时刻：结构化兜底（靠死因描述，不靠动词表）====================
// 第三次实测漏判（1993 成都·川剧团）：时间线写「21:10 贺清源推倒大戏箱压住陈慕舟口鼻」——
// 全句**没有任何死亡动词**（它只描述动作），而死因字段写的是"被推倒的大戏箱压住口鼻窒息死亡"。
// 靠词表穷举永远会漏（漏过"击杀"、漏过"致死"），所以补一条结构化判据：
// 行内**同时出现死者姓名与死因的实词片段**（且死者不是该行的动作主体）→ 即死亡时刻。

test("causeKeywords：从死因里抽出可用片段，且不产出过短片段", () => {
  const kw = causeKeywords("被推倒的大戏箱压住口鼻窒息死亡");
  assert.ok(kw.includes("大戏箱压住口鼻窒息"), "长实词片段要保留");
  assert.ok(kw.some((k) => k.includes("压住口鼻")), "长片段要切出 4 字窗口");
  assert.ok(!kw.includes("推倒"), "2 字片段刻意排除（太短会到处命中）");
  assert.ok(kw.every((k) => k.length >= 3), "不得产出 <3 字的片段（太短会到处命中）");
  assert.deepStrictEqual(causeKeywords(""), []);
  assert.deepStrictEqual(causeKeywords(null), []);
});

test("findDeathMoment：时间线没有死亡动词时，用死因兜底（真实大纲回归）", () => {
  const real = {
    victim: { name: "陈慕舟", causeOfDeath: "被推倒的大戏箱压住口鼻窒息死亡" },
    timeline: [
      { time: "19:00", desc: "马啸天与陈慕舟在乐池为板式改动争执，被罗小满听见" },
      { time: "21:10", desc: "贺清源推倒大戏箱压住陈慕舟口鼻，陈怀表摔碎停摆于9:13；库房门锁此刻仍未开" },
      { time: "21:40", desc: "众人发现陈慕舟尸体" },
    ],
  };
  assert.strictEqual(findDeathMoment(real), "21:10", "兜底必须能救回这种『只写动作、不写死亡』的时间线");
});

test("findDeathMoment：兜底不得把『死者自己在搬弄凶器』的前情行当成死亡时刻", () => {
  const o = {
    victim: { name: "陈慕舟", causeOfDeath: "被推倒的大戏箱压住口鼻窒息死亡" },
    timeline: [
      { time: "18:00", desc: "陈慕舟把大戏箱从库房推出来归位，累得直喘" },   // 死者是动作主体 → 不是死亡时刻
      { time: "21:10", desc: "贺清源推倒大戏箱压住陈慕舟口鼻" },
    ],
  };
  assert.strictEqual(findDeathMoment(o), "21:10");
});

test("findDeathMoment：兜底不得被『只提到凶器、死者不在场』的行带偏", () => {
  const o = {
    victim: { name: "陈慕舟", causeOfDeath: "被推倒的大戏箱压住口鼻窒息死亡" },
    timeline: [
      { time: "20:00", desc: "贺清源把大戏箱挪到走廊中间，试了试推不倒" },      // 无死者姓名
      { time: "21:10", desc: "贺清源推倒大戏箱压住陈慕舟口鼻" },
    ],
  };
  assert.strictEqual(findDeathMoment(o), "21:10");
});

test("findDeathMoment：兜底也要排除发现尸体那一条", () => {
  const o = {
    victim: { name: "陈慕舟", causeOfDeath: "被推倒的大戏箱压住口鼻窒息死亡" },
    timeline: [
      { time: "21:10", desc: "贺清源推倒大戏箱压住陈慕舟口鼻" },
      { time: "21:40", desc: "众人发现陈慕舟被大戏箱压着，尸体已凉" },        // 也含死因片段 → 必须排除
    ],
  };
  assert.strictEqual(findDeathMoment(o), "21:10");
});

test("findDeathMoment：与已发生事实同句的『准备』不算计划行（防止误排除真实死亡行）", () => {
  const o = {
    victim: { name: "周世奎" },
    timeline: [{ time: "20:40", desc: "周世奎正准备离开，被谭志强从背后击杀" }],
  };
  assert.strictEqual(findDeathMoment(o), "20:40", "「准备离开」+「被击杀」是真实死亡行");
});

// ==================== 死亡后活动：补日期维度（防误伤"案发前一日"）====================
// 实测（同上一轮的产物）：角色剧本里「**11月7日** 21:00 周世奎在二楼朝下喊我」这条
// **案发前一日**的正当内容，因为时刻晚于死亡时刻（20:40）被判成"死者死后仍在活动"。
// 量过真实产物：旧判据判出的 1 处违规，就是这 1 处误报（100% 误报率）。
// 病根与 checkDateLabels 规则 B、checkDateAgreement 相同：**代码分不清"案发夜"与"前情"**。

test("onCaseNight：前一日/其他日期不判，当日/次日/无标注判", () => {
  assert.equal(onCaseNight("11月7日 21:00 我在站房", "11月8日"), false, "不是案发日");
  assert.equal(onCaseNight("11月8日 21:00 我在站房", "11月8日"), true, "就是案发日");
  assert.equal(onCaseNight("11月7日 21:00 我在站房", null), false, "案发日未知 → 不判带日期的行（保守）");
  assert.equal(onCaseNight("21:00 我在站房", null), true, "无日期标注 → 沿用原行为");
  assert.equal(onCaseNight("案发前一日 21:00 我在站房", null), false);
  assert.equal(onCaseNight("案发当日 21:00 我在站房", null), true);
  assert.equal(onCaseNight("次日 01:00 我在站房", null), true);
  assert.equal(onCaseNight("腊月初八 21:00 我在站房", "腊月初八"), true, "中文日期也要支持");
});

test("checkVictimAfterDeath：案发前一日的正当内容不再被误判（实测误报）", () => {
  const line = "- **11月7日 21:00【座钟】**：站房值班休息室 — 我当夜班，周世奎在二楼调度室窗口朝下喊我，提醒我巡逻签到别再出问题，我应了声";
  assert.strictEqual(checkVictimAfterDeath(line, "20:40", "周世奎", null).violations.length, 0,
    "案发日未知时，带日期的行不该被判为死亡后活动");
  assert.strictEqual(checkVictimAfterDeath(line, "20:40", "周世奎", "11月7日").violations.length, 1,
    "但若案发日就是 11月7日，同一行确实是违规（判据不是把带日期的行一律放过）");
});

test("checkVictimAfterDeath：案发夜的违规仍要判（加日期维度不能变成漏判）", () => {
  // 注意：死者必须紧跟表内互动动词（victimActs 的判据），"抱怨"不在表内
  const noDate = "- **21:10**：我在站台上碰见周世奎，他说交接单还没核对完";
  assert.strictEqual(checkVictimAfterDeath(noDate, "20:40", "周世奎", null).violations.length, 1);
  const sameDay = "- **11月8日 21:10**：周世奎拉住了我，让我别走";
  assert.strictEqual(checkVictimAfterDeath(sameDay, "20:40", "周世奎", "11月8日").violations.length, 1);
  const prevDay = "- **11月7日 21:10**：周世奎拉住了我，让我别走";
  assert.strictEqual(checkVictimAfterDeath(prevDay, "20:40", "周世奎", "11月8日").violations.length, 0,
    "前一日同一时刻的互动是正当的");
});

// ==================== 角色权威锚点 ====================

test("characterAnchors：只取点名了该角色的条目", () => {
  const a = characterAnchors(OUTLINE, "林晚");
  assert.deepEqual(a.map((x) => x.time), ["19:35", "20:30"]);
  assert.deepEqual(characterAnchors(OUTLINE, "何嘉树").map((x) => x.time), ["20:40"]);
});

test("characterAnchors：查不到或名字为空时返回空数组", () => {
  assert.deepEqual(characterAnchors(OUTLINE, "张三"), []);
  assert.deepEqual(characterAnchors(OUTLINE, ""), []);
  assert.deepEqual(characterAnchors(null, "林晚"), []);
});

// ==================== 共享事实文本 ====================

test("buildSharedFacts：含死亡时刻禁令（点名死者与时刻）", () => {
  const s = buildSharedFacts(OUTLINE, { name: "林晚" });
  assert.ok(/死者「陆峥」的死亡时刻是 19:20/.test(s), "要点名死者与时刻");
  assert.ok(/19:20 之后/.test(s), "要说清禁令的时间界");
  assert.ok(/不得再与死者互动/.test(s), "要写成禁令而不是背景说明");
});

test("buildSharedFacts：含该角色自己的权威时刻锚点", () => {
  const s = buildSharedFacts(OUTLINE, { name: "林晚" });
  assert.ok(/19:35/.test(s) && /20:30/.test(s), "要列出该角色的锚点时刻");
  assert.ok(!/何嘉树回到宴会厅/.test(s), "不该把别人的条目塞给他");
});

test("buildSharedFacts：没有死亡时刻时不编造禁令", () => {
  const s = buildSharedFacts({ victim: { name: "陆峥" }, timeline: [] }, { name: "林晚" });
  assert.ok(!/死亡时刻/.test(s), "无依据不得声明死亡时刻");
});

// ==================== 死后活动检测 ====================

test("checkVictimAfterDeath：抓出死亡之后死者仍活动", () => {
  // 实测原文形态：某角色写死者 20:00 还在给她下指示
  const text = "- 案发当日 20:00【真实】：陆峥接了个电话后对我说，让我先上去试投影。";
  const r = checkVictimAfterDeath(text, "19:20", "陆峥");
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations.length, 1);
  assert.strictEqual(r.violations[0].time, "20:00");
});

test("checkVictimAfterDeath：死亡之前的互动不算违规", () => {
  const text = "- 案发当日 19:00【真实】：陆峥对我说了年会的安排。";
  assert.strictEqual(checkVictimAfterDeath(text, "19:20", "陆峥").ok, true);
});

test("checkVictimAfterDeath：发现尸体不算违规（否则必然误伤）", () => {
  const text = "- 案发当日 20:30【真实】：我推门发现陆峥倒在血泊中，立刻退到走廊报警。";
  assert.strictEqual(checkVictimAfterDeath(text, "19:20", "陆峥").ok, true, "发现尸体是必须发生的情节");
});

// ⚠️ 实测误报（清光绪·身份诡计那一轮）：检测器把 3 处发现尸体情节判成"死后活动"，
// 导致 4 个角色进入无谓重写（3 个重写后并未变好）。发现现场必然有"喊起来""我叫他"，
// 而死者在句中是别人动作的宾语、或被描述成尸体——**误报比漏报有害得多**。
// 修法：动词必须紧跟在死者姓名之后。
test("checkVictimAfterDeath：不误伤发现现场（实测原文形态）", () => {
  const lines = [
    "- **腊月初八 23:30【座钟】**：正院 — 我在正院打更，听见霍青在祠堂门口喊起来，跑过去一看，常伯衡跪在供桌前，银匣空了。",
    "- **腊月初八 23:30【座钟】**：正院祠堂 — 我推门进去，见常伯衡跪在供桌前，一动不动。我叫他，没应。上前摸，人已经凉了。",
    "- **23:30【座钟】**：我赶过去，祠堂门虚掩，常伯衡跪在供桌前，供桌银匣开着，祭银没了。",
  ].join("\n");
  assert.strictEqual(checkVictimAfterDeath(lines, "21:15", "常伯衡").ok, true, "发现尸体现场不得被误判");
});

test("checkVictimAfterDeath：死者是别人动作的宾语时不判", () => {
  const text = "- 23:30 我冲着祠堂方向喊常伯衡的名字，没人应。";
  assert.strictEqual(checkVictimAfterDeath(text, "21:15", "常伯衡").ok, true);
});

test("checkVictimAfterDeath：死者的所属物/地点（常伯衡书房）不判", () => {
  const text = "- 21:40【真实】：我潜入常伯衡书房，取出他写的信底烧毁。";
  assert.strictEqual(checkVictimAfterDeath(text, "21:15", "常伯衡").ok, true, "死者已死，但凶手进他的书房是正当情节");
});

test("checkVictimAfterDeath：死者做主语才是真违规（生前/死后都覆盖）", () => {
  // 实测 2015 那次的原文形态：死者 20:00 还在给人下指示
  const bad1 = "- 案发当日 20:00【真实】：陆峥接了个电话后对我说，让我先上去试投影。";
  assert.strictEqual(checkVictimAfterDeath(bad1, "19:20", "陆峥").ok, false);
  const bad2 = "- 21:30【真实】：常伯衡吩咐我今夜别熄账房的灯。";
  assert.strictEqual(checkVictimAfterDeath(bad2, "21:15", "常伯衡").ok, false);
  // 同形态放在死亡之前 → 不判
  const fine = "- 20:30【真实】：常伯衡吩咐我今夜别熄账房的灯。";
  assert.strictEqual(checkVictimAfterDeath(fine, "21:15", "常伯衡").ok, true);
});

test("checkVictimAfterDeath：不含死者姓名的行不判", () => {
  const text = "- 案发当日 20:00【真实】：我对何嘉树说，先上去试投影。";
  assert.strictEqual(checkVictimAfterDeath(text, "19:20", "陆峥").ok, true);
});

test("checkVictimAfterDeath：缺少死亡时刻或死者姓名时不启用", () => {
  const text = "- 20:00 陆峥对我说了句话。";
  assert.strictEqual(checkVictimAfterDeath(text, null, "陆峥").needed, false);
  assert.strictEqual(checkVictimAfterDeath(text, "19:20", "").needed, false);
});

test("checkVictimAfterDeath：跨午夜的时刻不误判（避免把次日凌晨算成违规）", () => {
  // 死亡 23:50，剧本里 00:30 的行属于次日，不应按同日比较判为"早于死亡"或误报
  const text = "- 次日 00:30【真实】：我在走廊碰见陆峥。";
  const r = checkVictimAfterDeath(text, "23:50", "陆峥");
  assert.strictEqual(r.ok, true, "跨午夜无法可靠判定，宁可漏报不可误伤");
});

// ==================== 权威事件表（独立于时钟）====================
// 背景：buildTimeAxis 只在能解析出"分钟级时钟偏差"时才产出。像"买通更夫漏敲三更"这类诡计
// 根本没有分钟偏差 → 角色拿不到任何权威事件表 → 各方对同一事件各说各话
// （实测 1948 北平：一个人送参汤，三个角色给出的时刻差 35 分钟）。

const NIGHT = {
  victim: { name: "沈慎之" },
  players: [{ name: "周慕堂" }, { name: "白玉茹" }, { name: "顾小舟" }],
  npcs: [{ name: "佟桂芳" }],
  timeline: [
    { time: "22:50", desc: "周慕堂用镇纸击杀沈慎之" },
    { time: "23:20", desc: "白玉茹送参汤到书房廊下" },
    { time: "00:40", desc: "牌局散场，顾小舟去账房" },
    { time: "06:30", desc: "佟桂芳发现尸体并报警" },
  ],
};

test("parseCnNum / cnNum：中文数字往返（1..30）", () => {
  for (let n = 1; n <= 30; n++) {
    assert.strictEqual(parseCnNum(cnNum(n)), n, `${n} 往返失败（${cnNum(n)}）`);
  }
  assert.strictEqual(parseCnNum("12"), 12);
  assert.strictEqual(parseCnNum("随便"), null);
});

test("nextDayLabel：中文与阿拉伯日期都能加一天，月底不给错答案", () => {
  assert.strictEqual(nextDayLabel("十二月十五日"), "十二月十六日");
  assert.strictEqual(nextDayLabel("12月15日"), "12月16日");
  assert.strictEqual(nextDayLabel("十二月十九日"), "十二月二十日");
  // 天数 ≥ 28 一律不给：二月没有三十日，而"十二月三十日"是否成立取决于月份与闰年。
  // 宁可退回相对表述（案发次日），也不给一个可能错的具体日期。
  assert.strictEqual(nextDayLabel("十二月二十七日"), "十二月二十八日");
  assert.strictEqual(nextDayLabel("十二月二十八日"), null);
  assert.strictEqual(nextDayLabel("十二月二十九日"), null);
  assert.strictEqual(nextDayLabel("十二月三十日"), null);
  assert.strictEqual(nextDayLabel("案发当日"), null);
  assert.strictEqual(nextDayLabel(null), null);
});

test("crossesMidnight：出现凌晨时刻或时刻回绕即判为跨午夜", () => {
  assert.strictEqual(crossesMidnight(NIGHT.timeline), true);
  assert.strictEqual(crossesMidnight([{ time: "20:00" }, { time: "21:00" }]), false);
  assert.strictEqual(crossesMidnight([{ time: "21:00" }, { time: "19:00" }]), true, "时刻回绕也算跨午夜");
  assert.strictEqual(crossesMidnight([]), false);
});

test("buildEventTable：无时钟偏差时也产出权威事件表（这是关键）", () => {
  const t = buildEventTable(NIGHT);
  assert.ok(t.includes("权威事件表"), "必须有无时钟也能用的公共事件表");
  for (const hm of ["22:50", "23:20", "00:40", "06:30"]) {
    assert.ok(t.includes(hm), `缺事件时刻 ${hm}`);
  }
  assert.ok(/同一事件只能有一个时刻/.test(t), "要说清「一件事只有一个时刻」的规则");
});

test("buildEventTable：算出每个事件涉及哪些角色（供各方对齐）", () => {
  const t = buildEventTable(NIGHT);
  assert.match(t, /\| 23:20 \|[^\n]*白玉茹/, "送参汤应点名白玉茹");
  assert.match(t, /\| 06:30 \|[^\n]*佟桂芳/, "发现尸体应点名佟桂芳");
  assert.match(t, /\| 22:50 \|[^\n]*周慕堂/);
});

test("buildEventTable：跨午夜时给出日期分界规则", () => {
  const t = buildEventTable(NIGHT);
  assert.ok(/跨过午夜/.test(t), "要提醒跨午夜");
  assert.ok(/00:00 之后的时刻属于\*\*案发次日\*\*/.test(t));
  assert.ok(/禁止把整段夜间事件统一标成同一天/.test(t), "要针对「整体错位一天」这种形态");
});

test("buildEventTable：没有时间线时返回空串（不编造）", () => {
  assert.strictEqual(buildEventTable({ timeline: [] }), "");
  assert.strictEqual(buildEventTable(null), "");
});

// ==================== 跨午夜日期标注校验 ====================
// 实测原文形态（1948 北平）：某角色把案发当日牌局（21:00、22:30）全标成"十四日"，
// 把 00:05/00:10 标成"十五日"——整篇错位一天。

const DATE_OPTS = { caseDate: "十二月十五日", nextDate: "十二月十六日", midnight: true };

test("checkDateLabels：午夜后的事件标成案发当日即违规，并提示整篇可能整体错位", () => {
  const text = "- **【真实】十二月十五日 00:10**：书房廊下 — 我端着托盘过去。";
  const r = checkDateLabels(text, DATE_OPTS);
  assert.strictEqual(r.ok, false);
  assert.ok(/属于案发次日/.test(r.violations[0].reason), r.violations[0].reason);
  assert.ok(/整体错位了一天/.test(r.violations[0].reason), "要提示这是整体位移一天的典型症状");
});

test("checkDateLabels：午夜后标成案发次日才正确", () => {
  const text = "- **【真实】十二月十六日 00:10**：书房廊下 — 我端着托盘过去。";
  assert.strictEqual(checkDateLabels(text, DATE_OPTS).ok, true);
});

test("checkDateLabels：夜前事件标成案发次日即违规", () => {
  const text = "- **【真实】十二月十六日 21:00**：前厅 — 牌局开始。";
  const r = checkDateLabels(text, DATE_OPTS);
  assert.strictEqual(r.ok, false);
  assert.ok(/属于案发当日/.test(r.violations[0].reason), r.violations[0].reason);
});

test("checkDateLabels：不误伤前一日的晚间情节（代码不猜「这行是案发夜还是前情」）", () => {
  // 第一版加了"夜间事件日期必须等于案发当日"，结果把"前一日 20:30 在报馆"这种正当前情判成违规。
  // 上一日的晚间事件标上一日的日期本来就是对的——判别它需要语义理解，代码不该猜。
  const text = "- **十二月十四日 20:30**：报馆 — 我核完社论清样，顾小舟在排字。";
  assert.strictEqual(checkDateLabels(text, DATE_OPTS).ok, true, "前一日晚间情节不应被判");
});

// ===== 规则 C：晚于案发当日的具体日期 =====
// 实测（清光绪·身份诡计）：设定集是"腊月初八"案发，柳氏整个时间线却写成
// "腊月十九/二十/廿一"，与其余五人（初七/初八/初九）完全错位。
// 上一轮为避开"前一日情节"的误伤，我把"第三个日期"整条规则删掉了——连带把这个真 bug 也放过了。
// 精确的判法是：**只判晚于案发当日**的日期（案发夜之后没有正当情节），早于的不判（可能是前情）。

test("parseDateLabel / compareDateLabels：支持腊月初八、廿一这类写法", () => {
  assert.deepEqual(parseDateLabel("腊月初八"), { month: 12, day: 8 });
  assert.deepEqual(parseDateLabel("腊月廿一"), { month: 12, day: 21 });
  assert.deepEqual(parseDateLabel("十二月十五日"), { month: 12, day: 15 });
  assert.deepEqual(parseDateLabel("12月15日"), { month: 12, day: 15 });
  assert.deepEqual(parseDateLabel("正月初一"), { month: 1, day: 1 });
  assert.equal(parseDateLabel("案发当日"), null);
  assert.ok(compareDateLabels("腊月十九", "腊月初八") > 0, "十九 晚于 初八");
  assert.ok(compareDateLabels("腊月初五", "腊月初八") < 0, "初五 早于 初八");
  assert.equal(compareDateLabels("腊月初八", "腊月初九"), -1);
});

test("checkDateLabels：晚于案发当日的具体日期被抓出（实测那种整体错位）", () => {
  const opts = { caseDate: "腊月初八", nextDate: "腊月初九", midnight: true };
  const text = "- **腊月十九 21:00**：柴房 — 我与他在火盆边坐到亥时末。";
  const r = checkDateLabels(text, opts);
  assert.strictEqual(r.ok, false);
  assert.ok(/晚于案发当日/.test(r.violations[0].reason), r.violations[0].reason);
});

test("checkDateLabels：早于案发当日的具体日期不判（可能是正当前情）", () => {
  const opts = { caseDate: "腊月初八", nextDate: "腊月初九", midnight: true };
  const text = "- **腊月初五 20:30**：前厅 — 他来过一趟，坐了半刻就走。";
  assert.strictEqual(checkDateLabels(text, opts).ok, true, "更早的日期可能是前情，不该判");
});

test("checkDateLabels：案发次日标出来是正常的，不算错位", () => {
  const opts = { caseDate: "腊月初八", nextDate: "腊月初九", midnight: true };
  const text = "- **腊月初九 07:00**：正厅 — 差役来查案。";
  assert.strictEqual(checkDateLabels(text, opts).ok, true);
});

test("checkDateLabels：前一日标注不判", () => {
  const text = "- **案发前一日 20:30**：报馆 — 我把一封信塞进内袋。";
  assert.strictEqual(checkDateLabels(text, DATE_OPTS).ok, true);
});

test("checkDateLabels：无统一日期时用相对标注判定（案发当日/次日）", () => {
  const opts = { caseDate: null, nextDate: null, midnight: true };
  assert.strictEqual(checkDateLabels("- **案发当日 22:40**：我借口如厕离席。", opts).ok, true);
  assert.strictEqual(checkDateLabels("- **案发当日 00:10**：我端着托盘过去。", opts).ok, false);
  assert.strictEqual(checkDateLabels("- **案发次日 00:10**：我端着托盘过去。", opts).ok, true);
});

test("checkDateLabels：不跨午夜时整个检查不启用", () => {
  const text = "- **十二月十五日 00:10**：书房廊下 — 我端着托盘过去。";
  const r = checkDateLabels(text, { caseDate: "十二月十五日", nextDate: null, midnight: false });
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.ok, true);
});

// ==================== 角色级公共事件表 ====================
// 背景（实测）：事件表只能对齐 timeline 里已有的事件。"某人何时上楼、手里拿着什么"
// 这类**角色级公共行踪**不在 timeline 里，于是四个角色对同一趟走动给出四种时刻与四种携带物。
// 这一块让大纲阶段产出 publicEvents 作为它的权威来源。

const PE_OUTLINE = {
  victim: { name: "苏韵秋" },
  players: [{ name: "苏韵秋" }, { name: "顾行舟" }, { name: "钱妈" }],
  npcs: [{ name: "阿蘅" }],
  publicEvents: [
    { time: "19:00", actor: "苏韵秋", place: "绣楼三层", doing: "携黑漆账匣上楼", who: ["钱妈"] },
    { time: "18:30", actor: "顾行舟", place: "前厅", doing: "入席", who: ["钱妈", "阿蘅"] },
    { time: "20:10", actor: "钱妈", place: "二层廊下", doing: "送醒酒汤", who: [] },
    { time: "21:30", actor: "阿蘅", place: "绣楼三层", doing: "上楼收拾", who: ["钱妈"] },
  ],
};

test("rosterNames：players + npcs + 死者（死者是公共事件的合法当事人）", () => {
  const o = { players: [{ name: "甲" }, { name: "乙" }], npcs: [{ name: "丙" }], victim: { name: "丁" } };
  assert.deepEqual(rosterNames(o).sort(), ["丁", "丙", "乙", "甲"].sort());
  // ⚠️ 实测教训：第一版不含死者，把"东家独自进茶仓"这类**死者的公开行踪**
  // 判成"当事人不在名单内"并丢弃——而死者的行踪恰恰是公共事件表最该收录的。
  assert.deepEqual(rosterNames(null), []);
});

test("validatePublicEvents：死者的公开行踪不算违规", () => {
  const o = {
    players: [{ name: "甲" }, { name: "乙" }],
    victim: { name: "东家" },
    publicEvents: [
      ...Array.from({ length: 6 }, (_, i) => ({ time: `1${i}:00`, actor: "甲" })),
      { time: "19:00", actor: "乙" },
      { time: "20:00", actor: "东家", place: "茶仓", doing: "独自进仓查货" },
    ],
  };
  const v = validatePublicEvents(o);
  assert.strictEqual(v.ok, true, v.errors.join("；"));
});

test("buildPublicEventTable：没有公共事件时返回空串（不编造）", () => {
  assert.strictEqual(buildPublicEventTable({ players: [{ name: "甲" }] }), "");
  assert.strictEqual(buildPublicEventTable(null), "");
});

test("buildPublicEventTable：丢弃当事人不在名单内的条目（防虚构人名污染提示词）", () => {
  // 实测：大纲写出了名单里不存在的「查无此人」。这类条目一旦注入，等于把虚构人物名
  // 送进每个角色的提示词——正是"名单外角色名污染"。
  const outline = {
    players: [{ name: "甲" }, { name: "乙" }],
    victim: { name: "东家" },
    publicEvents: [
      { time: "18:30", actor: "甲", place: "前厅", doing: "入席", who: ["乙", "查无此人"] },
      { time: "19:00", actor: "查无此人", place: "茶仓", doing: "独自进仓", who: [] },
      { time: "20:00", actor: "东家", place: "茶仓", doing: "查货", who: [] },
    ],
  };
  const t = buildPublicEventTable(outline);
  assert.ok(t.includes("甲"), "名单内当事人要保留");
  assert.ok(!t.includes("查无此人"), "名单外当事人必须整条丢弃");
  assert.ok(t.includes("东家"), "死者的公开行踪必须保留（他曾被误判为名单外）");
});

test("normalizePublicEvents：丢弃缺时刻/缺当事人的条目，去重并按时刻排序", () => {
  const raw = [
    { time: "20:10", actor: "钱妈", doing: "送汤" },
    { time: "没写", actor: "顾行舟", doing: "入席" },
    { time: "18:30", actor: "", doing: "入席" },
    { time: "20:10", actor: "钱妈", doing: "重复条目应被去掉" },
    { time: "18:30", actor: "顾行舟", doing: "入席", who: "钱妈、阿蘅" },
  ];
  const out = normalizePublicEvents(raw);
  assert.deepEqual(out.map((e) => `${e.time} ${e.actor}`), ["18:30 顾行舟", "20:10 钱妈"], "非法条目丢弃、去重、按时刻排序");
  assert.deepEqual(out[0].who, ["钱妈", "阿蘅"], "who 支持顿号分隔的字符串");
});

test("validatePublicEvents：缺表 / 条数不足 / 角色不在名单 / 有人没露面 都判不达标", () => {
  assert.strictEqual(validatePublicEvents({ players: [] }).ok, false);
  const tooFew = validatePublicEvents({ players: [{ name: "甲" }], publicEvents: [{ time: "18:00", actor: "甲" }] });
  assert.ok(tooFew.errors.some((e) => /覆盖不足/.test(e)), tooFew.errors.join("；"));
  const badActor = validatePublicEvents({
    players: [{ name: "甲" }, { name: "乙" }],
    publicEvents: Array.from({ length: 6 }, (_, i) => ({ time: `1${i}:00`, actor: i === 0 ? "丙" : "甲" })),
  });
  assert.ok(badActor.errors.some((e) => /不在角色名单内/.test(e)), badActor.errors.join("；"));
  const uncovered = validatePublicEvents(PE_OUTLINE);
  assert.ok(uncovered.errors.some((e) => /没有任何公开事件/.test(e)) === false, "PE_OUTLINE 里每人都有条目");
});

test("validatePublicEvents：清单达标即通过，并给出缺席名单", () => {
  const full = {
    players: [{ name: "甲" }, { name: "乙" }],
    publicEvents: [
      ...Array.from({ length: 6 }, (_, i) => ({ time: `1${i}:00`, actor: "甲" })),
      { time: "19:00", actor: "乙" },
    ],
  };
  const v = validatePublicEvents(full);
  assert.strictEqual(v.ok, true, v.errors.join("；"));
  assert.strictEqual(v.count, 7);
});

test("buildPublicEventTable：渲染当事人/地点/公开行为/在场者，并写明当事人必须复述该时刻", () => {
  const t = buildPublicEventTable(PE_OUTLINE);
  assert.ok(t.includes("角色级公共事件表"));
  assert.match(t, /\| 19:00 \| 苏韵秋 \| 绣楼三层 \| 携黑漆账匣上楼/, "要列出当事人与公开行为");
  assert.ok(/当事人（当事人列写了你）/.test(t), "要写明当事人必须复述该时刻");
  assert.ok(/同一件事只能有一个时刻/.test(t));
});

test("checkPublicEventAnchors：当事人没写出自己的时刻会被列出（仅告警用）", () => {
  const text = "- 21:30【座钟】：我上楼收拾屋子。";   // 只写了 21:30，漏了 18:30/19:00 等
  const r = checkPublicEventAnchors("钱妈", text, PE_OUTLINE.publicEvents, 0);
  assert.strictEqual(r.needed, true);
  assert.deepEqual(r.missing.map((m) => m.time), ["20:10"], "只核对属于他的条目");
  assert.strictEqual(r.ok, false);
});

test("checkPublicEventAnchors：写出时刻即算命中；时钟诡计下钟面读数也算", () => {
  const ok = checkPublicEventAnchors("钱妈", "- 20:10：我端汤上二层。", PE_OUTLINE.publicEvents, 0);
  assert.strictEqual(ok.ok, true);
  // 座钟快 45 分钟：角色写【座钟】21:55 等价于真实 21:10
  const events = [{ time: "21:10", actor: "甲", doing: "上楼" }];
  assert.strictEqual(checkPublicEventAnchors("甲", "- 21:55【座钟】：我上楼。", events, 45).ok, true);
});

test("checkPublicEventAnchors：不担任当事人的角色不启用（避免误伤）", () => {
  const r = checkPublicEventAnchors("顾行舟", "- 与公共事件无关的内容", [], 0);
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.ok, true);
});

// ==================== 就地改写单行（死亡类违规的修复） ====================
// 背景：改造前的修复是"整篇重生成"，两轮实测 5 次触发只有 1 次把违规降到 0
// （4 次"重写后违规未减少，保留原稿"）——重生成既慢，模型还常在新稿里重现同一错误。
// 现在优先**只改违规行**，其余一字不动；改不动才回退整篇重生成。

test("applyLineRewrites：只改目标行，邻行不受影响", () => {
  const content = [
    "- 20:30【真实】：账房 — 我结当日流水。",
    "- **【怀表】19:40**：账房 — 潘仲衡进来翻了我的进货簿，盯着花梨木那页看了半晌，没说话，出去了。",
    "- 21:10【真实】：通铺 — 我和衣睡下。",
  ].join("\n");
  const bad = ["- **【怀表】19:40**：账房 — 潘仲衡进来翻了我的进货簿，盯着花梨木那页看了半晌，没说话，出去了。"];
  const good = ["- **【怀表】19:40**：账房 — 我结当日流水，听见前厅有人起座。"];
  const out = applyLineRewrites(content, bad, good);
  assert.ok(out);
  assert.ok(out.includes(good[0]), "新行要生效");
  assert.ok(!out.includes("潘仲衡进来翻了我的进货簿"), "旧行要被替换掉");
  assert.ok(out.includes("20:30【真实】") && out.includes("21:10【真实】"), "邻行不受影响");
  assert.equal(out.split("\n").length, 3, "行数不变（就地替换，不增删）");
});

test("applyLineRewrites：同内容出现两次时只改首次（避免误伤别处）", () => {
  const content = "甲：潘仲衡进来。\n乙：潘仲衡进来。";
  const out = applyLineRewrites(content, ["甲：潘仲衡进来。"], ["甲：我独自站着。"]);
  assert.ok(out);
  assert.equal(out.split("\n")[0], "甲：我独自站着。");
  assert.equal(out.split("\n")[1], "乙：潘仲衡进来。", "第二处不该被改动");
});

test("applyLineRewrites：没命中或全不变时返回 null（调用方保留原稿）", () => {
  assert.equal(applyLineRewrites("abc", ["不存在的行"], ["新行"]), null);
  assert.equal(applyLineRewrites("abc", ["abc"], ["abc"]), null);
  assert.equal(applyLineRewrites("", [], []), null);
});

test("checkVictimAfterDeath：违规项携带**未截断**的整行（否则就地替换匹配不到）", () => {
  const longLine = "- 23:30：我赶到书房，看见常伯衡站在案前，指着我低声说了很多话" + "。".repeat(140);
  const r = checkVictimAfterDeath(longLine, "21:15", "常伯衡");
  assert.equal(r.violations.length, 1);
  assert.ok(r.violations[0].line.length > 120, "整行原文要完整保留");
  assert.equal(r.violations[0].short.length, 120, "展示用的截断版单独存放");
  assert.ok(longLine.includes(r.violations[0].line), "line 必须能在原文里精确命中");
});

// ==================== 跨角色日期核对（众数投票版） ====================
// 旧的逐条判据（"行首日期相差>1天即不一致"）被单测否掉：角色时间线本来就要求覆盖
// "案发前一日"，`六月初五` 是合法前情却被误判。新版用**众数投票**：案发夜在每份
// 时间线里都有 10+ 条细粒度记录，前情只有 1-2 条，众数必然落在案发夜上。

function tlScript(name, caseDate, extra = []) {
  // 生成一份"案发夜"时间线：案发日 10 条 + 可选前情条目
  const lines = [];
  const times = ["18:30", "19:00", "19:40", "20:10", "20:40", "21:10", "21:40", "22:10", "23:30", "00:20"];
  times.forEach((t) => lines.push(`- **${caseDate} ${t}**：前厅 — 我在场。`));
  return { name, text: [...lines, ...extra].join("\n") };
}

test("dateDiffDays：跨年相邻（12月31 → 1月1）按相邻处理", () => {
  assert.strictEqual(dateDiffDays("十二月三十一日", "一月一日"), 1, "跨年相邻");
  assert.strictEqual(dateDiffDays("十二月三十日", "一月一日"), 2, "隔了一天就不算相邻");
  assert.strictEqual(dateDiffDays("六月十四日", "六月十五日"), 1);
  assert.strictEqual(dateDiffDays("六月十四日", "四月十四日"), 61, "两个月差");
  assert.strictEqual(dateDiffDays("案发当日", "六月十五日"), null, "非具体日期返回 null");
});

test("checkDateAgreement：同一套日期（含跨午夜相邻两天）判为一致", () => {
  const sections = [
    tlScript("甲", "六月十四日", ["- **六月十五日 00:30**：绣楼 — 上楼。"]),
    tlScript("乙", "六月十四日"),
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, true, r.message);
});

test("checkDateAgreement：三份剧本三个日期，少数派被点名（实测 1890 广州形态）", () => {
  const sections = [
    tlScript("梁允之", "六月十四日"),
    tlScript("何秀姑", "六月十四日"),
    tlScript("潘映棠", "六月十四日"),
    tlScript("苏敬亭", "六月十四日"),
    tlScript("麦安琪", "四月十四日"),
    tlScript("陈九", "四月十七日"),
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/案发日期不一致/.test(r.message), r.message);
  assert.ok(/麦安琪/.test(r.message) && /四月十四日/.test(r.message), "要点名少数派及其日期");
  assert.ok(/陈九/.test(r.message));
  assert.ok(!/梁允之/.test(r.message), "多数派不该被点名");
});

test("checkDateAgreement：前情日期不改变众数（这正是旧版误伤的地方）", () => {
  // 甲的剧本里有一条"案发前一日"（六月初五），但案发夜有 10 条 → 众数仍是六月十四
  const sections = [
    tlScript("甲", "六月十四日", ["- **六月初五 20:30**：报馆 — 他来过一趟。"]),
    tlScript("乙", "六月十四日"),
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, true, "前情只贡献 1 票，不改变众数：" + r.message);
});

test("checkDateAgreement：整个案发夜整体前移一天要判（实测 1960 云南形态）", () => {
  // 实测：岩温把案发前一日全部标成腊月十六（傍晚时段），其余五人是腊月十七。
  // 总众数只差 1 天，会被"跨午夜相邻"的宽容放过——但傍晚窗口没有跨午夜，差 1 天就是整体位移。
  const sections = [
    tlScript("和永丰", "腊月十七"),
    tlScript("赵铁栓", "腊月十七"),
    tlScript("阿依莎", "腊月十七"),
    tlScript("白小满", "腊月十七"),
    tlScript("岩温", "腊月十六"),
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, false, "傍晚窗口下 1 天位移必须判：" + r.message);
  assert.ok(/岩温/.test(r.message) && /腊月十六/.test(r.message), r.message);
});

test("checkDateAgreement：合法的跨午夜相邻日（凌晨条目）不触发（傍晚窗口排除凌晨）", () => {
  // 案发夜跨午夜：傍晚在六月十四，凌晨在六月十五。凌晨条目不参与傍晚窗口的众数，
  // 所以两份剧本的傍晚众数都是六月十四 → 一致。
  const sections = [
    tlScript("甲", "六月十四日", ["- **六月十五日 00:30**：绣楼 — 上楼。", "- **六月十五日 01:10**：后院 — 遛狗。"]),
    tlScript("乙", "六月十四日"),
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, true, "凌晨相邻日是合法的跨午夜：" + r.message);
});

test("checkDateAgreement：跨年相邻（12月31傍晚 → 1月1凌晨）的合法跨午夜不触发", () => {
  const sections = [
    { name: "甲", text: [
      ...Array.from({ length: 6 }, (_, i) => `- **十二月三十一日 2${i}:${String(10 + i * 5).padStart(2, "0")}**：前厅 — 在场。`),
      "- **一月一日 00:40**：后院 — 遛狗。",
    ].join("\n") },
    { name: "乙", text: Array.from({ length: 6 }, (_, i) => `- **十二月三十一日 2${i}:${String(10 + i * 5).padStart(2, "0")}**：前厅 — 在场。`).join("\n") },
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, true, "跨年相邻也是合法跨午夜：" + r.message);
});

test("checkDateAgreement：众数出现 <3 次的剧本不参与比对（防薄剧本误判）", () => {
  // 丙只有 2 条日期记录 → 众数不可信 → 不参与比对（但甲乙的分歧仍要判）
  const sections = [
    tlScript("甲", "六月十四日"),
    tlScript("乙", "四月十四日"),
    { name: "丙", text: "- **六月初五 20:30**：报馆。\n- **六月初六 21:00**：茶楼。" },
  ];
  const r = checkDateAgreement(sections, {});
  // 甲、乙各 10 票，构成 1-1 分歧——无多数派，但 2 个不同的傍晚日期本身就是不一致，如实报告
  assert.strictEqual(r.ok, false, "无多数派但确有分歧，要报告：" + r.message);
  assert.ok(/甲/.test(r.message) && /乙/.test(r.message), "要列出双方");
  assert.ok(!/丙/.test(r.message), "薄剧本（<3 票）不参与，不该被点名");
});

test("checkDateAgreement：四套日期各执一词也要报（实测 1965 长春形态）", () => {
  // 实测：赵铁成 10月14/15、孙丽梅 11月17/18、马长贵 11月2/3、吴桂芳 11月12/13
  // 各 1 票、无多数——此前直接放行，交叉校验抓到"同一案件出现四套日期"却没人拦在修订之前。
  const sections = [
    tlScript("赵铁成", "十月十四"),
    tlScript("孙丽梅", "十一月十七"),
    tlScript("马长贵", "十一月初二"),
    tlScript("吴桂芳", "十一月十二"),
    { name: "周卫东", text: "- **前一日 20:00**：澡堂。" },   // 只写相对日期，不参与
  ];
  const r = checkDateAgreement(sections, {});
  assert.strictEqual(r.ok, false, "四套日期必须报：" + r.message);
  assert.ok(/无多数派/.test(r.message), "要说明是无多数派的情形");
  for (const n of ["赵铁成", "孙丽梅", "马长贵", "吴桂芳"]) {
    assert.ok(r.message.includes(n), `要列出 ${n} 及其日期`);
  }
  assert.ok(!/周卫东/.test(r.message), "只写相对日期的角色不参与");
});

test("checkDateAgreement：大纲有权威案发日时优先用它", () => {
  const sections = [
    tlScript("甲", "腊月初八"),
    tlScript("乙", "腊月初八"),
    tlScript("丙", "腊月十九"),   // 实测清光绪那轮的整篇错位
  ];
  const outline = { timeline: [{ time: "21:00", desc: "案发" }, { time: "22:00", desc: "案发" }] };
  // parseCaseDate 需要唯一日期才生效；此例故意让大纲无日期 → 走多数票（腊月初八 2 票 vs 腊月十九 1 票）
  const r = checkDateAgreement(sections, outline);
  assert.strictEqual(r.ok, false);
  assert.ok(/丙/.test(r.message) && /腊月十九/.test(r.message), r.message);
});

// ==================== 关键物件状态变更表 ====================
// 实测：交叉校验反复报出"书房灯未熄 vs 里头没点灯""闸板已放下 vs 闸板尚全开"这类矛盾，
// 根因是各角色对同一物件在同一时刻的状态各写各的，没有权威来源可对齐。
// 只做注入（预防），不做确定性检测——物件状态是开放自然语言，词表匹配必然误伤。

const OS_OUTLINE = {
  players: [{ name: "甲" }],
  objectStates: [
    { at: "19:00", object: "书房的灯", state: "亮着" },
    { at: "20:30", object: "书房的灯", state: "熄了（灯芯已剪）" },
    { at: "21:00", object: "书房的门", state: "虚掩，插销未落" },
    { at: "21:40", object: "书房的门", state: "闩上（从内侧插了插销）" },
    { at: "20:10", object: "桌上的账本", state: "摊开在欠款那一页" },
  ],
};

test("validateObjectStates：覆盖不足（条目或物件数不足）判不达标", () => {
  assert.ok(validateObjectStates({}).errors.some((e) => /完全没有 objectStates/.test(e)));
  const thin = { objectStates: [{ at: "19:00", object: "灯", state: "亮着" }] };
  const r = validateObjectStates(thin);
  assert.ok(r.errors.some((e) => /覆盖不足/.test(e)), r.errors.join("；"));
  assert.ok(r.errors.some((e) => /至少 3 个物件/.test(e)), "只涉及 1 个物件也要报");
});

test("validateObjectStates：状态里泄漏秘密动作（凶手把…暗中…）判不达标", () => {
  const leaky = { objectStates: OS_OUTLINE.objectStates.concat([{ at: "21:30", object: "书房的窗", state: "凶手暗中把窗闩拨开了" }]) };
  const r = validateObjectStates(leaky);
  assert.ok(r.errors.some((e) => /秘密动作/.test(e)), r.errors.join("；"));
});

test("validateObjectStates：合规的物件状态表通过", () => {
  const v = validateObjectStates(OS_OUTLINE);
  assert.strictEqual(v.ok, true, v.errors.join("；"));
  assert.strictEqual(v.objects.length, 3, "涉及灯、门、账本三个物件");
});

test("buildObjectStateTable：按时刻排序并写明「两次变更之间状态恒定」", () => {
  // 故意乱序输入
  const shuffled = { objectStates: [...OS_OUTLINE.objectStates].reverse() };
  const t = buildObjectStateTable(shuffled);
  const idx1900 = t.indexOf("| 19:00 |"), idx2030 = t.indexOf("| 20:30 |");
  assert.ok(idx1900 > -1 && idx2030 > -1, "两行都要在");
  assert.ok(idx1900 < idx2030, "必须按时刻升序");
  assert.ok(/两次变更之间，该物件的状态恒定/.test(t), "要写明变更间恒定的规则");
  assert.ok(/只写\*\*可被观察到的客观状态\*\*/.test(t), "要说清不含秘密动作");
});

test("buildObjectStateTable：没有物件状态时返回空串（不编造）", () => {
  assert.strictEqual(buildObjectStateTable({ players: [{ name: "甲" }] }), "");
  assert.strictEqual(buildObjectStateTable(null), "");
});

// ==================== 跨角色日期体系核对：**已放弃** ====================
// 曾实现 checkDateAgreement（取各角色时间线行首的"日期+时刻"，比较是否相差超过1天），
// 但单测立刻暴露它会误伤：角色的时间线**本来就要求覆盖"案发前一日"**
// （模板明确要求），所以行首必然合法地出现比案发日更早的日期——
// `- **六月初五 20:30**：报馆 — 他来过一趟`（案发日六月十四）会被误判成"体系不一致"。
// **行首形态区分不了"案发夜"与"前情"**，与 8.7 节那次误伤同一个病根。
// 这一类（跨角色日期不统一）已由既有的"交叉校验 → 定向修订"覆盖
// （实测 1890 广州那轮把它列为头号问题，修订阶段应用 31 条补丁），
// 因此撤掉该实现而不带着已知缺陷发货。详见 builder 里保留的放弃说明。
