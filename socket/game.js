// WebSocket 游戏事件处理

const { verifyToken } = require("../modules/auth");
const { getRedis } = require("../modules/redis-client");
const { getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer, getClues, assignClue, getPlayerClues, recordVote, getVotes, addChatMessage, getChatMessages, addIntroduction, getIntroductions } = require("../modules/game-manager");
const { getPhaseConfig, getPhaseRound, getNextPhase, validateAction, getAvailableCluesForPlayer, pickRandomClue, searchClues } = require("../modules/game-engine");
const { generatePhaseNarrative } = require("../modules/dm-agent");
const { generateNpcResponse } = require("../modules/npc-agent");
const { autoAdvancePhase } = require("./ai-dm");
const { syncAiFillers } = require("../modules/ai-player");
const aiPlayer = require("../modules/ai-player");

function setupGameSocket(io) {
  const disconnectTimers = {};
  const phaseTimers = {};
  // 语音聊天（WebRTC 网状连接）信令：音频本身走点对点，服务端只记录"谁开了语音"
  // 并中转 SDP/ICE，不接触也不转发任何音频数据。
  const voiceRooms = {}; // roomCode → Set<socketId>
  // socketId → Set<roomCode>。必须自己记：socket.io v4 在 disconnect 事件触发前已 leaveAll()，
  // 断线处理器里读 socket.rooms 得到的是空集合（实测：断线后玩家 connected 永远停在 true，
  // 而 humanCount 用 connected 过滤 → 幽灵玩家会让人永远凑不满"全员已准备"，只能等超时）。
  const socketRooms = {};
  function voiceLeave(code, id) {
    const set = voiceRooms[code];
    if (!set) return;
    if (set.delete(id)) io.to(code).emit("voice_leave", { playerId: id });
    if (!set.size) delete voiceRooms[code];
  }

  // async socket handler 错误边界
  function safeHandler(fn) {
    return (...args) => fn(...args).catch(err => {
      console.error("[socket] handler:", err.message);
    });
  }

  const rateLimits = {}; // socketId → { eventName → lastTimestamp }
  const RATE_LIMIT_MS = {
    chat: 800,
    investigate: 1500,
    vote: 2000,
    ready: 3000,
    ask_npc: 2000,
    join_room: 1000,
    intro_statement: 2000,
    ask_ai_player: 3000,
    voice_state: 400,
  };

  function checkRateLimit(socket, eventName) {
    if (!RATE_LIMIT_MS[eventName]) return true;
    const now = Date.now();
    if (!rateLimits[socket.id]) rateLimits[socket.id] = {};
    const last = rateLimits[socket.id][eventName] || 0;
    if (now - last < RATE_LIMIT_MS[eventName]) return false;
    rateLimits[socket.id][eventName] = now;
    return true;
  }

  // 防房间码撞库：对"房间不存在"的连续尝试计数，超阈值临时锁定该房间码
  const failedJoin = {}; // roomCode → { count, windowStart, lockedUntil }
  const FAILED_JOIN_MAX = 20;
  const FAILED_JOIN_WINDOW_MS = 60 * 1000;
  const FAILED_JOIN_LOCK_MS = 10 * 60 * 1000;

  // 房间被删除时释放本模块的房间级内存态。
  // 覆盖生命周期扫描器回收与管理端删除这两条路径 —— 以前它们不清理，
  // phaseTimers / disconnectTimers / voiceRooms / failedJoin 会一直残留到各自超时才消失。
  function cleanupRoomState(code) {
    if (phaseTimers[code]) { clearTimeout(phaseTimers[code]); delete phaseTimers[code]; }
    delete voiceRooms[code];
    delete failedJoin[code];
    for (const key of Object.keys(disconnectTimers)) {
      if (key.startsWith(code + ":")) { clearTimeout(disconnectTimers[key]); delete disconnectTimers[key]; }
    }
    for (const [sid, set] of Object.entries(socketRooms)) {
      if (set && set.has(code)) { set.delete(code); if (!set.size) delete socketRooms[sid]; }
    }
  }
  try { require("../modules/room-cleanup-hooks").onRoomDeleted(cleanupRoomState); } catch (e) { /* ignore */ }

  function markFailedJoin(roomCode) {    const now = Date.now();
    const f = failedJoin[roomCode];
    if (!f || now - f.windowStart > FAILED_JOIN_WINDOW_MS) {
      failedJoin[roomCode] = { count: 1, windowStart: now, lockedUntil: 0 };
      return;
    }
    f.count++;
    if (f.count >= FAILED_JOIN_MAX) f.lockedUntil = now + FAILED_JOIN_LOCK_MS;
  }

  function isJoinLocked(roomCode) {
    const f = failedJoin[roomCode];
    return !!(f && f.lockedUntil > Date.now());
  }

  // 定期清理断线的 rate limit 记录
  setInterval(() => {
    for (const sid of Object.keys(rateLimits)) {
      if (!io.sockets.sockets.get(sid)) delete rateLimits[sid];
    }
    const now = Date.now();
    for (const code of Object.keys(failedJoin)) {
      const f = failedJoin[code];
      if (now - f.windowStart > FAILED_JOIN_WINDOW_MS && f.lockedUntil < now) delete failedJoin[code];
    }
  }, 60000);

  io.on("connection", (socket) => {
    console.log(`[socket] ${socket.id}`);

    socket.on("join_room", async ({ roomCode, token }) => {
      try {
        if (!checkRateLimit(socket, "join_room")) {
          return socket.emit("error", { code: "RATE_LIMITED", message: "操作过于频繁，请稍后再试" });
        }
        const user = await verifyToken(token);
        if (!user) return socket.emit("error", { code: "AUTH", message: "请先登录" });
        const room = await getRoom(roomCode);
        if (!room) {
          markFailedJoin(roomCode);
          if (isJoinLocked(roomCode)) {
            return socket.emit("error", { code: "JOIN_LOCKED", message: "该房间连接尝试次数过多，已临时限制" });
          }
          // 房间可能"已过期"而不是"从未存在"：getRoom 对超过最大存活时间的房间返回 null，
          // 这里把两种可能都告诉用户，避免他反复怀疑自己输错了房号。
          const { expiryText } = require("../modules/room-lifecycle");
          return socket.emit("error", {
            code: "NOT_FOUND",
            message: `房间不存在或已超过保留时间（最长 ${expiryText()}）`,
          });
        }

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
        (socketRooms[socket.id] || (socketRooms[socket.id] = new Set())).add(roomCode);

        // 同步 AI 补位：真人已选角色之外的玩家槽位自动由 AI 扮演
        await syncAiFillers(roomCode);
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
        // 只下发"已被发现"的线索；未发现的线索绝不出网关（防止 devtools 看到全部谜底）
        const foundClues = (allCluesRaw || []).filter(c => c.foundBy && c.foundBy.length > 0).map(c => {
          const finder = allPlayers.find(p => p.playerId === c.foundBy[0]);
          return { ...c, foundByName: finder?.characterName || finder?.playerName || "未知" };
        });
        // 本人发现的线索（私有视角）
        const myClues = foundClues.filter(c => c.foundBy && c.foundBy.includes(socket.id));
        // 角色摘要白名单：绝不下发 script/secret/isMurderer（否则玩家在控制台即可看到凶手与全部秘密）
        const publicCharacters = (parsed.characters || []).map(c => ({
          name: c.name, occupation: c.occupation || "", roleType: c.roleType || "player", gender: c.gender || "",
        }));

        // 检查是否可以开始游戏（AI 会补满剩余角色，真人≥1 且都选好角色即可）
        const totalPlayerSlots = (parsed.characters || []).filter(c => c.roleType !== "npc").length;
        const assignedCount = currentHumans.filter(p => p.characterName).length;
        const aiCount = allPlayers.filter(p => p.isAI).length;
        const allReady = currentHumans.length >= 1 && assignedCount >= currentHumans.length;

        socket.emit("room_state", {
          room: { roomCode, status: room.status, phase: room.phase, ownerId: updatedRoom.ownerId, maxPlayers: room.maxPlayers },
          phase: room.phase,
          playerId: socket.id,
          players: allPlayers.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, connected: p.connected, isNPC: p.isNPC || false, isAI: p.isAI || false, isOwner: p.playerId === updatedRoom.ownerId })),
          myCharacter: myCharacter ? { name: myCharacter.name, occupation: myCharacter.occupation || "", roleType: myCharacter.roleType || "player" } : null,
          myClues, allClues: foundClues, chatMessages: await getChatMessages(roomCode, 50),
          phaseConfig: getPhaseConfig(room.phase), narrative: room.aiNarrative || "",
          scriptSummary: { title: parsed.title, setting: parsed.setting, victim: parsed.victim, layoutDescription: parsed.layoutDescription || "" },
          allCharacters: publicCharacters,
          introData: await getIntroductions(roomCode),
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
        if (socketRooms[socket.id]) socketRooms[socket.id].delete(roomCode);
        voiceLeave(roomCode, socket.id); // 退出房间同时退出语音
        // 清理该玩家的 ready/投票残留（否则继续干扰阶段推进计数）
        try {
          const rr = await getRedis();
          await rr.srem(`game:${roomCode}:ready`, me?.playerName || socket.id);
          await rr.hdel(`game:${roomCode}:votes`, socket.id);
        } catch (e) { /* ignore */ }
        const remaining = await getPlayers(roomCode);
        const humanRemaining = remaining.filter(p => !p.isNPC);

        // 房主离开时转让给随机其他人
        if (room.ownerId === socket.id && humanRemaining.length > 0) {
          const newOwner = humanRemaining[Math.floor(Math.random() * humanRemaining.length)];
          await updateRoom(roomCode, { ownerId: newOwner.playerId });
        }

        if (humanRemaining.length === 0) {
          if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
          aiPlayer.cancelRoom(roomCode);
          const { getRedis } = require("../modules/game-manager");
          const r2 = await getRedis();
          await r2.srem("rooms:open", roomCode);
          await deleteGameRoom(roomCode);
        } else {
          // 游戏中离场：该角色由 AI 接管（否则角色槽位悬空：线索仍指向他、投票候选消失）
          if (room.phase && room.phase !== "lobby") {
            try { await syncAiFillers(roomCode); } catch (e) { console.warn("[leave_room] AI 接管失败:", e.message); }
          }
          const updatedRoom = await getRoom(roomCode);
          io.to(roomCode).emit("room_updated", { players: await getPlayers(roomCode), ownerId: updatedRoom.ownerId });
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
        // AI 补位的角色真人可随时抢占（TAKEN 只针对真人）
        if (players.some(p => !p.isAI && p.characterName === characterName)) return socket.emit("error", { code: "TAKEN", message: "角色已被选择" });
        await updatePlayer(roomCode, socket.id, { characterName, characterScript: JSON.stringify(char) });
        socket.emit("character_selected", { characterName, character: char, isMurderer: char.isMurderer });
        // 重新对齐 AI 补位（真人抢走 AI 角色后，AI 释放并补齐其它剩余角色）
        const after = await syncAiFillers(roomCode);
        io.to(roomCode).emit("room_updated", { players: after, ownerId: room.ownerId });
      } catch (e) { socket.emit("error", { code: "SELECT_FAILED", message: e.message }); }
    });

    socket.on("start_game", async ({ roomCode }) => {
      try {
        const room = await getRoom(roomCode);
        // 只有房主可以开始游戏
        if (room.ownerId && room.ownerId !== socket.id) {
          return socket.emit("error", { code: "NOT_OWNER", message: "只有房主可以开始游戏" });
        }
        // 阶段守卫：仅大厅阶段可开局（防止重复/重放事件把进行中的游戏倒回 reading、重复补位）
        if (room.phase !== "lobby") {
          return socket.emit("error", { code: "WRONG_PHASE", message: "游戏已经开始，无法重复开局" });
        }
        const curPlayers = await getPlayers(roomCode);
        const humanPlayers = curPlayers.filter(p => !p.isNPC);
        if (humanPlayers.length < 1) return socket.emit("error", { code: "NOT_ENOUGH", message: "至少需要1名玩家" });

        const parsed = JSON.parse(room.parsedScript || "{}");

        // 单人本检查：只有剧本本身是单人本（1 个玩家槽位）且无 NPC 嫌疑人才阻止开局
// （1 真人 + AI 补位的多人本凶手在玩家槽位里，不需要 NPC 嫌疑人）
        const npcCount = (parsed.characters || []).filter(c => c.roleType === "npc").length;
        const totalSlots = (parsed.characters || []).filter(c => c.roleType !== "npc").length;
        if (totalSlots === 1 && npcCount === 0) return socket.emit("error", { code: "NEED_NPC", message: "单人本需要NPC嫌疑人" });
        // 检查是否所有人已选角色（AI 会补满剩余槽位）
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
        // 同步 AI 补位玩家（真人选角后剩余槽位由 AI 扮演）
        await syncAiFillers(roomCode);
        // 重新获取完整玩家列表（含 NPC 审讯角色 + AI 补位）
        const allPlayers = await getPlayers(roomCode);

        for (const p of assigned) {
          const char = parsed.characters?.find(c => c.name === p.characterName);
          if (char) io.to(p.playerId).emit("character_assigned", { characterName: p.characterName, character: char, isMurderer: char.isMurderer || false });
        }
        // 立即进入 reading 阶段，叙事异步生成（不再阻塞玩家等待 LLM）
        await updateRoom(roomCode, { status: "playing", phase: "reading", phaseStartedAt: Date.now(), aiNarrative: "" });
        io.to(roomCode).emit("game_started", { phase: "reading", config: getPhaseConfig("reading"), narrative: "AI DM 正在准备开场叙事..." });
        io.to(roomCode).emit("phase_changed", { phase: "reading", label: "阅读剧本", config: getPhaseConfig("reading"), narrative: "" });
        (await getRedis()).srem("rooms:open", roomCode);
        // 调度 AI 玩家行为（reading 阶段无行动，下一阶段由 ready 推进时调度）
        aiPlayer.scheduleRoom(io, roomCode, "reading");

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
      if (!checkRateLimit(socket, "investigate")) return;
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
        // 并发安全：用 SET NX 抢占线索，避免两人同时搜证拿到同一条
        // （此前"读时过滤 + SADD"在并发下会重复发放同一条线索）
        const r2 = await getRedis();
        let clue = null;
        let dmMessage = "";
        let pool = available.slice();
        for (let i = 0; i < 6 && pool.length; i++) {
          let cand = null;
          if (query && query.trim()) {
            const sr = searchClues(query, pool);
            cand = sr.clue;
            if (sr.message) dmMessage = sr.message;
          } else {
            cand = pickRandomClue(pool);
          }
          if (!cand) break;
          const claimed = await r2.set(`game:${roomCode}:claim:${cand.id}`, socket.id, "EX", 3600, "NX");
          if (claimed) { clue = cand; break; }
          pool = pool.filter(c => c.id !== cand.id); // 已被抢走，换下一条
        }
        if (!clue) return socket.emit("error", { code: "NO_CLUES", message: "线索已被其他玩家取走，请稍后再试" });
        await assignClue(roomCode, clue.id, socket.id);
        const finder = players.find(p => p.playerId === socket.id);

        // 有 DM 叙事消息时先发 narrative，再发线索
        if (dmMessage) {
          io.to(roomCode).emit("chat_message", {
            playerId: "dm", playerName: "DM", characterName: "AI DM",
            content: dmMessage, timestamp: Date.now(),
          });
        }
        io.to(roomCode).emit("clue_received", { clue, foundBy: finder?.characterName || finder?.playerName || "未知" });
      } catch (e) { socket.emit("error", { code: "INVESTIGATE_FAILED", message: e.message }); }
    });

    socket.on("chat", async ({ roomCode, content }) => {
      if (!checkRateLimit(socket, "chat")) return;
      try {
        const room = await getRoom(roomCode);
        const player = await getPlayer(roomCode, socket.id);
        const val = validateAction("send_chat", { phase: room.phase, players: await getPlayers(roomCode) }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message });
        const msg = await addChatMessage(roomCode, socket.id, player?.playerName || "", player?.characterName || "", content, room.phase);
        io.to(roomCode).emit("chat_message", msg);
        // 真人在聊天里点名某位 AI 角色并提问时，让该 AI 作答。
        // 只认"点名 + 问号"，避免 AI 对每句话都插嘴刷屏。
        aiPlayer.maybeAnswerMention(io, roomCode, content, player?.characterName || player?.playerName || "")
          .catch(() => {});
      } catch (e) { socket.emit("error", { code: "CHAT_FAILED", message: e.message }); }
    });

    // 开场介绍：玩家向全员交代角色故事与时间线
    socket.on("intro_statement", async ({ roomCode, content }) => {
      if (!checkRateLimit(socket, "intro_statement")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room || room.phase !== "intro") return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段不能提交介绍" });
        const text = String(content || "").trim();
        if (!text) return socket.emit("error", { code: "EMPTY", message: "介绍内容不能为空" });
        if (text.length > 1000) return socket.emit("error", { code: "TOO_LONG", message: "介绍请控制在1000字以内" });
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        const who = me?.characterName || me?.playerName || "未知";
        await addIntroduction(roomCode, who, text);
        // 只发一条"会被渲染成聊天记录"的事件。
        // 历史 bug：这里另外还 emit 了 intro_statement，前端把它和下面这条 chat_message
        // 双双追加进聊天列表，于是同一次自我介绍显示两遍（一条带 📣 前缀、一条不带）。
        // 自我介绍统一以聊天消息为准：它会被持久化，重连/刷新后仍能从 chatMessages 恢复。
        // addIntroduction 保留，结构化数据仍通过 room_state.introData 下发。
        const msg = await addChatMessage(roomCode, socket.id, me?.playerName || "", who, `📣【自我介绍】${text}`, room.phase);
        io.to(roomCode).emit("chat_message", msg);
      } catch (e) { socket.emit("error", { code: "INTRO_FAILED", message: e.message }); }
    });

    // 玩家向 AI 玩家审讯提问（AI 仅依据自己的剧本/线索回答，全员可见）
    socket.on("ask_ai_player", async ({ roomCode, characterName, question }) => {
      if (!checkRateLimit(socket, "ask_ai_player")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room || ["lobby", "reading"].includes(room.phase)) {
          return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段不能询问AI玩家" });
        }
        const q = String(question || "").trim();
        if (!q) return socket.emit("error", { code: "EMPTY", message: "请输入问题" });
        if (q.length > 500) return socket.emit("error", { code: "TOO_LONG", message: "问题请控制在500字以内" });
        const players = await getPlayers(roomCode);
        const ai = players.find(p => p.isAI && p.characterName === characterName);
        if (!ai) return socket.emit("error", { code: "NOT_FOUND", message: "未找到该AI玩家" });
        const asker = players.find(p => p.playerId === socket.id);
        // 必须是在房玩家才能提问（否则任意连接可刷 LLM 成本）
        if (!asker) return socket.emit("error", { code: "NOT_IN_ROOM", message: "你不在该房间内" });
        const askerName = asker?.characterName || asker?.playerName || "玩家";

        // AI 回答（LLM + 规则回退）
        let answer = null;
        try {
          const aiLlm = require("../modules/ai-player-llm");
          const parsed = JSON.parse(room.parsedScript || "{}");
          const k = await aiLlm.buildKnowledge(roomCode, ai, parsed);
          const history = await aiLlm.getPublicContext(roomCode, 8);
          answer = await aiLlm.answerLLM(k, askerName, q, history);
        } catch (e) { console.warn("[ai-player] ask LLM 失败:", e.message); }
        if (!answer) {
          answer = `🤖 ${ai.characterName || "AI"}：我这边暂时没有更多线索，关于这个问题我知道的就是剧本中提到的情况，目前还不好下结论。`;
        }

        // 问题与回答广播（全员可见，辅助集体推理）
        // 只发聊天消息：它会持久化，重连/刷新后仍能从 chatMessages 恢复。
        // 历史 bug：这里另外还 emit 了 ai_answer，而前端把它也追加进聊天列表，
        // 于是同一个回答显示两遍（与自我介绍重复显示是同一类问题）。
        const qMsg = await addChatMessage(roomCode, socket.id, asker?.playerName || "", askerName, `🎤 向 ${ai.characterName || "AI"}（AI玩家）提问：${q}`, room.phase);
        io.to(roomCode).emit("chat_message", qMsg);
        const aMsg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", answer, room.phase);
        io.to(roomCode).emit("chat_message", aMsg);
      } catch (e) { socket.emit("error", { code: "ASK_AI_FAILED", message: e.message }); }
    });

    // 审讯NPC：玩家向NPC嫌疑人提问
    socket.on("ask_npc", async ({ roomCode, npcName, question }) => {
      if (!checkRateLimit(socket, "ask_npc")) return;
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        // 审讯NPC在搜证和讨论阶段均可使用（阅读和投票阶段不可用）
        if (room.phase === "reading" || room.phase === "lobby") return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段无法审讯NPC" });
        if (!question?.trim()) return socket.emit("error", { code: "EMPTY", message: "请输入问题" });
        const qText = String(question).trim();
        if (qText.length > 500) return socket.emit("error", { code: "TOO_LONG", message: "问题请控制在500字以内" });
        // 必须是在房玩家才能审讯（防任意连接刷 LLM 成本）
        const askerPlayer = players.find(p => p.playerId === socket.id);
        if (!askerPlayer) return socket.emit("error", { code: "NOT_IN_ROOM", message: "你不在该房间内" });

        const parsed = JSON.parse(room.parsedScript || "{}");
        const npcChar = parsed.characters?.find(c => c.name === npcName && c.roleType === "npc");
        if (!npcChar) return socket.emit("error", { code: "NOT_FOUND", message: "未找到该NPC" });

        const player = askerPlayer;
        const askerName = player?.characterName || player?.playerName || "未知";

        // 每局每个NPC的提问次数上限（防止上下文无限膨胀、LLM成本失控）
        const NPC_MAX_QUESTIONS = 20;
        const r = getRedis();
        const qKey = `game:${roomCode}:npcq:${npcName}`;
        const asked = parseInt(await r.get(qKey)) || 0;
        if (asked >= NPC_MAX_QUESTIONS) {
          return socket.emit("error", { code: "NPC_LIMIT", message: `该NPC已被盘问过${NPC_MAX_QUESTIONS}次，去和其他人聊聊吧` });
        }
        await r.incr(qKey);
        await r.expire(qKey, 3 * 3600); // 3小时覆盖一局游戏时长，局后自动清理

        // 获取最近的聊天记录作为上下文
        const chatHistory = await getChatMessages(roomCode, 12);

        // 全场已公开的线索：玩家常常引用线索来质证 NPC（"有人看见你20:35在走廊"），
        // 不把这些给它，NPC 只会在自己的剧本范围内打转、答非所问。
        const allCluesForNpc = await getClues(roomCode);
        const publicCluesForNpc = (allCluesForNpc || [])
          .filter(c => (c.foundBy || []).length > 0)
          .map(c => `【${c.id || "线索"}】${String(c.content || "").substring(0, 200)}${c.location ? "（发现于 " + c.location + "）" : ""}`);

        const scriptSummary = {
          title: parsed.title,
          setting: parsed.setting,
          victim: parsed.victim,
          gameMode: parsed.setting?.gameMode || "",
          roomCode, // 供 opencode 网关做"每段对话一个稳定会话"的路由与提示词缓存
          publicClues: publicCluesForNpc,
        };
        const npcForAgent = { ...npcChar, roleMode: parsed.setting?.gameMode || "" };

        // 先广播玩家的问题
        const qMsg = await addChatMessage(roomCode, socket.id, "NPC:" + npcName, askerName, `🔍 审问 ${npcName}：${question}`, room.phase);
        io.to(roomCode).emit("chat_message", qMsg);

        const response = await generateNpcResponse(npcForAgent, question, scriptSummary, chatHistory);

        // NPC回复以聊天消息形式广播
        const msg = await addChatMessage(roomCode, "npc_" + npcName, "NPC:" + npcName, npcName, `${response}`, room.phase);
        io.to(roomCode).emit("chat_message", msg);
      } catch (e) { socket.emit("error", { code: "NPC_FAILED", message: e.message }); }
    });

    socket.on("vote", async ({ roomCode, targetCharacterName }) => {
      if (!checkRateLimit(socket, "vote")) return;
      try {
        const room = await getRoom(roomCode);
        const allPlayers = await getPlayers(roomCode);
        const player = allPlayers.find(p => p.playerId === socket.id);
        if (!player) return socket.emit("error", { code: "NOT_FOUND", message: "玩家不存在" });
        const val = validateAction("cast_vote", { phase: room.phase, players: allPlayers }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message || "当前阶段无法投票" });
        // 检查投票目标是否存在（真人角色 + AI 补位角色 + 审讯NPC角色）
        const humanPlayers = allPlayers.filter(p => !p.isNPC);
        const parsed = JSON.parse(room.parsedScript || "{}");
        const gameMode = (parsed.setting?.gameMode || "").toUpperCase();
        const npcInVote = gameMode !== "PVP"; // PVP 下 NPC 是目击者/关系人，不进投票
        const npcNames = npcInVote ? (parsed.characters || []).filter(c => c.roleType === "npc").map(c => c.name) : [];
        const aiNames = allPlayers.filter(p => p.isAI && p.characterName).map(p => p.characterName);
        const allCharNames = [...new Set([...humanPlayers.map(p => p.characterName).filter(Boolean), ...aiNames, ...npcNames])];
        if (!allCharNames.includes(targetCharacterName)) return socket.emit("error", { code: "INVALID_TARGET", message: "投票目标不存在" });
        // 不可投自己（剧本杀投票是"指认他人为凶手"）
        if (player.characterName && player.characterName === targetCharacterName) {
          return socket.emit("error", { code: "SELF_VOTE", message: "不能投票给自己" });
        }
        // 已投票不可改（防反复覆盖：此前 HSET 会静默改写，导致票数统计被操纵）
        const existingVotes = await getVotes(roomCode);
        if (existingVotes && existingVotes[socket.id]) {
          return socket.emit("error", { code: "ALREADY_VOTED", message: "你已投过票，不能更改" });
        }
        await recordVote(roomCode, socket.id, targetCharacterName);
        socket.emit("vote_recorded", { target: targetCharacterName });
        const votes = await getVotes(roomCode);
        const aiCount = allPlayers.filter(p => p.isAI && p.characterName).length;
        io.to(roomCode).emit("vote_update", { count: Object.keys(votes).length, total: humanPlayers.length + aiCount });
      } catch (e) { socket.emit("error", { code: "VOTE_FAILED", message: e.message }); }
    });

    socket.on("ready", async ({ roomCode }) => {
      if (!checkRateLimit(socket, "ready")) return;
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
        // 用稳定的玩家标识（playerName）而非 socket.id 作为成员：
        // 重连会换 socket.id，旧成员残留会让 readyCount 提前达标
        await r.sadd(readyKey, player.playerName || socket.id);
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
              aiPlayer.scheduleRoom(io, roomCode, nextPhase);
              await r2.del(countdownKey);
              delete phaseTimers[roomCode];
            } catch (e) { await getRedis().del(countdownKey); delete phaseTimers[roomCode]; }
          }, 10 * 60 * 1000); // 10分钟
        }

        // 所有人就绪：取消计时器，立即倒计时推进
        if (readyCount >= humanCount) {
          if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
          // 原子抢锁：SET NX EX 只有一个调用者能成功，避免并发 ready 导致双推进（round1 直接跳 voting）
          const gotLock = await r.set(countdownKey, "1", "EX", 30, "NX");
          if (!gotLock) return;
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
          aiPlayer.scheduleRoom(io, roomCode, nextPhase);
          await r.del(countdownKey);
        }
      } catch (e) { socket.emit("error", { code: "READY_FAILED", message: e.message }); }
    });

    // ==================== 语音聊天（WebRTC 信令中转） ====================
    // 两个开关的语义（都在客户端一侧生效，服务端只做成员管理）：
    //   micOn    「向其他人说话」：是否把自己的麦克风轨加入连接
    //   listenOn 「接收其他人说话」：是否播放收到的远端音频
    socket.on("voice_join", async ({ roomCode }) => {
      try {
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        if (!me) return socket.emit("error", { code: "NOT_IN_ROOM", message: "你不在该房间内" });
        if (me.isNPC || me.isAI) return; // 虚拟角色不参与语音
        const set = voiceRooms[roomCode] || (voiceRooms[roomCode] = new Set());
        // 新加入者向"已在语音中的成员"发起 offer，方向固定，避免双方同时发起造成 glare
        const peers = [...set].filter(id => id !== socket.id);
        set.add(socket.id);
        // 名册里只有 socketId，必须连名字一起下发，否则新加入者的成员列表上全是乱码 ID
        const names = {};
        for (const id of peers) {
          const p = players.find(x => x.playerId === id);
          if (p) names[id] = p.characterName || p.playerName;
        }
        socket.emit("voice_roster", { peers, names, self: socket.id });
        socket.to(roomCode).emit("voice_join", {
          playerId: socket.id,
          playerName: me.characterName || me.playerName,
        });
      } catch (e) { socket.emit("error", { code: "VOICE_JOIN_FAILED", message: e.message }); }
    });

    socket.on("voice_leave", ({ roomCode }) => {
      voiceLeave(roomCode, socket.id);
      const set = voiceRooms[roomCode];
      socket.emit("voice_roster", { peers: set ? [...set].filter(id => id !== socket.id) : [], self: socket.id });
    });

    // SDP / ICE 中转：只按 socketId 点对点转发
    socket.on("voice_signal", ({ to, data }) => {
      if (!to || !data) return;
      io.to(to).emit("voice_signal", { from: socket.id, data });
    });

    // 广播开关状态，供其他玩家看到"谁开了麦 / 谁没在听"
    socket.on("voice_state", async ({ roomCode, micOn, listenOn }) => {
      if (!checkRateLimit(socket, "voice_state")) return;
      try {
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        if (!me) return;
        io.to(roomCode).emit("voice_state", {
          playerId: socket.id,
          playerName: me.characterName || me.playerName,
          micOn: !!micOn,
          listenOn: !!listenOn,
        });
      } catch (e) { /* ignore */ }
    });

    socket.on("disconnect", async () => {
      delete rateLimits[socket.id]; // 即时清理，不等定时器
      try {
        // 用 socket.io 自身的房间集合定位（不能依赖 rooms:open——开局时房间已被 srem，
        // 历史 bug：开局后断线处理器对所有房间空转，connected 永不落库、幽灵玩家不清理）
        // socket.io v4 在 emit("disconnect") 之前已执行 leaveAll()，此处 socket.rooms 为空集合。
        // 因此以自己维护的 socketRooms 为主，socket.rooms 仅作兜底。
        const joined = [...new Set([
          ...(socketRooms[socket.id] ? [...socketRooms[socket.id]] : []),
          ...[...socket.rooms].filter(c => c !== socket.id),
        ])];
        delete socketRooms[socket.id];
        for (const code of joined) {
          try { await updatePlayer(code, socket.id, { connected: false }); } catch (e) { /* skip */ }
          voiceLeave(code, socket.id); // 断线即退出语音（重连后由客户端重新加入）
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
                  aiPlayer.cancelRoom(code);
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
      } catch (e) { console.warn("[socket] disconnect 处理异常:", e.message); }
    });

  });
}

module.exports = { setupGameSocket };
