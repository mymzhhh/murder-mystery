// WebSocket 游戏事件处理

const { verifyToken } = require("../core/auth");
const { getRedis } = require("../core/redis-client");
const { getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer, getClues, assignClue, getPlayerClues, recordVote, getVotes, addChatMessage, getChatMessages, addIntroduction, getIntroductions, claimClue, digClue, claimCharacter, releaseCharacterClaim, consumeSearchQuota, getSearchQuota, SEARCH_MAX_PER_ROUND, revealClue, shareClue, addWhisper, getWhispersFor } = require("../game/game-manager");
const { buildRoundSearchLocations, cluesAtLocation, pickClueAtLocation, availableClues } = require("../game/search-locations");
const { getPhaseConfig, getPhaseRound, getNextPhase, validateAction, visibleClues, clueVisibilityOf, PHASE_DEADLINE_MS, needsPhaseDeadline } = require("../game/game-engine");
const { generatePhaseNarrative } = require("../game/dm-agent");
const { generateNpcResponse } = require("../game/npc-agent");
const { autoAdvancePhase } = require("./ai-dm");
const { syncAiFillers } = require("../game/ai-player");
const aiPlayer = require("../game/ai-player");

function setupGameSocket(io) {
  const disconnectTimers = {};
  // 断线多久算"人走了"：超过这个时间仍未重连就踢出房间，并由 AI 接管其角色。
  // 只有断开超过 AFK_KICK_MS 才动手，短暂掉线（刷新页面、切网络）不会被误踢。
  const AFK_KICK_MS = Math.max(60 * 1000, (Number(process.env.AFK_KICK_MIN || 5) || 5) * 60 * 1000);
  const phaseTimers = {};

  // ==================== 阶段推进：就绪阈值与倒计时 ====================
  // 原来的规则是"全员就绪 → 5 秒推进；否则干等 10 分钟超时"。
  // 问题是只要有一个真人挂着不点，全桌就得干等十分钟；而玩家反馈正是"因某人不动而无法推进"。
  // 现在分两档：
  //   · 全员就绪        → ALL_READY_SECONDS（默认 10 秒）后推进
  //   · 只差一个人就绪  → PARTIAL_READY_SECONDS（默认 60 秒）倒计时后自动推进
  // 两者都保留 10 分钟的阶段兜底（见 armPhaseDeadline），确保任何情况下都不会永久卡住。
  //
  // ⚠ 这一整块（状态 + 函数）必须留在 setupGameSocket 作用域，绝不能挪进下面 io.on("connection") 的回调。
  //   挪进去就变成"每个 socket 各一份"：A 点准备起了 60 秒倒计时，B 随后点准备想取消它时
  //   读到的是自己那份空表（实测日志：cancel run=false keys=），于是旧倒计时停不下来，
  //   桌上同时收到两个倒计时数字（all cd=2 与 partial cd=48 交替下发）。
  const ALL_READY_SECONDS = Math.max(3, Number(process.env.ALL_READY_SECONDS || 10) || 10);
  const PARTIAL_READY_SECONDS = Math.max(10, Number(process.env.PARTIAL_READY_SECONDS || 60) || 60);
  // 阶段兜底时长统一由 game-engine 提供：ai-player 算"AI 出手节奏"用的是同一个值，
  // 两处各写一份环境变量迟早会漂移（后果是安排的动作来不及在阶段内执行完）。
  const PHASE_MAX_WAIT_MS = PHASE_DEADLINE_MS;
  const REASON_ALL = "全员已准备";

  /** 进行中的倒计时：roomCode → { cancelled, reason, seconds } */
  const readyCountdowns = {};

  /** 取消进行中的倒计时，并立刻释放锁（随后可能马上起一个更短的倒计时） */
  async function cancelReadyCountdown(roomCode) {
    const run = readyCountdowns[roomCode];
    if (run) run.cancelled = true;
    // 立刻删锁：否则紧接着要起的"全员就绪"倒计时会因 SET NX 失败而根本起不来
    await getRedis().del(`game:${roomCode}:countdown`).catch(() => {});
  }

  /**
   * 倒计时结束后自动推进阶段。
   * 用"带 token 的 SET NX"抢锁：并发的 ready 只有一个能推进（原来的锁机制保留），
   * 且被取消的旧倒计时不会误删新倒计时的锁（token 不匹配就不删）。
   * @returns {Promise<boolean>} 是否真正完成了推进
   */
  async function advanceAfterCountdown(io, roomCode, seconds, reason, meta = {}) {
    const r = getRedis();
    const countdownKey = `game:${roomCode}:countdown`;
    const token = Date.now() + ":" + Math.random().toString(36).slice(2, 8);
    const got = await r.set(countdownKey, token, "EX", seconds + 20, "NX");
    if (!got) return false;

    const run = { cancelled: false, reason, seconds };
    readyCountdowns[roomCode] = run;
    try {
      const room = await getRoom(roomCode);
      if (!room) return false;
      const parsed = JSON.parse(room.parsedScript || "{}");
      const nextPhase = getNextPhase(room.phase);
      // 提前并行生成叙事，别让倒计时走完还要再等一次 LLM
      const narrativePromise = nextPhase ? generatePhaseNarrative(parsed, nextPhase, { roomCode }) : Promise.resolve("");

      for (let cd = seconds; cd >= 1; cd--) {
        if (run.cancelled) return false;
        io.to(roomCode).emit("ready_update", {
          readyCount: meta.readyCount || 0, totalCount: meta.totalCount || 0,
          countdown: cd, reason, mode: meta.mode || "",
        });
        await new Promise(res => setTimeout(res, 1000));
      }
      if (run.cancelled) return false;

      await r.del(`game:${roomCode}:ready`).catch(() => {});
      const preGen = await narrativePromise;
      await autoAdvancePhase(io, roomCode, parsed, preGen);
      aiPlayer.scheduleRoom(io, roomCode, nextPhase);
      // 进入下一阶段后重新装兜底计时器（reading/intro/round1/round2 才需要）
      armPhaseDeadline(io, roomCode, nextPhase);
      io.to(roomCode).emit("narrative", { text: `⏱ ${reason}，已自动进入下一阶段。` });
      return true;
    } finally {
      // 只在锁仍属于自己时才删，避免把后来者的倒计时锁误删
      const cur = await r.get(countdownKey).catch(() => null);
      if (cur === token) await r.del(countdownKey).catch(() => {});
      if (readyCountdowns[roomCode] === run) delete readyCountdowns[roomCode];
    }
  }

  /** 阶段兜底：进入需要"就绪"的阶段后，无论如何 10 分钟内推进一次 */
  function armPhaseDeadline(io, roomCode, phase) {
    // 哪些阶段需要兜底由 game-engine 的 needsPhaseDeadline 统一决定（可被单测钉住）。
    // ⚠️ voting 必须在列：实测有房间因前端投票页无可投对象而**永久**停在投票阶段
    // （原来这个白名单是写在这里的字面量，恰好漏了 voting，与注释里的保证相矛盾）。
    if (!needsPhaseDeadline(phase)) return;
    if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
    phaseTimers[roomCode] = setTimeout(async () => {
      try {
        const cur = await getRoom(roomCode);
        if (!cur || cur.phase !== phase) return;
        const players = await getPlayers(roomCode);
        const humanCount = players.filter(p => !p.isNPC && p.connected).length;
        await advanceAfterCountdown(io, roomCode, 5, "⏰ 等待超时（AI DM 接管）", { readyCount: 0, totalCount: humanCount, mode: "timeout" });
      } catch (e) { /* 忽略 */ } finally { delete phaseTimers[roomCode]; }
    }, PHASE_MAX_WAIT_MS);
  }

  // 语音聊天（WebRTC 网状连接）信令：音频本身走点对点，服务端只记录"谁开了语音"
  // 并中转 SDP/ICE，不接触也不转发任何音频数据。
  const voiceRooms = {}; // roomCode → Set<socketId>
  // socketId → roomCode（反向索引）。voice_signal 只带 {to, data}，没有房号，
  // 必须靠这张表才知道"这个 socket 属于哪个语音房间"，从而校验转发目标是否同房。
  const voiceSocketRoom = {};

  /**
   * 玩家记录 → 可以下发给客户端的字段白名单。
   *
   * 玩家记录里存着 characterScript —— 那是**完整角色对象**（整篇个人剧本 + secret + isMurderer），
   * AI 补位与叙事生成要用，属于服务端内部数据。历史上 room_updated 直接把 getPlayers() 原样广播，
   * 于是同房间任何人（甚至没选角色、只是旁观的）打开 DevTools 的 WS 面板就能看到：
   *   "characterScript":"{\"name\":\"沈砚\",\"isMurderer\":true,..."
   * 以及凶手完整的作案过程与别人的秘密（实测单帧 28KB）。
   * room_state 一直做对了（有 publicCharacters 白名单），room_updated 漏了同一道防线。
   *
   * ⚠ 所有面向客户端的玩家列表都必须走这里，不要再出现 emit(..., { players: await getPlayers() }).
   */
  function publicPlayers(players, ownerId) {
    return (players || []).filter(Boolean).map(p => ({
      playerId: p.playerId,
      playerName: p.playerName,
      characterName: p.characterName || "",
      connected: !!p.connected,
      isNPC: !!p.isNPC,
      isAI: !!p.isAI,
      isAlive: p.isAlive !== false,
      ...(ownerId !== undefined ? { isOwner: p.playerId === ownerId } : {}),
    }));
  }
  // socketId → Set<roomCode>。必须自己记：socket.io v4 在 disconnect 事件触发前已 leaveAll()，
  // 断线处理器里读 socket.rooms 得到的是空集合（实测：断线后玩家 connected 永远停在 true，
  // 而 humanCount 用 connected 过滤 → 幽灵玩家会让人永远凑不满"全员已准备"，只能等超时）。
  const socketRooms = {};
  function voiceLeave(code, id) {
    const set = voiceRooms[code];
    if (voiceSocketRoom[id] === code) delete voiceSocketRoom[id];
    if (!set) return;
    if (set.delete(id)) io.to(code).emit("voice_leave", { playerId: id });
    if (!set.size) delete voiceRooms[code];
  }

  // voice_signal 是高频事件：trickle ICE 会一次连着来几十条候选，
  // 用"最小间隔"限流会丢掉候选、导致连不上。改成滑动窗口计数：
  // 正常一局每秒几条，给到 3 秒 60 条足够宽松，同时能挡住刷帧。
  const voiceSignalLog = {}; // socketId → number[]
  const VOICE_SIGNAL_WINDOW_MS = 3000;
  const VOICE_SIGNAL_MAX = 60;
  function voiceSignalAllowed(id) {
    const now = Date.now();
    const arr = (voiceSignalLog[id] || []).filter(t => now - t < VOICE_SIGNAL_WINDOW_MS);
    arr.push(now);
    voiceSignalLog[id] = arr;
    return arr.length <= VOICE_SIGNAL_MAX;
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
    reveal_clue: 800,
    share_clue: 800,
    whisper: 800,
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
    // 倒计时也要停：房间都没了，再往下推进只会对空气广播
    if (readyCountdowns[code]) readyCountdowns[code].cancelled = true;
    delete readyCountdowns[code];
    if (voiceRooms[code]) for (const id of voiceRooms[code]) { if (voiceSocketRoom[id] === code) delete voiceSocketRoom[id]; }
    delete voiceRooms[code];
    delete failedJoin[code];
    for (const key of Object.keys(disconnectTimers)) {
      if (key.startsWith(code + ":")) { clearTimeout(disconnectTimers[key]); delete disconnectTimers[key]; }
    }
    for (const [sid, set] of Object.entries(socketRooms)) {
      if (set && set.has(code)) { set.delete(code); if (!set.size) delete socketRooms[sid]; }
    }
  }
  try { require("../game/room-cleanup-hooks").onRoomDeleted(cleanupRoomState); } catch (e) { /* ignore */ }

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
          const { expiryText } = require("../game/room-lifecycle");
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
        const isReturning = !!(byUsername || bySocketId);

        // ⚠ 两条准入校验（原来一条都没有，实测：maxPlayers=2 的房间能进 4 个人；
        //   而且任何人都能用房间号闯进一局进行中的牌 —— 他的 ready 会被算进人数
        //   把全桌推进押着走，还能 investigate 从线索池里拿走线索、投票影响结局。
        //   房间号不是秘密：/api/player/rooms 会把开放房间直接列给任何登录用户。）

        // 1) 进行中的局不收新人，原班底掉线重连不受影响
        if (room.phase !== "lobby" && !isReturning) {
          return socket.emit("error", {
            code: "GAME_STARTED",
            message: "这局已经开始，无法中途加入。如果你是掉线重连，请用原来那个账号登录。",
          });
        }

        // 2) 人数上限（只算真人；AI 补位不占名额）
        const maxPlayers = parseInt(room.maxPlayers, 10) || 6;
        if (!isReturning && humanPlayers.length >= maxPlayers) {
          return socket.emit("error", {
            code: "ROOM_FULL",
            message: `房间已满（${humanPlayers.length}/${maxPlayers}），请换一个房间。`,
          });
        }

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
        const nameOfPlayer = (pid) => {
          const p = allPlayers.find(x => x.playerId === pid);
          return p?.characterName || p?.playerName || "未知";
        };
        // 只下发**该玩家可见**的线索：自己找到的 / 已被公开的 / 别人单独分享给他的。
        // 未发现、也未分享给他的线索绝不出网关（否则在 devtools 里能看到全部谜底）。
        // 可见性判定统一走 game-engine，AI 知识构建用的是同一套，避免两边口径不一致。
        const myClues = visibleClues(allCluesRaw, socket.id).map(c => ({
          ...c,
          visibility: clueVisibilityOf(c, socket.id),
          foundByName: (c.foundBy || []).map(nameOfPlayer).join("、") || "未知",
        }));
        // 全场已公开的线索（前端"公开线索"分组用）
        const allClues = (allCluesRaw || []).filter(c => c.revealed).map(c => ({
          ...c,
          foundByName: (c.foundBy || []).map(nameOfPlayer).join("、") || "未知",
        }));
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
          room: { roomCode, status: room.status, phase: room.phase, ownerId: updatedRoom.ownerId, maxPlayers: room.maxPlayers, scriptSessionId: room.scriptSessionId || "" },
          phase: room.phase,
          playerId: socket.id,
          players: publicPlayers(allPlayers, updatedRoom.ownerId),
          myCharacter: myCharacter ? { name: myCharacter.name, occupation: myCharacter.occupation || "", roleType: myCharacter.roleType || "player" } : null,
          myClues, allClues, chatMessages: await getChatMessages(roomCode, 50),
          // 与该玩家有关的私聊（收发都算）。只下发他自己的，重连后可恢复。
          // self 由服务端标注：客户端不掌握自己的 playerId，靠它就能判断每条是自己发的还是收到的。
          whispers: (await getWhispersFor(roomCode, socket.id, 120)).map(m => ({ ...m, self: m.from === socket.id })),
          phaseConfig: getPhaseConfig(room.phase), narrative: room.aiNarrative || "",
          scriptSummary: { title: parsed.title, setting: parsed.setting, victim: parsed.victim, layoutDescription: parsed.layoutDescription || "" },
          allCharacters: publicCharacters,
          introData: await getIntroductions(roomCode),
          canStart: allReady, totalSlots: totalPlayerSlots,
        });
        io.to(roomCode).emit("room_updated", { players: publicPlayers(await getPlayers(roomCode)), ownerId: room.ownerId });
      } catch (e) { socket.emit("error", { code: "JOIN_FAILED", message: e.message }); }
    });

    // ==================== 管理端旁观（测试剧本） ====================
    // 只允许**管理员**旁观**测试房**：
    //  · 真人局的房间里有其他玩家的秘密与剧本，给旁观口子等于越权读全场；
    //  · 测试房是全 AI 对局，本来就是给管理员看的（管理端"测试剧本"功能）。
    // 与 join_room 的关键差别：**不创建玩家、不占角色位** —— 用户要求"所有玩家均由 AI 扮演"。
    // 只把 socket 加进房间频道即可：chat_message / phase_changed / clue_received /
    // truth_revealed 本来就发往 io.to(roomCode)，加进来就都能收到。
    socket.on("spectate_room", async ({ roomCode, token }) => {
      try {
        const user = await verifyToken(token);
        if (!user || user.role !== "admin") {
          return socket.emit("error", { code: "AUTH", message: "需要管理员身份" });
        }
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "NOT_FOUND", message: "房间不存在或已结束" });
        if (!room.testRun) return socket.emit("error", { code: "NOT_TEST_ROOM", message: "只能旁观测试房间" });
        const players = await getPlayers(roomCode);
        const clues = await getClues(roomCode);
        const parsed = JSON.parse(room.parsedScript || "{}");
        socket.join(roomCode);
        socket.emit("spectate_ready", {
          roomCode,
          phase: room.phase,
          label: getPhaseConfig(room.phase).label,
          scriptTitle: parsed.title || "",
          players: publicPlayers(players, room.ownerId),
          chat: await getChatMessages(roomCode, 100),
          // 测试是为了看"剧本有没有错"，所以把**全部**线索（含还没被发现的）连同发现情况一起给管理员
          clues: (clues || []).map(c => ({
            id: c.id, content: c.content, location: c.location,
            round: c.round, found: (c.foundBy || []).length > 0,
          })),
          murdererName: room.murdererName || "",
        });
        console.log(`[socket] ${user.username} 旁观测试房 ${roomCode}（phase=${room.phase}）`);
      } catch (e) {
        socket.emit("error", { code: "SPECTATE_FAILED", message: e.message });
      }
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
          const { getRedis } = require("../game/game-manager");
          const r2 = await getRedis();
          await r2.srem("rooms:open", roomCode);
          await deleteGameRoom(roomCode);
        } else {
          // 游戏中离场：该角色由 AI 接管（否则角色槽位悬空：线索仍指向他、投票候选消失）
          if (room.phase && room.phase !== "lobby") {
            try { await syncAiFillers(roomCode); } catch (e) { console.warn("[leave_room] AI 接管失败:", e.message); }
          }
          const updatedRoom = await getRoom(roomCode);
          io.to(roomCode).emit("room_updated", { players: publicPlayers(await getPlayers(roomCode)), ownerId: updatedRoom.ownerId });
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
        // ⚠ 上面的校验是"先查后写"，两名玩家同时选同一个角色时会双双通过校验、
        //   双双写入（实测复现过：两人都拿到同一角色）。必须再用原子占位兜一次。
        const got = await claimCharacter(roomCode, characterName, socket.id);
        if (!got) return socket.emit("error", { code: "TAKEN", message: "角色已被选择" });
        // 换角：占住新角色之后，再释放自己原来的角色占位
        if (me?.characterName && me.characterName !== characterName) {
          await releaseCharacterClaim(roomCode, me.characterName, socket.id).catch(() => {});
        }
        await updatePlayer(roomCode, socket.id, { characterName, characterScript: JSON.stringify(char) });
        socket.emit("character_selected", { characterName, character: char, isMurderer: char.isMurderer });
        // 重新对齐 AI 补位（真人抢走 AI 角色后，AI 释放并补齐其它剩余角色）
        const after = await syncAiFillers(roomCode);
        io.to(roomCode).emit("room_updated", { players: publicPlayers(after), ownerId: room.ownerId });
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
        const { getRedis } = require("../game/game-manager");
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
        // 装上阶段兜底计时器：即使全桌没人点"已读完"，10 分钟后也会自动推进，不会永久卡住
        armPhaseDeadline(io, roomCode, "reading");

        // 异步生成开场叙事，完成后推送
        generatePhaseNarrative(parsed, "reading", {}).then(async (narrative) => {
          try {
            await updateRoom(roomCode, { aiNarrative: narrative });
            io.to(roomCode).emit("narrative_ready", { phase: "reading", narrative });
          } catch (e) { console.error("[narrative] 推送失败:", e.message); }
        }).catch(e => console.error("[narrative] 生成失败:", e.message));
      } catch (e) { socket.emit("error", { code: "START_FAILED", message: e.message }); }
    });

    socket.on("investigate", async ({ roomCode, location }) => {
      if (!checkRateLimit(socket, "investigate")) return;
      try {
        const room = await getRoom(roomCode);
        const players = await getPlayers(roomCode);
        const val = validateAction("request_clue", { phase: room.phase, players }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message || "当前阶段无法获取线索" });
        const round = getPhaseRound(room.phase);
        const allClues = await getClues(roomCode);
        if (!allClues || allClues.length === 0) return socket.emit("error", { code: "NO_CLUES", message: "剧本未加载线索数据" });

        // 搜证：默认**随机发一条**本轮还没被取走的线索（location 留空即可）。
        //
        // 曾经做过"玩家从地点列表里选房间"，想用地点取舍换取博弈深度。实测后撤回：
        // 玩家面对十几个地点时只是在猜，而且猜错就白费一次机会 —— 这是随机惩罚，不是决策。
        // 现在保留 location 参数（AI 路径与旧客户端仍按地点搜），但玩家端不再暴露选择。
        const chosen = String(location || "").trim();
        if (chosen) {
          // ⚠️ 校验用的地点池也必须是**本轮**的。用全部线索会把下一轮的地点也认成合法，
          // 客户端（旧页面/AI 路径）传它就能通过校验、然后一条都搜不到 —— 白耗一次配额，
          // 正是 search-locations.js 注释里点名的"不公平的随机惩罚"。
          // round <= 0（非搜证阶段）时该函数不筛，保持原行为。
          const known = buildRoundSearchLocations(allClues, round, JSON.parse(room.parsedScript || "{}").layoutDescription);
          if (!known.some(l => l === chosen)) {
            return socket.emit("error", { code: "UNKNOWN_LOCATION", message: "该地点不在本案场景内" });
          }
        }

        // 配额按 playerName 计，不用 socket.id：playerId 是连接 id，刷新页面就会变，
        // 用它会变成"断线重连即可重置搜证次数"。
        const me = players.find(p => p.playerId === socket.id);
        const quotaId = (me && me.playerName) || socket.id;

        const quota = await consumeSearchQuota(roomCode, round, quotaId);
        if (!quota.allowed) {
          return socket.emit("investigate_failed", {
            reason: "QUOTA_EXHAUSTED",
            location: chosen,
            message: `本轮搜证次数已用完（每人每轮 ${quota.max} 次）。和同伴交流一下，再进入下一阶段。`,
            quota,
          });
        }

        // 可选池：指定地点 → 该地点；未指定 → 本轮全部尚未被取走的线索（随机搜证）
        const pickPool = (all) => (chosen ? cluesAtLocation(all, chosen, round) : availableClues(all, round));

        // 并发安全：SET NX 抢占线索，避免两人同时搜证拿到同一条。
        // 抢占逻辑在 game-manager.claimClue，人类与 AI 路径共用同一套。
        let clue = null;
        let pool = pickPool(allClues);
        for (let i = 0; i < 8 && pool.length; i++) {
          const cand = chosen ? pickClueAtLocation(pool, chosen, round) : pool[Math.floor(Math.random() * pool.length)];
          if (!cand) break;
          if (await claimClue(roomCode, cand.id, socket.id)) { clue = cand; break; }
          pool = pool.filter(c => c.id !== cand.id); // 已被抢走，换下一条
        }

        // 线索池真的空了才算搜空（随机模式下唯一的失败原因）
        if (!clue) {
          return socket.emit("investigate_failed", {
            reason: "NOTHING_HERE",
            location: chosen,
            message: chosen
              ? `你在${chosen}仔细翻找了一阵，没有发现值得注意的东西。`
              : "本轮能被找到的线索都已经被翻出来了，等进入下一阶段吧。",
            quota,
          });
        }

        await assignClue(roomCode, clue.id, socket.id);
        // 一搜到就自动公开给全场。
        //
        // 曾经把线索做成"默认私有、由发现者决定是否公开"，想引入藏线索 / 选择性透露的博弈。
        // 实测下来代价太大：玩家会私藏关键线索，其他人推理缺证据，游戏直接走不通
        // （一局 42 条线索、1 个真人玩家时，甚至会有十几条永远搜不出来）。
        // 博弈收益远小于"线索根本流不出来"的伤害，所以策略改回"发现即公开"。
        // 可见性机制本身保留（revealed 仍然照写），只是不再由玩家决定。
        const revealedRes = await revealClue(roomCode, clue.id, socket.id);
        const publicClue = revealedRes.ok ? revealedRes.clue : clue;
        const finder = players.find(p => p.playerId === socket.id);
        io.to(roomCode).emit("clue_received", {
          clue: publicClue,
          foundBy: finder?.characterName || finder?.playerName || "未知",
          revealed: true,
        });
        socket.emit("investigate_ok", { clueId: clue.id, location: chosen, quota });
      } catch (e) { socket.emit("error", { code: "INVESTIGATE_FAILED", message: e.message }); }
    });

    // 深入调查：把一条线索的隐藏层翻出来（真本 45 条里有 8 条这类线索）。
    // 代价 = 一次搜证配额，收益 = 一条会改变推理方向的深层信息，全员可见。
    socket.on("dig_clue", async ({ roomCode, clueId }) => {
      if (!checkRateLimit(socket, "dig_clue")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在" });
        const players = await getPlayers(roomCode);
        const val = validateAction("request_clue", { phase: room.phase, players }, socket.id);
        if (!val.ok) return socket.emit("error", { code: val.error, message: val.message || "当前阶段无法深入调查" });
        const round = getPhaseRound(room.phase);
        const me = players.find(p => p.playerId === socket.id);
        const quotaId = (me && me.playerName) || socket.id;

        // 先查有没有隐藏层，避免白扣配额
        const allClues = await getClues(roomCode);
        const target = (allClues || []).find(c => c.id === clueId);
        if (!target) return socket.emit("error", { code: "CLUE_NOT_FOUND", message: "线索不存在" });
        if (!String(target.hiddenContent || "").trim()) {
          return socket.emit("error", { code: "NO_HIDDEN", message: "这条线索没有更深的可查内容" });
        }

        const quota = await consumeSearchQuota(roomCode, round, quotaId);
        if (!quota.allowed) {
          return socket.emit("investigate_failed", {
            reason: "QUOTA_EXHAUSTED",
            message: `本轮搜证次数已用完（每人每轮 ${quota.max} 次），无法再深入调查。`,
            quota,
          });
        }

        const res = await digClue(roomCode, clueId, socket.id);
        if (!res.ok) {
          const msg = res.error === "ALREADY_DUG" ? "这条线索已经被人深入调查过了"
            : res.error === "NO_HIDDEN" ? "这条线索没有更深的可查内容"
              : res.error === "NOT_FOUND_YET" ? "这条线索还没被搜出来"
                : "深入调查失败";
          return socket.emit("error", { code: res.error, message: msg });
        }
        io.to(roomCode).emit("clue_dug", {
          clueId,
          hiddenContent: res.hiddenContent,
          byName: me?.characterName || me?.playerName || "某人",
          clue: res.clue,
        });
      } catch (e) { socket.emit("error", { code: "DIG_FAILED", message: e.message }); }
    });

    // 公开一条线索给全场。只有发现者本人能公开（服务端校验，不信任客户端）。
    socket.on("reveal_clue", async ({ roomCode, clueId }) => {
      if (!checkRateLimit(socket, "reveal_clue")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在" });
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        const res = await revealClue(roomCode, clueId, socket.id);
        if (!res.ok) {
          const msg = res.error === "NOT_FINDER" ? "只有线索的发现者才能公开它" : "线索不存在";
          return socket.emit("error", { code: res.error, message: msg });
        }
        io.to(roomCode).emit("clue_revealed", {
          clue: res.clue,
          byName: me?.characterName || me?.playerName || "某人",
        });
      } catch (e) { socket.emit("error", { code: "REVEAL_FAILED", message: e.message }); }
    });

    // 把一条线索单独给某位玩家看。同样只有发现者本人能操作。
    socket.on("share_clue", async ({ roomCode, clueId, targetPlayerId }) => {
      if (!checkRateLimit(socket, "share_clue")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在" });
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        const target = players.find(p => p.playerId === targetPlayerId);
        if (!target) return socket.emit("error", { code: "NO_TARGET", message: "找不到该玩家" });
        if (target.playerId === socket.id) return socket.emit("error", { code: "SELF_SHARE", message: "这条线索本来就是你的" });
        const res = await shareClue(roomCode, clueId, socket.id, targetPlayerId);
        if (!res.ok) {
          const msg = res.error === "NOT_FINDER" ? "只有线索的发现者才能分享它" : "线索不存在";
          return socket.emit("error", { code: res.error, message: msg });
        }
        const payload = { clue: res.clue, fromName: me?.characterName || me?.playerName || "某人" };
        // 只发给分享双方：目标玩家收到线索，分享者收到回执（用于刷新按钮状态）
        io.to(targetPlayerId).emit("clue_shared", payload);
        socket.emit("clue_shared", { ...payload, isReceipt: true, targetName: target.characterName || target.playerName });
      } catch (e) { socket.emit("error", { code: "SHARE_FAILED", message: e.message }); }
    });

    // 私聊：只有收发双方能看到。公屏发言会进 AI 的 transcript，私聊绝不进去。
    socket.on("whisper", async ({ roomCode, targetPlayerId, content }) => {
      if (!checkRateLimit(socket, "whisper")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在" });
        if (!getPhaseConfig(room.phase).allowChat) {
          return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段不能私聊" });
        }
        const players = await getPlayers(roomCode);
        const me = players.find(p => p.playerId === socket.id);
        if (!me) return socket.emit("error", { code: "NOT_IN_ROOM", message: "你不在该房间内" });
        const target = players.find(p => p.playerId === targetPlayerId);
        if (!target) return socket.emit("error", { code: "NO_TARGET", message: "找不到该玩家" });
        if (target.playerId === socket.id) return socket.emit("error", { code: "SELF_WHISPER", message: "不能和自己私聊" });
        // 私聊**只对真人开放**（用户要求）。两个理由：
        //   1) AI 的私下应答等于给玩家一条绕过「审讯全场可见」的免费套话通道 ——
        //      同一个 AI 在公屏上守口如瓶，在私聊里却没有人监督它守什么；
        //   2) 私聊的定位是"见不得光的小动作"，只该发生在真人之间。
        // 前端已经不列出 AI，这里再挡一次：前端拦不住的 socket 调用照样能绕过去。
        if (target.isAI || target.isNPC) {
          return socket.emit("error", { code: "AI_WHISPER_DISABLED", message: "私聊只能和真人玩家进行" });
        }
        const text = String(content || "").trim();
        if (!text) return socket.emit("error", { code: "EMPTY", message: "请输入内容" });
        if (text.length > 300) return socket.emit("error", { code: "TOO_LONG", message: "私聊内容请控制在 300 字以内" });

        const myName = me.characterName || me.playerName || "某人";
        const toName = target.characterName || target.playerName || "某人";
        const msg = await addWhisper(roomCode, socket.id, myName, target.playerId, toName, text, room.phase);
        socket.emit("whisper_message", { ...msg, self: true });
        io.to(target.playerId).emit("whisper_message", { ...msg, self: false });
      } catch (e) { socket.emit("error", { code: "WHISPER_FAILED", message: e.message }); }
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
    // 提交自我介绍。
    // 原本要求 phase === "intro"，但 intro 阶段已从流程中移除 —— 那样这个端点会变成
    // "永远返回 WRONG_PHASE"的死胡同。改成按"当前阶段是否允许发言"判断，
    // 它就仍然是一个可用的接口（前端不再为它做专门的界面，但那不等于接口该失效）。
    socket.on("intro_statement", async ({ roomCode, content }) => {
      if (!checkRateLimit(socket, "intro_statement")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在" });
        if (!getPhaseConfig(room.phase).allowChat) {
          return socket.emit("error", { code: "WRONG_PHASE", message: "当前阶段不能提交介绍" });
        }
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
      // ⚠️ 限流命中必须**给出反馈**：这里原来是 `return;` 静默丢弃，
      // 于是玩家快速追问时看到的是"点了完全没反应"，只会以为功能坏了（实测就是这么被报上来的）。
      if (!checkRateLimit(socket, "ask_ai_player")) {
        return socket.emit("error", { code: "RATE_LIMITED", message: "提问太频繁，请等 3 秒后再问" });
      }
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
          const aiLlm = require("../game/ai-player-llm");
          const parsed = JSON.parse(room.parsedScript || "{}");
          const k = await aiLlm.buildKnowledge(roomCode, ai, parsed);
          answer = await aiLlm.answerLLM(k, askerName, q);
        } catch (e) { console.warn("[ai-player] ask LLM 失败:", e.message); }
        if (!answer) {
          // 兜底文案要像人说话：原来那句"我这边暂时没有更多线索…"在审讯场景里看着像 AI 坏了。
          // 触发兜底的实测原因是 25 秒超时（日志 [agnes] 超时丢弃 … ai.answer），
          // 所以这里给一句自然的口头回避，玩家不会觉得系统卡住。
          answer = `🤖 ${ai.characterName || "AI"}：这个……我得再想想，一时也说不准。`;
        }

        // 问题与回答广播（全员可见，辅助集体推理）
        // 只发聊天消息：它会持久化，重连/刷新后仍能从 chatMessages 恢复。
        // 历史 bug：这里另外还 emit 了 ai_answer，而前端把它也追加进聊天列表，
        // 于是同一个回答显示两遍（与自我介绍重复显示是同一类问题）。
        // 审讯问答打上 kind:"ask"：前端据此把它从「全屋讨论」摘出来，
        // 显示在「审讯」对话框里（所有玩家看到的是同一份，因为消息本身仍是广播的）。
        const askTag = { kind: "ask", askerName, targetName: ai.characterName || "AI" };
        const qMsg = await addChatMessage(roomCode, socket.id, asker?.playerName || "", askerName, `🎤 向 ${ai.characterName || "AI"}（AI玩家）提问：${q}`, room.phase, { ...askTag, askQuestion: true, question: q });
        io.to(roomCode).emit("chat_message", qMsg);
        const aMsg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", answer, room.phase, { ...askTag, askQuestion: false });
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

        // 玩家会引用线索来质证 NPC（"有人看见你20:35在走廊"），不给它这些，NPC 只会在
        // 自己的剧本范围内打转、答非所问。
        // 注意口径：线索私有化之后，NPC 只应知道**已公开**的线索 ——
        // 若把"任何人找到的"都喂给它，玩家藏着的私有线索就等于从 NPC 嘴里漏了出去。
        const allCluesForNpc = await getClues(roomCode);
        const publicCluesForNpc = (allCluesForNpc || [])
          .filter(c => c.revealed)
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

        // 先广播玩家的问题（同样打 kind:"ask"，进「审讯」对话框而不是公屏）
        const npcAskTag = { kind: "ask", askerName, targetName: npcName };
        const qMsg = await addChatMessage(roomCode, socket.id, "NPC:" + npcName, askerName, `🔍 审问 ${npcName}：${question}`, room.phase, { ...npcAskTag, askQuestion: true, question: qText });
        io.to(roomCode).emit("chat_message", qMsg);

        const response = await generateNpcResponse(npcForAgent, question, scriptSummary, chatHistory);

        // NPC回复以聊天消息形式广播（同样进「审讯」对话框）
        const msg = await addChatMessage(roomCode, "npc_" + npcName, "NPC:" + npcName, npcName, `${response}`, room.phase, { ...npcAskTag, askQuestion: false });
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
        // 投满票 → 立即推进（用户实测：全员投完后房间会卡在投票阶段）
        setImmediate(() => { try { require("../game/vote-advance").advanceIfAllVoted(io, roomCode).catch(() => {}); } catch (e) {} });
        socket.emit("vote_recorded", { target: targetCharacterName });
        const votes = await getVotes(roomCode);
        const aiCount = allPlayers.filter(p => p.isAI && p.characterName).length;
        io.to(roomCode).emit("vote_update", { count: Object.keys(votes).length, total: humanPlayers.length + aiCount });
      } catch (e) { socket.emit("error", { code: "VOTE_FAILED", message: e.message }); }
    });

    // ==================== 阶段推进：就绪阈值与倒计时 ====================
    // 实现（readyCountdowns / advanceAfterCountdown / armPhaseDeadline）在 setupGameSocket 作用域，
    // 不在本回调内 —— 详见文件上方那一大段注释（放进回调会变成每 socket 一份，取消不生效）。

    socket.on("ready", async ({ roomCode }) => {
      if (!checkRateLimit(socket, "ready")) return;
      try {
        const room = await getRoom(roomCode);
        if (!room) return socket.emit("error", { code: "ROOM_NOT_FOUND", message: "房间不存在或已过期" });
        if (room.phase === "truth_reveal" || room.phase === "finished" || room.phase === "lobby") return;
        const r = getRedis();
        const player = await getPlayer(roomCode, socket.id);
        if (!player) return socket.emit("error", { code: "NOT_IN_ROOM", message: "玩家不在房间内，请刷新页面重新加入" });
        if (player.isNPC) return;

        const readyKey = `game:${roomCode}:ready`;
        // 用稳定的玩家标识（playerName）而非 socket.id 作为成员：
        // 重连会换 socket.id，旧成员残留会让 readyCount 提前达标
        await r.sadd(readyKey, player.playerName || socket.id);
        const readyCount = await r.scard(readyKey);

        const allPlayers = await getPlayers(roomCode);
        const humanCount = allPlayers.filter(p => !p.isNPC && p.connected).length;

        io.to(roomCode).emit("ready_update", { readyCount, totalCount: humanCount, playerName: player.characterName || player.playerName });

        const allReady = humanCount > 0 && readyCount >= humanCount;
        // 只差一个人：不能再干等十分钟。给一段可预期的倒计时，到点自动推进。
        const almostReady = humanCount >= 2 && readyCount >= humanCount - 1;
        const running = readyCountdowns[roomCode];

        // ⚠ 这里不能"倒计时进行中就早退"。
        //   那样会在"只差一人"的长倒计时跑着时，把最后一人点准备的合法升级路径一并挡掉，
        //   结果全桌都准备好了还得把 60 秒倒计时走完（实测复现过）：
        //   既要挡住重复点击导致倒计时被无限重启，又要允许"情况升级"换成更短的倒计时。
        if (allReady) {
          if (running && running.reason === REASON_ALL) return; // 已在跑全员倒计时，重复点击不重启
          if (phaseTimers[roomCode]) { clearTimeout(phaseTimers[roomCode]); delete phaseTimers[roomCode]; }
          await cancelReadyCountdown(roomCode);                 // 把"只差一人"的长倒计时换成短的
          await advanceAfterCountdown(io, roomCode, ALL_READY_SECONDS, REASON_ALL, { readyCount: humanCount, totalCount: humanCount, mode: "all" });
        } else if (almostReady) {
          if (running) return;                                  // 已有倒计时在跑，让它跑完
          // mode=partial 告诉前端"还没到齐，最后一个人现在点准备依然有效"，
          // 否则前端会把准备按钮置灰，玩家眼睁睁看着 60 秒倒计时却按不动。
          await advanceAfterCountdown(io, roomCode, PARTIAL_READY_SECONDS, `已有 ${readyCount}/${humanCount} 人准备`, { readyCount, totalCount: humanCount, mode: "partial" });
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
        voiceSocketRoom[socket.id] = roomCode;
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

    // SDP / ICE 中转：只按 socketId 点对点转发。
    //
    // ⚠ 必须校验"收发双方在同一个语音房间里"：
    //   socket.io 是匿名可连的（握手不带 token），原来这里对 to/data 不做任何校验，
    //   于是任何能连上服务端的人，只要拿到某个 socketId，就能往任意连接注入 SDP/ICE：
    //   既能无限刷帧，也能伪造 offer 逼对方建立 P2P 连接 —— 而 WebRTC 的 ICE 会暴露
    //   对端的真实 IP（本机与公网地址都会进候选），对方开麦时还能收到音频。
    //   socketId 不是秘密：room_state / voice_roster / clue_received 里都会下发。
    socket.on("voice_signal", ({ to, data }) => {
      if (!to || !data || typeof to !== "string") return;
      if (to === socket.id) return;
      if (!voiceSignalAllowed(socket.id)) return;
      const myRoom = voiceSocketRoom[socket.id];
      if (!myRoom) return;                       // 自己没在语音里，不许转发
      const set = voiceRooms[myRoom];
      if (!set || !set.has(socket.id) || !set.has(to)) return;  // 目标不在同一语音房间
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
      delete voiceSocketRoom[socket.id];
      delete voiceSignalLog[socket.id];
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
          // 超过 AFK_KICK_MS 仍未重连则踢出房间
          const timerKey = code + ":" + socket.id;
          if (disconnectTimers[timerKey]) clearTimeout(disconnectTimers[timerKey]);
          disconnectTimers[timerKey] = setTimeout(async () => {
            try {
              const players = await getPlayers(code);
              const me = players.find(p => p.playerId === socket.id);
              if (!me || me.connected) return; // 已重连或已被移除

              const leftChar = me.characterName || "";
              await removePlayer(code, socket.id);

              let remaining = await getPlayers(code);
              const humanRemaining = remaining.filter(p => !p.isNPC);
              if (humanRemaining.length === 0) {
                aiPlayer.cancelRoom(code);
                const r = await getRedis();
                await r.srem("rooms:open", code);
                await deleteGameRoom(code);
                return;
              }

              // 房间还有其他人：让 AI 接管这名玩家原来的角色。
              // 不接管的话那个角色会永远空着 —— 剧情缺一角，而且"凶手/关键角色"可能恰好是它。
              // syncAiFillers 的语义正是"把没有被真人选中的角色补成 AI"，直接复用。
              let tookOver = null;
              try {
                await syncAiFillers(code);
                remaining = await getPlayers(code);
                if (leftChar) {
                  const ai = remaining.find(p => p.isNPC && p.isAI && p.characterName === leftChar);
                  if (ai) tookOver = leftChar;
                }
              } catch (e) { console.warn("[socket] AI 接管失败:", e.message); }

              // 房主走了要把房主转给还在的人，否则没人能开局/推进
              let room = await getRoom(code);
              if (room && (!room.ownerId || !humanRemaining.some(p => p.playerId === room.ownerId))) {
                await updateRoom(code, { ownerId: humanRemaining[0].playerId });
                room = await getRoom(code);
              }

              // 无论有没有成功补位，都必须告诉桌上其他人"这个人走了"。
              // 原来只在 AI 接管成功时发消息，补位失败就变成"人凭空消失"，其他人根本不知道发生了什么。
              const mins = Math.round(AFK_KICK_MS / 60000);
              const who = me.characterName || me.playerName;
              const text = tookOver
                ? `🤖 ${who} 已离开超过 ${mins} 分钟，由 AI 接管该角色继续游戏。`
                : `⚠️ ${who} 已离开超过 ${mins} 分钟，已被移出房间（该角色暂时空置）。`;
              const msg = await addChatMessage(code, "system", "系统", "系统", text, room ? room.phase : "lobby");
              io.to(code).emit("chat_message", msg);
              io.to(code).emit("room_updated", { players: publicPlayers(remaining), ownerId: room ? room.ownerId : undefined });
            } catch (e) { console.warn("[socket] 断线清理异常:", e.message); }
            delete disconnectTimers[timerKey];
          }, AFK_KICK_MS);
        }
      } catch (e) { console.warn("[socket] disconnect 处理异常:", e.message); }
    });

  });
}

module.exports = { setupGameSocket };
