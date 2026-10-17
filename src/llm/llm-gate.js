// LLM 调用闸门：并发上限 + 优先级 + 硬超时
//
// 解决三个实际问题：
//  1) 没有并发上限。6 个 AI 玩家 + NPC + 多房间会同时打向 provider，一旦触发限流，
//     openai SDK 会按 maxRetries 退避重试，单次调用被放大成数倍时长。
//  2) 没有硬超时。agnes-client 原本是 timeout 90s + maxRetries 2，单次 AI 动作最坏能挂
//     约 270 秒，这期间整桌人都在等它。NPC 有 15s 保护，AI 玩家反而没有。
//  3) 没有优先级。玩家主动发起的审讯（NPC 回答 / 向 AI 玩家提问）会排在后台
//     AI 闲聊后面，交互体验最差。这里让 interactive 队列优先出队。
//
// 超时按"排队 + 执行"的总时长计算：定时器在入队时就装上，排队期间到点同样算超时
// （否则一个排在长队里的请求会一直等到轮到自己才开始计时，玩家感知就是永久卡住）。
// 到点会真正 abort 底层请求，并立即归还槽位，避免闸门被泄漏的槽位卡死。

const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.LLM_MAX_CONCURRENCY || "6", 10) || 6);
const DEFAULT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LLM_TIMEOUT_MS || "45000", 10) || 45000);

let active = 0;
/** interactive 优先于 background；同级 FIFO */
const queues = { interactive: [], background: [] };

const stats = {
  submitted: 0, ok: 0, failed: 0, timeout: 0,
  waitMsTotal: 0, durMsTotal: 0, maxWaitMs: 0, maxDurMs: 0,
  peakConcurrency: 0,
};

function takeNext() {
  if (queues.interactive.length) return queues.interactive.shift();
  if (queues.background.length) return queues.background.shift();
  return null;
}

function pump() {
  while (active < MAX_CONCURRENCY) {
    const job = takeNext();
    if (!job) return;
    runJob(job);
  }
}

function runJob(job) {
  if (job.finished) return;
  job.started = true;
  job.startedAt = Date.now();
  active++;
  stats.peakConcurrency = Math.max(stats.peakConcurrency, active);
  // 排队时长在"真正开始执行"这一刻就能确定，必须在这里累加：
  // 漏掉这一步会让 maxWaitMs/avgWaitMs 永远是 0，日志里明明在排队、
  // 统计却显示"没有排队"，排查时会被彻底带偏（作者已经踩过一次）。
  const waitMs = job.startedAt - job.enqueueAt;
  stats.waitMsTotal += waitMs;
  stats.maxWaitMs = Math.max(stats.maxWaitMs, waitMs);
  job.waitMs = waitMs;

  // 注意：deadline 定时器在入队时就已装上，这里不再重设计时器，
  // 保证"排队 + 执行"共用同一个总时限。
  const ac = new AbortController();
  job.ac = ac;

  Promise.resolve()
    .then(() => job.task(ac.signal))
    .then((value) => {
      if (job.finished) return; // 已经因超时结算过了，晚到的结果必须丢弃，否则会污染统计
      const durMs = Date.now() - job.startedAt;
      stats.durMsTotal += durMs;
      stats.maxDurMs = Math.max(stats.maxDurMs, durMs);
      if (value == null) {
        stats.failed++;
        job.settle({ ok: false, reason: "empty", value: null, waitMs: job.startedAt - job.enqueueAt, durMs });
      } else {
        stats.ok++;
        job.settle({ ok: true, reason: "ok", value, waitMs: job.startedAt - job.enqueueAt, durMs });
      }
    })
    .catch((err) => {
      if (job.finished) return;
      const durMs = Date.now() - job.startedAt;
      stats.durMsTotal += durMs;
      stats.maxDurMs = Math.max(stats.maxDurMs, durMs);
      stats.failed++;
      job.settle({ ok: false, reason: "error", error: err, value: null, waitMs: job.startedAt - job.enqueueAt, durMs });
    });
}

/**
 * 排队执行一次 LLM 调用。
 * @param {(signal: AbortSignal) => Promise<any>} task
 * @param {{priority?: "interactive"|"background", timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<{ok: boolean, value: any, reason: string, waitMs: number, durMs: number, error?: Error}>}
 */
function run(task, opts = {}) {
  const priority = opts.priority === "interactive" ? "interactive" : "background";
  // 下限只防 0/负数/NaN，不要设成 1000ms 这种"看起来合理"的值：
  // 那会把任何小于 1 秒的超时静默改大，配置失效且极难发现（作者就在这里踩过一次）。
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  stats.submitted++;

  return new Promise((resolve) => {
    const job = {
      task, resolve, priority, label: opts.label || "",
      enqueueAt: Date.now(), deadline: Date.now() + timeoutMs,
      started: false, finished: false, startedAt: 0, ac: null, timer: null,
    };

    job.settle = (result) => {
      if (job.finished) return;
      job.finished = true;
      if (job.timer) clearTimeout(job.timer);
      if (job.started) {
        active--;
      } else {
        // 还没轮到就超时了：必须从队列里摘掉，否则会占着位置被反复取出
        const q = queues[job.priority];
        const i = q.indexOf(job);
        if (i >= 0) q.splice(i, 1);
      }
      job.resolve(result);
      pump();
    };

    // 总时限定时器：入队即开始计时，覆盖"排队 + 执行"全程
    job.timer = setTimeout(() => {
      if (job.ac) { try { job.ac.abort(); } catch (e) { /* ignore */ } }
      stats.timeout++;
      const waitMs = (job.startedAt || Date.now()) - job.enqueueAt;
      // 排队等到超时（从未拿到槽位）的任务也要计入等待统计，否则"全在排队"这种情况
      // 反而显示成"没人排队"
      if (!job.started) {
        stats.waitMsTotal += waitMs;
        stats.maxWaitMs = Math.max(stats.maxWaitMs, waitMs);
      }
      job.settle({
        ok: false, reason: "timeout", value: null,
        waitMs, durMs: job.startedAt ? Date.now() - job.startedAt : 0,
      });
    }, timeoutMs);

    queues[priority].push(job);
    pump();
  });
}

/** 运行快照，供日志/诊断使用 */
function snapshot() {
  return {
    maxConcurrency: MAX_CONCURRENCY,
    active,
    queued: queues.interactive.length + queues.background.length,
    queuedInteractive: queues.interactive.length,
    queuedBackground: queues.background.length,
    ...stats,
    avgWaitMs: stats.submitted ? Math.round(stats.waitMsTotal / stats.submitted) : 0,
    avgDurMs: stats.submitted ? Math.round(stats.durMsTotal / stats.submitted) : 0,
  };
}

/** 仅用于测试：清空队列与统计 */
function _reset() {
  queues.interactive.length = 0;
  queues.background.length = 0;
  active = 0;
  Object.keys(stats).forEach(k => { stats[k] = 0; });
}

module.exports = { run, snapshot, MAX_CONCURRENCY, DEFAULT_TIMEOUT_MS, _reset };
