// 投票候选判定：回归"整局卡死"那一次（房间 BM4AFM）。
//
// 现象：投票页只有自己那一张卡，而自己不可自投 → 一个可点项都没有，玩家一票投不出。
// 根因：判据把 PVP 下的所有 isNPC 一律滤掉，而 **AI 补位的也是 isNPC: true**：
//       players.filter(p => p.characterName && !(gameMode === "PVP" && p.isNPC))
// 服务端口径（src/socket/game.js 的 cast_vote）是：真人角色 + AI 补位角色 +（非 PVP 时）审讯 NPC。
//
// 下面第一个用例用的就是该房间从 Redis 里读出的**真实玩家数据形态**，
// 不是构造出来的理想数据——这是它作为回归测试的价值所在。
import test from "node:test";
import assert from "node:assert";
import { votablePlayers, canVoteFor } from "../../frontend/src/lib/vote.mjs";

/** 房间 BM4AFM 的真实玩家列表（1 真人 + 5 AI 补位 + 1 审讯 NPC） */
const ROOM_BM4AFM = [
  { playerName: "AI 玩家", characterName: "顾一鸣", isNPC: true, isAI: true },
  { playerName: "AI 玩家", characterName: "苏曼", isNPC: true, isAI: true },
  { playerName: "NPC:赵德海", characterName: "赵德海", isNPC: true, isAI: false },
  { playerName: "AI 玩家", characterName: "郑秋萍", isNPC: true, isAI: true },
  { playerName: "AI 玩家", characterName: "沈翊", isNPC: true, isAI: true },
  { playerName: "AI 玩家", characterName: "程雪", isNPC: true, isAI: true },
  { playerName: "mymz", characterName: "林小满", isNPC: undefined, isAI: undefined },
];

test("回归（BM4AFM）：PVP 下 AI 补位角色必须可投，否则只剩自己→整局卡死", () => {
  const list = votablePlayers(ROOM_BM4AFM, "PVP");
  const names = list.map((p) => p.characterName);
  assert.ok(names.includes("顾一鸣") && names.includes("苏曼") && names.includes("郑秋萍")
    && names.includes("沈翊") && names.includes("程雪"), `5 个 AI 补位角色都要可投，实际：${names.join("、")}`);
  assert.deepEqual(names.sort(), ["沈翊", "程雪", "苏曼", "郑秋萍", "顾一鸣", "林小满"].sort(),
    "可投项 = 1 真人 + 5 AI");
  // 关键：除自己以外必须还有可投对象（原缺陷下这里只剩自己一个）
  const others = list.filter((p) => canVoteFor(p.characterName, "林小满"));
  assert.ok(others.length >= 1, `除自己外必须有可投对象，实际 ${others.length} 个`);
});

test("PVP：非 AI 的审讯 NPC（目击者/关系人）不进投票", () => {
  const names = votablePlayers(ROOM_BM4AFM, "PVP").map((p) => p.characterName);
  assert.ok(!names.includes("赵德海"), "PVP 下 NPC 是目击者，不是嫌疑人");
});

test("PVE：审讯 NPC 进投票（侦探要从 NPC 里找出真凶）", () => {
  const names = votablePlayers(ROOM_BM4AFM, "PVE").map((p) => p.characterName);
  assert.ok(names.includes("赵德海"), "PVE 下 NPC 就是嫌疑人，必须可投");
  assert.ok(names.includes("顾一鸣"), "AI 补位角色在 PVE 下同样可投");
});

test("没分到角色的玩家不能当被投对象", () => {
  const players = [
    { playerName: "u1", characterName: "", isNPC: false },
    { playerName: "u2", characterName: null, isNPC: false },
    { playerName: "u3", characterName: "甲", isNPC: false },
  ];
  assert.deepEqual(votablePlayers(players, "PVP").map((p) => p.characterName), ["甲"]);
});

test("游戏模式大小写不敏感（后端各处都用 toUpperCase 比较）", () => {
  assert.deepEqual(
    votablePlayers(ROOM_BM4AFM, "pvp").map((p) => p.characterName),
    votablePlayers(ROOM_BM4AFM, "PVP").map((p) => p.characterName),
  );
  assert.ok(votablePlayers(ROOM_BM4AFM, "pvp").every((p) => p.characterName !== "赵德海"), "小写 pvp 也要排除 NPC");
});

test("入参为空/缺失时返回空数组（不能抛）", () => {
  assert.deepEqual(votablePlayers(null, "PVP"), []);
  assert.deepEqual(votablePlayers(undefined, "PVP"), []);
  assert.deepEqual(votablePlayers([null, undefined], "PVP"), []);
});

test("canVoteFor：不可自投，可投他人，空值不可投", () => {
  assert.equal(canVoteFor("林小满", "林小满"), false, "不能投自己（服务端也拒绝）");
  assert.equal(canVoteFor("苏曼", "林小满"), true);
  assert.equal(canVoteFor("", "林小满"), false);
  assert.equal(canVoteFor(null, "林小满"), false);
});
