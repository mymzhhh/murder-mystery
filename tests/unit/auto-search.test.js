// 测试房"代码搜证"的选人判据契约测试
//
// 实测教训（连续拦了两轮：报告 17 / 房间 HRM5FG 与 PF7TGY）：
// 第一版写 `p.isAI && !p.isNPC`，第二版又给 `isNPC` 加了"或"条件 —— 两版都错，
// 因为**真实记录里 AI 玩家身上 `isNPC` 也是 true**：
//   {"playerId":"ai_<房号>_<角色名>","playerName":"AI 玩家","characterName":"赵磊",
//    "isAI":true,"isNPC":true,...}
// 这个字段在本项目里的实际语义是"非真人接管"，不是"审讯 NPC"。
// 症状是代码搜证静默跳过、clueFound 停在 8/36。
//
// 所以下面的用例**直接照抄真实记录的形状**，不再靠对字段语义的猜想。
const test = require("node:test");
const assert = require("node:assert");
const { pickSearchers } = require("../../src/game/auto-search");

/** 真实记录（从 Redis 里 get 出来的原样形状，截去长字段） */
const REAL_AI = {
  playerId: "ai_PF7TGY_赵磊", playerName: "AI 玩家", characterName: "赵磊",
  isDM: false, isAI: true, isNPC: true, isAlive: true, connected: true,
};
const REAL_NPC = {
  playerId: "npc_PF7TGY_0", playerName: "NPC:老周", characterName: "老周",
  isDM: false, isNPC: true, isAlive: true, connected: true,
};
const REAL_HUMAN = {
  playerId: "u_123", playerName: "真人玩家", characterName: "林强",
  isDM: false, isAI: false, isNPC: false, isAlive: true, connected: true,
};

test("真实形状：AI 玩家身上 isNPC=true 也必须被选中（这正是当初连错两轮的地方）", () => {
  assert.deepStrictEqual(pickSearchers([REAL_AI]).map(p => p.characterName), ["赵磊"],
    "AI 玩家的 isNPC=true 是『非真人接管』的意思，不能据此排除");
});

test("审讯 NPC（npc_ 前缀）不参与认领", () => {
  assert.strictEqual(pickSearchers([REAL_NPC]).length, 0);
});

test("真人玩家不由代码代搜（他们自己点搜证）", () => {
  assert.strictEqual(pickSearchers([REAL_HUMAN]).length, 0);
});

test("测试房混合场景：4 个 AI 玩家全选、2 个审讯 NPC 排除", () => {
  const players = [
    { ...REAL_AI, playerId: "ai_X_甲", characterName: "甲" },
    { ...REAL_AI, playerId: "ai_X_乙", characterName: "乙" },
    { ...REAL_AI, playerId: "ai_X_丙", characterName: "丙" },
    { ...REAL_AI, playerId: "ai_X_丁", characterName: "丁" },
    { ...REAL_NPC, playerId: "npc_X_0", characterName: "老周" },
    { ...REAL_NPC, playerId: "npc_X_1", characterName: "老黄" },
  ];
  assert.deepStrictEqual(pickSearchers(players).map(p => p.characterName), ["甲", "乙", "丙", "丁"]);
});

test("字符串布尔与缺字段都兜住；没角色名的排除（认领要记名）", () => {
  assert.strictEqual(pickSearchers([{ playerId: "ai_X_甲", characterName: "甲", isAI: "1", isNPC: "1" }]).length, 1);
  assert.strictEqual(pickSearchers([{ playerId: "ai_X_乙", characterName: "" }]).length, 0);
  assert.deepStrictEqual(pickSearchers([]), []);
  assert.deepStrictEqual(pickSearchers(null), []);
});
