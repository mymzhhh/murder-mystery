// Player API routes

const { getRoom, getPlayers, getClues, getVotes, getChatMessages } = require("../modules/game-manager");
const { getRedis } = require("../modules/redis-client");

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
          characterCount: Number(s.real_player_count) || Number(s.player_count) || 0, textType: "murder-mystery",
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

  // 游戏复盘：真相揭示、凶手、投票分布、线索发现、聊天记录
  app.get("/api/player/review/:code", authMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在" });
      if (!["truth_reveal", "finished"].includes(room.phase)) {
        return res.status(403).json({ error: "游戏尚未结束，无法查看复盘" });
      }
      const parsed = JSON.parse(room.parsedScript || "{}");
      const players = await getPlayers(req.params.code);
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
        characters: parsed.characters || [],
        players: players.map(p => ({ playerId: p.playerId, playerName: p.playerName, characterName: p.characterName, isNPC: !!p.isNPC })),
        votes, clues, chat,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

}

module.exports = { setupPlayerRoutes };
