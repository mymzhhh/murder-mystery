// Player API routes

const { getRoom, getPlayers, getClues, getVotes, getChatMessages, getNotes, saveNotes } = require("../modules/game-manager");
const { getRedis } = require("../modules/redis-client");
const { normalizeCharacterScript } = require("../modules/script-parser");

function setupPlayerRoutes(app, authMiddleware) {
  // 可用剧本列表（从 PG 读取）
  app.get("/api/player/scripts", authMiddleware, async (req, res) => {
    try {
      const scripts = [];
      try {
        const { listScripts } = require("../modules/db");
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
const { createGameRoom } = require("../modules/game-room-creator");
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
      const clues = (await getClues(req.params.code)).map(c => {
        const finder = players.find(p => (c.foundBy || []).includes(p.playerId));
        return {
          id: c.id, content: (c.content || "").substring(0, 200),
          location: c.location || "", round: c.round,
          foundBy: finder ? (finder.characterName || finder.playerName) : null,
        };
      });
      const chat = (await getChatMessages(req.params.code, 120)).map(m => ({
        ...m,
        content: (m.content || "").substring(0, 300),
      }));
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
        generatedAt: new Date().toISOString(),
      });
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
