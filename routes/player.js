// Player API routes

const { v4: uuidv4 } = require("uuid");
const { getRoom, getPlayers } = require("../modules/game-manager");

function setupPlayerRoutes(app, authMiddleware) {
  // 可用剧本列表（优先从 split 数据读取）
  app.get("/api/player/scripts", authMiddleware, async (req, res) => {
    try {
      const { getRedis } = require("../modules/game-manager");
      const r2 = await getRedis();
      const splitIds = await r2.smembers("scripts:split");
      const scripts = [];

      for (const id of splitIds) {
        const meta = await r2.hgetall(`split:${id}:meta`);
        if (meta && meta.title) {
          scripts.push({
            sessionId: id,
            title: meta.title,
            topic: meta.title,
            characterCount: parseInt(meta.playerCount) || 0,
            textType: "murder-mystery",
            createdAt: meta.splitAt || "",
            messageCount: parseInt(meta.clueCount) || 0,
          });
        }
      }

      // 只显示已完成切分的剧本
      res.json({ scripts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 可加入的房间
  app.get("/api/player/rooms", authMiddleware, async (req, res) => {
    const { getRedis } = require("../modules/game-manager");
    const r2 = await getRedis();
    const codes = await r2.smembers("rooms:open");
    const rooms = [];
    for (const code of codes) {
      const room = await getRoom(code);
      if (room) {
        const players = await getPlayers(code);
        const parsed = JSON.parse(room.parsedScript || "{}");
        const assigned = players.map(p => p.characterName).filter(Boolean);
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
  const { createGameRoom } = require("./admin");
  app.post("/api/player/rooms", authMiddleware, async (req, res) => {
    try {
      const { scriptSessionId, maxPlayers } = req.body;
      if (!scriptSessionId) return res.status(400).json({ error: "请选择剧本" });
      res.json(await createGameRoom(scriptSessionId, maxPlayers || 6));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 提交剧本请求
  app.post("/api/player/requests", authMiddleware, async (req, res) => {
    try {
      const { description } = req.body;
      if (!description?.trim()) return res.status(400).json({ error: "请输入需求描述" });
      const { getRedis } = require("../modules/game-manager");
      const r2 = await getRedis();
      const id = uuidv4();
      await r2.hset(`script_requests:${id}`, { id, requester: req.user.username, description, status: "pending", createdAt: new Date().toISOString() });
      res.json({ id, message: "请求已提交" });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { setupPlayerRoutes };
