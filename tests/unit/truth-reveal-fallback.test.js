// 单元测试：真相复盘的**同步兜底**（不调 LLM 的那一份）。
//
// 为什么需要它（2026-10-17 实测）：阶段推进要求"先翻阶段、立刻广播"，那一刻不能等 LLM；
// 但广播 payload 里得有可用文本。于是把兜底抽成 fallbackTruthReveal，由
// autoAdvancePhase 立即使用、generateTruthReveal 超时/失败时也复用它。
// 本测试钉三件事：四种结局各自的措辞、DM 手册节选、以及"没有手册时也必须给出可读文本"。
const test = require("node:test");
const assert = require("node:assert");
const { fallbackTruthReveal } = require("../../src/game/dm-agent");

const SCRIPT = { dmGuide: { truthReveal: "真凶是占卜师。他用右胸那一枪击中了卡门的心脏。" } };

test("四种结局各有对应措辞（不需要调 LLM 就能拿到）", () => {
  const cases = {
    true_accusation: "玩家成功指认真凶",
    wrong_accusation: "玩家指认错误，真凶逍遥法外",
    tie: "票数平局，凶手趁乱逃脱",
    no_votes: "无人投票",
  };
  for (const [outcome, text] of Object.entries(cases)) {
    const s = fallbackTruthReveal(SCRIPT, { outcome });
    assert.ok(s.includes(text), `结局 ${outcome} 应出现「${text}」，实际：${s.slice(0, 60)}`);
    assert.ok(s.startsWith("【真相复盘】"), "必须带可识别的标题，前端据此展示");
  }
});

test("未知/缺失结局退回「游戏结束」，不抛错", () => {
  for (const o of [{ outcome: "something_new" }, {}, null, undefined]) {
    const s = fallbackTruthReveal(SCRIPT, o);
    assert.ok(s.includes("游戏结束"), `应退回「游戏结束」，实际：${s.slice(0, 60)}`);
  }
});

test("带上 DM 手册的真相节选（玩家立刻能读到内容，不是空壳）", () => {
  const s = fallbackTruthReveal(SCRIPT, { outcome: "true_accusation" });
  assert.ok(s.includes("占卜师"), "必须包含手册里的真凶信息");
  assert.ok(s.includes("根据DM手册记录"), "节选要有出处，别让人以为是 DM 现编的");
});

test("DM 手册过长时截断到 1200 字（同步路径不能塞进整本手册）", () => {
  const long = { dmGuide: { truthReveal: "甲".repeat(5000) } };
  const s = fallbackTruthReveal(long, { outcome: "tie" });
  assert.ok(s.length < 1400, `应截断，实际长度 ${s.length}`);
});

test("没有 DM 手册 / 结构缺失时也要给出可读文本，而不是空白或抛错", () => {
  for (const s of [undefined, null, {}, { dmGuide: {} }, { dmGuide: { truthReveal: "   " } }]) {
    const out = fallbackTruthReveal(s, { outcome: "no_votes" });
    assert.ok(out.includes("无人投票"));
    assert.ok(out.includes("（DM手册暂无真相记录）"), `应明确说明没有手册记录，实际：${out.slice(0, 80)}`);
  }
});
