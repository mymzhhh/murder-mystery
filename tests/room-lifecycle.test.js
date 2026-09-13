// 房间生命周期：过期判定与配置边界
//
// 这条逻辑的真实背景：房间在 Redis 里原本没有任何时间上限，唯一的自动清理
// （断线 5 分钟后无人则删房）把定时器放在内存里，服务器一重启就全丢，
// 于是出现"9 天前创建的房间仍可重连进入"。
// 判定一旦写错两个方向都有害：过松 = 房间永久堆积；过严 = 正常进行中的对局被删掉。
const test = require("node:test");
const assert = require("node:assert");
const lifecycle = require("../modules/room-lifecycle");

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
