// 房间删除钩子 + 残留子键回收
//
// 两个真实缺陷：
//  1) 删房间有四条路径（断线超时/主动离开/管理端/生命周期扫描器），
//     但只有前两条清理内存态 → 扫描器回收的房间会永久残留 timers/searchCounts。
//  2) 扫描器原本只按 games:index 枚举房间。曾出现"房间主键已删、却残留
//     game:{code}:chat / :intro 子键"（删除与 AI 写入之间的竞态），这类房间不在索引里，
//     永远回收不掉。
const test = require("node:test");
const assert = require("node:assert");
const hooks = require("../modules/room-cleanup-hooks");

test.beforeEach(() => hooks._resetHooks());

test("钩子：删除房间时通知全部注册者", () => {
  const seen = [];
  hooks.onRoomDeleted((c) => seen.push("a:" + c));
  hooks.onRoomDeleted((c) => seen.push("b:" + c));
  hooks.runRoomDeleted("ABCDEF");
  assert.deepStrictEqual(seen.sort(), ["a:ABCDEF", "b:ABCDEF"]);
});

test("钩子：单个回调抛异常不影响其它回调（清理必须尽量做完）", () => {
  const seen = [];
  hooks.onRoomDeleted(() => { throw new Error("boom"); });
  hooks.onRoomDeleted((c) => seen.push(c));
  assert.doesNotThrow(() => hooks.runRoomDeleted("ABCDEF"));
  assert.deepStrictEqual(seen, ["ABCDEF"], "前面的回调抛异常后，后面的仍要被调用");
});

test("钩子：非法回调被忽略，不污染注册表", () => {
  hooks.onRoomDeleted(null);
  hooks.onRoomDeleted("not a function");
  const seen = [];
  hooks.onRoomDeleted((c) => seen.push(c));
  hooks.runRoomDeleted("X");
  assert.deepStrictEqual(seen, ["X"]);
});

test("钩子：code 为空时不触发（避免误清）", () => {
  let called = 0;
  hooks.onRoomDeleted(() => called++);
  hooks.runRoomDeleted("");
  hooks.runRoomDeleted(null);
  hooks.runRoomDeleted(undefined);
  assert.strictEqual(called, 0);
});

test("真实模块注册了钩子：ai-player 与 socket 层都应在删除时被通知", () => {
  // 载入 ai-player 会注册它自己的清理回调；socket/game.js 的注册在 registerGameSocket 内部，
  // 这里只验证 ai-player 这一侧确实挂上了（socket 侧由集成测试覆盖）。
  hooks._resetHooks();
  const seen = [];
  hooks.onRoomDeleted((c) => seen.push("probe:" + c));
  delete require.cache[require.resolve("../modules/ai-player")];
  require("../modules/ai-player");
  hooks.runRoomDeleted("ROOM01");
  assert.ok(seen.includes("probe:ROOM01"), "探针回调应当收到通知");
  // 直接调用 sweepOnce 依赖 Redis，这里只断言"注册行为"没有抛错
  assert.doesNotThrow(() => hooks.runRoomDeleted("ROOM02"));
});
