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
