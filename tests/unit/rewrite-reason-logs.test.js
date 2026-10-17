// 单元测试：重写类校验必须**逐条**把原因与原文打进日志，不能只留一个"N 处"。
//
// 为什么值得单独钉（2026-10-17 实测）：
//   `ensureDateConsistent` 每命中一次就**整篇重写一遍角色剧本**（实测一次约 1 分钟），
//   而日志里只有一行「阿花 日期标注校验失败：7 处」—— 事后连"这 7 处是真缺陷
//   还是判据误伤"都判断不了。改后那一本有 2 个角色因此各多跑了一整遍，却无从复核。
//   `ensureDeathConsistent` 同理，而且它判错会把**写对的内容改坏**（见 repairDeathLines 注释）。
//
// 与 bible-enforce 的 warn 路径保持一致（那里也是逐条列原因与原文）。
const test = require("node:test");
const assert = require("node:assert");
const { ensureDateConsistent, ensureDeathConsistent, checkDateLabels } = require("../../src/script/murder-mystery-builder");

/** 捕获执行期间的 console.warn 文本 */
async function captureWarn(fn) {
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.map((x) => String(x)).join(" "));
  try { await fn(); } finally { console.warn = orig; }
  return logs.join("\n");
}

// 一句话解释这条为什么违规：17:00–23:59 属于案发当日，却被标成了案发次日（规则 B）
const CROSS_MIDNIGHT_SCRIPT = [
  "### 一、你的背景故事",
  "我是录像厅的售票员。",
  "",
  "### 二、你的时间线",
  "",
  "- **10月17日 21:00**：大堂 — 我在门口等人，看见阿明上楼",
  "- **10月17日 22:10**：楼梯口 — 听见放映室有响动",
  "",
  "### 三、你的任务",
  "藏住工资条。",
].join("\n");

const OPTS = { caseDate: "10月16日", nextDate: "10月17日", midnight: true };

test("预习：这份剧本在该判据下确实有违规（否则下面的日志断言没有意义）", () => {
  const chk = checkDateLabels(CROSS_MIDNIGHT_SCRIPT, OPTS);
  assert.strictEqual(chk.needed, true);
  assert.ok(chk.violations.length >= 1, `应至少 1 处违规，实际 ${chk.violations.length}`);
});

test("ensureDateConsistent：每条违规的原因与原文都必须进日志", async () => {
  let retried = 0;
  const logs = await captureWarn(async () => {
    await ensureDateConsistent("阿花", CROSS_MIDNIGHT_SCRIPT, OPTS, async () => { retried++; return CROSS_MIDNIGHT_SCRIPT; }, null);
  });
  assert.strictEqual(retried, 1, "有违规就必须重写一次（前提）");

  const chk = checkDateLabels(CROSS_MIDNIGHT_SCRIPT, OPTS);
  assert.match(logs, /日期标注校验失败：\d+ 处/, "保留原有的一行汇总");
  for (const v of chk.violations) {
    assert.ok(logs.includes(v.reason), `日志里必须逐条出现违规原因：「${v.reason}」`);
    assert.ok(logs.includes(v.line), `日志里必须出现违规原文：${v.line}`);
  }
  assert.match(logs, /\[日期标注\]/, "逐条日志要有可检索的标签");
});

test("ensureDeathConsistent：每条违规的时刻与原文都必须进日志", async () => {
  // 死者在 22:28 死亡，剧本里 23:10 还在写他活动 → 死后活动违规。
  // ⚠️ 两个前提缺一不可（第一次写测试时就漏了，当场被判据挡住）：
  //   ① 死者必须是**动作主语**且动词在 VICTIM_ACT_RE_SRC 表里（"让"不在表里 → 用"吩咐"）；
  //   ② 行里有明确日期时，必须把 caseDate 传进 opts，否则 onCaseNight 保守地"不判"。
  const content = [
    "### 二、你的时间线",
    "",
    "- **10月16日 23:10**：放映室 — 邱长贵吩咐我把门带上，他自己还在抽烟",
  ].join("\n");
  let retried = 0;
  const logs = await captureWarn(async () => {
    await ensureDeathConsistent("阿明", content, "22:28", "邱长贵", async () => { retried++; return content; }, null, { caseDate: "10月16日" });
  });
  assert.ok(retried >= 1, "有死后活动就必须处置（就地改写或整篇重生成）");
  assert.match(logs, /死亡时刻校验失败：\d+ 处（死亡时刻 22:28）/, "保留原有的一行汇总");
  assert.match(logs, /\[死后活动\]/, "逐条日志要有可检索的标签");
  assert.ok(logs.includes("邱长贵吩咐我把门带上"), `日志里必须出现违规原文，实际日志：\n${logs}`);
  assert.match(logs, /23:10/, "日志里必须出现违规时刻");
});
