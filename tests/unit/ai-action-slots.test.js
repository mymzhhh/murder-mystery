// AI 动作错峰（时间片预约）测试
//
// 背景：AI 之间的互相问答原本各自算一个随机延迟，导致同一批 AI 的回答几乎同时入队。
// LLM 闸门的 deadline 是"排队 + 执行"共用一个时限（replyToQuestion 为 25 秒），
// 队列一积压，排在后面的任务就被直接摘掉、返回 null ——
// 而 actReplyToQuestion 拿到 null 就 return 沉默，玩家看到的就是"有的 AI 被点名却不回答"。
//
// 时间片预约从源头避免积压：同类动作之间至少隔开 gapMs。
// 这里钉住它的三条性质：不早于下界、彼此错开、状态被正确推进。
const test = require("node:test");
const assert = require("node:assert");

const { reserveSlot } = require("../../src/game/ai-player");

test("首个动作只受 baseMs 约束", () => {
  const state = {};
  const d = reserveSlot(state, "reply", 1000, 2000, 5000);
  assert.strictEqual(d, 2000, "没有前序动作时应恰好延迟 baseMs");
});

test("后续同类动作被推到前一个之后 gapMs", () => {
  const state = {};
  const now = 1000;
  assert.strictEqual(reserveSlot(state, "reply", now, 2000, 5000), 2000);  // 排在 3000
  assert.strictEqual(reserveSlot(state, "reply", now, 2000, 5000), 7000);  // 排在 8000
  assert.strictEqual(reserveSlot(state, "reply", now, 2000, 5000), 12000); // 排在 13000
});

test("一批同时触发的回答会被均匀错开，而不是挤在一起", () => {
  const state = {};
  const now = 5000;
  const delays = [0, 1, 2, 3].map(() => reserveSlot(state, "reply", now, 1000, 5000));
  // 关键性质：相邻两次的实际时刻差 ≥ gapMs
  for (let i = 1; i < delays.length; i++) {
    const gap = (now + delays[i]) - (now + delays[i - 1]);
    assert.ok(gap >= 5000, `第 ${i} 个与第 ${i - 1} 个的间隔应 ≥ 5000ms，实际 ${gap}`);
  }
  // 且确实是递增的（后触发的不会插到前面）
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] > delays[i - 1], "后预约的必须排在更后面");
  }
});

test("不同类别互不影响（提问与回答各有各的时间轴）", () => {
  const state = {};
  const now = 0;
  const ask1 = reserveSlot(state, "ask", now, 1000, 7000);
  const reply1 = reserveSlot(state, "reply", now, 2000, 5000);
  assert.strictEqual(ask1, 1000);
  assert.strictEqual(reply1, 2000, "reply 不应被 ask 的预约顶到后面");
});

test("baseMs 大于前序空档时取 baseMs（预约不会把动作提前）", () => {
  const state = {};
  const now = 0;
  reserveSlot(state, "reply", now, 1000, 5000);   // 占用到 6000
  // 很久以后才再触发：此时 now + base 已经超过 6000，应取 now + base
  const d = reserveSlot(state, "reply", 100000, 3000, 5000);
  assert.strictEqual(d, 3000, "间隔早已过去，不应再被历史预约拖延");
});

test("状态被推进：连续预约的基准时刻单调递增", () => {
  const state = {};
  const now = 0;
  reserveSlot(state, "reply", now, 1000, 5000);
  const first = state.reply;
  reserveSlot(state, "reply", now, 1000, 5000);
  assert.ok(state.reply > first, "预约表必须向前推进，否则错峰会失效");
  assert.strictEqual(state.reply, first + 5000);
});

test("空状态对象不会被污染出多余字段", () => {
  const state = {};
  reserveSlot(state, "reply", 0, 1000, 1000);
  assert.deepStrictEqual(Object.keys(state), ["reply"]);
});
