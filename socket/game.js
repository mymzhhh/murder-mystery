// WebSocket 游戏事件处理

const { verifyToken } = require("../modules/auth");
const { getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer, getClues, assignClue, getPlayerClues, recordVote, getVotes, addChatMessage, getChatMessages } = require("../modules/game-manager");
const { getPhaseConfig, getPhaseRound, getNextPhase, validateAction, getAvailableCluesForPlayer, pickRandomClue, searchClues } = require("../modules/game-engine");
const { generatePhaseNarrative } = require("../modules/dm-agent");
const { generateNpcResponse } = require("../modules/npc-agent");
const { autoAdvancePhase } = require("./ai-dm");

function setupGameSocket(io) {
  const disconnectTimers = {}; // 断线重连计时器
  const phaseTimers = {}; // 阶段推进计时器：{roomCode: timerId}

  io.on("connection", (socket) => {
    console.log(`[socket] ${socket.id}`);

    socket.on("join_room", async ({ roomCode, token }) => {
      try {
        const user = await verifyToken(token);
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
          phase: room.phase,
          playerId: socket.id,
          players: allPlayers.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, connected: p.connected, isNPC: p.isNPC || false, isOwner: p.playerId === updatedRoom.ownerId })),
          myCharacter, myClues, allClues: allCluesRaw, chatMessages: await getChatMessages(roomCode, 50),
          phaseConfig: getPhaseConfig(room.phase), narrative: room.aiNarrative || "",
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
          if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
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
        // 立即进入 reading 阶段，叙事异步生成（不再阻塞玩家等待 LLM）
        await updateRoom(roomCode, { status: "playing", phase: "reading", phaseStartedAt: Date.now(), aiNarrative: "" });
        io.to(roomCode).emit("game_started", { phase: "reading", config: getPhaseConfig("reading"), narrative: "AI DM 正在准备开场叙事..." });
        io.to(roomCode).emit("phase_changed", { phase: "reading", label: "阅读剧本", narrative: "" });
        (await getRedis()).srem("rooms:open", roomCode);

        // 异步生成开场叙事，完成后推送
        generatePhaseNarrative(parsed, "reading", {}).then(async (narrative) => {
          try {
            await updateRoom(roomCode, { aiNarrative: narrative });
            io.to(roomCode).emit("narrative_ready", { phase: "reading", narrative });
          } catch (e) { console.error("[narrative] 推送失败:", e.message); }
        }).catch(e => console.error("[narrative] 生成失败:", e.message));
      } catch (e) { socket.emit("error", { code: "START_FAILED", message: e.message }); }
    });

    socket.on("investigate", async ({ roomCode, query }) => {
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

        // 自然语言搜证 vs 随机发放
        var searchResult;
        if (query && query.trim()) {
          searchResult = searchClues(query, available);
        } else {
          searchResult = { clue: pickRandomClue(available), matchLevel: "random", message: "" };
        }

        const clue = searchResult.clue;
        if (!clue) return socket.emit("error", { code: "NO_CLUES", message: "未找到合适的线索，请稍后再试" });
        await assignClue(roomCode, clue.id, socket.id);
        const finder = players.find(p => p.playerId === socket.id);

        // 有 DM 叙事消息时先发 narrative，再发线索
        if (searchResult.message) {
          io.to(roomCode).emit("chat_message", {
            playerId: "dm", playerName: "DM", characterName: "AI DM",
            content: searchResult.message, timestamp: Date.now(),
          });
        }
        io.to(roomCode).emit("clue_received", { clue, foundBy: finder?.characterName || finder?.playerName || "未知" });
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

        // 倒计时进行中：忽略重复 ready 事件
        const countdownKey = `game:${roomCode}:countdown`;
        if (await r.exists(countdownKey)) return;

        const readyKey = `game:${roomCode}:ready`;
        await r.sadd(readyKey, socket.id);
        const readyCount = await r.scard(readyKey);

        const allPlayers = await getPlayers(roomCode);
        const humanCount = allPlayers.filter(p => !p.isNPC && p.connected).length;

        io.to(roomCode).emit("ready_update", { readyCount, totalCount: humanCount, playerName: player.characterName || player.playerName });

        // 10分钟超时计时器（仅首次）
        if (readyCount === 1 && !phaseTimers[roomCode]) {
          phaseTimers[roomCode] = setTimeout(async () => {
            try {
              const curRoom = await getRoom(roomCode);
              if (!curRoom || curRoom.phase === "truth_reveal" || curRoom.phase === "finished") {
                delete phaseTimers[roomCode];
                return;
              }
              // 10分钟到了，强制推进
              const r2 = await getRedis();
              const curPlayers = await getPlayers(roomCode);
              const curHuman = curPlayers.filter(p => !p.isNPC && p.connected).length;
              await r2.del(readyKey);
              await r2.setex(countdownKey, 30, "1");
              io.to(roomCode).emit("ready_update", { readyCount: 0, totalCount: curHuman, forceAdvance: true, countdown: 5 });
              io.to(roomCode).emit("narrative", { text: "⏰ 等待超时，AI DM 将自动进入下一阶段。" });

              const parsed = JSON.parse(curRoom.parsedScript || "{}");
              const nextPhase = getNextPhase(curRoom.phase);
              const narrativePromise = nextPhase ? generatePhaseNarrative(parsed, nextPhase, { roomCode }) : Promise.resolve("");

              for (let cd = 4; cd >= 0; cd--) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                io.to(roomCode).emit("ready_update", { readyCount: 0, totalCount: curHuman, forceAdvance: true, countdown: cd });
              }
              const preGenNarrative = await narrativePromise;
              await autoAdvancePhase(io, roomCode, parsed, preGenNarrative);
              await r2.del(countdownKey);
              delete phaseTimers[roomCode];
            } catch (e) { await getRedis().del(countdownKey); delete phaseTimers[roomCode]; }
          }, 10 * 60 * 1000); // 10分钟
        }

        // 所有人就绪：取消计时器，立即倒计时推进
        if (readyCount >= humanCount) {
          if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
          await r.setex(countdownKey, 30, "1"); // 互斥锁防重复触发
          await r.del(readyKey);
          io.to(roomCode).emit("ready_update", { readyCount: humanCount, totalCount: humanCount, countdown: 5 });

          const parsed = JSON.parse(room.parsedScript || "{}");
          const nextPhase = getNextPhase(room.phase);
          const narrativePromise = nextPhase ? generatePhaseNarrative(parsed, nextPhase, { roomCode }) : Promise.resolve("");

          for (let cd = 4; cd >= 0; cd--) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            io.to(roomCode).emit("ready_update", { readyCount: humanCount, totalCount: humanCount, countdown: cd });
          }
          const preGenNarrative = await narrativePromise;
          await autoAdvancePhase(io, roomCode, parsed, preGenNarrative);
          await r.del(countdownKey);
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
