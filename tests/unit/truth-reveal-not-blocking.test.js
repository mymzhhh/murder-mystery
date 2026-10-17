// 单元测试：真相阶段**不许等 LLM 叙述**（阻塞路径必须消失）。
//
// 背景（2026-10-17 实测）：旧实现 `narrative = await generateTruthReveal(...)`（最长 20s 超时）
// 之后才 updateRoom + 广播，于是房间在投完票后**停在 voting 长达 20 秒**：
// 这期间玩家刷新看到的还是投票页，只能重按"提交并查看真相"。
// 上方注释早就写明"真相叙述是可选装饰，绝不能让它的失败挡住阶段推进"，
// 但那次只加了 try/catch —— await 仍在阻塞路径上。
//
// 本测试用**永不 resolve** 的假 generateTruthReveal 来钉死这一点：
//   · 修好的实现：立刻翻阶段 + 广播（测试 1 秒内就通过）；
//   · 旧实现：会挂在这个 await 上，测试超时失败。
// 这比"看最终有没有到 truth_reveal"强 —— 旧代码最终也会到，只是晚 20 秒。
//
// 用 mock 而不是真 Redis/PG：与 auth.test.js、script-images-db.test.js 同一路子，
// 跑 npm test 不该依赖本机是否起着 Redis/PostgreSQL。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---- 假依赖：注意 request 字符串必须与 ai-dm.js 里写的 require 参数逐字一致 ----
let roomPhase = "voting";
const updated = [];

const stubs = {
  "../game/game-manager": {
    getRoom: async () => ({ phase: roomPhase, murdererName: "占卜师" }),
    updateRoom: async (_code, patch) => { if (patch && patch.phase) roomPhase = patch.phase; updated.push(patch || {}); },
    getVotes: async () => ({ 占卜师: "占卜师" }),
    clearVotes: async () => {},
    getPlayers: async () => [{ playerName: "ai1", isNPC: true }],
    getRedis: async () => ({ del: async () => 1 }),
  },
  "../game/game-engine": {
    getPhaseConfig: () => ({ label: "真相复盘", allowClueReq: false }),
    getNextPhase: () => "truth_reveal",
    tallyVotes: () => ({ 占卜师: 1 }),
    determineOutcome: () => ({ outcome: "true_accusation", description: "玩家指认成功" }),
  },
  "../game/dm-agent": {
    generatePhaseNarrative: async () => "",
    // ★ 关键：永不 resolve。修好的实现不会等它；旧实现会挂在这里。
    generateTruthReveal: () => new Promise(() => {}),
    fallbackTruthReveal: () => "【真相复盘】玩家成功指认真凶。\n\n根据DM手册记录：\n真凶是占卜师。",
  },
  "../game/ai-player": { voteForAllPending: async () => 2 },
};

const origLoad = Module._load;
Module._load = function (request /* , parent, isMain */) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};

const { autoAdvancePhase } = require("../../src/socket/ai-dm");

/** 假装是 socket.io 的 io */
function fakeIo(sink) {
  return { to: () => ({ emit: (ev, payload) => sink.push([ev, payload]) }) };
}

test("真相阶段：LLM 叙述永不返回时也必须立刻翻阶段并广播（不得 await 它）", async () => {
  roomPhase = "voting";
  updated.length = 0;
  const emitted = [];
  const p = autoAdvancePhase(fakeIo(emitted), "ABC123", {}, null);

  // 1 秒的宽容窗口：修好的实现应当几乎立刻返回；旧实现会挂在那个 await 上
  const settled = await Promise.race([
    p.then(() => true).catch(() => true),
    new Promise((r) => setTimeout(() => r(false), 1000)),
  ]);
  assert.strictEqual(settled, true, "autoAdvancePhase 不得等待 LLM 叙述 —— 旧实现会在这里挂住（超时）");

  assert.strictEqual(roomPhase, "truth_reveal", "阶段必须已经翻到 truth_reveal");

  const tr = emitted.find((e) => e[0] === "truth_revealed");
  assert.ok(tr, "必须已经广播 truth_revealed（玩家端据此切到真相页）");
  assert.strictEqual(tr[1].phase, "truth_reveal");
  assert.ok(typeof tr[1].narrative === "string" && tr[1].narrative.includes("真相复盘"),
    "广播里必须带**同步可得**的兜底叙述，不能是空字符串（否则玩家先看到一个空白真相页）");

  const finishPatch = updated.find((u) => u.status === "finished");
  assert.ok(finishPatch, "必须标记 status=finished");
  assert.ok(typeof finishPatch.aiNarrative === "string" && finishPatch.aiNarrative.includes("真相复盘"),
    "落库的 aiNarrative 也要先用兜底文本，不能等 LLM");
});

test("真相阶段：不得发 phase_changed（会被前端 renderGame 覆盖真相数据）", async () => {
  roomPhase = "voting";
  const emitted = [];
  await autoAdvancePhase(fakeIo(emitted), "ABC124", {}, null);
  assert.ok(!emitted.some((e) => e[0] === "phase_changed"), "真相阶段只发 truth_revealed");
  assert.ok(emitted.some((e) => e[0] === "truth_revealed"));
});
