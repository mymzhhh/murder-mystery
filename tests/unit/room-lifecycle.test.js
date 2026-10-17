// 房间生命周期：过期判定与配置边界
//
// 这条逻辑的真实背景：房间在 Redis 里原本没有任何时间上限，唯一的自动清理
// （断线 5 分钟后无人则删房）把定时器放在内存里，服务器一重启就全丢，
// 于是出现"9 天前创建的房间仍可重连进入"。
// 判定一旦写错两个方向都有害：过松 = 房间永久堆积；过严 = 正常进行中的对局被删掉。
const test = require("node:test");
const assert = require("node:assert");
const lifecycle = require("../../src/game/room-lifecycle");

const HOUR = 3600 * 1000;

test("超过最大存活时间判为过期", () => {
  const now = Date.now();
  const old = { roomCode: "AAAAAA", createdAt: now - lifecycle.MAX_LIFETIME_MS - 1000 };
  const fresh = { roomCode: "BBBBBB", createdAt: now - 1000 };
  assert.strictEqual(lifecycle.isRoomExpired(old, now), true);
  assert.strictEqual(lifecycle.isRoomExpired(fresh, now), false);
});

test("刚好到边界不算过期（避免临界点抖动）", () => {
  const now = Date.now();
  assert.strictEqual(lifecycle.isRoomExpired({ createdAt: now - lifecycle.MAX_LIFETIME_MS }, now), false);
  assert.strictEqual(lifecycle.isRoomExpired({ createdAt: now - lifecycle.MAX_LIFETIME_MS - 1 }, now), true);
});

test("createdAt 缺失时不过期（不误杀老数据）", () => {
  const now = Date.now();
  assert.strictEqual(lifecycle.isRoomExpired({ roomCode: "X" }, now), false);
  assert.strictEqual(lifecycle.isRoomExpired({ roomCode: "X", createdAt: "" }, now), false);
  assert.strictEqual(lifecycle.isRoomExpired({ roomCode: "X", createdAt: "abc" }, now), false);
});

test("null / undefined 房间视为过期（调用方据此当「不存在」处理）", () => {
  assert.strictEqual(lifecycle.isRoomExpired(null), true);
  assert.strictEqual(lifecycle.isRoomExpired(undefined), true);
});

test("createdAt 是字符串数字时也能正确比较（Redis 返回的都是字符串）", () => {
  const now = Date.now();
  const oldStr = { roomCode: "S", createdAt: String(now - lifecycle.MAX_LIFETIME_MS - 5000) };
  const freshStr = { roomCode: "S", createdAt: String(now - 5000) };
  assert.strictEqual(lifecycle.isRoomExpired(oldStr, now), true, "Redis 的字符串时间戳必须被正确解析");
  assert.strictEqual(lifecycle.isRoomExpired(freshStr, now), false);
});

test("默认值合理：最长存活 6 小时、无人回收 30 分钟、扫描间隔 10 分钟", () => {
  // 默认 6 小时足够覆盖一局剧本杀（1~3 小时），又不会让房间过夜堆积
  assert.strictEqual(lifecycle.MAX_LIFETIME_HOURS, 6);
  assert.strictEqual(lifecycle.MAX_LIFETIME_MS, 6 * HOUR);
  assert.strictEqual(lifecycle.ABANDONED_MS, 30 * 60 * 1000);
  assert.strictEqual(lifecycle.SWEEP_INTERVAL_MS, 10 * 60 * 1000);
});

test("无人回收阈值必须小于最大存活时间（否则第二条规则永远不会生效）", () => {
  assert.ok(lifecycle.ABANDONED_MS < lifecycle.MAX_LIFETIME_MS,
    `无人回收(${lifecycle.ABANDONED_MS}) 应小于最大存活(${lifecycle.MAX_LIFETIME_MS})`);
});

test("expiryText 给人看的文案非空且含单位", () => {
  const t = lifecycle.expiryText();
  assert.ok(typeof t === "string" && t.length > 0);
  assert.match(t, /小时|分钟/);
});

// ==================== 无人回收：规则本身 + 测试房例外 ====================
//
// 背景（实测复现的真 bug）：测试房里**一个真人玩家都没有**（管理员是旁观者，不是玩家），
// 于是"没有真人连着就回收"这条规则必然命中它。压缩节奏（4 分钟/阶段、一局约 13 分钟）
// 跑不到 30 分钟，所以一直没暴露；但按**真实节奏**测（10 分钟/阶段）一局 30 分钟以上，
// 正好被扫描器删掉 —— 而那恰恰是管理员最需要的那种测试。
// 复现证据：造测试房 → createdAt 改到 40 分钟前 → 真跑 sweepOnce()
//   → { abandoned: 1, freedKeys: 57 }，房间被删。
const MIN = 60 * 1000;
const oldRoom = (extra = {}) => ({ roomCode: "TEST01", createdAt: Date.now() - 40 * MIN, ...extra });

test("测试房不因「没有真人连着」被回收（管理员是旁观者，不是玩家）", () => {
  const r = lifecycle.abandonedReason(oldRoom({ testRun: "true" }), { playerCount: 6, hasHuman: false });
  assert.strictEqual(r, null, "测试房必须豁免，否则按真实节奏测试时会被中途删房");
});

test("testRun 是布尔 true 还是字符串 'true' 都要认（Redis hgetall 返回字符串）", () => {
  assert.strictEqual(lifecycle.isTestRoom({ testRun: "true" }), true);
  assert.strictEqual(lifecycle.isTestRoom({ testRun: true }), true);
  assert.strictEqual(lifecycle.isTestRoom({ testRun: "false" }), false);
  assert.strictEqual(lifecycle.isTestRoom({}), false);
  assert.strictEqual(lifecycle.abandonedReason(oldRoom({ testRun: true }), { playerCount: 6, hasHuman: false }), null);
});

test("普通房间：没有玩家记录 → no-players（原规则 4 不变）", () => {
  assert.strictEqual(lifecycle.abandonedReason(oldRoom(), { playerCount: 0, hasHuman: false }), "no-players");
});

test("普通房间：有玩家记录但没真人连着 → no-humans（原规则 5 不变）", () => {
  assert.strictEqual(lifecycle.abandonedReason(oldRoom(), { playerCount: 3, hasHuman: false }), "no-humans");
});

test("普通房间：有真人连着就不回收", () => {
  assert.strictEqual(lifecycle.abandonedReason(oldRoom(), { playerCount: 3, hasHuman: true }), null);
});

test("没到无人回收时限就不回收（测试房与否都一样）", () => {
  const fresh = { roomCode: "NEW001", createdAt: Date.now() - 5 * MIN };
  assert.strictEqual(lifecycle.abandonedReason(fresh, { playerCount: 0, hasHuman: false }), null);
  assert.strictEqual(lifecycle.abandonedReason({ roomCode: "X" }, { playerCount: 0, hasHuman: false }), null, "缺 createdAt 不回收（不误杀老数据）");
});