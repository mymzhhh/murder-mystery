// 投票候选的判定 —— 纯函数，供 Node 单测直接引入（见 tests/unit/vote-targets.test.mjs）。
//
// ## 为什么把它从组件里提出来
//
// 判据原本内联在 GameView 的 VotingView 里，写成：
//     players.filter((p) => p.characterName && !(gameMode === "PVP" && p.isNPC))
// 看起来合理，实际与服务端口径不一致，并造成过一次**整局卡死**：
//
// 实测房间 BM4AFM（1 真人 + 5 AI 补位 + 1 审讯 NPC）：
//   5 个 AI 玩家的数据是 { isNPC: true, isAI: true } —— 它们 fill 的是**玩家角色**；
//   而上面这条过滤在 PVP 下把所有 isNPC 一律滤掉，AI 补位角色因此全被滤掉，
//   只剩自己那一张卡，而自己又是 disabled（不可自投）→ **一个可点项都没有**，
//   玩家一票都投不出（该局他恰好是凶手，最终计分里就是"未投票"）。
//
// 正解以服务端 cast_vote 的校验为准（src/socket/game.js）：
//   可投目标 = 真人角色 + **AI 补位角色** +（非 PVP 时）审讯 NPC
// 也就是说，PVP 下要排除的是"**非 AI 的** NPC"（目击者/关系人），而不是所有 NPC。
// 这个模块就是那条口径的单一出处，组件与测试都从这里取。

/** 归一化游戏模式（后端各处都用 toUpperCase 比较，保持一致） */
function isPVP(gameMode) {
  return String(gameMode || "").toUpperCase() === "PVP";
}

/**
 * 可被投票的角色列表。
 * @param {Array<{characterName?:string, isNPC?:boolean, isAI?:boolean}>} players 房间公开玩家列表
 *   （来自 room_state / room_updated 的 publicPlayers，带 isAI）
 * @param {string} gameMode "PVP" | "PVE" | 其它
 * @returns {Array} 过滤后的玩家（含自己——自己那张卡由界面 disabled 展示，不在这里剔除）
 */
export function votablePlayers(players, gameMode) {
  const pvp = isPVP(gameMode);
  return (players || []).filter((p) => {
    if (!p || !p.characterName) return false;      // 没分到角色的玩家不能当被投对象
    if (pvp && p.isNPC && !p.isAI) return false;   // PVP：只有"非 AI 的 NPC"不进投票
    return true;
  });
}

/** 能不能投给这个人（自投被服务端拒绝，界面据此把"你自己"那张卡置灰） */
export function canVoteFor(targetCharacterName, myCharacterName) {
  const t = String(targetCharacterName || "");
  if (!t) return false;
  return t !== String(myCharacterName || "");
}
