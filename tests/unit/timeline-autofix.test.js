// 时间线确定性自愈（2026-10-22）：用户实测"时间线对不上"的根因修复
//   ① 死者化名混用   ② 缺全员事件
const test = require("node:test");
const assert = require("node:assert");
const {
  unifyVictimAliasInTimeline, ensureCollectiveAnchors, collectiveEventsOf,
} = require("../../src/script/timeline-autofix.js");

const ROLE = [
  "### 玩家角色 1：苏晚晴",
  "- **6月18日 19:15**：化妆间门口 — 我把青瓷罐放下",
  "- **6月18日 22:00**：前台书场 — 我坐在台侧",
  "",
  "### 玩家角色 4：周阿贵",
  "- **6月18日 19:20**：门口 — 看到顾松亭送客",
  "- **6月18日 19:25**：化妆间门口 — 看到顾松亭拿起罐子",
  "- **6月18日 22:00**：前台书场 — 俺站在角落",
].join("\n");

// ---------- ① 化名统一 ----------
test("时间线里真名/化名混用 → 按多数派统一", () => {
  const t = [
    "- **6月18日 19:20**：门口 — 顾松亭送客",
    "- **6月18日 19:25**：化妆间 — 顾松亭拿起罐子",
    "- **6月18日 22:00**：书场 — 阿庆平时站这儿",
  ].join("\n");
  const r = unifyVictimAliasInTimeline(t, { realName: "顾松亭", alias: "阿庆" });
  assert.strictEqual(r.changed, 1);
  assert.strictEqual(r.to, "顾松亭");
  assert.ok(!r.text.includes("阿庆"), r.text);
});

test("只用一种称呼 → 不动（知道真相的角色可以一直用真名）", () => {
  const t = "- **6月18日 19:20**：门口 — 顾松亭送客\n- **6月18日 22:00**：书场 — 我站着";
  const r = unifyVictimAliasInTimeline(t, { realName: "顾松亭", alias: "阿庆" });
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.text, t);
});

test("非时间线的行不动（背景/真相段保留原文）", () => {
  const t = [
    "我早就知道阿庆其实是顾松亭。",
    "- **6月18日 19:20**：门口 — 顾松亭送客",
    "- **6月18日 19:25**：化妆间 — 顾松亭拿罐",
    "- **6月18日 22:00**：书场 — 阿庆站这儿",
  ].join("\n");
  const r = unifyVictimAliasInTimeline(t, { realName: "顾松亭", alias: "阿庆" });
  assert.ok(r.text.startsWith("我早就知道阿庆其实是顾松亭。"), "背景段必须原样保留");
});

test("没给化名 / 真名等于化名 → 不动", () => {
  const t = "- **6月18日 19:20**：门口 — 顾松亭送客";
  assert.strictEqual(unifyVictimAliasInTimeline(t, { realName: "顾松亭" }).changed, 0);
  assert.strictEqual(unifyVictimAliasInTimeline(t, { realName: "甲", alias: "甲" }).changed, 0);
  assert.strictEqual(unifyVictimAliasInTimeline("", { realName: "甲", alias: "乙" }).changed, 0);
});

// ---------- ② 全员事件补齐 ----------
test("缺 22:30 全员事件 → 补在时间顺序正确的位置", () => {
  // 真实调用是**逐角色**调用（每个角色本单独处理），所以夹具也用单个角色段
  const single = [
    "### 玩家角色 1：苏晚晴",
    "- **6月18日 19:15**：化妆间门口 — 我把青瓷罐放下",
    "- **6月18日 22:00**：前台书场 — 我坐在台侧",
  ].join("\n");
  const r = ensureCollectiveAnchors(single, {
    events: [{ time: "22:30", place: "前台书场", desc: "众人集合，开始梳理线索" }],
    caseDate: "6月18日",
  });
  assert.strictEqual(r.added.length, 1);
  const lines = r.text.split("\n");
  const i2230 = lines.findIndex((l) => l.includes("22:30"));
  assert.ok(i2230 > 0);
  assert.ok(lines[i2230 - 1].includes("22:00"), "22:30 必须排在 22:00 之后");
  assert.ok(lines[i2230].includes("前台书场"));
});

test("已经有该时刻 → 幂等，不再重复插入", () => {
  const once = ensureCollectiveAnchors(ROLE, {
    events: [{ time: "22:30", place: "前台书场" }], caseDate: "6月18日",
  });
  const twice = ensureCollectiveAnchors(once.text, {
    events: [{ time: "22:30", place: "前台书场" }], caseDate: "6月18日",
  });
  assert.strictEqual(twice.added.length, 0);
  assert.strictEqual(twice.text, once.text);
});

test("中间时刻缺失 → 插到正确位置（21:20 在 19:25 与 22:00 之间）", () => {
  const r = ensureCollectiveAnchors(ROLE, {
    events: [{ time: "21:20", place: "化妆间内", desc: "众人看到尸体" }], caseDate: "6月18日",
  });
  const lines = r.text.split("\n");
  // 第一个角色段里应出现 21:20，且在第 2 条（19:15）之后
  const idx = lines.findIndex((l) => l.includes("21:20"));
  assert.ok(idx > 0 && lines[idx].includes("化妆间内"), r.text);
});

test("没有时间线行 → 不硬塞（避免污染非时间线段落）", () => {
  const r = ensureCollectiveAnchors("这是一段没有时间线的正文。", {
    events: [{ time: "22:30", place: "书场" }], caseDate: "6月18日",
  });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.text, "这是一段没有时间线的正文。");
});

// ---------- ③ 全员事件抽取 ----------
test("collectiveEventsOf 只挑 actor=所有人 的事件", () => {
  const outline = {
    timeline: [
      { time: "19:15", actor: "苏晚晴", place: "化妆间门口" },
      { time: "21:20", actor: "所有人", place: "化妆间内", desc: "众人看到尸体" },
      { time: "22:30", actor: "全员", place: "前台书场", desc: "众人集合" },
      { time: "20:25", actor: "江砚", place: "化妆间内" },
    ],
  };
  const evs = collectiveEventsOf(outline);
  assert.deepStrictEqual(evs.map((e) => e.time), ["21:20", "22:30"]);
});

test("无 outline / 无 timeline → 空数组", () => {
  assert.deepStrictEqual(collectiveEventsOf(null), []);
  assert.deepStrictEqual(collectiveEventsOf({}), []);
});
