// AI DM 自动推进逻辑

const { getRoom, updateRoom, getVotes, clearVotes, getPlayers } = require("../game/game-manager");
const { getPhaseConfig, getNextPhase, tallyVotes, determineOutcome } = require("../game/game-engine");
const { generatePhaseNarrative, generateTruthReveal, fallbackTruthReveal } = require("../game/dm-agent");

async function autoAdvancePhase(io, roomCode, parsed, preGenNarrative) {
  const room = await getRoom(roomCode);
  if (!room || room.phase === "finished") return;

  const nextPhase = getNextPhase(room.phase);
  if (!nextPhase) return;

  if (nextPhase === "voting") await clearVotes(roomCode);

  if (nextPhase === "truth_reveal") {
    // 兜底：为所有未投票的 AI 玩家补投（防止玩家提前推进导致 AI 无票）
    try {
      const { voteForAllPending } = require("../game/ai-player");
      const aiVotes = await voteForAllPending(io, roomCode);
      if (aiVotes > 0) console.log(`[ai-dm] AI 补投 ${aiVotes} 票`);
    } catch (e) { console.warn("[ai-dm] AI 补投失败:", e.message); }

    const votes = await getVotes(roomCode);
    const players = await getPlayers(roomCode);
    const realPlayers = players.filter(p => !p.isNPC);
    const outcome = determineOutcome(votes, room.murdererName);
    const tallied = tallyVotes(votes, realPlayers);
    // ⚠️ 这里必须**先翻阶段、立刻广播**，绝不 await LLM。
    //
    // 旧实现是 `narrative = await generateTruthReveal(...)`（最长 20s 超时）之后才
    // updateRoom + emit，于是房间在投完票后**停在 voting 长达 20 秒**：这期间玩家
    // 刷新看到的还是投票页，只能重按"提交并查看真相"。
    // 实测症状（子代理真浏览器跑出来的）："一次推进不生效、需刷新后重按"。
    // 上方 L29 的注释早就写明"真相叙述是可选装饰，绝不能让它的失败挡住阶段推进"，
    // 但那次只加了 try/catch —— await 仍在阻塞路径上，问题没根治。
    //
    // 现在与本文件下方"先切换阶段（即时响应）"用同一套模式：
    //   ① 立刻用**同步可得**的兜底文本（结局概要 + DM 手册真相节选）广播；
    //   ② LLM 版叙述异步生成，好了再补发一条 `narrative`（客户端已监听该事件）。
    // 于是"真相页立刻出现"与"叙述仍然戏剧化"两件事不再互相牺牲。
    const immediateNarrative = fallbackTruthReveal(parsed, outcome);

    await updateRoom(roomCode, { phase: "truth_reveal", phaseStartedAt: Date.now(), aiNarrative: immediateNarrative, status: "finished" });
    const { getRedis: gr } = require("../game/game-manager");
    (await (await gr())).del(`game:${roomCode}:ready`);
    // 只发送 truth_revealed，不发送 phase_changed（避免前端 renderGame 覆盖真相数据）
    io.to(roomCode).emit("truth_revealed", {
      murdererName: room.murdererName, votes: tallied,
      outcome: outcome.outcome, description: outcome.description, narrative: immediateNarrative,
      phase: "truth_reveal",
    });

    // 异步补上 LLM 版叙述。失败/超时都只降级（玩家已经拿到可读的复盘页），不影响开局。
    generateTruthReveal(parsed, votes, outcome).then(async (n) => {
      if (!n || n === immediateNarrative) return;
      await updateRoom(roomCode, { aiNarrative: n });
      io.to(roomCode).emit("narrative", { text: n });
    }).catch((e) => console.warn("[ai-dm] 真相叙述异步生成失败（复盘页已可用，不回滚）:", e.message));
    return;
  }

  // 先切换阶段（即时响应）
  const narrative = preGenNarrative || "";
  if (narrative) await updateRoom(roomCode, { phase: nextPhase, phaseStartedAt: Date.now(), aiNarrative: narrative });
  else await updateRoom(roomCode, { phase: nextPhase, phaseStartedAt: Date.now() });

  const { getRedis } = require("../game/game-manager");
  (await (await getRedis())).del(`game:${roomCode}:ready`);
  io.to(roomCode).emit("phase_changed", { phase: nextPhase, label: getPhaseConfig(nextPhase).label, config: getPhaseConfig(nextPhase), narrative });

  // 如果没有预生成，则异步生成
  if (!preGenNarrative) {
    generatePhaseNarrative(parsed, nextPhase, { roomCode }).then(async (n) => {
      if (n) {
        await updateRoom(roomCode, { aiNarrative: n });
        io.to(roomCode).emit("narrative", { text: n });
      }
    }).catch(e => console.warn("[dm] narrative push failed:", e.message));
  }

  // 超时提醒
  const autoTimers = {
    reading: 180000, intro: 150000,
    round1: 420000, round2: 420000, voting: 120000,
  };
  const delay = autoTimers[nextPhase];
  if (delay) {
    setTimeout(async () => {
      try {
        const currentRoom = await getRoom(roomCode);
        if (currentRoom?.phase === nextPhase) {
          io.to(roomCode).emit("narrative", { text: "⏰ AI DM 提示：当前阶段时间较长，所有玩家点击「进入下一阶段」后自动推进。" });
        }
      } catch (e) { /* skip */ }
    }, delay);
  }
}

module.exports = { autoAdvancePhase };
