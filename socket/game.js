// WebSocket 游戏事件处理

const { verifyToken } = require("../modules/auth");
const { getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer, getClues, assignClue, getPlayerClues, recordVote, getVotes, clearVotes, addChatMessage, getChatMessages } = require("../modules/game-manager");
const { getPhaseConfig, getPhaseRound, validateAction, getAvailableCluesForPlayer } = require("../modules/game-engine");
const { generatePhaseNarrative, decideClueForPlayer } = require("../modules/dm-agent");
const { autoAdvancePhase } = require("./ai-dm");

function setupGameSocket(io) {
  io.on("connection", (socket) => {
    console.log(`[socket] ${socket.id}`);

    socket.on("join_room", async ({ roomCode, token }) => {
      try {
        const user = verifyToken(token);
        if (!user) return socket.emit("error", { code: "AUTH", message: "请先登录" });
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "NOT_FOUND", message: "房间不存在" });

        const existing = await getPlayers(roomCode);
        const byUsername = existing.find(p => p.playerName === user.username);
        const bySocketId = existing.find(p => p.playerId === socket.id);

        if (byUsername) {
          await updatePlayer(roomCode, byUsername.playerId, { playerId: socket.id, connected: true });
          await removePlayer(roomCode, byUsername.playerId);
          await addPlayer(roomCode, socket.id, user.username);
          if (byUsername.characterName) {
            await updatePlayer(roomCode, socket.id, { characterName: byUsername.characterName, characterScript: byUsername.characterScript });
          }
        } else if (!bySocketId) {
          await addPlayer(roomCode, socket.id, user.username);
        }
        socket.join(roomCode);

        const players = await getPlayers(roomCode);
        const parsed = JSON.parse(room.parsedScript || "{}");
        const myPlayer = players.find(p => p.playerId === socket.id);
        const myCharacter = parsed.characters?.find(c => c.name === myPlayer?.characterName);
        // 线索公开：所有已发现的线索对所有玩家可见
        const allCluesRaw = await getClues(roomCode);
        const myClues = (allCluesRaw || []).filter(c => c.foundBy && c.foundBy.length > 0).map(c => {
          const finder = players.find(p => p.playerId === c.foundBy[0]);
          return { ...c, foundByName: finder?.characterName || finder?.playerName || "未知" };
        });

        socket.emit("room_state", {
          room: { roomCode, status: room.status, phase: room.phase },
          players: players.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, connected: p.connected, isNPC: p.isNPC || false })),
          myCharacter, myClues, allClues: allCluesRaw, chatMessages: await getChatMessages(roomCode, 50),
          phaseConfig: getPhaseConfig(room.phase), phaseNarrative: room.aiNarrative || "",
          scriptSummary: { title: parsed.title, setting: parsed.setting, victim: parsed.victim },
          allCharacters: parsed.characters || [], // 完整角色列表（含NPC、roleType）
        });
        io.to(roomCode).emit("room_updated", { players: await getPlayers(roomCode) });
      } catch (e) { socket.emit("error", { code: "JOIN_FAILED", message: e.message }); }
    });

    socket.on("leave_room", async ({ roomCode }) => {
      try {
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        if (me) await removePlayer(roomCode, socket.id);
        socket.leave(roomCode);
        const remaining = await getPlayers(roomCode);
        if (remaining.length === 0) {
          const { getRedis } = require("../modules/game-manager");
          const r2 = await getRedis();
          await r2.srem("rooms:open", roomCode);
          await deleteGameRoom(roomCode);
        } else {
          io.to(roomCode).emit("room_updated", { players: remaining });
        }
        socket.emit("left_room", {});
      } catch (e) { socket.emit("error", { code: "LEAVE_FAILED", message: e.message }); }
    });

    socket.on("select_character", async ({ roomCode, characterName }) => {
      try {
        const room = await getRoom(roomCode);
        if (room.phase !== "lobby") return socket.emit("error", { code: "WRONG_PHASE", message: "游戏已开始" });
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        const parsed = JSON.parse(room.parsedScript || "{}");
        const char = parsed.characters?.find(c => c.name === characterName);
        if (!char) return socket.emit("error", { code: "NOT_FOUND", message: "角色不存在" });
        if (me?.characterName && me.characterName === characterName) return socket.emit("error", { code: "SAME_CHAR", message: "你已经选择了该角色" });
        if (players.some(p => p.characterName === characterName)) return socket.emit("error", { code: "TAKEN", message: "角色已被选择" });
        await updatePlayer(roomCode, socket.id, { characterName, characterScript: JSON.stringify(char) });
        socket.emit("character_selected", { characterName, character: char, isMurderer: char.isMurderer });
        io.to(roomCode).emit("room_updated", { players: await getPlayers(roomCode) });
      } catch (e) { socket.emit("error", { code: "SELECT_FAILED", message: e.message }); }
    });

    socket.on("start_game", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        const assigned = players.filter(p => p.characterName);
        if (assigned.length < 2) return socket.emit("error", { code: "NOT_ENOUGH", message: "至少需要2名玩家" });
        const parsed = JSON.parse(room.parsedScript || "{}");

        // 将NPC角色以虚拟玩家身份加入游戏（AI控制）
        const npcChars = parsed.characters?.filter(c => c.roleType === "npc") || [];
        const { getRedis } = require("../modules/game-manager");
        for (let i = 0; i < npcChars.length; i++) {
          const npc = npcChars[i];
          const npcId = "npc_" + roomCode + "_" + i;
          const existingNpc = players.find(p => p.playerId === npcId);
          if (!existingNpc) {
            await addPlayer(roomCode, npcId, "NPC:" + npc.name, false);
            await updatePlayer(roomCode, npcId, {
              characterName: npc.name,
              characterScript: JSON.stringify(npc),
              isNPC: true,
            });
          }
        }
        // 重新获取完整玩家列表（含NPC）
        const allPlayers = await getPlayers(roomCode);

        for (const p of assigned) {
          const char = parsed.characters?.find(c => c.name === p.characterName);
          if (char) io.to(p.playerId).emit("character_assigned", { characterName: p.characterName, character: char, isMurderer: char.isMurderer || false });
        }
        const narrative = await generatePhaseNarrative(parsed, "reading", {});
        await updateRoom(roomCode, { status: "playing", phase: "reading", phaseStartedAt: Date.now(), aiNarrative: narrative });
        io.to(roomCode).emit("game_started", { phase: "reading", config: getPhaseConfig("reading"), narrative });
        io.to(roomCode).emit("phase_changed", { phase: "reading", label: "阅读剧本", narrative });
        (await getRedis()).srem("rooms:open", roomCode);
        setTimeout(async () => { try { await autoAdvancePhase(io, roomCode, parsed); } catch (e) { /* ignore */ } }, 180000);
      } catch (e) { socket.emit("error", { code: "START_FAILED", message: e.message }); }
    });

    socket.on("investigate", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        const val = validateAction("request_clue", { phase: room.phase, players }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message || "当前阶段无法获取线索" });
        const round = getPhaseRound(room.phase);
        const allClues = await getClues(roomCode);
        if (!allClues || allClues.length === 0) return socket.emit("error", { code: "NO_CLUES", message: "剧本未加载线索数据" });
        const playerClues = await getPlayerClues(roomCode, socket.id);
        const available = getAvailableCluesForPlayer(allClues, socket.id, round);
        if (available.length === 0) return socket.emit("error", { code: "NO_CLUES", message: "本轮线索已全部获取，等待进入下一阶段" });
        const parsed = JSON.parse(room.parsedScript || "{}");
        const player = players.find(p => p.playerId === socket.id);
        const myChar = parsed.characters?.find(c => c.name === player?.characterName);
        const clue = await decideClueForPlayer(parsed, myChar || {}, available, playerClues, round, room.phase);
        if (!clue) return socket.emit("error", { code: "NO_CLUES", message: "未找到合适的线索，请稍后再试" });
        await assignClue(roomCode, clue.id, socket.id);
        // 线索公开：广播给房间内所有玩家
        io.to(roomCode).emit("clue_received", { clue, foundBy: player?.characterName || player?.playerName || "未知" });
      } catch (e) { socket.emit("error", { code: "INVESTIGATE_FAILED", message: e.message }); }
    });

    socket.on("chat", async ({ roomCode, content }) => {
      try {
        const room = await getRoom(roomCode);
        const player = await getPlayer(roomCode, socket.id);
        const val = validateAction("send_chat", { phase: room.phase, players: await getPlayers(roomCode) }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message });
        const msg = await addChatMessage(roomCode, socket.id, player?.playerName || "", player?.characterName || "", content, room.phase);
        io.to(roomCode).emit("chat_message", msg);
      } catch (e) { socket.emit("error", { code: "CHAT_FAILED", message: e.message }); }
    });

    socket.on("vote", async ({ roomCode, targetCharacterName }) => {
      try {
        const room = await getRoom(roomCode);
        const allPlayers = await getPlayers(roomCode);
        const player = allPlayers.find(p => p.playerId === socket.id);
        if (!player) return socket.emit("error", { code: "NOT_FOUND", message: "玩家不存在" });
        const val = validateAction("cast_vote", { phase: room.phase, players: allPlayers }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message || "当前阶段无法投票" });
        // 检查投票目标是否存在（含NPC角色）
        const humanPlayers = allPlayers.filter(p => !p.isNPC);
        const parsed = JSON.parse(room.parsedScript || "{}");
        const npcNames = (parsed.characters || []).filter(c => c.roleType === "npc").map(c => c.name);
        const allCharNames = [...new Set([...humanPlayers.map(p => p.characterName).filter(Boolean), ...npcNames])];
        if (!allCharNames.includes(targetCharacterName)) return socket.emit("error", { code: "INVALID_TARGET", message: "投票目标不存在" });
        await recordVote(roomCode, socket.id, targetCharacterName);
        socket.emit("vote_recorded", { target: targetCharacterName });
        const votes = await getVotes(roomCode);
        io.to(roomCode).emit("vote_update", { count: Object.keys(votes).length, total: humanPlayers.length });
      } catch (e) { socket.emit("error", { code: "VOTE_FAILED", message: e.message }); }
    });

    socket.on("ready", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        if (room.phase === "truth_reveal" || room.phase === "finished") return;
        await autoAdvancePhase(io, roomCode, JSON.parse(room.parsedScript || "{}"));
      } catch (e) { socket.emit("error", { code: "READY_FAILED", message: e.message }); }
    });

    // ==================== WebRTC 语音信令 ====================
    socket.on("rtc_offer", ({ roomCode, targetId, offer }) => {
      io.to(targetId).emit("rtc_offer", { fromId: socket.id, offer });
    });
    socket.on("rtc_answer", ({ roomCode, targetId, answer }) => {
      io.to(targetId).emit("rtc_answer", { fromId: socket.id, answer });
    });
    socket.on("rtc_ice", ({ roomCode, targetId, candidate }) => {
      io.to(targetId).emit("rtc_ice", { fromId: socket.id, candidate });
    });
    socket.on("rtc_mute", ({ roomCode, muted }) => {
      socket.to(roomCode).emit("rtc_mute_update", { playerId: socket.id, muted });
    });

    socket.on("disconnect", async () => {
      const { getRedis } = require("../modules/game-manager");
      const codes = await (await getRedis()).smembers("rooms:open");
      for (const code of codes) {
        try { await updatePlayer(code, socket.id, { connected: false }); } catch (e) { /* skip */ }
      }
    });
  });
}

module.exports = { setupGameSocket };
