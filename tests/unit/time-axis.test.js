// 回归测试：权威时间轴（时间基准统一）+ 诡计可观测性校验
// 背景：实测《钟楼诡影》——各角色时间基准混用且大半不标注（柳如烟全裸数字、老赵自己前后不一致），
// 同一个数字在不同角色嘴里代表不同真实时刻；且全案只有一口被拨快的座钟、花园那口停摆（不能作基准）、
// 唯一能测出时差的怀表没有线索卡 → 核心诡计在物证上不可观测。
const test = require("node:test");
const assert = require("node:assert");
const {
  parseTimeOffset,
  shiftClock,
  buildTimeAxis,
  checkTrickObservability,
  parseCaseDate,
  nextDayLabel,
  findTamperMoment,
  minutesOf,
  hmOf,
  findDeathMoment,
  extractCharacterSections,
  deterministicSnapshot,
  snapshotRegressions,
} = require("../../src/script/murder-mystery-builder");

// 取自实测大纲《钟楼诡影》的真实字段：注意 type 写"调慢"而 mechanism 写"调快"
const OUTLINE = {
  coreTrick: "时间诡计（通过拨快/拨慢宅邸座钟，制造众人对案发时间的集体误判）",
  trickSpec: {
    trick: "时钟诡计",
    type: "时间诡计(时差/钟表调慢)",
    mechanism: "凶手提前将大厅的落地座钟调快约15分钟。当座钟显示21:30（晚餐结束）时，真实时间仅21:15。",
  },
  timeline: [
    { time: "19:45", desc: "拨快座钟" },
    { time: "21:15", desc: "宴席结束" },
    { time: "21:16-21:28", desc: "作案窗口" },
    { time: "23:50", desc: "跨日测试" },
  ],
};

test("parseTimeOffset：方向取自紧邻数字的词，不被 type 的『调慢』误导", () => {
  const off = parseTimeOffset(OUTLINE);
  assert.ok(off, "应解析出偏移");
  assert.strictEqual(off.offsetMin, 15);
  assert.strictEqual(off.slow, false, "type 写调慢、mechanism 写调快15分钟 → 应为『快』");
});

test("parseTimeOffset：真正的拨慢本应识别为慢", () => {
  const off = parseTimeOffset({ trickSpec: { mechanism: "凶手将大厅座钟拨慢10分钟，使众人晚到。" } });
  assert.strictEqual(off.offsetMin, 10);
  assert.strictEqual(off.slow, true);
});

test("parseTimeOffset：非时间类诡计返回 null", () => {
  assert.strictEqual(parseTimeOffset({ trickSpec: { mechanism: "利用地毯下的暗格藏匿凶器。" } }), null);
  assert.strictEqual(parseTimeOffset(null), null);
});

test("shiftClock：平移与跨日回绕", () => {
  assert.strictEqual(shiftClock("21:15", 15), "21:30");
  assert.strictEqual(shiftClock("21:16-21:28", 15), "21:31-21:43");
  assert.strictEqual(shiftClock("23:50", 15), "00:05", "跨日应回绕");
  assert.strictEqual(shiftClock("21:15", -15), "21:00");
  assert.strictEqual(shiftClock("晚上", 15), null);
});

test("buildTimeAxis：含偏移说明、标注规范与真实↔座钟对照表", () => {
  const axis = buildTimeAxis(OUTLINE);
  assert.ok(axis.includes("快 15 分钟"), "应写明快/慢与分钟数");
  assert.ok(axis.includes("座钟时间 = 真实时间 + 15 分钟"), "应给出换算公式");
  assert.ok(axis.includes("【座钟】21:30"), "应给出标注格式示例");
  assert.ok(axis.includes("| 19:45 | 20:00 | 拨快座钟 |"), "对照表应把 19:45 映射到 20:00");
  assert.ok(axis.includes("| 21:15 | 21:30 | 宴席结束 |"), "对照表应把 21:15 映射到 21:30");
});

test("buildTimeAxis：非时间类诡计返回空串（不污染 prompt）", () => {
  assert.strictEqual(buildTimeAxis({ trickSpec: { mechanism: "利用暗格藏凶器。" } }), "");
  assert.strictEqual(buildTimeAxis(null), "");
});

// ==================== 拨钟时刻 = 时间轴上的状态转折点 ====================
// 背景：改造前时间轴把偏差描述成**恒定状态**（"座钟比真实时间快45分钟"），
// 从不说座钟是几时被动的手脚。角色写拨钟之前的场景时照着它写出
// "18:30，座钟显示七点一刻（快45分钟）"——完全符合时间轴，却与诡计直接冲突。
// 实测三次端到端的交叉校验里，"座钟拨快时刻矛盾"每一轮都出现。

test("minutesOf：解析时刻，非法值返回 null", () => {
  assert.strictEqual(minutesOf("20:10"), 1210);
  assert.strictEqual(minutesOf("20：10"), 1210, "中文冒号同样接受");
  assert.strictEqual(minutesOf("21:16-21:28"), 1276, "区间取起点");
  assert.strictEqual(minutesOf("晚上"), null);
  assert.strictEqual(minutesOf("25:99"), null);
  assert.strictEqual(minutesOf(""), null);
});

// 实测第四次死亡时刻漏判（1994 郑州·打包机案）：那一轮大纲的 time 字段**全带日期**
// （「11月17日 23:50」），而原实现要求字符串以 HH:MM 开头 → 全部 null →
// 尽管行里明写"陈广发**死亡**"，findDeathMoment 仍判不出 → 整层死亡约束再次静默失效。
test("minutesOf/hmOf：容忍『日期 + 时刻』的写法（实测第四次漏判）", () => {
  assert.strictEqual(minutesOf("11月17日 23:50"), 1430);
  assert.strictEqual(minutesOf("腊月十七 23:50"), 1430);
  assert.strictEqual(hmOf("11月17日 23:50"), "23:50", "不能截成『11月17』");
  assert.strictEqual(hmOf("11月17日23:50"), "23:50");
  assert.strictEqual(hmOf("23:50"), "23:50");
  assert.strictEqual(hmOf("9:05"), "09:05", "要补前导零");
  assert.strictEqual(hmOf("21:16-21:28"), "21:16");
  assert.strictEqual(hmOf("25:99"), null);
  assert.strictEqual(hmOf("晚上"), null);
  assert.strictEqual(hmOf(""), null);
  assert.strictEqual(hmOf(null), null);
});

test("findDeathMoment：时刻字段带日期时也要能判出死亡时刻（真实形态回归）", () => {
  const real = {
    victim: { name: "陈广发", causeOfDeath: "被运行中的打包机压伤致死" },
    timeline: [
      { time: "11月17日 22:00", desc: "王栓柱提前拔走三号库沿线第7、8块巡更牌" },
      { time: "11月17日 23:50", desc: "王栓柱从背后袭击核对棉垛的陈广发，推入运行中的打包机，陈广发死亡" },
      { time: "11月18日 06:30", desc: "早班工人发现陈广发死于打包机下" },
    ],
  };
  assert.strictEqual(findDeathMoment(real), "23:50", "带日期的时刻不该让死亡时刻判不出来");
});

test("findTamperMoment：取紧邻动手动词的那个时刻（不是更早的无关时刻）", () => {
  // 这是关键判别：19:40 是投毒时刻，离"拨快"很远；20:10 紧邻"拨快"
  const outline = {
    trickSpec: { mechanism: "凶手19:40潜入书房在茶壶投毒；20:10拨快大厅座钟45分钟。" },
  };
  assert.strictEqual(findTamperMoment(outline), "20:10", "不能把投毒时刻误判成拨钟时刻");
});

test("findTamperMoment：动词在时刻之后也能识别", () => {
  const outline = { trickSpec: { mechanism: "拨快大厅座钟的动作发生在20:10。" } };
  assert.strictEqual(findTamperMoment(outline), "20:10");
});

test("findTamperMoment：诡计文本里没有时刻时，回退到大纲时间线的那一条", () => {
  assert.strictEqual(findTamperMoment(OUTLINE), "19:45");
});

test("findTamperMoment：不把「座钟显示 X」的读数当成拨钟时刻", () => {
  // 实测大纲："凶手提前将…座钟调快约15分钟。当座钟显示21:30（晚餐结束）时，真实时间仅21:15。"
  // 离"调快"最近的时刻是 21:30，但那是表盘**读数**；真值是时间线里的 19:45。
  // 只按"离动词最近"取会稳定取错，所以必须识别"显示/指着/停在"这类读数句式。
  assert.strictEqual(findTamperMoment(OUTLINE), "19:45", "读数不是动作时刻");
  const withReading = {
    trickSpec: { mechanism: "凶手把座钟拨慢20分钟。当座钟显示22:40时，真实时间已是23:00。" },
    timeline: [{ time: "20:30", desc: "拨慢座钟" }],
  };
  assert.strictEqual(findTamperMoment(withReading), "20:30", "应回退到时间线，而不是取读数 22:40");
});

test("findTamperMoment：没有任何拨钟信息返回 null（宁可不说，不可说错）", () => {
  assert.strictEqual(findTamperMoment({ trickSpec: { mechanism: "利用暗格藏凶器。" } }), null);
  assert.strictEqual(findTamperMoment(null), null);
  assert.strictEqual(findTamperMoment({ trickSpec: {}, timeline: [] }), null);
});

test("buildTimeAxis：拨钟之前座钟读数与真实时间一致，之后才偏移", () => {
  const outline = {
    trickSpec: { mechanism: "凶手在20:10拨快大厅座钟45分钟。" },
    timeline: [
      { time: "18:30", desc: "宾客到大厅" },
      { time: "19:40", desc: "投毒" },
      { time: "20:10", desc: "拨快座钟" },
      { time: "21:00", desc: "发现尸体" },
    ],
  };
  const axis = buildTimeAxis(outline);
  const row = (hm) => (axis.match(new RegExp(`^\\| ${hm} \\| (.+?) \\|`, "m")) || [])[1];
  assert.strictEqual(row("18:30"), "18:30（与真实一致）", "拨钟前不得偏移");
  assert.strictEqual(row("19:40"), "19:40（与真实一致）", "拨钟前不得偏移");
  assert.strictEqual(row("20:10"), "20:55", "拨钟当刻起偏移生效");
  assert.strictEqual(row("21:00"), "21:45", "拨钟之后持续偏移");
});

test("buildTimeAxis：分段模型必须是头条第一条（不能只做后置例外）", () => {
  const outline = {
    trickSpec: { mechanism: "凶手在20:10拨快大厅座钟45分钟。" },
    timeline: [{ time: "20:10", desc: "拨快座钟" }, { time: "21:00", desc: "发现尸体" }],
  };
  const axis = buildTimeAxis(outline);
  const lines = axis.split("\n").filter((l) => l.trim());
  // 第 0 行是标题；第 1 行就必须是分段声明，且第一行里不得出现无条件的恒定偏差公式
  assert.match(lines[1], /关键.*20:10.*才被人动过/, "分段声明要占据头条位置");
  assert.ok(!/^-\s*案发当日，公共时钟.*座钟时间 = 真实时间/.test(lines[1]), "头条不得是无条件的恒定偏差公式（实测会被模型锚定）");
  assert.ok(/20:10 之前[\s\S]*?座钟时间 = 真实时间，没有任何偏差/.test(axis), "要说明拨动前无偏差");
  assert.ok(/痕迹在动手之前还不存在/.test(axis), "要禁止拨动前出现痕迹（实测常见的穿帮）");
  assert.match(axis, /读数示例/, "要给可照抄的读数示例，而不是只给规则");
});

test("buildTimeAxis：读数示例在拨钟前后给出不同口径", () => {
  const outline = {
    trickSpec: { mechanism: "凶手在20:10拨快大厅座钟45分钟。" },
    timeline: [{ time: "20:10", desc: "拨快座钟" }],
  };
  const axis = buildTimeAxis(outline);
  // 拨钟前：真实 = 座钟；拨钟后：座钟 = 真实 + 45
  assert.match(axis, /\|\s*19:50\s*\|\s*19:50\s*\|\s*拨钟前\s*\|/, "拨钟前示例应两侧相同");
  assert.match(axis, /\|\s*20:25\s*\|\s*21:10\s*\|\s*拨钟后\s*\|/, "拨钟后示例应带偏移");
});

test("buildTimeAxis：找不到拨钟时刻时不编造转折点（保持改造前行为）", () => {
  const outline = {
    trickSpec: { mechanism: "凶手把大厅座钟拨快20分钟。" },   // 有偏移，但没说几时拨的
    timeline: [{ time: "21:00", desc: "发现尸体" }],
  };
  const axis = buildTimeAxis(outline);
  assert.ok(axis.includes("快 20 分钟"), "偏移说明仍应在");
  assert.ok(!/才被动的手脚/.test(axis), "没有依据就不该声明转折点");
  const row = (axis.match(/^\| 21:00 \| (.+?) \|/m) || [])[1];
  assert.strictEqual(row, "21:20", "无转折点时沿用改造前的一律偏移");
});

test("checkTrickObservability：缺独立时间源与时钟异常线索时判为不可观测", () => {
  const report = { clues: "- 花园凉亭铜挂钟因受潮已停摆，指针停在21:16。" };
  const r = checkTrickObservability(report, OUTLINE);
  assert.strictEqual(r.needed, true);
  assert.strictEqual(r.hasIndependent, false);
  assert.strictEqual(r.ok, false, "停摆的钟不能充当时间基准");
});

test("checkTrickObservability：具备两类锚点才通过", () => {
  const report = { clues: "- 老赵的怀表读数为21:15，与大厅座钟的21:30不符。\n- 大厅座钟机芯有近期拨动痕迹。" };
  const r = checkTrickObservability(report, OUTLINE);
  assert.strictEqual(r.ok, true);
});

test("checkTrickObservability：推广后非时间类诡计也参与校验（改造前不参与）", () => {
  // ⚠️ 契约变更：改造前本检查只在"能解析出时钟偏移"时才触发，非时间类诡计直接 needed=false，
  // 于是密室/身份诡计的线索体系哪怕一条物证都没有也照样通过。
  // 现在任何诡计都要求至少一条可得锚点（见 builder 的 checkTrickObservability 注释）。
  const r = checkTrickObservability({ clues: "" }, { trickSpec: { mechanism: "暗格藏凶器。" } });
  assert.strictEqual(r.needed, true, "有诡计就必须校验");
  assert.strictEqual(r.clockNeeded, false, "非时钟诡计不要求独立时间源/时钟异常那两项");
  assert.strictEqual(r.hasAnchor, false);
  assert.strictEqual(r.ok, false, "空线索体系无法证伪手法");

  // 补上一条物证锚点后即通过
  const ok = checkTrickObservability(
    { clues: "暗格内侧留有新鲜划痕与半枚指印。" },
    { trickSpec: { mechanism: "暗格藏凶器。" } }
  );
  assert.strictEqual(ok.ok, true);
});

test("checkTrickObservability：完全没有诡计的剧本不触发校验", () => {
  const r = checkTrickObservability({ clues: "任何内容" }, {}, "");
  assert.strictEqual(r.needed, false);
  assert.strictEqual(r.ok, true);
});

// ==================== 回归：实测《落钟诡计》的真实线索文本 ====================
// 早期实现把钟的名词写成 座钟|时钟|挂钟|铜钟，而剧本通篇用「落地钟」，
// 导致明明有撬痕/钥匙/怀表线索却误报"缺少公共时钟异常线索"（假阴性）。

const REAL_CLUES = [
  "大堂内的老式落地钟，其黄铜底座边缘有崭新的细微刮痕，位置与使用钥匙或工具打开后盖的角度一致。",
  "落地钟后盖内侧，发现一处新鲜的、细微的撬痕。钟摆下方地面有一小滴凝固的蜡油。",
  "吧台下层找到一个被遗忘的黄铜钥匙，齿痕特殊，与落地钟后盖锁孔尝试后吻合。",
  "钱鼎斋随身携带一块老式怀表，表盖内侧刻有“庚申年制”字样，时间显示20:50。",
  "钱鼎斋在“发现尸体后”于大堂集合时，曾当众查看自己的怀表并大声说：“我的表是准的，现在已经是晚上九点差十分了！大堂的钟只走到八点三十五，肯定有人动过！”",
].join("\n");

test("checkTrickObservability：真实线索（落地钟撬痕 + 怀表）应判为可观测", () => {
  const r = checkTrickObservability({ clues: REAL_CLUES }, OUTLINE);
  assert.strictEqual(r.hasIndependent, true, "怀表应被识别为独立时间源");
  assert.strictEqual(r.hasClockAnomaly, true, "『落地钟…撬痕/底座刮痕』应被识别为时钟异常（曾因名词表漏了『落地钟』而假阴性）");
  assert.strictEqual(r.ok, true);
});

test("checkTrickObservability：『分钟』不得被误判为时钟异常", () => {
  const r = checkTrickObservability({ clues: "他等了15分钟，动作很慢。" }, OUTLINE);
  assert.strictEqual(r.hasClockAnomaly, false, "分钟+慢 不应算作时钟被动手脚的证据");
});

// ==================== 日期基准（跨角色日期冲突的预防） ====================

test("parseCaseDate：无日期或多个冲突日期时返回 null", () => {
  assert.strictEqual(parseCaseDate({ storyBackground: "1937年，上海法租界。" }), null);
  assert.strictEqual(
    parseCaseDate({ timeline: [{ time: "20:00", desc: "4月12日案发" }, { time: "21:00", desc: "10月18日另一说" }] }),
    null
  );
});

// ==================== 修订后复检：从成稿切段 + 确定性体检（护栏）====================
// 背景：定向修订照着 LLM 产的问题清单**自动改写成稿**，原来两轮都用同一份清单、
// 改完不复核。现在每轮改完做一次确定性体检（只用既有判据，不新增判断规则），
// 某条从"通过"变"不通过"就整轮回退——宁可少改，不可把已经对了的地方改坏。

test("extractCharacterSections：从成稿里按标题切出角色段落，并去掉 [凶手] 标记", () => {
  const script = [
    "# 第二部分：人物角色",
    "### 玩家角色 1：贺清源 [凶手]",
    "- **21:10**：后台走廊 — 我推倒了大戏箱",
    "### 玩家角色 2：沈望舒",
    "- **21:40**：库房 — 我封锁了现场",
    "### NPC 1：秦二娃",
    "- **21:12**：票根背面写闭幕",
  ].join("\n");
  const secs = extractCharacterSections(script);
  assert.strictEqual(secs.length, 3);
  assert.deepStrictEqual(secs.map((s) => s.name), ["贺清源", "沈望舒", "秦二娃"]);
  assert.ok(secs[0].text.includes("推倒了大戏箱"));
  assert.ok(!secs[0].name.includes("凶手"), "[凶手] 标记不该混进姓名");
  assert.ok(secs[2].text.includes("闭幕"));
});

test("snapshotRegressions：只判『通过→不通过』与『违规变多』", () => {
  const good = { dateAgreement: "ok", roundUnlock: "ok", deathViolations: 0 };
  const bad = { dateAgreement: "bad", roundUnlock: "bad", deathViolations: 2 };
  assert.deepStrictEqual(snapshotRegressions(good, good), [], "没变化不算回退");
  const r = snapshotRegressions(good, bad);
  assert.strictEqual(r.length, 3, "三条都该被抓到");
  assert.ok(r.some((x) => x.includes("日期")));
  assert.ok(r.some((x) => x.includes("指控真凶")));
  assert.ok(r.some((x) => x.includes("2 处")));
  // 反向不判：从"不通过"变"通过"是好事，不能因此回退
  assert.deepStrictEqual(snapshotRegressions(bad, good), []);
  // unknown / na 不该被当成"通过"，否则信息不足时会误判为回退
  assert.deepStrictEqual(
    snapshotRegressions({ dateAgreement: "unknown", roundUnlock: "na", deathViolations: 0 }, bad),
    ["死者死后仍在活动由 0 处增加到 2 处"],
  );
});

test("deterministicSnapshot：无 outline 也不抛，且没给 deathAt 时不判死亡后活动", () => {
  assert.doesNotThrow(() => deterministicSnapshot(null, null));
  assert.doesNotThrow(() => deterministicSnapshot("", { outline: null, murdererName: null, deathAt: "21:10" }));
  const script = [
    "### 玩家角色 1：甲",
    "- **6月14日 18:00**：站台 — 我在交接",
    "### 玩家角色 2：乙",
    "- **4月16日 18:00**：食堂 — 我在吃饭",
    "### 玩家角色 3：丙",
    "- **4月16日 18:00**：库房 — 我在清点",
  ].join("\n");
  const snap = deterministicSnapshot(script, {});
  assert.strictEqual(snap.sectionCount, 3);
  assert.strictEqual(snap.deathViolations, 0, "没给 deathAt 就不该判");
  assert.ok(["ok", "bad", "na", "unknown"].includes(snap.dateAgreement));
});

test("deterministicSnapshot：能给死亡后活动计数（护栏依赖这个变化）", () => {
  const script = [
    "### 玩家角色 1：甲",
    "- **21:30**：站台 — 周世奎拉住我，说交接单还没核对完",
  ].join("\n");
  const snap = deterministicSnapshot(script, { deathAt: "20:40", victimName: "周世奎", caseDate: null });
  assert.strictEqual(snap.deathViolations, 1);
  assert.deepStrictEqual(snap.deathDetail, ["甲×1"]);
});

test("parseCaseDate：唯一日期时采用", () => {
  assert.strictEqual(parseCaseDate({ storyBackground: "案发当日为4月12日，暴雨。" }), "4月12日");
});

// 大纲的显式 caseDate 字段是权威来源。实测根因：没有它时 6 个角色各自编日期、编出 4 套，
// 只能靠事后 76 条补丁统一——日期这种"全局唯一事实"必须钉在源头。
test("parseCaseDate：优先采用大纲的显式 caseDate 字段", () => {
  assert.strictEqual(parseCaseDate({ caseDate: "6月14日" }), "6月14日");
  assert.strictEqual(parseCaseDate({ caseDate: " 6月14日 " }), "6月14日", "要去空白");
  assert.strictEqual(parseCaseDate({ caseDate: "腊月初八" }), "腊月初八", "中文日期也接受");
  assert.strictEqual(
    parseCaseDate({ caseDate: "6月14日", storyBackground: "后来又提到10月18日" }),
    "6月14日",
    "显式字段优先于文本扫描",
  );
});

// 实测（1988 武汉·棉纺厂）：模型给的是跨午夜区间「5月17日夜至5月18日晨」——
// 对"夜里发案、凌晨发现"的案件这比单日更准确，不该被判非法而整条丢掉。
test("parseCaseDate：接受跨午夜区间写法，取第一段作为案发当日", () => {
  assert.strictEqual(parseCaseDate({ caseDate: "5月17日夜至5月18日晨" }), "5月17日");
  assert.strictEqual(parseCaseDate({ caseDate: "5月17日夜间至5月18日凌晨" }), "5月17日");
  assert.strictEqual(parseCaseDate({ caseDate: "四月十二日夜至十三日晨" }), "四月十二日", "中文数字日期");
  // 区间被正确读出后，次日应由 nextDayLabel 推出（跨午夜机制依赖这一点）
  assert.strictEqual(nextDayLabel(parseCaseDate({ caseDate: "5月17日夜至5月18日晨" })), "5月18日");
});

test("parseCaseDate：caseDate 非法/空缺时回退到文本扫描", () => {
  assert.strictEqual(parseCaseDate({ caseDate: "未设定", storyBackground: "案发当日为4月12日。" }), "4月12日");
  assert.strictEqual(parseCaseDate({ caseDate: "某日", storyBackground: "案发当日为4月12日。" }), "4月12日");
  assert.strictEqual(parseCaseDate({ caseDate: "", storyBackground: "案发当日为4月12日。" }), "4月12日");
  assert.strictEqual(parseCaseDate({ caseDate: "不详" }), null, "空值不该被当成日期");
  assert.strictEqual(
    parseCaseDate({ caseDate: "不详", timeline: [{ time: "20:00", desc: "4月12日" }] }),
    "4月12日",
    "非法 caseDate 不应阻断兜底扫描",
  );
});

test("buildTimeAxis：未设绝对日期时强制相对日期（禁止自创月日）", () => {
  const axis = buildTimeAxis(OUTLINE); // OUTLINE 的 storyBackground 只有年份
  assert.ok(axis.includes("未设定绝对日期"), "应声明无绝对日期");
  assert.ok(axis.includes("案发前一日"), "应给出相对日期写法");
  assert.ok(axis.includes("严禁自创月份与日期"), "应明确禁止自创月日");
});

test("buildTimeAxis：大纲有唯一日期时统一为该日期", () => {
  const axis = buildTimeAxis({ ...OUTLINE, storyBackground: "案发当日为4月12日。" });
  assert.ok(axis.includes("案发日期统一为「4月12日」"), "应注入统一日期");
  assert.ok(!axis.includes("未设定绝对日期"));
});
