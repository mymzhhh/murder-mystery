// DM 上帝时间线补主语（2026-10-20 用户反馈）
//
// 用户贴出的原文是这样的：
//   19:30 拿着煤油灯进入密室，从内部锁上铜锁，开始盘点当物
//   19:30 坐到账桌前，开始核对当月的当物流水账
//   —— 只有时刻和动作，**没有主语**。下游写角色本/线索时只能猜是谁做的，
//   幻觉（同一时刻两人做同一件事、角色写出不属于自己的动作）就是从这里来的。
//
// 修法：用权威时间线做确定性回填 —— 时刻唯一确定、或用地点/动作消歧后才补，否则不动。
const test = require("node:test");
const assert = require("node:assert");
const sb = require("../../src/script/story-bible.js");

function bibleOf(timeline) {
  const o = {
    caseDate: "10月20日",
    timeline,
    publicEvents: [],
    victim: { name: "王贵", deathTime: "22:00" },
  };
  return sb.buildBible(o);
}

const TL = [
  { id: "T1", time: "19:30", actor: "林默", place: "账房", doing: "核对当月当物流水账" },
  { id: "T2", time: "19:30", actor: "赵福", place: "朝奉室", doing: "整理当天收的当物，登记品相" },
  { id: "T3", time: "19:40", actor: "苏晓", place: "后院", doing: "倒垃圾" },
];

test("时刻唯一时直接补主语", () => {
  const b = bibleOf(TL);
  const r = sb.repairGodTimeline("- 19:40 把垃圾倒到后院的垃圾堆里", b);
  assert.strictEqual(r.fixed.length, 1);
  assert.ok(r.text.includes("19:40 苏晓"), r.text);
});

test("同一时刻多人时，用地点消歧", () => {
  const b = bibleOf(TL);
  const r = sb.repairGodTimeline("- 19:30 坐到朝奉桌前，整理当天收的当物", b);
  assert.strictEqual(r.fixed.length, 1);
  assert.ok(r.text.includes("赵福"), r.text);
});

test("同一时刻多人、地点也对不上时，用动作文本消歧", () => {
  const b = bibleOf(TL);
  const r = sb.repairGodTimeline("- 19:30 坐到账桌前，开始核对当月的当物流水账", b);
  assert.strictEqual(r.fixed.length, 1);
  assert.ok(r.text.includes("林默"), r.text);
});

test("已有主语的条目不重复加", () => {
  const b = bibleOf(TL);
  const src = "- 19:40 苏晓 把垃圾倒到后院";
  const r = sb.repairGodTimeline(src, b);
  assert.strictEqual(r.fixed.length, 0);
  assert.strictEqual(r.text, src);
});

test("无法唯一确定时保持原样（宁可留空也不猜错主语）", () => {
  const b = bibleOf(TL);
  const src = "- 19:30 有人在走廊里走动";   // 两人都可能，动作也不匹配
  const r = sb.repairGodTimeline(src, b);
  assert.strictEqual(r.fixed.length, 0);
  assert.strictEqual(r.text, src);
});

test("没有该时刻的权威条目时不动", () => {
  const b = bibleOf(TL);
  const r = sb.repairGodTimeline("- 23:59 关门", b);
  assert.strictEqual(r.fixed.length, 0);
});

test("空输入安全", () => {
  assert.strictEqual(sb.repairGodTimeline("", bibleOf(TL)).fixed.length, 0);
  assert.strictEqual(sb.repairGodTimeline("- 19:40 倒垃圾", null).fixed.length, 0);
});
