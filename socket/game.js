// WebSocket 游戏事件处理

const { verifyToken } = require("../modules/auth");
const { getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer, getClues, assignClue, getPlayerClues, recordVote, getVotes, clearVotes, addChatMessage, getChatMessages } = require("../modules/game-manager");
const { getPhaseConfig, getPhaseRound, validateAction, getAvailableCluesForPlayer, pickRandomClue } = require("../modules/game-engine");
const { generatePhaseNarrative } = require("../modules/dm-agent");
const { generateNpcResponse } = require("../modules/npc-agent");
const { autoAdvancePhase } = require("./ai-dm");

function setupGameSocket(io) {
  const disconnectTimers = {}; // 断线重连计时器

  io.on("connection", (socket) => {
    console.log(`[socket] ${socket.id}`);

    socket.on("join_room", async ({ roomCode, token }) => {
      try {
        const user = verifyToken(token);
        if (!user) return socket.emit("error", { code: "AUTH", message: "请先登录" });
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "NOT_FOUND", message: "房间不存在" });

        // 清除断线计时器（玩家重连成功）
        const timerKey = roomCode + ":" + socket.id;
        if (disconnectTimers[timerKey]) { clearTimeout(disconnectTimers[timerKey]); delete disconnectTimers[timerKey]; }

        const existing = await getPlayers(roomCode);
        // 过滤掉NPC虚拟玩家
        const humanPlayers = existing.filter(p => !p.isNPC);
        const byUsername = humanPlayers.find(p => p.playerName === user.username);
        const bySocketId = humanPlayers.find(p => p.playerId === socket.id);

        // 检查重连前是否是房主
        const wasOwner = room.ownerId && byUsername && room.ownerId === byUsername.playerId;

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

        // 更新房主：重连的原房主保留主权，否则设第一个人类玩家为房主
        const allPlayers = await getPlayers(roomCode);
        const currentHumans = allPlayers.filter(p => !p.isNPC);
        if (wasOwner) {
          await updateRoom(roomCode, { ownerId: socket.id });
        } else if (!room.ownerId || !currentHumans.find(p => p.playerId === room.ownerId)) {
          const newOwner = currentHumans[0];
          if (newOwner) {
            await updateRoom(roomCode, { ownerId: newOwner.playerId });
          }
        }
        const updatedRoom = await getRoom(roomCode);

        const parsed = JSON.parse(room.parsedScript || "{}");
        const myPlayer = allPlayers.find(p => p.playerId === socket.id);
        const myCharacter = parsed.characters?.find(c => c.name === myPlayer?.characterName);
        const allCluesRaw = await getClues(roomCode);
        const myClues = (allCluesRaw || []).filter(c => c.foundBy && c.foundBy.length > 0).map(c => {
          const finder = allPlayers.find(p => p.playerId === c.foundBy[0]);
          return { ...c, foundByName: finder?.characterName || finder?.playerName || "未知" };
        });

        // 检查是否可以开始游戏
        const totalPlayerSlots = (parsed.characters || []).filter(c => c.roleType !== "npc").length;
        const assignedCount = currentHumans.filter(p => p.characterName).length;
        const allReady = currentHumans.length >= totalPlayerSlots && assignedCount >= currentHumans.length && currentHumans.length >= 2;

        socket.emit("room_state", {
          room: { roomCode, status: room.status, phase: room.phase, ownerId: updatedRoom.ownerId, maxPlayers: room.maxPlayers },
          playerId: socket.id,
          players: allPlayers.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, connected: p.connected, isNPC: p.isNPC || false, isOwner: p.playerId === updatedRoom.ownerId })),
          myCharacter, myClues, allClues: allCluesRaw, chatMessages: await getChatMessages(roomCode, 50),
          phaseConfig: getPhaseConfig(room.phase), phaseNarrative: room.aiNarrative || "",
          scriptSummary: { title: parsed.title, setting: parsed.setting, victim: parsed.victim, layoutDescription: parsed.layoutDescription || "" },
          allCharacters: parsed.characters || [],
          canStart: allReady, totalSlots: totalPlayerSlots,
        });
        io.to(roomCode).emit("room_updated", { players: await getPlayers(roomCode), ownerId: room.ownerId });
      } catch (e) { socket.emit("error", { code: "JOIN_FAILED", message: e.message }); }
    });

    socket.on("leave_room", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        if (me) await removePlayer(roomCode, socket.id);
        socket.leave(roomCode);
        const remaining = await getPlayers(roomCode);
        const humanRemaining = remaining.filter(p => !p.isNPC);

        // 房主离开时转让给随机其他人
        if (room.ownerId === socket.id && humanRemaining.length > 0) {
          const newOwner = humanRemaining[Math.floor(Math.random() * humanRemaining.length)];
          await updateRoom(roomCode, { ownerId: newOwner.playerId });
        }

        if (humanRemaining.length === 0) {
          const { getRedis } = require("../modules/game-manager");
          const r2 = await getRedis();
          await r2.srem("rooms:open", roomCode);
          await deleteGameRoom(roomCode);
        } else {
          const updatedRoom = await getRoom(roomCode);
          io.to(roomCode).emit("room_updated", { players: remaining, ownerId: updatedRoom.ownerId });
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
        if (char.roleType === "npc") return socket.emit("error", { code: "NPC_CHAR", message: "NPC角色由AI控制，不可选择" });
        if (me?.characterName && me.characterName === characterName) return socket.emit("error", { code: "SAME_CHAR", message: "你已经选择了该角色" });
        if (players.some(p => p.characterName === characterName)) return socket.emit("error", { code: "TAKEN", message: "角色已被选择" });
        await updatePlayer(roomCode, socket.id, { characterName, characterScript: JSON.stringify(char) });
        socket.emit("character_selected", { characterName, character: char, isMurderer: char.isMurderer });
        io.to(roomCode).emit("room_updated", { players: await getPlayers(roomCode), ownerId: room.ownerId });
      } catch (e) { socket.emit("error", { code: "SELECT_FAILED", message: e.message }); }
    });

    socket.on("start_game", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        // 只有房主可以开始游戏
        if (room.ownerId && room.ownerId !== socket.id) {
          return socket.emit("error", { code: "NOT_OWNER", message: "只有房主可以开始游戏" });
        }
        const curPlayers = await getPlayers(roomCode);
        const humanPlayers = curPlayers.filter(p => !p.isNPC);
        if (humanPlayers.length < 1) return socket.emit("error", { code: "NOT_ENOUGH", message: "至少需要1名玩家" });

        const parsed = JSON.parse(room.parsedScript || "{}");

        // 单人本检查：必须有NPC嫌疑人
        const npcCount = (parsed.characters || []).filter(c => c.roleType === "npc").length;
        if (humanPlayers.length === 1 && npcCount === 0) return socket.emit("error", { code: "NEED_NPC", message: "单人本需要NPC嫌疑人" });
        const totalSlots = (parsed.characters || []).filter(c => c.roleType !== "npc").length;

        // 检查人数是否足够
        if (humanPlayers.length < totalSlots) {
          return socket.emit("error", { code: "NOT_FULL", message: `等待更多玩家加入（${humanPlayers.length}/${totalSlots}人）` });
        }
        // 检查是否所有人已选角色
        const unassigned = humanPlayers.filter(p => !p.characterName);
        if (unassigned.length > 0) {
          return socket.emit("error", { code: "NOT_READY", message: `还有${unassigned.length}名玩家未选择角色` });
        }

        const assigned = humanPlayers.filter(p => p.characterName);

        // 将NPC角色以虚拟玩家身份加入游戏（AI控制）
        const npcChars = parsed.characters?.filter(c => c.roleType === "npc") || [];
        const { getRedis } = require("../modules/game-manager");
        for (let i = 0; i < npcChars.length; i++) {
          const npc = npcChars[i];
          const npcId = "npc_" + roomCode + "_" + i;
          const existingNpc = curPlayers.find(p => p.playerId === npcId);
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
        // 立即进入游戏（不等待AI叙事）
        await updateRoom(roomCode, { status: "playing", phase: "reading", phaseStartedAt: Date.now() });
        io.to(roomCode).emit("game_started", { phase: "reading", config: getPhaseConfig("reading"), narrative: "" });
        io.to(roomCode).emit("phase_changed", { phase: "reading", label: "阅读剧本", narrative: "" });
        (await getRedis()).srem("rooms:open", roomCode);
        // 异步生成开场叙事，通过聊天推送
        generatePhaseNarrative(parsed, "reading", {}).then(async (n) => {
          if (n) {
            await updateRoom(roomCode, { aiNarrative: n });
            io.to(roomCode).emit("narrative", { text: n });
          }
        }).catch(() => {});
        // 阶段推进改为全员确认机制，不再用自动计时器
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
        const clue = pickRandomClue(available);
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

    // 审讯NPC：玩家向NPC嫌疑人提问
    socket.on("ask_npc", async ({ roomCode, npcName, question }) => {
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        // 审讯NPC在搜证和讨论阶段均可使用（阅读和投票阶段不可用）
        if (room.phase === "reading" || room.phase === "lobby") return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段无法审讯NPC" });
        if (!question?.trim()) return socket.emit("error", { code: "EMPTY", message: "请输入问题" });

        const parsed = JSON.parse(room.parsedScript || "{}");
        const npcChar = parsed.characters?.find(c => c.name === npcName && c.roleType === "npc");
        if (!npcChar) return socket.emit("error", { code: "NOT_FOUND", message: "未找到该NPC" });

        const player = players.find(p => p.playerId === socket.id);
        const askerName = player?.characterName || player?.playerName || "未知";

        // 获取最近的聊天记录作为上下文
        const chatHistory = await getChatMessages(roomCode, 10);

        const scriptSummary = {
          title: parsed.title,
          setting: parsed.setting,
          victim: parsed.victim,
        };

        // 先广播玩家的问题
        const qMsg = await addChatMessage(roomCode, socket.id, "NPC:" + npcName, askerName, `🔍 审问 ${npcName}：${question}`, room.phase);
        io.to(roomCode).emit("chat_message", qMsg);

        const response = await generateNpcResponse(npcChar, question, scriptSummary, chatHistory);

        // NPC回复以聊天消息形式广播
        const msg = await addChatMessage(roomCode, "npc_" + npcName, "NPC:" + npcName, npcName, `${response}`, room.phase);
        io.to(roomCode).emit("chat_message", msg);
      } catch (e) { socket.emit("error", { code: "NPC_FAILED", message: e.message }); }
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
        if (room.phase === "truth_reveal" || room.phase === "finished" || room.phase === "lobby") return;
        const { getRedis } = require("../modules/game-manager");
        const r = await getRedis();
        const player = await getPlayer(roomCode, socket.id);
        if (!player) return socket.emit("error", { code: "NOT_IN_ROOM", message: "玩家不在房间内，请刷新页面重新加入" });
        if (player.isNPC) return;

        // 将当前玩家加入就绪集合
        const readyKey = `game:${roomCode}:ready`;
        await r.sadd(readyKey, socket.id);
        const readyCount = await r.scard(readyKey);

        // 统计人类玩家数
        const allPlayers = await getPlayers(roomCode);
        const humanCount = allPlayers.filter(p => !p.isNPC && p.connected).length;

        // 广播就绪状态
        io.to(roomCode).emit("ready_update", { readyCount, totalCount: humanCount, playerName: player.characterName || player.playerName });

        // 所有人就绪则推进
        if (readyCount >= humanCount) {
          await r.del(readyKey);
          io.to(roomCode).emit("ready_update", { readyCount: 0, totalCount: humanCount, advancing: true });
          await autoAdvancePhase(io, roomCode, JSON.parse(room.parsedScript || "{}"));
        }
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
        // 5分钟后未重连则自动离开房间
        const timerKey = code + ":" + socket.id;
        if (disconnectTimers[timerKey]) clearTimeout(disconnectTimers[timerKey]);
        disconnectTimers[timerKey] = setTimeout(async () => {
          try {
            const players = await getPlayers(code);
            const me = players.find(p => p.playerId === socket.id);
            if (me && !me.connected) {
              await removePlayer(code, socket.id);
              const remaining = await getPlayers(code);
              const humanRemaining = remaining.filter(p => !p.isNPC);
              if (humanRemaining.length === 0) {
                const r = await getRedis();
                await r.srem("rooms:open", code);
                await deleteGameRoom(code);
              } else {
                io.to(code).emit("room_updated", { players: remaining, ownerId: (await getRoom(code)).ownerId });
              }
            }
          } catch (e) { /* skip */ }
          delete disconnectTimers[timerKey];
        }, 5 * 60 * 1000); // 5分钟
      }
    });

  });
}

module.exports = { setupGameSocket };
