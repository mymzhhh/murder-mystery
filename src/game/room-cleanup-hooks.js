// 房间删除钩子 — 让"删房间"这件事只有一个入口，且各模块都能收到通知
//
// 为什么需要它：内存态的清理（AI 定时器、阶段计时器、语音房间成员……）分散在各模块的闭包里，
// 而删房间的路径有四条：断线超时、玩家主动离开、管理端删除、生命周期扫描器回收。
// 原来只有前两条会调 aiPlayer.cancelRoom()，于是"扫描器回收"和"管理端删除"会留下
// timers[roomCode] / searchCounts 这类永不释放的内存条目（每个房间泄漏一份）。
//
// 现在统一为：任何删除都走 game-manager.deleteRoom() → 触发钩子 → 各模块自行清理。

const hooks = new Set();

/** 注册一个"房间被删除"回调。回调抛异常不影响其它回调与删除流程。 */
function onRoomDeleted(fn) {
  if (typeof fn === "function") hooks.add(fn);
}

/** 触发全部回调（由 deleteRoom 调用） */
function runRoomDeleted(code) {
  if (!code) return;
  for (const fn of hooks) {
    try { fn(code); } catch (e) { /* 单个钩子失败不影响其它 */ }
  }
}

/** 仅测试用：清空已注册的钩子 */
function _resetHooks() { hooks.clear(); }

module.exports = { onRoomDeleted, runRoomDeleted, _resetHooks };
