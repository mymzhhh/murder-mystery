// 线索阶段的三组守卫校验 + 就地改写原语。
// 这些检查全部是确定性代码（不调 LLM），所以可以被穷举测试；
// 对应的修复动作（repairClueTexts）只改措辞、不动编号与轮次，因此测试覆盖其纯文本原语。
const test = require("node:test");
const assert = require("node:assert");
const {
  checkTrickObservability,
  checkEraCarriers,
  detectEra,
  checkRoundUnlock,
  replaceClueBlock,
  extractClueBlocks,
  nameAccuses,
} = require("../../src/script/murder-mystery-builder");

// ==================== 时代载体（防"民国本子写出联网日志"）====================

test("detectEra：按时代文本分档", () => {
  assert.equal(detectEra("民国二十六年的上海"), "民国");
  assert.equal(detectEra("1937年，抗日战争全面爆发前夕"), "民国");
  assert.equal(detectEra("光绪三十年的苏州"), "古代");
  assert.equal(detectEra("明代万历年间的杭州"), "古代");
  assert.equal(detectEra("现代都市，2024年秋季"), null);
  assert.equal(detectEra("架空世界，未来城市"), null);
});

test("checkEraCarriers：民国本子里的联网日志/微信/手机信号被抓出来", () => {
  const clues = `### A1：
- 线索类型：文件
- 发现地点：书房
- 线索内容：书桌抽屉里的联网日志显示，案发前有异常访问。

### B2：
- 线索类型：人证
- 发现地点：管家
- 线索内容：微信聊天记录显示他与人密谋，手机号码可查。`;
  const r = checkEraCarriers("民国", clues);
  assert.equal(r.needed, true);
  for (const w of ["联网日志", "微信", "手机号码"]) {
    assert.ok(r.offenders.includes(w), `应抓出「${w}」，实际：${r.offenders.join("、")}`);
  }
});

test("checkEraCarriers：民国本里的时代内载体不误伤（怀表/账本/当票/更夫证词）", () => {
  const clues = `### A1：
- 线索类型：物证
- 发现地点：顾明堂
- 线索内容：贴身怀表指针停在21:15，表壳内侧有近期上弦留下的油渍。

### B2：
- 线索类型：人证
- 发现地点：更夫
- 线索内容：更夫证词：他按座钟报时时，教堂钟声已敲过二刻；账房里有当票存根。`;
  const r = checkEraCarriers("民国", clues);
  assert.deepEqual(r.offenders, [], `不应有误伤，实际：${r.offenders.join("、")}`);
});

test("checkEraCarriers：晚清真实存在的载体不误伤（电报/报纸/火车/轮船/电话）", () => {
  // detectEra 把"光绪/宣统"归入「古代」，而这些东西在晚清真实存在
  // （电报局、申报、淞沪铁路、轮船招商局）。早期版本把它们列为违规 → 会把正确内容改坏。
  const clues = "- 线索内容：上海电报局的送报回执上盖着十九时五十分的戳记；当日的《申报》也登了讣告；他乘轮船自汉口来。";
  assert.deepEqual(checkEraCarriers("古代", clues).offenders, [], "晚清载体不应被当成穿越");
  assert.deepEqual(checkEraCarriers("民国", clues).offenders, []);
});

test("checkEraCarriers：真正的现代载体在两档都被抓（联网日志/微信/身份证）", () => {
  const clues = "- 线索内容：联网日志与微信记录可查，身份证登记在案。";
  assert.ok(checkEraCarriers("古代", clues).offenders.length > 0);
  assert.ok(checkEraCarriers("民国", clues).offenders.length > 0);
});

test("checkEraCarriers：现代/未知时代不设限（避免误伤）", () => {
  const clues = "- 线索内容：联网日志显示异常访问。";
  assert.equal(checkEraCarriers("现代", clues).needed, false);
  assert.equal(checkEraCarriers(null, clues).needed, false);
});

// ==================== 轮次解锁（第一轮不得点名真凶）====================

const ROUND_CLUES = `## 第一轮线索

### A1：
- 线索类型：人证
- 发现地点：王管家
- 线索内容：王管家声称案发当晚在守夜。有目击称他 22:30 往书房方向走去——凶手就是王管家。

## 第二轮线索

### B1：
- 线索类型：物证
- 发现地点：书房
- 线索内容：死者怀表停在21:15，与座钟读数相差二十分钟。`;

test("checkRoundUnlock：第一轮**指控**真凶被检出", () => {
  // 注意判据已从"出现姓名"改为"结论性指控"——纯提及（证词/文档/目击）不判（见 nameAccuses 注释）
  const r = checkRoundUnlock(ROUND_CLUES, "王管家");
  assert.equal(r.r1NamesMurderer, "王管家");
  assert.equal(r.ok, false);
});

test("checkRoundUnlock：第一轮纯提及真凶姓名**不算违规**（PVP 核心玩法材料）", () => {
  // 实测（1965 长春）被点名的其实是正当内容：凶手自己的公开证词、客观文档列名、目击某某出现在某处。
  // PVP 剧本里所有人互为嫌疑人，"签到簿上有他的名字"本来就是推理材料，不是指控。
  const clues = `## 第一轮线索

### A1：
- 线索类型：文件
- 发现地点：签到簿
- 线索内容：签到簿当日页：郑国栋19:15签到；王管家22:10（事由栏写"巡检"）。

### A2：
- 线索类型：证词
- 发现地点：王管家证词（公开陈述）
- 线索内容："我八点差一刻才到澡堂，一进门就撞见老郑往深水区走。"

## 第二轮线索

### B1：
- 线索内容：死者怀表停在21:15，与座钟读数相差二十分钟。`;
  const r = checkRoundUnlock(clues, "王管家");
  assert.equal(r.r1NamesMurderer, "", "纯提及（证词/文档/目击）不该被判为指控");
  assert.deepEqual(r.r1Blocks, [], "违规块列表必须为空");
  assert.equal(r.ok, true);
});

test("checkRoundUnlock：第一轮匿名 + 第二轮有定案锚点 → 通过", () => {
  const r = checkRoundUnlock(ROUND_CLUES, "赵德忠");
  assert.equal(r.r1NamesMurderer, "");
  assert.equal(r.r2HasAnchor, true);
  assert.equal(r.ok, true);
});

test("checkRoundUnlock：第二轮无定案锚点 → 不通过（无法抵赖阶段缺料）", () => {
  const weak = `## 第一轮线索

### A1：
- 线索内容：守夜的仆人说一切正常。

## 第二轮线索

### B1：
- 线索内容：宾客回忆当晚气氛紧张，各怀心思。`;
  const r = checkRoundUnlock(weak, "赵德忠");
  assert.equal(r.r2HasAnchor, false);
  assert.equal(r.ok, false);
});

test("checkRoundUnlock：第二轮点名真凶**不算违规**（第二轮本来就该能定案）", () => {
  // 这是端到端复验里抓出来的实现缺陷：改写范围一度混进了 B 打头的第二轮线索，
  // 白削了定案证据。第一轮才是"只能起疑"的阶段。
  const clues = `## 第一轮线索

### A1：
- 线索类型：人证
- 发现地点：账房先生
- 线索内容：账房先生称案发时自己在核对账目。

## 第二轮线索

### B1：
- 线索类型：物证
- 发现地点：书房
- 线索内容：死者怀表停在21:15，与座钟读数相差四十五分钟，指向掌钟人沈砚清。`;
  const r = checkRoundUnlock(clues, "沈砚清");
  assert.equal(r.r1NamesMurderer, "", "第二轮点名不应触发第一轮违规");
  assert.deepEqual(r.r1Blocks, [], "违规块列表必须为空");
  assert.equal(r.r2HasAnchor, true);
  assert.equal(r.ok, true);
});

test("checkRoundUnlock：r1Blocks 只收第一轮区间内的**指控性**违规块（供就地改写用）", () => {
  const clues = `## 第一轮线索

### A1：
- 线索内容：账房先生的账册上有一笔说不清的支出，留有一处涂改痕迹——凶手就是沈砚清。

### A2：
- 线索内容：仆人说当夜听见东厢有动静。

## 第二轮线索

### B1：
- 线索内容：座钟机芯有新鲜的拨动痕迹，时间戳与沈砚清的怀表读数相差四十五分钟。`;
  const r = checkRoundUnlock(clues, "沈砚清");
  assert.equal(r.r1NamesMurderer, "沈砚清");
  assert.deepEqual(r.r1Blocks.map((b) => b.id), ["A1"], "只应包含第一轮里指控的 A1");
  assert.equal(r.ok, false);
});

// ==================== 指控 vs 纯提及（第五次「规则比事实更绝对」的教训） ====================
// 原判据是"第一轮出现真凶姓名即违规"，每轮端到端都触发匿名化；把产物抽出来看，
// 被点名的全是正当 PVP 内容（凶手自己的公开证词、客观文档列名、目击某某出现在某处）。
// 真正破坏两轮制的是**结论性指控**（"凶手是X""X杀害了死者"）。

test("nameAccuses：结论性指控的四种形态都被检出", () => {
  assert.ok(nameAccuses("种种迹象表明，凶手就是赵铁成。", "赵铁成"));
  assert.ok(nameAccuses("凶手是赵铁成，他趁夜动手。", "赵铁成"));
  assert.ok(nameAccuses("赵铁成杀害了死者，手法是勒毙。", "赵铁成"));
  assert.ok(nameAccuses("这说明凶手是赵铁成，动机是夺产。", "赵铁成"));
  assert.ok(nameAccuses("赵铁成乃真凶也。", "赵铁成"));
});

test("nameAccuses：纯提及不判（证词/文档/目击/含凶手字样但不指控）", () => {
  // 凶手自己的公开证词
  assert.ok(!nameAccuses("王管家证词：我八点差一刻才到澡堂，一进门就撞见老郑往深水区走。", "王管家"));
  // 客观文档列名
  assert.ok(!nameAccuses("签到簿当日页：郑国栋19:15签到；王管家22:10（事由栏写巡检）。", "王管家"));
  // 目击某某出现在某处（PVP 核心玩法材料）
  assert.ok(!nameAccuses("有目击称王管家 22:30 往书房方向走去。", "王管家"));
  // 提到凶手字样但不指控（众人议论凶手是谁）
  assert.ok(!nameAccuses("众人议论凶手会是谁，王管家低着头不说话。", "王管家"));
  // 空输入（无姓名时函数无法判定任何事，返回 false 是设计行为）
  assert.ok(!nameAccuses("", "王管家"));
  assert.ok(!nameAccuses("凶手就是王管家。", ""), "没有姓名可比对时不判");
});

// ==================== 线索块原地替换 ====================

test("replaceClueBlock：只改目标块，编号与邻块不动", () => {
  const merged = replaceClueBlock(ROUND_CLUES, "A1", `- 线索类型：人证\n- 发现地点：账房先生\n- 线索内容：账房先生声称案发当晚在守夜，但语气闪烁。`);
  assert.ok(merged);
  assert.ok(merged.includes("账房先生"), "改写内容应生效");
  assert.ok(merged.includes("### A1："), "编号必须保留");
  assert.ok(!merged.includes("王管家声称案发当晚在守夜"), "旧内容应被替换");
  assert.ok(merged.includes("怀表停在21:15"), "邻块不应受影响");
  // 替换后仍能被真实解析器读懂
  const blocks = extractClueBlocks(merged);
  const a1 = blocks.find((b) => b.id === "A1");
  assert.ok(a1 && a1.body.includes("账房先生"));
});

test("replaceClueBlock：未知编号返回 null（不静默改错地方）", () => {
  assert.equal(replaceClueBlock(ROUND_CLUES, "B99", "随便什么"), null);
});

test("extractClueBlocks：按编号切块", () => {
  const blocks = extractClueBlocks(ROUND_CLUES);
  assert.deepEqual(blocks.map((b) => b.id), ["A1", "B1"]);
  assert.ok(blocks[1].body.includes("怀表"));
});

// ==================== 诡计可观测性（推广到所有诡计）====================

const CLOCK_OUTLINE = {
  coreTrick: "座钟被拨慢，凶手借此伪造不在场证明",
  trickSpec: { mechanism: "凶手把大厅座钟拨慢20分钟，再按真实时间行动" },
  murderer: { name: "赵德忠", method: "拨慢座钟后下毒" },
  timeline: [{ time: "20:55", desc: "凶手拨钟" }],
};
const PLAIN_OUTLINE = {
  coreTrick: "书房密室",
  murderer: { name: "赵德忠", method: "用鱼线从门外拨回插销" },
};

test("checkTrickObservability：没有任何诡计的剧本不触发检查", () => {
  const r = checkTrickObservability({ clues: "随便写点" }, { murderer: {} }, "");
  assert.equal(r.needed, false);
});

test("checkTrickObservability：推广后——非时钟诡计无任何物证锚点也会被判不足", () => {
  // 这是改造前测不到的：旧实现只在时钟诡计时检查，密室诡计的线索体系全靠聊天也能过
  const noAnchor = { clues: "### A1：\n- 线索内容：大厅的窗帘是深红色的。书桌上放着一本翻开的书。" };
  const r = checkTrickObservability(noAnchor, PLAIN_OUTLINE, "");
  assert.equal(r.needed, true);
  assert.equal(r.clockNeeded, false);
  assert.equal(r.hasAnchor, false);
  assert.equal(r.ok, false);
});

test("checkTrickObservability：非时钟诡计有物证锚点即通过", () => {
  const withAnchor = { clues: "### A1：\n- 线索内容：窗台内侧有两道平行的细压痕，边缘发亮。" };
  const r = checkTrickObservability(withAnchor, PLAIN_OUTLINE, "");
  assert.equal(r.hasAnchor, true);
  assert.equal(r.ok, true);
});

test("checkTrickObservability：时钟诡计仍要求独立时间源 + 时钟异常两项", () => {
  const onlyAnchor = { clues: "### A1：\n- 线索内容：抽屉里有一本账本，最后一页有涂改痕迹。" };
  const r = checkTrickObservability(onlyAnchor, CLOCK_OUTLINE, "");
  assert.equal(r.clockNeeded, true);
  assert.equal(r.hasIndependent, false);
  assert.equal(r.hasClockAnomaly, false);
  assert.equal(r.ok, false);
});

test("checkTrickObservability：时钟诡计齐备两项后通过", () => {
  const full = {
    clues: `### A1：\n- 线索内容：死者怀表停在21:15。\n\n### B1：\n- 线索内容：座钟机芯调速螺母上有新鲜扳手压痕。`,
  };
  const r = checkTrickObservability(full, CLOCK_OUTLINE, "");
  assert.equal(r.hasIndependent, true);
  assert.equal(r.hasClockAnomaly, true);
  assert.equal(r.ok, true);
});
