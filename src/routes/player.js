// Player API routes

const { getRoom, getPlayers, getClues, getVotes, getChatMessages, getNotes, saveNotes, getSearchQuota } = require("../game/game-manager");
const { getRedis } = require("../core/redis-client");
const { normalizeCharacterScript } = require("../script/script-parser");
const { generatePersonalReview } = require("../game/review-agent");
const { determineOutcome, getPhaseConfig, getPhaseRound } = require("../game/game-engine");
const { buildRoundSearchLocations } = require("../game/search-locations");
const { computeScores } = require("../game/scoring");

/** 个性化复盘的缓存时长（7 天）：真相已固定，同一玩家重复刷新不必重复花 LLM 配额 */
const PERSONAL_REVIEW_TTL = 7 * 24 * 3600;

function setupPlayerRoutes(app, authMiddleware) {
  // 可用剧本列表（从 PG 读取）
  app.get("/api/player/scripts", authMiddleware, async (req, res) => {
    try {
      const scripts = [];
      try {
        const { listScripts } = require("../core/db");
        const pgList = await listScripts();
        pgList.forEach(s => scripts.push({
          sessionId: s.id, title: s.title, topic: s.title,
          characterCount: Number(s.real_player_count) || Number(s.player_count) || 0,
          npcCount: Number(s.real_npc_count) || Number(s.npc_count) || 0,
          era: s.era || "", location: s.location || "",
          textType: "murder-mystery",
          createdAt: s.split_at || s.created_at, messageCount: s.clue_count || 0,
        }));
      } catch (e) { /* PG不可用 */ }
      res.json({ scripts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 可加入的房间
  app.get("/api/player/rooms", authMiddleware, async (req, res) => {
    const r2 = getRedis();
    const codes = await r2.smembers("rooms:open");
    const rooms = [];
    for (const code of codes) {
      const room = await getRoom(code);
      if (room) {
        const players = await getPlayers(code);
        const parsed = JSON.parse(room.parsedScript || "{}");
        // 真人已选角色（AI 补位的角色不占用，真人可随时抢占）
        const assigned = players.filter(p => !p.isNPC && !p.isAI).map(p => p.characterName).filter(Boolean);
        rooms.push({
          roomCode: code, status: room.status, phase: room.phase,
          title: parsed.title || "未命名", setting: parsed.setting || {},
          playerCount: players.length, maxPlayers: parseInt(room.maxPlayers) || 6,
          availableCharacters: (parsed.characters || []).filter(c => c.roleType !== "npc" && !assigned.includes(c.name)).map(c => c.name),
        });
      }
    }
    res.json({ rooms });
  });

  // 创建房间
const { createGameRoom } = require("../game/game-room-creator");
  app.post("/api/player/rooms", authMiddleware, async (req, res) => {
    try {
      const { scriptSessionId, maxPlayers } = req.body;
      if (!scriptSessionId) return res.status(400).json({ error: "请选择剧本" });
      res.json(await createGameRoom(scriptSessionId, maxPlayers || 6));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 我的角色剧本（只返回请求者自己的角色剧本，防止越权读取他人秘密）
  app.get("/api/player/rooms/:code/my-script", authMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在" });
      const players = await getPlayers(req.params.code);
      const me = players.find(p => p.playerName === req.user.username);
      if (!me) return res.status(403).json({ error: "你不在该房间内" });
      if (!me.characterName) return res.json({ characterName: "", script: "", secret: "" });
      const parsed = JSON.parse(room.parsedScript || "{}");
      const char = (parsed.characters || []).find(c => c.name === me.characterName);
      if (!char) return res.status(404).json({ error: "角色不存在" });
      // 角色的 script 是对象（{story, secret, fullScript, ...}）而不是字符串。
      // 历史上这里直接写 `char.script || ...`，于是返回了对象 → 前端拼字符串得到
      // "[object Object]"，整页剧本都变成这个；同时秘密也没带出来
      // （split 路径下秘密在 char.script.secret，char.secret 是 undefined）。
      const { script, secret } = normalizeCharacterScript(char);
      res.json({
        characterName: char.name,
        occupation: char.occupation || "",
        script,
        secret,
        isMurderer: !!char.isMurderer,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 游戏复盘：真相揭示、凶手、投票分布、线索发现、聊天记录
  app.get("/api/player/review/:code", authMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在" });
      if (!["truth_reveal", "finished"].includes(room.phase)) {
        return res.status(403).json({ error: "游戏尚未结束，无法查看复盘" });
      }
      const players = await getPlayers(req.params.code);
      // 越权校验：只有本局参与者才能查看复盘（否则任意登录用户凭房号即可拿到凶手与真相）
      const isMember = players.some(p => p.playerName === req.user.username);
      if (!isMember && req.user.role !== "admin") {
        return res.status(403).json({ error: "你不是本局玩家，无法查看复盘" });
      }
      const parsed = JSON.parse(room.parsedScript || "{}");
      const votesRaw = await getVotes(req.params.code);
      const votes = Object.entries(votesRaw || {}).map(([pid, target]) => {
        const p = players.find(x => x.playerId === pid);
        return { voter: p?.characterName || p?.playerName || "未知", target };
      });
      const cluesRaw = await getClues(req.params.code);
      const clues = cluesRaw.map(c => {
        const finder = players.find(p => (c.foundBy || []).includes(p.playerId));
        return {
          id: c.id, content: (c.content || "").substring(0, 200),
          location: c.location || "", round: c.round,
          foundBy: finder ? (finder.characterName || finder.playerName) : null,
          // 复盘阶段真相已公开，所以这里下发全部线索；但标出当时是否公开过 ——
          // "这条线索当时只有你知道，而你错过了它"正是复盘最有价值的内容
          revealed: !!c.revealed,
        };
      });
      const chat = (await getChatMessages(req.params.code, 120)).map(m => ({
        ...m,
        content: (m.content || "").substring(0, 300),
      }));
      // 结算榜：分数全部由可观测事实算出（投票 / 阵营胜负 / 线索 / 发言），刻意不调 LLM ——
      // 分数一旦不确定，玩家就会觉得"凭什么"，反而比没有分更糟。
      const scoreboard = computeScores({
        players,
        votes: votesRaw,
        murdererName: parsed.murderer?.name || "",
        clues: cluesRaw,
        chatMessages: chat,
      });
      res.json({
        roomCode: req.params.code,
        title: parsed.title,
        murderer: parsed.murderer || {},
        truthReveal: parsed.dmGuide?.truthReveal || "",
        // 复盘阶段真相已公开，可展示角色名单，但不下发各角色 secret/剧本原文
        characters: (parsed.characters || []).map(c => ({
          name: c.name, occupation: c.occupation || "", roleType: c.roleType || "player",
          isMurderer: !!c.isMurderer,
        })),
        players: players.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, isNPC: !!p.isNPC })),
        votes, clues, chat,
        scoreboard,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==================== 搜证地点与剩余次数 ====================
  // 搜证从"打字猜关键词"改为"选地点"，前端需要拿到本局地点列表与本轮剩余次数。
  // 服务端在 investigate 时会重新校验地点与配额，这里只是给 UI 用的视图，不构成授权。
  app.get("/api/player/rooms/:code/locations", authMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在" });
      const players = await getPlayers(req.params.code);
      const me = players.find(p => p.playerName === req.user.username);
      if (!me) return res.status(403).json({ error: "你不在该房间内" });

      const config = getPhaseConfig(room.phase);
      const round = getPhaseRound(room.phase);
      const parsed = JSON.parse(room.parsedScript || "{}");
      const clues = await getClues(req.params.code);
      // ⚠️ 地点池只列**本轮还能搜出东西**的地点（口径收敛在 buildRoundSearchLocations 里）。
      // 旧实现直接拿全部线索（含下一轮的地点），于是第一轮就把第二轮的搜证地点也摆出来，
      // 玩家选了必然空手 —— 正是 search-locations.js 注释里点名的"不公平的随机惩罚"。
      // 注：玩家端现在的搜证是**随机翻一条**（见 socket/game.js 的说明），
      // 这个列表属遗留路径，但口径仍然要对 —— 否则以后谁把它接回 UI 就踩同一个坑。
      const locations = buildRoundSearchLocations(clues, round, parsed.layoutDescription);
      // 配额按 playerName 计（playerId 是 socket.id，刷新即变）
      const quota = round ? await getSearchQuota(req.params.code, round, me.playerName) : { used: 0, max: 0, remaining: 0 };

      res.json({
        locations,
        round,
        quota,
        canSearch: !!config.allowClueReq && round > 0,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==================== 个性化复盘（只给本人） ====================
  // 与上面的全局复盘分开：这里的内容包含"你的秘密""你的推理哪里错了"，
  // 泄漏给同局其他人等于二次剧透，所以**只允许查自己**，不接受传 playerId/角色名。
  app.get("/api/player/review/:code/me", authMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在" });
      if (!["truth_reveal", "finished"].includes(room.phase)) {
        return res.status(403).json({ error: "游戏尚未结束，无法查看复盘" });
      }
      const players = await getPlayers(req.params.code);
      const me = players.find(p => p.playerName === req.user.username);
      if (!me) return res.status(403).json({ error: "你不是本局玩家，无法查看复盘" });

      const r = getRedis();
      const cacheKey = `review:${req.params.code}:${req.user.username}`;
      try {
        const cached = await r.get(cacheKey);
        if (cached) return res.json({ ...JSON.parse(cached), cached: true });
      } catch (e) { /* 缓存不可用不影响生成 */ }

      const parsed = JSON.parse(room.parsedScript || "{}");
      const votesRaw = (await getVotes(req.params.code)) || {};
      const murderer = parsed.murderer || {};
      const outcome = determineOutcome(votesRaw, murderer.name);

      const char = (parsed.characters || []).find(c => c.name === me.characterName) || {};
      const { script: myScript, secret } = normalizeCharacterScript(char);

      const allClues = await getClues(req.params.code);
      const nameOf = (pid) => {
        const p = players.find(x => x.playerId === pid);
        return p?.characterName || p?.playerName || "某人";
      };
      const myClues = [];
      const publicClues = [];
      for (const c of allClues || []) {
        const by = c.foundBy || [];
        if (!by.length) continue; // 无人发现 → 不能出现在复盘里（隔离红线与全局复盘保持一致）
        const line = `【${c.id || "线索"}】${(c.content || "").substring(0, 200)}${c.location ? "（" + c.location + "）" : ""}`;
        if (by.includes(me.playerId)) myClues.push(line);
        else publicClues.push(`${line} —— 由 ${by.map(nameOf).join("、")} 公开`);
      }

      const msgs = await getChatMessages(req.params.code, 120);
      const myStatements = (msgs || []).filter(m => m.playerId === me.playerId).map(m => m.content || "");
      const transcript = (msgs || []).map(m => `${m.characterName || m.playerName || "某人"}: ${m.content || ""}`);

      const { text, source } = await generatePersonalReview({
        roomCode: req.params.code,
        title: parsed.title,
        characterName: me.characterName,
        isMurderer: !!char.isMurderer,
        secret,
        personality: char.personality || "",
        goal: char.goal || "",
        playerScript: myScript,
        myClues,
        publicClues,
        myStatements,
        transcript,
        myVote: votesRaw[me.playerId] || null,
        outcome: outcome.outcome,
        murderer: { name: murderer.name, method: murderer.method, motive: murderer.motive },
        truthReveal: parsed.dmGuide?.truthReveal || "",
      });

      const payload = {
        roomCode: req.params.code,
        characterName: me.characterName || "",
        text,
        source,
        generatedAt: new Date().toISOString(),
      };
      try { await r.set(cacheKey, JSON.stringify(payload), "EX", PERSONAL_REVIEW_TTL); } catch (e) { /* ignore */ }
      res.json(payload);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==================== 玩家便签（私有） ====================
  // 只有本人能读写自己的便签：身份取自已认证的用户名，不接受客户端传入的 playerId，
  // 也不接受"看别人的便签"这种请求 —— 便签里会写满推理与怀疑，泄漏等于剧透。
  //
  // 用 playerName（登录用户名）而不是 playerId 做键：playerId 是 socket.id，
  // 断线重连会变，用它会让玩家一掉线笔记全丢。

  async function resolveSelf(req, res) {
    const room = await getRoom(req.params.code);
    if (!room) { res.status(404).json({ error: "房间不存在" }); return null; }
    const players = await getPlayers(req.params.code);
    const me = players.find(p => p.playerName === req.user.username);
    if (!me) { res.status(403).json({ error: "你不在该房间内" }); return null; }
    return { room, me, key: req.user.username };
  }

  app.get("/api/player/rooms/:code/notes", authMiddleware, async (req, res) => {
    try {
      const self = await resolveSelf(req, res);
      if (!self) return;
      res.json({ notes: await getNotes(req.params.code, self.key) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/player/rooms/:code/notes", authMiddleware, async (req, res) => {
    try {
      const self = await resolveSelf(req, res);
      if (!self) return;
      const incoming = (req.body && req.body.notes) || [];
      if (!Array.isArray(incoming)) return res.status(400).json({ error: "notes 必须是数组" });
      const saved = await saveNotes(req.params.code, self.key, incoming);
      res.json({ notes: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

}

module.exports = { setupPlayerRoutes };
