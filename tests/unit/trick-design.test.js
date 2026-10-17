// 验证「核心诡计 + 证明链」的确定性校验。
//
// 这一层是整个推理链方案的可信度所在：校验必须是**代码**，不能是"再叫一次 LLM"，
// 否则只是用一次不确定的判断去校验另一次不确定的输出。
// 所以这里逐条钉住每个校验规则——尤其是"时间诡计必须带独立时间源 + 时钟异常"，
// 它把改造前 builder.checkTrickObservability 的**事后警告**变成了事前约束。
const test = require("node:test");
const assert = require("node:assert");
const {
  validateTrickDesign,
  involvesClock,
  involvesIdentity,
  splitSupports,
  trickDesignToText,
  checkClockMagnitude,
  magNumeral,
  parseDurations,
  TRICK_TYPES,
  CLUE_KINDS,
  OBTAINABLE_KINDS,
} = require("../../src/script/trick-design");

/** 一个各项都合规的基准设计（非时间诡计）。用它做基线，任何规则误伤都会在这里暴露。 */
function baseDesign() {
  return {
    genre: "本格",
    type: "密室",
    coreTrick: "书房从内侧反锁，凶手从未进入",
    dependsOnClock: false,
    mechanism:
      "凶手在案发前一小时把书房窗户的插销用鱼线预先拉松，作案后从门外用另一根鱼线把插销推回插槽，造成密室假象。",
    conceal: "对外声称整晚在大厅，并让仆人误以为他一直在场",
    breakPoint: "窗台内侧的鱼线压痕与插销上的金属擦痕",
    feasibility: {
      physics: "书房窗户朝向内院，夜间无人经过；鱼线可从门缝穿过，全部动作在两分钟内完成。",
      witness: "21:00-21:05 走廊有人经过，此窗口不能动手；实际动手在 21:20，众人正在大厅用餐，无人目击。",
      weakest: "鱼线会在插销上留下擦痕，只要有人检查窗户就会暴露",
    },
    proofChain: [
      {
        clue: "窗台内侧木板上有两道平行的细压痕，间距约半寸，边缘发亮",
        kind: "physical-trace",
        supports: "means",
        proves: "有人用细线从内侧拉动过插销",
      },
      {
        clue: "插销插孔内壁有新鲜金属擦痕，颜色比周围亮",
        kind: "physical-trace",
        supports: "means",
        proves: "插销是被外力推回，而不是自然落下",
      },
      {
        clue: "仆人证词：21:20 左右听见书房方向有极轻的摩擦声",
        kind: "testimony",
        supports: "opportunity",
        proves: "作案时间落在无人目击的窗口内",
      },
      {
        clue: "书房抽屉最里层有一张当票存根，当出的是死者名下的田契，日期在案发前三日",
        kind: "record",
        supports: "motive",
        proves: "死者在案发前数日已将田契当出，有人因此在经济上被逼到绝境",
      },
    ],
  };
}

/** 一个合规的时间诡计（含独立时间源与时钟异常） */
function clockDesign() {
  const d = baseDesign();
  d.type = "时间诡计";
  d.dependsOnClock = true;
  d.coreTrick = "大厅座钟被拨慢，凶手借此伪造不在场证明";
  d.mechanism =
    "凶手在案发前一日深夜进入大厅，把座钟机芯的调速螺母回调，使座钟比真实时间慢二十分钟，随后按真实时间行凶。";
  d.proofChain = [
    {
      clue: "死者怀表指针停在 21:15，表壳内侧有近期上弦留下的油渍",
      kind: "independent-time-source",
      supports: "timeline",
      proves: "真实时间约为 21:15，与座钟读数相差二十分钟",
    },
    {
      clue: "座钟机芯调速螺母上有新鲜的扳手压痕，周围积灰被扰动",
      kind: "clock-anomaly",
      supports: "means",
      proves: "座钟在近期被人为调整过",
    },
    {
      clue: "更夫证词：他按座钟报时敲梆时，远处教堂钟声已敲过二刻",
      kind: "testimony",
      supports: "opportunity",
      proves: "座钟与外部可靠时间源对不上",
    },
    {
      clue: "死者书房铁皮箱内的账本显示：案发前半月，有一笔由死者垫付的巨额赌债即将到期",
      kind: "record",
      supports: "motive",
      proves: "有人在案发前被逼到还债无门，构成杀机",
    },
  ];
  return d;
}

// ==================== 基线 ====================

test("合规设计通过校验（防止规则误伤导致每次都重做）", () => {
  const v = validateTrickDesign(baseDesign());
  assert.equal(v.ok, true, `不应有错误，实际：${v.errors.join("；")}`);
  assert.deepEqual(v.errors, []);
});

test("合规的时间诡计通过校验", () => {
  const v = validateTrickDesign(clockDesign());
  assert.equal(v.ok, true, `不应有错误，实际：${v.errors.join("；")}`);
});

// ==================== 三锁覆盖度（动机-手法-机会） ====================
// 改造前只数条数和 kind，不问"这条线索推得动哪一维"——凑够 3 条全是物证、
// 动机零支撑也能过。三锁任缺一锁即打回。

test("三锁缺动机被拒（线索全在证明手法与机会，没人能推出「为什么是他」）", () => {
  const d = baseDesign();
  d.proofChain = d.proofChain.filter((c) => c.supports !== "motive");
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /三锁不齐备/.test(e) && /动机/.test(e)), v.errors.join("；"));
});

test("三锁缺手法被拒", () => {
  const d = baseDesign();
  // 保留 3 条（先满足条数），但把所有线索的 supports 换成非 means 维度 → 手法零支撑
  d.proofChain = d.proofChain.map((c, i) => ({ ...c, supports: i < 2 ? "opportunity" : "motive" }));
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /三锁不齐备/.test(e) && /手法/.test(e)), v.errors.join("；"));
});

test("三锁缺机会被拒", () => {
  const d = baseDesign();
  d.proofChain = d.proofChain.filter((c) => c.supports !== "opportunity");
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /三锁不齐备/.test(e) && /机会/.test(e)), v.errors.join("；"));
});

test("supports 字段非法被拒", () => {
  const d = baseDesign();
  d.proofChain[0].supports = "随便写";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /proofChain\[0\]\.supports/.test(e)), v.errors.join("；"));
});

test("时间诡计：三锁齐备但没有 supports=timeline 也被拒", () => {
  const d = clockDesign();
  // 把时间线那条的 supports 改成 means：kind 仍是 independent-time-source（时钟规则不报错），
  // 但三锁/时间线覆盖里没有 timeline 维度
  d.proofChain[0].supports = "means";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /「timeline」维度/.test(e)), v.errors.join("；"));
  // 三锁本身齐备，不应报三锁错误
  assert.ok(!v.errors.some((e) => /三锁不齐备/.test(e)), "三锁应当齐备：" + v.errors.join("；"));
});

test("非时间诡计不受 timeline 维度约束（防误伤）", () => {
  const d = baseDesign();
  // 密室本不应要求 timeline；故意不给任何 timeline 支撑
  d.proofChain = d.proofChain.filter((c) => c.supports !== "timeline");
  const v = validateTrickDesign(d);
  assert.equal(v.ok, true, `不应有错误，实际：${v.errors.join("；")}`);
});

// ==================== 时钟偏移幅度可行性 ====================
// 实测（1890 广州）：设定集称"拨快两刻"（30 分钟）即可让死亡时刻被推后约两个时辰
// （午初≈11:00 → 未时≈13:00，2 小时）——两刻根本不够，交叉校验事后才把它抓出来。

test("magNumeral：中文/阿拉伯数量词换算（两=2、半=0.5、支持一~九十九）", () => {
  assert.strictEqual(magNumeral("两"), 2);
  assert.strictEqual(magNumeral("半"), 0.5);
  assert.strictEqual(magNumeral("十"), 10);
  assert.strictEqual(magNumeral("十五"), 15);
  assert.strictEqual(magNumeral("二十"), 20);
  assert.strictEqual(magNumeral("九十九"), 99);
  assert.strictEqual(magNumeral("45"), 45);
  assert.strictEqual(magNumeral("随便"), null);
  assert.strictEqual(magNumeral(""), null);
});

test("parseDurations：带单位的时长换算成分，并给出位置", () => {
  assert.equal(parseDurations("拨快两刻").map((d) => d.minutes).join(","), "30");
  assert.equal(parseDurations("一个时辰").map((d) => d.minutes).join(","), "120");
  assert.equal(parseDurations("半小时").map((d) => d.minutes).join(","), "30");
  assert.equal(parseDurations("调慢45分钟").map((d) => d.minutes).join(","), "45");
  assert.equal(parseDurations("二十分钟").map((d) => d.minutes).join(","), "20");
  // 文本里没有单位的数字不应被当成时长（"19:40" 这种时刻不算）
  assert.equal(parseDurations("凶手19:40潜入").length, 0);
});

test("checkClockMagnitude：偏移不足以支撑声称的时间差 → 报错（实测原文形态）", () => {
  // 实测原文：「拨快两刻即可让死亡时刻被推后约两个时辰」
  const d = {
    coreTrick: "拨快自鸣钟伪造死亡时间",
    mechanism: "凶手拨快两刻即可让死亡时刻被推后约两个时辰，洗清自己。",
  };
  const r = checkClockMagnitude(d);
  assert.equal(r.offset, 30, "拨快两刻 = 30 分钟");
  assert.equal(r.claimed, 240, "两个时辰 = 240 分钟");
  assert.ok(r.errors.length === 1 && /幅度不足/.test(r.errors[0]), r.errors.join("；"));
  // 并且要能通过 validateTrickDesign 的时钟分支触发
  const full = clockDesign();
  full.mechanism = d.mechanism;
  const v = validateTrickDesign(full);
  assert.equal(v.ok, false, "validateTrickDesign 应把幅度不足判为不合格");
  assert.ok(v.errors.some((e) => /幅度不足/.test(e)), v.errors.join("；"));
});

test("checkClockMagnitude：偏移等于声称的时间差 → 通过", () => {
  const r = checkClockMagnitude({
    coreTrick: "拨慢座钟45分钟",
    mechanism: "凶手把大厅座钟拨慢45分钟，让人以为案发在45分钟之后。",
  });
  assert.equal(r.offset, 45);
  assert.equal(r.claimed, 45);
  assert.deepEqual(r.errors, [], "偏移够用就不该报错");
});

test("checkClockMagnitude：只提到调校、没提伪装时长 → 不报错（防误伤）", () => {
  const r = checkClockMagnitude({
    coreTrick: "座钟被调慢",
    mechanism: "凶手在深夜把大厅座钟拨慢45分钟，使所有人对案发时刻产生误判。",
  });
  assert.equal(r.offset, 45);
  assert.equal(r.claimed, null, "没有具体的伪装时长可比");
  assert.deepEqual(r.errors, []);
});

test("checkClockMagnitude：文本里的无关时长不参与比较（防误伤）", () => {
  // "死者生前在书房待了一个时辰" 与钟无关，不该被当成伪装时长
  const r = checkClockMagnitude({
    coreTrick: "座钟被拨快45分钟",
    mechanism: "死者生前在书房待了一个时辰。凶手趁无人时把大厅座钟拨快45分钟。",
  });
  assert.equal(r.offset, 45);
  assert.equal(r.claimed, null, "离伪装动词远的时长不算");
  assert.deepEqual(r.errors, []);
});

test("checkClockMagnitude：非时间诡计的文本无钟相关时长时完全不触发", () => {
  const r = checkClockMagnitude(baseDesign());
  assert.equal(r.offset, null);
  assert.equal(r.claimed, null);
  assert.deepEqual(r.errors, []);
});

// ==================== 身份诡计与复合支撑值 ====================
// 实测事故：身份诡计里模型写 supports="identity"，被枚举打回；重做后写 "identity-motive" 又被打回，
// 两次失败 → **整个诡计阶段降级**（本次生成不注入诡计硬约束）。一整类本子因此拿不到诡计约束。

test("splitSupports：复合值拆成多维度（identity-motive → 两项）", () => {
  assert.deepEqual(splitSupports("identity-motive"), ["identity", "motive"]);
  assert.deepEqual(splitSupports("motive"), ["motive"]);
  assert.deepEqual(splitSupports("motive／opportunity"), ["motive", "opportunity"]);
  assert.deepEqual(splitSupports("motive、means"), ["motive", "means"]);
  assert.deepEqual(splitSupports(""), []);
  assert.deepEqual(splitSupports(null), []);
});

test("involvesIdentity：只认 type 明确为身份错位（避免误伤）", () => {
  assert.equal(involvesIdentity({ type: "身份错位" }), true);
  assert.equal(involvesIdentity({ type: "密室" }), false);
  assert.equal(involvesIdentity({ type: "叙述性诡计", mechanism: "有人冒充了死者" }), false, "仅机制提到身份不算，避免误伤");
  assert.equal(involvesIdentity(null), false);
});

test("复合支撑值被接受，且各维度都计入三锁覆盖", () => {
  const d = baseDesign();
  // 把"动机"那条改成复合写法：应同时计为 identity 与 motive
  d.proofChain = d.proofChain.map((c) => (c.supports === "motive" ? { ...c, supports: "identity-motive" } : c));
  d.type = "身份错位";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, true, `复合值不应被判非法，实际：${v.errors.join("；")}`);
});

test("身份诡计缺 identity 支撑被拒", () => {
  const d = baseDesign();
  d.type = "身份错位";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /支撑「identity」维度/.test(e)), v.errors.join("；"));
});

test("身份诡计有 identity 支撑即通过；非身份诡计不要求 identity", () => {
  const withIdentity = baseDesign();
  withIdentity.type = "身份错位";
  withIdentity.proofChain[0].supports = "identity";
  const v1 = validateTrickDesign(withIdentity);
  assert.equal(v1.ok, true, `不应有错误，实际：${v1.errors.join("；")}`);

  // 防误伤：密室本不该被要求 identity（baseDesign 里没有任何 identity 支撑）
  const plain = validateTrickDesign(baseDesign());
  assert.equal(plain.ok, true);
  assert.ok(!plain.errors.some((e) => /identity/.test(e)), "非身份诡计不得被要求 identity");
});

// ==================== 输入形状 ====================

test("非对象输入被拒", () => {
  assert.equal(validateTrickDesign(null).ok, false);
  assert.equal(validateTrickDesign("密室").ok, false);
  assert.equal(validateTrickDesign([]).ok, false);
  assert.match(validateTrickDesign(null).errors[0], /JSON 对象/);
});

// ==================== 必填与枚举 ====================

test("缺少 proofChain 时拒绝，并说明至少 3 条", () => {
  const d = baseDesign();
  delete d.proofChain;
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /proofChain 至少需要 3 条/.test(e)), v.errors.join("；"));
});

test("mechanism 过短被拒（不能是空话）", () => {
  const d = baseDesign();
  d.mechanism = "设计巧妙的密室";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /mechanism/.test(e)), v.errors.join("；"));
});

test("feasibility 三项缺失分别报错", () => {
  const d = baseDesign();
  d.feasibility = { physics: "朝向内院，可执行" };
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /feasibility\.witness/.test(e)));
  assert.ok(v.errors.some((e) => /feasibility\.weakest/.test(e)));
});

test("type 不在枚举内被拒", () => {
  const d = baseDesign();
  d.type = "量子纠缠";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /type「量子纠缠」不在允许的类型内/.test(e)), v.errors.join("；"));
});

test("proofChain 条目的 kind 非法被拒", () => {
  const d = baseDesign();
  d.proofChain[0].kind = "magic";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /proofChain\[0\]\.kind/.test(e)), v.errors.join("；"));
});

// ==================== 内容质量 ====================

test("线索里出现结论句被拒（推断要留给玩家）", () => {
  const d = baseDesign();
  d.proofChain[0].clue = "窗台内侧有两道细压痕，这证明凶手是用鱼线拉动插销的";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /结论句/.test(e)), v.errors.join("；"));
});

test("超自然设定被拒", () => {
  const d = baseDesign();
  d.mechanism = "凶手使用穿越能力回到一小时前完成作案，因此没有不在场证明问题。";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /超自然/.test(e)), v.errors.join("；"));
});

test("证明链里没有任何玩家可获取的实体线索被拒", () => {
  const d = baseDesign();
  d.proofChain = d.proofChain.map((c, i) => ({ ...c, kind: "identity" }));
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /没有一条实体线索/.test(e)), v.errors.join("；"));
});

// ==================== 时间诡计的硬性要求（本方案的核心收益） ====================

test("时间诡计缺独立时间源被拒", () => {
  const d = clockDesign();
  d.proofChain = d.proofChain.filter((c) => c.kind !== "independent-time-source");
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /independent-time-source/.test(e)), v.errors.join("；"));
});

test("时间诡计缺时钟异常被拒", () => {
  const d = clockDesign();
  d.proofChain = d.proofChain.filter((c) => c.kind !== "clock-anomaly");
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /clock-anomaly/.test(e)), v.errors.join("；"));
});

test("停摆的钟不能充当独立时间源（如实测过的《钟楼诡影》反例）", () => {
  // 这条不是断言代码能识别"停摆"，而是钉住产品结论：
  // 只有 clock-anomaly 而没有 independent-time-source 的证明链必须被拒。
  const d = clockDesign();
  d.proofChain = [
    { clue: "花园里的落地钟停在 20:40，钟摆已经不再摆动", kind: "clock-anomaly", proves: "有一口钟停在案发前" },
    { clue: "大厅座钟的钟面与教堂钟声对不上", kind: "clock-anomaly", proves: "座钟读数不可信" },
    { clue: "仆人说他听见大厅钟声敲响", kind: "testimony", proves: "有人在案发时段在走廊活动" },
  ];
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /independent-time-source/.test(e)), v.errors.join("；"));
});

test("未显式声明 dependsOnClock，但文本提到钟表时同样按时间诡计要求", () => {
  const d = baseDesign();
  d.type = "不在场证明";
  d.dependsOnClock = false; // 故意不声明
  d.mechanism = "凶手把大厅座钟的指针往前拨了二十分钟，用错误读数制造不在场证明，作案时众人看的都是那口钟。";
  const v = validateTrickDesign(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /independent-time-source/.test(e)), v.errors.join("；"));
  assert.ok(v.errors.some((e) => /clock-anomaly/.test(e)), v.errors.join("；"));
});

// ==================== involvesClock / 文本渲染 ====================

test("involvesClock：显式字段 / 类型 / 文本三条信号都能识别", () => {
  const byFlag = baseDesign();
  byFlag.dependsOnClock = true;
  assert.equal(involvesClock(byFlag), true);

  const byType = baseDesign();
  byType.type = "时间诡计";
  assert.equal(involvesClock(byType), true);

  const byText = baseDesign();
  byText.mechanism = "凶手调整了落地钟的机芯，使报时整体延后。";
  assert.equal(involvesClock(byText), true);

  assert.equal(involvesClock(baseDesign()), false);
  assert.equal(involvesClock(null), false);
});

test("involvesClock 不把「分钟」误判成时钟", () => {
  const d = baseDesign();
  d.mechanism = "凶手在案发后十分钟内返回大厅，全程不超过二十分钟，中间没有任何停顿。";
  assert.equal(involvesClock(d), false);
});

test("trickDesignToText：输出可注入大纲的硬约束，且完整列出证明链", () => {
  const t = trickDesignToText(clockDesign());
  assert.ok(t.includes("核心诡计设计"));
  assert.ok(t.includes("不得另立诡计"));
  assert.ok(t.includes("21:15"));
  assert.ok(t.includes("independent-time-source"));
  assert.ok(t.includes("clock-anomaly"));
  assert.ok(t.includes("证明链"));
  // 无设计时返回空串（降级路径）
  assert.equal(trickDesignToText(null), "");
});

test("枚举自洽：可获取线索种类必须是线索种类的子集", () => {
  for (const k of OBTAINABLE_KINDS) {
    assert.ok(CLUE_KINDS.includes(k), `${k} 不在 CLUE_KINDS 内`);
  }
  assert.ok(TRICK_TYPES.length >= 5);
});

// ==================== 可观测性补写：插入位置 ====================
// 这一组用**真实解析器**验证，而不是断言字符串位置：
// 线索插错轮次 = 在游戏里根本不会被发出来，只有解析器能回答"插对了没有"。
const { extractAllClues } = require("../../src/script/script-parser");
const { nextClueId, insertCluesIntoRound2, normalizeClueBlocks } = require("../../src/script/trick-design");

/**
 * 按 assembleScript 的真实包法组装：extractAllClues 靠「第三部分」定位线索章节，
 * 靠「# 第四部分」定边界。夹具必须与生产一致，否则测的不是真链路。
 */
const wrap = (clues) => `# 第三部分：线索系统\n${clues}\n---\n\n# 第四部分：DM 手册\n`;

const CLUES = `## 第一轮线索

### A1：
- 线索类型：人证
- 发现地点：王管家
- 线索内容：他说案发当晚听见书房方向有响动。

### A2：
- 线索类型：文件
- 发现地点：书房
- 线索内容：桌上一本账册，最后一页有涂改。

## 第二轮线索

### B1：
- 线索类型：物证
- 发现地点：书房
- 线索内容：茶杯内壁有白色残留物。

### B2：
- 线索类型：痕迹
- 发现地点：走廊
- 线索内容：地板上有一道拖痕。
`;

const NEW_BLOCKS = [
  "### B3：\n- 线索类型：物证\n- 发现地点：顾明堂\n- 线索内容：贴身怀表指针停在 21:15，表壳内侧有近期上弦留下的油渍。",
  "### B4：\n- 线索类型：痕迹\n- 发现地点：大厅\n- 线索内容：座钟机芯调速螺母上有新鲜扳手压痕，周围积灰被扰动。",
];

test("nextClueId：从现有编号续排，不撞车", () => {
  assert.equal(nextClueId(CLUES, "B"), 3);
  assert.equal(nextClueId(CLUES, "A"), 3);
  assert.equal(nextClueId("", "B"), 1);
  assert.equal(nextClueId("### B9：\n- 线索内容：x", "B"), 10);
});

test("插入的线索能被真实解析器读到，并归入第二轮", () => {
  const merged = insertCluesIntoRound2(CLUES, NEW_BLOCKS);
  const rounds = extractAllClues(wrap(merged));
  const ids2 = rounds.round2.map((c) => c.id).sort();
  assert.deepEqual(ids2, ["B1", "B2", "B3", "B4"]);
  // 第一轮不受影响
  assert.deepEqual(rounds.round1.map((c) => c.id).sort(), ["A1", "A2"]);
  // 内容与地点确实解析出来了（不是空壳）
  const b3 = rounds.round2.find((c) => c.id === "B3");
  assert.match(b3.content, /21:15/);
  assert.equal(b3.location, "顾明堂");
  // 补写线索确实命中了可观测性正则（独立时间源 + 时钟异常）
  const all = merged;
  assert.match(all, /怀表/);
  assert.match(all, /机芯[^。\n]{0,40}(拨|调|不准|走时|机芯|痕迹|齿轮|撬|后盖|底座|对不上|不一致|动过|快|慢)/);
});

test("存在第三轮标题时，补写线索仍落在第二轮（落错轮次等于不发）", () => {
  const withRound3 = CLUES + "\n## 第三轮线索\n\n### C1：\n- 线索类型：物证\n- 发现地点：阁楼\n- 线索内容：旧箱子。\n";
  const merged = insertCluesIntoRound2(withRound3, NEW_BLOCKS);
  const rounds = extractAllClues(wrap(merged));
  assert.deepEqual(rounds.round2.map((c) => c.id).sort(), ["B1", "B2", "B3", "B4"]);
  // C1 必须仍在第三轮，没有被挤走
  assert.deepEqual(rounds.round3.map((c) => c.id), ["C1"]);
});

test("没有轮次标题时走兜底：按 B 前缀归入第二轮", () => {
  const noHeading = "### B1：\n- 线索类型：物证\n- 发现地点：书房\n- 线索内容：茶渍。\n";
  const merged = insertCluesIntoRound2(noHeading, NEW_BLOCKS);
  const rounds = extractAllClues(wrap(merged));
  assert.ok(rounds.round2.some((c) => c.id === "B3"), "兜底路径也要能解析到新线索");
});

test("insertCluesIntoRound2：空块时不改动原文", () => {
  assert.equal(insertCluesIntoRound2(CLUES, []), CLUES);
  assert.equal(insertCluesIntoRound2(CLUES, null), CLUES);
});

test("normalizeClueBlocks：重新编号、丢弃无内容的块", () => {
  const raw = `### B99：
- 线索类型：物证
- 发现地点：大厅
- 线索内容：座钟机芯有新鲜撬痕。

### 一些没用的说明文字

### 新线索
- 线索类型：人证
- 发现地点：更夫
- 线索内容：他说教堂钟声已敲过二刻。`;
  const blocks = normalizeClueBlocks(raw, 7, "B");
  assert.equal(blocks.length, 2, "只保留含线索内容的块");
  assert.ok(blocks[0].startsWith("### B7："), blocks[0]);
  assert.ok(blocks[1].startsWith("### B8："), blocks[1]);
  // 模型自编的 B99 必须被覆盖，避免与现有 ID 撞车
  assert.ok(!blocks.join("").includes("B99"));
  assert.match(blocks[0], /撬痕/);
});

// ==================== 诡计定稿后，框架阶段必须停止"自己设计诡计" ====================
// 这一组对应实测出来的框架阶段故障：模板要求模型"先在脑中敲定核心诡计，确保逻辑自洽、
// 物理可行"，叠加它自身庞大的产出要求，推理模型会把 32768 token 全部烧在思考上、
// 一个字正文都不输出。诡计已由上游定稿并通过校验后，这段推理纯属浪费，必须显式取消。
const { buildFrameworkPrompt } = require("../../src/script/murder-mystery-builder");

test("buildFrameworkPrompt：未注入诡计时保持改造前行为", () => {
  const cfg = { playerCount: 6, npcCount: 0, isPVE: false };
  const p = buildFrameworkPrompt("民国寿宴命案", cfg, null);
  assert.match(p.system, /先定核心诡计/, "未注入时不应改动原有指令");
  assert.ok(!p.user.includes("核心诡计设计"), "未注入时不应出现诡计块");
  // 占位符必须已替换（残留字面量会导致下游正则大面积失配）
  assert.ok(!/\{playerCount\}/.test(p.system), "占位符未替换");
  assert.ok(p.system.includes("6"), "人数未写入");
});

test("buildFrameworkPrompt：注入诡计后取消「自己设计诡计」并带上设计内容", () => {
  const cfg = { playerCount: 6, npcCount: 0, isPVE: false };
  const design = clockDesign();
  const p = buildFrameworkPrompt("民国寿宴命案", cfg, design);

  // ① 旧的自我设计指令必须消失
  assert.ok(!/先在脑中敲定本局的核心诡计/.test(p.system), "残留了旧的自我设计指令");
  // ② 换成"已定稿，禁止重新设计"
  assert.match(p.system, /核心诡计已定稿，禁止重新设计/);
  assert.match(p.system, /不要重新构思诡计/);
  // ③ 设计内容确实注入到用户消息
  assert.ok(p.user.includes("核心诡计设计"), "诡计块未注入");
  assert.ok(p.user.includes("21:15"), "证明链内容未注入");
  assert.ok(p.user.includes("clock-anomaly"), "证明链种类未注入");
  // ④ 顺序纪律的其余两条仍在（只是不再让模型自己设计诡计）
  assert.match(p.system, /直接围绕它构思人物/);
  assert.match(p.system, /最后填时间线/);
  // ⑤ 占位符替换不受影响
  assert.ok(!/\{playerCount\}/.test(p.system + p.user));
  assert.ok(!/\{npcConstraint\}/.test(p.system + p.user));
});
