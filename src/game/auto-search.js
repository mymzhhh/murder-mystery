// 测试房的**确定性搜证**：不靠 AI 回合把线索搜完（用户指定）。
//
// 为什么要有它：测试房要同时验证两件事——
//   ① 线索能不能被搜到（可达性）；② AI 会不会正常讨论/投票。
// 实测把两者绑在同一个"回合预算"上会互相挤压：
//   · 报告 15（房间 5PFT2F）：四个 AI 的 search 是 6/10/8/10，而 speak **全是 0**
//     ——"搜证与讨论"里的讨论一次都没发生；
//   · 反过来给发言留回合，线索就搜不全（42 条只翻出 6 条那次的教训）。
// 所以测试房里**搜证交给代码**，AI 的回合只用于发言/提问/投票。
//
// ⚠️ 关键：仍然走**与真人/AI 完全相同**的地点解析 + 原子认领路径
//   （buildSearchLocations → cluesAtLocation → claimClue → assignClue → revealClue），
//   只是不需要 AI"出手"了。
//   如果图省事直接"把线索全塞给某个玩家"，那么"线索卡在没人搜得到的地方"
//   这类真实缺陷就再也测不出来了 —— 而它正是测试房存在的理由。

const { getRoom, getPlayers, getClues, assignClue, claimClue, revealClue } = require("./game-manager");
const { buildSearchLocations, cluesAtLocation } = require("./search-locations");
const { recordTurn } = require("./ai-observability");
const { getPhaseRound } = require("./game-engine");

/** 一次清扫最多认领多少条（防死循环；正常一局几十条） */
const MAX_SWEEP = 300;

/**
 * 挑出"可以认领线索的 AI 玩家"。
 *
 * ⚠️ 只能靠 **playerId 前缀**判断，不能用 `isNPC`：
 * 真实记录里 AI 补位的玩家槽位是
 *   `{"playerId":"ai_<房号>_<角色名>","playerName":"AI 玩家","characterName":"赵磊",
 *     "isAI":true,"isNPC":true,...}`
 * ——**AI 玩家身上 `isNPC` 也是 true**（这个字段在本项目里的实际语义是"非真人接管"，
 * 不是"审讯 NPC"）。所以 `!p.isNPC` 会把 AI 玩家一起排除掉，代码搜证静默跳过。
 * 实测被拦了两轮：报告 17（HRM5FG）与 PF7TGY 都是
 *   `[auto-search] … 跳过：没有 AI 玩家可认领线索`
 * 而 `clueFound` 停在 8/36。
 *
 * 判据：`ai_<房号>_<角色名>` = AI 扮演的**玩家角色**（要搜证）；
 *       `npc_<房号>_<序号>` = 审讯 NPC（不搜证，与人类局一致）。
 */
function pickSearchers(players) {
  return (players || []).filter(p => {
    const id = String(p.playerId || "");
    if (id.startsWith("npc_")) return false;      // 审讯 NPC：不搜证
    if (id.startsWith("ai_")) return !!p.characterName;
    // 没有 playerId（理论上不会）→ 退回字段判据，但仍要求"不是审讯 NPC 槽位"
    const truthy = (v) => v === true || v === "1" || v === 1 || v === "true";
    return truthy(p.isAI) && !id.startsWith("npc_") && !!p.characterName;
  });
}

/**
 * 把本轮**还剩的线索全部搜出来**（确定性，无随机）。
 *
 * @param {object} io socket.io server（用于把线索广播给旁观的管理员）
 * @param {string} roomCode 房间号
 * @returns {Promise<{round:number, found:number, remaining:number, by:{[name:string]:number}>}>}
 */
async function sweepRound(io, roomCode) {
  const room = await getRoom(roomCode);
  const empty = { round: 0, found: 0, remaining: 0, by: {} };
  if (!room) { console.log(`[auto-search] ${roomCode} 跳过：房间不存在`); return empty; }
  const round = getPhaseRound(room.phase);
  // ⚠️ 跳过也要出声音：这里以前是静默 return，于是"代码搜证没生效"时
  // 日志里连一行都没有，只能靠反推（实测就这么排查了一轮）。
  if (!round) { console.log(`[auto-search] ${roomCode} 跳过：phase=${room.phase} 不是搜证轮（只认 round1/round2）`); return empty; }
  const parsed = JSON.parse(room.parsedScript || "{}");
  const searchers = pickSearchers(await getPlayers(roomCode));
  if (!searchers.length) { console.log(`[auto-search] ${roomCode} 跳过：没有 AI 玩家可认领线索`); return { ...empty, round }; }

  const by = {};
  let found = 0;
  // 轮询分配：线索均匀落在各个 AI 头上（不搞"全给第一个"）
  let cursor = 0;
  for (let guard = 0; guard < MAX_SWEEP; guard++) {
    const all = await getClues(roomCode);
    const ranked = buildSearchLocations(all, parsed.layoutDescription)
      .map(loc => ({ loc, pool: cluesAtLocation(all, loc, round) }))
      .filter(x => x.pool.length > 0)
      .sort((a, b) => b.pool.length - a.pool.length);   // 先从线索最多的地点搜起
    if (!ranked.length) break;                          // 本轮搜空

    let claimedThisRound = false;
    // 逐个地点、逐条尝试原子认领（与人类路径同一把锁）
    for (const { loc, pool } of ranked) {
      for (const cand of pool) {
        const who = searchers[cursor % searchers.length];
        cursor++;
        if (!(await claimClue(roomCode, cand.id, who.playerId))) continue;   // 被抢走 → 试下一条
        await assignClue(roomCode, cand.id, who.playerId);
        try { await revealClue(roomCode, cand.id, who.playerId); } catch (e) { /* 公开失败不影响入账 */ }
        recordTurn(roomCode, who.characterName, "search");
        by[who.characterName] = (by[who.characterName] || 0) + 1;
        found++;
        try { io.to(roomCode).emit("clue_received", { clue: cand, foundBy: who.characterName || "AI", revealed: true }); } catch (e) { /* 无 io 时忽略 */ }
        claimedThisRound = true;
        break;                                          // 换下一个地点（模拟"挨个地方翻"）
      }
      if (claimedThisRound) break;
    }
    if (!claimedThisRound) break;                       // 一条也认领不到 → 防死循环
  }

  // ⚠️ "剩余"必须按**该轮全部线索减去已找到**来算，不能只数"落进地点池的那些"。
  //    第一版只数地点池 → 落不进任何地点的线索既搜不到、也不计入剩余 → 日志报"剩余 0"，
  //    而报告是 clueFound 34/36（实测藏了两轮才被翻出来）。
  //    宁可让数字难看，也不能让它撒谎：搜不到的线索必须显式列出来。
  const after = await getClues(roomCode);
  const roundClues = after.filter(c => c.round == round);            // == 兼容 Redis 字符串轮次
  const foundIds = new Set(roundClues.filter(c => c.foundBy && c.foundBy.length > 0).map(c => c.id));
  const remaining = roundClues.length - foundIds.size;
  const stuck = roundClues.filter(c => !foundIds.has(c.id)).map(c => `${c.id}「${c.location || "?"}」`);
  if (stuck.length) {
    console.log(`[auto-search] ${roomCode} 第 ${round} 轮**搜不到** ${stuck.length} 条：${stuck.slice(0, 8).join(" / ")}${stuck.length > 8 ? " …" : ""}`);
  }
  if (found) {
    console.log(`[auto-search] ${roomCode} 第 ${round} 轮代码搜证：找到 ${found} 条，本轮剩余 ${remaining} 条（${Object.entries(by).map(([n, c]) => `${n} ${c}`).join(" / ")}）`);
  } else {
    console.log(`[auto-search] ${roomCode} 第 ${round} 轮：无可搜线索（本轮剩余 ${remaining}）`);
  }
  return { round, found, remaining, by, stuck };
}

module.exports = { sweepRound, pickSearchers, MAX_SWEEP };
