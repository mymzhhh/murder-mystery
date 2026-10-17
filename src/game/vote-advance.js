// 投票阶段：**所有人都投完之后立即推进**，不再干等阶段计时器。
//
// 用户实测的 bug：测试房里 4 个 AI 全部投完票后，房间一直停在「投票阶段」，只有 DM 发一句
// "点击进入下一阶段"的提示 —— 代码里根本没有"投满票"这个触发。
//
// 第一版失败的原因（本次修正）：筛"该投票的人"时用了 !p.isNPC，并假设 getVotes() 的键是 playerId。
// 测试房四个座位全是 AI 填充位、NPC 角色的标记方式未知 —— 一旦筛错或键口径不对，pending 永远 > 0，
// 函数静默 return false，跑完一局才知道没触发。现在：
//   ① 用**剧本里的 NPC 角色名**排除 NPC（不依赖任何 isNPC 标志）；
//   ② 投票键**两种口径都认**（playerId / characterName）；
//   ③ **每次都打一行诊断**（应投/已投/未投），下一次跑必然看得出真相。
//
// 用惰性 require 引 ai-dm：ai-dm 反过来 require ai-player，顶层 require 会形成环。

function npcNamesOf(parsed) {
  const set = new Set();
  for (const c of (parsed && parsed.characters) || []) {
    if (c && c.name && c.roleType === "npc") set.add(String(c.name));
  }
  return set;
}

async function advanceIfAllVoted(io, roomCode) {
  try {
    const { getRoom, getPlayers, getVotes } = require("./game-manager");
    const room = await getRoom(roomCode);
    if (!room || room.phase !== "voting") return false;

    let parsed = {};
    try { parsed = JSON.parse(room.parsedScript || "{}"); } catch (e) { parsed = {}; }
    const npcNames = npcNamesOf(parsed);

    const all = await getPlayers(roomCode);
    const voters = (all || []).filter((p) => p && p.characterName && !npcNames.has(String(p.characterName)));
    const votes = (await getVotes(roomCode)) || {};
    const keys = new Set(Object.keys(votes));
    const hasVoted = (p) => keys.has(String(p.playerId)) || keys.has(String(p.characterName));
    const pending = voters.filter((p) => !hasVoted(p));

    console.log("[vote-advance] " + roomCode + " 应投=" + voters.length + " 已投=" + (voters.length - pending.length) +
      " 未投=" + (pending.map((p) => p.characterName).join("/") || "无") +
      "（NPC 角色 " + npcNames.size + " 个已排除；投票键 " + keys.size + " 个）");

    if (!voters.length) return false;
    if (pending.length) return false;

    const { autoAdvancePhase } = require("../socket/ai-dm");
    console.log("[vote-advance] " + roomCode + " 全员已投票 → 立即推进");
    await autoAdvancePhase(io, roomCode, parsed);
    return true;
  } catch (e) {
    console.warn("[vote-advance] 投满票推进失败:", e.message);
    return false;
  }
}

module.exports = { advanceIfAllVoted, npcNamesOf };