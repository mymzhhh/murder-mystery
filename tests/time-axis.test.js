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
} = require("../modules/murder-mystery-builder");

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

test("checkTrickObservability：非时间类诡计不参与校验", () => {
  const r = checkTrickObservability({ clues: "" }, { trickSpec: { mechanism: "暗格藏凶器。" } });
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

test("parseCaseDate：唯一日期时采用", () => {
  assert.strictEqual(parseCaseDate({ storyBackground: "案发当日为4月12日，暴雨。" }), "4月12日");
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
