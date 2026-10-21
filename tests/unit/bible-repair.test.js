// 权威表矛盾的确定性修复（2026-10-20）
//
// 背景：正文明细自检原本**只报警不修**。gen-v10 一次生成就报出 7 处矛盾：
//   · 王福生 20:50 同时出现在「客栈大堂」与「账房门口」
//   · 21:10 同一件事，基准时间线写「陈桂香」、公开行踪写「沈默」
// 这些矛盾会原样传进 4 个角色本与 DM 手册，靠交叉校验+两轮修订去救（实测救不干净）。
const test = require("node:test");
const assert = require("node:assert");
const sb = require("../../src/script/story-bible.js");

function mkOutline(over) {
  return {
    title: "测试本",
    caseDate: "10月20日",
    timeline: [
      { id: "T1", time: "20:50", actor: "王福生", place: "客栈大堂", doing: "算账" },
      { id: "T2", time: "20:50", actor: "王福生", place: "账房门口", doing: "走动" },
    ],
    publicEvents: [],
    victim: { name: "死者", deathTime: "22:00" },
    ...(over || {}),
  };
}

test("同一角色同一时刻两个地点 → 保留第一条、删第二条", () => {
  const o = mkOutline();
  const bible = sb.buildBible(o);
  const r = sb.repairBibleContradictions(o, bible);
  assert.strictEqual(o.timeline.length, 1);
  assert.strictEqual(o.timeline[0].id, "T1");
  assert.ok(r.fixes.some((f) => f.code === "tl_dup_place"), r.fixes.map((f) => f.code).join(","));
});

test("公开行踪与基准时间线地点冲突 → 删公开行踪那条", () => {
  const o = mkOutline({
    timeline: [{ id: "T1", time: "20:50", actor: "王福生", place: "客栈大堂", doing: "算账" }],
    publicEvents: [{ id: "P1", time: "20:50", actor: "王福生", place: "账房门口", doing: "走动" }],
  });
  const bible = sb.buildBible(o);
  const r = sb.repairBibleContradictions(o, bible);
  assert.strictEqual(o.publicEvents.length, 0);
  assert.ok(r.fixes.some((f) => f.code === "pe_conflict"));
});

test("同一时刻同一地点被不同角色认领 → 以基准时间线为准", () => {
  const o = mkOutline({
    timeline: [{ id: "T1", time: "21:10", actor: "陈桂香", place: "客栈走廊", doing: "看到沈默" }],
    publicEvents: [{ id: "P1", time: "21:10", actor: "沈默", place: "客栈走廊", doing: "拿钥匙" }],
  });
  const bible = sb.buildBible(o);
  const r = sb.repairBibleContradictions(o, bible);
  assert.strictEqual(o.publicEvents.length, 0);
  assert.ok(r.fixes.some((f) => f.code === "pe_other_actor"), r.fixes.map((f) => f.code).join(","));
});

test("死者死亡后仍有动作 → 删除该条", () => {
  const o = mkOutline({
    timeline: [
      { id: "T1", time: "21:00", actor: "死者", place: "大堂", doing: "招呼客人" },
      { id: "T2", time: "22:30", actor: "死者", place: "库房", doing: "清点货物" },
    ],
    publicEvents: [],
  });
  const bible = sb.buildBible(o);
  const r = sb.repairBibleContradictions(o, bible);
  assert.strictEqual(o.timeline.length, 1);
  assert.strictEqual(o.timeline[0].id, "T1");
  assert.ok(r.fixes.some((f) => f.code === "victim_after_death"));
});

test("没有矛盾时 → 一条都不删、fixes 为空", () => {
  const o = mkOutline({
    timeline: [
      { id: "T1", time: "20:50", actor: "王福生", place: "客栈大堂", doing: "算账" },
      { id: "T2", time: "21:10", actor: "沈默", place: "账房", doing: "对账" },
    ],
    publicEvents: [{ id: "P1", time: "21:10", actor: "沈默", place: "账房", doing: "对账" }],
  });
  const before = JSON.stringify(o);
  const bible = sb.buildBible(o);
  const r = sb.repairBibleContradictions(o, bible);
  assert.strictEqual(r.fixes.length, 0, `不该有修复，实际：${r.fixes.map((f) => f.text).join(" | ")}`);
  assert.strictEqual(o.timeline.length, 2);
  assert.strictEqual(o.publicEvents.length, 1);
  assert.strictEqual(JSON.stringify(o), before, "无矛盾时不应改动任何数据");
});

test("空输入安全", () => {
  assert.deepStrictEqual(sb.repairBibleContradictions(null, null).fixes, []);
  const o = {};
  const r = sb.repairBibleContradictions(o, { victim: {} });
  assert.strictEqual(r.fixes.length, 0);
});
