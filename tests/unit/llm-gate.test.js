// llm-gate 的并发闸门测试
//
// 为什么必须测：这段逻辑错了的后果比"慢"严重得多 ——
//   · 并发上限失效 → 打爆 provider 触发限流 → 重试风暴
//   · 槽位泄漏（超时后不归还）→ 闸门永久卡死，之后所有 LLM 调用全部排队到超时
//   · 优先级失效 → 玩家审讯 NPC 排在后台 AI 闲聊后面，交互体验最差
// 这些都是"看起来还能跑、实际整桌卡住"的故障，必须有确定性测试钉住。
const test = require("node:test");
const assert = require("node:assert");
const gate = require("../../src/llm/llm-gate");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test.beforeEach(() => gate._reset());

test("并发上限：同时最多只跑 MAX_CONCURRENCY 个任务", async () => {
  let running = 0, peak = 0;
  const tasks = Array.from({ length: gate.MAX_CONCURRENCY * 3 }, () =>
    gate.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(30);
      running--;
      return "ok";
    }, { timeoutMs: 5000 })
  );
  const results = await Promise.all(tasks);
  assert.strictEqual(results.every(r => r.ok), true);
  assert.ok(peak <= gate.MAX_CONCURRENCY, `峰值并发 ${peak} 超过上限 ${gate.MAX_CONCURRENCY}`);
  assert.strictEqual(gate.snapshot().active, 0, "全部完成后不应残留占用中的槽位");
  assert.strictEqual(gate.snapshot().queued, 0, "队列应清空");
});

test("优先级：interactive 排在 background 前面出队", async () => {
  // 先用满并发，让后续任务只能排队
  const blockers = Array.from({ length: gate.MAX_CONCURRENCY }, () =>
    gate.run(() => sleep(80).then(() => "block"), { timeoutMs: 5000 })
  );
  await sleep(10); // 确保 blockers 已经占满槽位

  const order = [];
  // 先塞 3 个后台任务，再塞 1 个交互任务：交互任务必须插到它们前面
  const bg = Array.from({ length: 3 }, (_, i) =>
    gate.run(async () => { order.push("bg" + i); return "x"; }, { priority: "background", timeoutMs: 5000 })
  );
  const ia = gate.run(async () => { order.push("interactive"); return "x"; }, { priority: "interactive", timeoutMs: 5000 });

  await Promise.all([...blockers, ...bg, ia]);
  assert.strictEqual(order[0], "interactive", `交互任务应当第一个出队，实际顺序: ${order.join(",")}`);
});

test("超时：到点后返回 ok=false 且立刻归还槽位（不泄漏）", async () => {
  let aborted = false;
  const r = await gate.run(async (signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    await sleep(5000);
    return "太晚了";
  }, { timeoutMs: 200, label: "timeout-test" });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "timeout");
  assert.strictEqual(r.value, null);
  assert.strictEqual(aborted, true, "超时必须 abort 底层请求，否则请求还在占 provider 配额");
  // 关键：槽位必须已经归还，否则后续调用会一直排队到超时
  await sleep(50);
  assert.strictEqual(gate.snapshot().active, 0, "超时后槽位必须归还");
  const after = await gate.run(async () => "还能跑", { timeoutMs: 2000 });
  assert.strictEqual(after.ok, true, "超时之后闸门必须仍能正常工作（槽位未泄漏）");
});

test("超时覆盖排队时间：排队等到超时也算失败", async () => {
  // 占满并发并保持住
  const blockers = Array.from({ length: gate.MAX_CONCURRENCY }, () =>
    gate.run(() => sleep(400).then(() => "block"), { timeoutMs: 5000 })
  );
  await sleep(10);
  const t0 = Date.now();
  const r = await gate.run(async () => "永远排不到", { timeoutMs: 150 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "timeout");
  assert.ok(elapsed < 500, `排队超时应当在 deadline 内返回，实际 ${elapsed}ms`);
  await Promise.all(blockers);
});

test("任务返回 null 视为失败，不计入 ok", async () => {
  const r = await gate.run(async () => null, { timeoutMs: 2000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "empty");
});

test("任务抛异常不会卡住闸门，且能继续接活", async () => {
  const r = await gate.run(async () => { throw new Error("boom"); }, { timeoutMs: 2000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "error");
  assert.match(r.error.message, /boom/);
  const after = await gate.run(async () => "ok", { timeoutMs: 2000 });
  assert.strictEqual(after.ok, true);
});

test("统计口径：submitted/ok/timeout/failed 与平均耗时", async () => {
  // 用增量断言：其他用例的在途任务可能晚到并改动全局计数，
  // 断言绝对值会让测试变得脆弱（这里就踩过一次）。
  const before = gate.snapshot();
  await gate.run(async () => "a", { timeoutMs: 2000 });
  await gate.run(async () => null, { timeoutMs: 2000 });
  await gate.run(async () => { throw new Error("x"); }, { timeoutMs: 2000 });
  await gate.run(async () => { await sleep(3000); }, { timeoutMs: 100 });
  await sleep(50);
  const s = gate.snapshot();
  assert.strictEqual(s.submitted - before.submitted, 4);
  assert.strictEqual(s.ok - before.ok, 1);
  assert.strictEqual(s.failed - before.failed, 2);
  assert.strictEqual(s.timeout - before.timeout, 1);
  assert.strictEqual(s.active, 0);
  assert.ok(s.avgDurMs >= 0);
});

test("超时下限：小于 1 秒的超时不会被静默改大", async () => {
  const t0 = Date.now();
  const r = await gate.run(async () => { await sleep(2000); }, { timeoutMs: 120 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.reason, "timeout");
  assert.ok(elapsed < 600, `120ms 的超时应当很快返回，实际 ${elapsed}ms（说明下限把配置改大了）`);
});

test("等待统计：真的排队了就必须体现出来（曾因漏累加而恒为 0）", async () => {
  const before = gate.snapshot();
  // 占满并发 200ms，再排 3 个后台任务，它们必然要等
  const blockers = Array.from({ length: gate.MAX_CONCURRENCY }, () =>
    gate.run(() => sleep(200).then(() => "b"), { timeoutMs: 5000 })
  );
  await sleep(10);
  const queued = Array.from({ length: 3 }, () =>
    gate.run(async () => "ok", { timeoutMs: 5000 })
  );
  const results = await Promise.all([...blockers, ...queued]);
  assert.strictEqual(results.every(r => r.ok), true);
  const s = gate.snapshot();
  const deltaTotal = s.waitMsTotal - before.waitMsTotal;
  assert.ok(s.maxWaitMs > 50, `排队过就必须有 maxWaitMs，实际 ${s.maxWaitMs}ms（漏累加时会恒为 0）`);
  assert.ok(deltaTotal > 0, `waitMsTotal 必须累加，实际增量 ${deltaTotal}`);
  // 注意：要读 resolve 之后的结果对象，不能读 queued 里的 promise（那样 waitMs 恒为 undefined）
  const queuedResults = results.slice(-3);
  assert.ok(queuedResults.every(r => r.waitMs > 0),
    `排队任务的 waitMs 必须为正，实际 ${JSON.stringify(queuedResults.map(r => r.waitMs))}（并发上限=${gate.MAX_CONCURRENCY}）`);
});

test("等待统计：排队等到超时的任务也要计入等待", async () => {
  const before = gate.snapshot();
  const blockers = Array.from({ length: gate.MAX_CONCURRENCY }, () =>
    gate.run(() => sleep(500).then(() => "b"), { timeoutMs: 5000 })
  );
  await sleep(10);
  const r = await gate.run(async () => "排不到", { timeoutMs: 150 });
  assert.strictEqual(r.reason, "timeout");
  const s = gate.snapshot();
  assert.ok(s.maxWaitMs > 100, `排队超时的等待也要统计，实际 maxWaitMs=${s.maxWaitMs}`);
  assert.ok(s.waitMsTotal > before.waitMsTotal, "排队超时的等待也要累加");
  await Promise.all(blockers);
});

