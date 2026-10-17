// bible-enforce 的**可观测性与接线**契约测试
//
// 两个真实缺口（都由"跑一局真剧本后没人看得见"暴露出来）：
//   ① 「提示级问题不自动改写、仅记录」—— 但**从来没有把问题列出来过**。
//      实测一本戏 11 条（跨节复述 9 / 同刻相近 1 / 时序可疑 1），事后无从复盘。
//   ② 无损清理必须放在 `!factsText` 提前返回**之前**：没有权威条目的角色同样要清
//      （否则那类角色会把"日期/地点"标签原样留给玩家看）。
const test = require("node:test");
const assert = require("node:assert");
const sb = require("../../src/script/story-bible");
const { ensureBibleAligned } = require("../../src/script/bible-enforce");

/**
 * 捕获 console.log + console.warn（两者都用：
 * 进度类走 log、问题类走 warn，测试必须同时看两个流，否则会漏判"日志到底打没打"）。
 */
async function withWarn(fn) {
  const out = [];
  const origLog = console.log, origWarn = console.warn;
  const push = (...a) => out.push(a.join(" "));
  console.log = push; console.warn = push;
  try { const result = await fn(); return { result, warns: out }; }
  finally { console.log = origLog; console.warn = origWarn; }
}

/** 假 deps：任何"真去调模型"的行为都要让测试炸掉 */
function deps(shouldNotCallLLM) {
  return {
    generate: async () => { if (shouldNotCallLLM) throw new Error("不该调用 LLM"); return { content: "" }; },
    runStage: async (n, fn) => { if (shouldNotCallLLM) throw new Error("不该调用 runStage：" + n); return fn(); },
    sb,
    applyLineRewrites: () => null,
    extractJsonStrict: () => null,
    repairTruncatedJson: (s) => s,
  };
}

const BIBLE = {
  characters: ["林默"],
  places: ["一楼大厅"],
  victim: { name: "赵建国", deathTime: "21:30" },
  timeline: [{ time: "20:00", actor: "林默", doing: "在一楼大厅核对账目", place: "一楼大厅", kind: "public" }],
  publicEvents: [], objectStates: [], knowledge: [],
};

test("提示级问题必须**逐条列出来**，而不是只报一个数字（且不得触发改写）", async () => {
  // 4 条"修不掉的"占位词残留（某日/某时这类没有真值，只报不改）→ 提示级、无硬冲突
  const content = [
    "### 二、你的时间线",
    "- **某日20:00**：一层车间 — 甲。",
    "- **某日21:00**：一层车间 — 乙。",
    "- **某时22:00**：一层车间 — 丙。",
    "- **某时23:00**：一层车间 — 丁。",
  ].join("\n");
  const { result, warns } = await withWarn(() => ensureBibleAligned(deps(true), "林默", content, BIBLE, null));
  const joined = warns.join("\n");
  assert.match(joined, /提示级问题（无硬冲突），不自动改写，逐条列出/, "必须打出门槛那句话");
  assert.match(joined, /模板占位词残留/, "必须打出**类别中文名**，而不是 code");
  assert.match(joined, /某日20:00/, "必须把**问题原文**列出来");
  assert.match(joined, /证据：/, "必须带证据行");
  // 提示级不自动改写 → 内容一字不改、也没调模型（调了会抛）
  assert.strictEqual(result.rounds, 0, "不该有任何改写轮次");
  assert.strictEqual(result.content, content, "提示级不改写，内容必须原样返回");
});

test("无损清理在 `!factsText` 提前返回之前：没有权威条目的角色同样要清掉占位词", async () => {
  // 真正"没有任何权威条目"的权威表：bibleFactsFor 返回空 → 走 factsText 提前返回那条路。
  // ⚠️ 不能拿上面那份 BIBLE：它有一条 kind:"public" 的节点，而 public 节点是**发给所有人**的
  //（bibleFactsFor 的口径：e.actor === n || e.kind === "public"），根本不会提前返回。
  const EMPTY_BIBLE = { characters: ["无关角色"], places: [], victim: {}, timeline: [], publicEvents: [], objectStates: [], knowledge: [] };
  const content = [
    "### 二、你的时间线",
    "- **日期12月4日 20:10（真实）**：一层车间工具房 — 帮赵磊整理密封垫片。",
    "- **10月12日 18:50（真实18:50）**：地点一楼大厅 — 我坐在角落核对账目。",
  ].join("\n");
  const { result, warns } = await withWarn(() => ensureBibleAligned(deps(true), "无关角色", content, EMPTY_BIBLE, null));
  assert.ok(!/日期12月4日/.test(result.content), "**日期<数字> 必须被清掉");
  assert.ok(!/：地点一楼大厅/.test(result.content), "**：地点<房间名> 必须被清掉");
  assert.match(result.content, /\*\*12月4日 20:10（真实）\*\*：一层车间工具房 — 帮赵磊整理密封垫片。/, "其余文字必须逐字保留");
  assert.match(warns.join("\n"), /占位词残留：无损清理 2 处/, "必须留下清理日志（否则没人知道被改过）");
  assert.strictEqual(result.rounds, 0, "没有权威条目 → 不该有改写轮次");
});
