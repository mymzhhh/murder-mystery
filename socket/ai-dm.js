// AI DM 自动推进逻辑

const { getRoom, updateRoom, getVotes, clearVotes, getPlayers } = require("../modules/game-manager");
const { getPhaseConfig, getNextPhase, tallyVotes, determineOutcome } = require("../modules/game-engine");
const { generatePhaseNarrative, generateTruthReveal } = require("../modules/dm-agent");

async function autoAdvancePhase(io, roomCode, parsed, preGenNarrative) {
  const room = await getRoom(roomCode);
  if (!room || room.phase === "finished") return;

  const nextPhase = getNextPhase(room.phase);
  if (!nextPhase) return;

  if (nextPhase === "voting") await clearVotes(roomCode);

  if (nextPhase === "truth_reveal") {
    const votes = await getVotes(roomCode);
    const players = await getPlayers(roomCode);
    const realPlayers = players.filter(p => !p.isNPC);
    const outcome = determineOutcome(votes, room.murdererName);
    const tallied = tallyVotes(votes, realPlayers);
    const narrative = await generateTruthReveal(parsed, votes, outcome);

    await updateRoom(roomCode, { phase: "truth_reveal", phaseStartedAt: Date.now(), aiNarrative: narrative, status: "finished" });
    const { getRedis: gr } = require("../modules/game-manager");
    (await (await gr())).del(`game:${roomCode}:ready`);
    // 只发送 truth_revealed，不发送 phase_changed（避免前端 renderGame 覆盖真相数据）
    io.to(roomCode).emit("truth_revealed", {
      murdererName: room.murdererName, votes: tallied,
      outcome: outcome.outcome, description: outcome.description, narrative,
      phase: "truth_reveal",
    });
    return;
  }

  // 先切换阶段（即时响应）
  const narrative = preGenNarrative || "";
  if (narrative) await updateRoom(roomCode, { phase: nextPhase, phaseStartedAt: Date.now(), aiNarrative: narrative });
  else await updateRoom(roomCode, { phase: nextPhase, phaseStartedAt: Date.now() });

  const { getRedis } = require("../modules/game-manager");
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
    reading: 180000, round1_investigation: 300000, round1_discussion: 180000,
    round2_investigation: 300000, round2_discussion: 180000,
    round3: 360000, voting: 120000,
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
