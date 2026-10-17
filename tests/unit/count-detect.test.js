// 需求解析：人数与模式
//
// 回归背景（本会话端到端实测）：需求写「4名玩家 + 1名NPC」时，
//   1) detectPlayerCount 不认分类词「名」→ 返回 0 → 上层静默退回人数上限 6；
//   2) detectNpcCount 当时不存在，NPC 数一律由 isPVE 决定；
//   3) detectPVE 只要正文出现「NPC」就算 PVE（而 PVP 本里 NPC 是目击者/关系人）。
// 三者叠加 → 用户要「4名玩家 + 1名NPC」拿到「6名玩家 + 2名NPC（PVE）」，且全程没有任何提示。
// 这组用例就是为防止它复发。
const test = require("node:test");
const assert = require("node:assert");
const { detectPlayerCount, detectNpcCount, detectPVE } = require("../../src/script/script-writer");

const REAL_INPUT = "1935年上海，一家老牌绸缎庄的账房先生在库房被杀，死因是被铜镇纸击中后脑。要一个以两本流水账被人对调、让众人记错库房开门时间的诡计，4名玩家 + 1名NPC，各怀秘密，结尾有反转。";

test("detectPlayerCount：这次真实踩坑的需求必须解析出 4（不认「名」是根因）", () => {
  assert.strictEqual(detectPlayerCount(REAL_INPUT), 4);
});

test("detectPlayerCount：各种常见写法都要认", () => {
  assert.strictEqual(detectPlayerCount("4名玩家"), 4);
  assert.strictEqual(detectPlayerCount("4位玩家"), 4);
  assert.strictEqual(detectPlayerCount("4个玩家"), 4);
  assert.strictEqual(detectPlayerCount("4玩家"), 4);
  assert.strictEqual(detectPlayerCount("4人本"), 4);
  assert.strictEqual(detectPlayerCount("六名玩家"), 6);
  assert.strictEqual(detectPlayerCount("两人本"), 2);
  assert.strictEqual(detectPlayerCount("10名玩家"), 10);
});

test("detectPlayerCount：不能把 NPC 数、年代、人数以外的数字算成玩家数", () => {
  assert.strictEqual(detectPlayerCount("1名NPC"), 0, "NPC 不是玩家");
  assert.strictEqual(detectPlayerCount("1935年上海，一桩凶案"), 0, "年代不能被当成人数");
  assert.strictEqual(detectPlayerCount("3个嫌疑人"), 0, "嫌疑人不是玩家");
  assert.strictEqual(detectPlayerCount("要一个诡计，结尾有反转"), 0);
});

test("detectNpcCount：需求里明确写了 NPC 数就要读出来", () => {
  assert.strictEqual(detectNpcCount(REAL_INPUT), 1);
  assert.strictEqual(detectNpcCount("4名玩家 + 3NPC"), 3);
  assert.strictEqual(detectNpcCount("6名玩家 + 3名NPC"), 3);
  assert.strictEqual(detectNpcCount("两名NPC"), 2);
  assert.strictEqual(detectNpcCount("4名玩家，纯PVP"), null, "没写 NPC 数时返回 null（由模式决定）");
});

test("detectPVE：提到 NPC 不等于 PVE（PVP 本里 NPC 就是目击者）", () => {
  assert.strictEqual(detectPVE(REAL_INPUT), false, "「4名玩家 + 1名NPC」是 PVP，不是 PVE");
  assert.strictEqual(detectPVE("4名玩家 + 3NPC 的目击者关系人模式"), false);
  assert.strictEqual(detectPVE("单人侦探本，玩家扮演侦探审问嫌疑人"), true);
  assert.strictEqual(detectPVE("PVE 模式"), true);
  assert.strictEqual(detectPVE("PVP 玩家互疑"), false);
});
