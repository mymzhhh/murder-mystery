// "搜证 : 发言"配比（AI 回合分配）契约测试
//
// 背景（实测报告 15 / 房间 5PFT2F）：四个 AI 的 search 是 6/10/8/10，而 speak **全是 0**
// —— "搜证与讨论"阶段里讨论一次都没发生。成因是 actTurn「先搜证，搜到就 return」
// 加上 actInvestigate 的自我续搜，一个 AI 能把整轮的全部回合都烧在搜证上。
//
// 为什么不能靠"限制搜证总次数"解决：配额代码里踩过 —— 曾设 3 次/轮，
// 实测 42 条线索只翻出 6 条，推理没有证据、整局走不通。
// 所以这里只调**配比**（每 1 次发言允许 N 次搜证），总容量不动。
const test = require("node:test");
const assert = require("node:assert");
const { searchWanted, SEARCH_PER_TALK } = require("../../src/game/ai-player");
const { mixKey, MIX_KINDS } = require("../../src/game/ai-observability");

test("配比判据：起始先搜证（搜证仍是主要动作，符合『先搜证再讨论』）", () => {
  assert.strictEqual(searchWanted({ search: 0, talk: 0 }, 2), true, "0 搜 0 说 → 先搜证");
  assert.strictEqual(searchWanted(null, 2), true, "还没记录 → 先搜证");
});

test("配比 2：每 2 次搜证夹 1 次发言（5 个回合 = 3 搜证 + 2 发言，原来 5 个回合全是搜证）", () => {
  const mix = { search: 0, talk: 0 };
  const seq = [];
  for (let i = 0; i < 5; i++) {
    const s = searchWanted(mix, 2);
    seq.push(s ? "search" : "talk");
    if (s) mix.search++; else mix.talk++;
  }
  assert.deepStrictEqual(seq, ["search", "talk", "search", "search", "talk"], "5 手的序列");
  assert.deepStrictEqual(mix, { search: 3, talk: 2 }, "5 手之后：3 搜证 + 2 发言");
});

test("配比 1：严格交替；发言次数永远不会被搜证甩开（讨论不可能为 0）", () => {
  const mix = { search: 0, talk: 0 };
  for (let i = 0; i < 8; i++) {
    const s = searchWanted(mix, 1);
    if (s) mix.search++; else mix.talk++;
  }
  assert.strictEqual(mix.search, 4);
  assert.strictEqual(mix.talk, 4);
});

test("配比是**每轮**独立的：第 2 轮重新从『先搜证』开始（否则第 1 轮搜多了第 2 轮就再也不搜）", () => {
  // 上一轮结束时搜证远多于发言；换成新一轮的键，计数清零
  const round1 = { search: 9, talk: 1 };
  assert.strictEqual(searchWanted(round1, 2), false, "同一轮内：9 搜 1 说 → 该说话了");
  const round2 = { search: 0, talk: 0 };   // 新一轮从零开始
  assert.strictEqual(searchWanted(round2, 2), true, "新一轮：0 搜 0 说 → 又能搜证了");
  assert.notStrictEqual(mixKey("ABC123", 1), mixKey("ABC123", 2), "配比键必须按轮分开");
});

test("默认配比是 2（可用 AI_SEARCH_PER_TALK 覆盖）", () => {
  assert.ok(SEARCH_PER_TALK >= 1, "配比至少 1");
  assert.deepStrictEqual(MIX_KINDS, ["search", "talk"]);
});
