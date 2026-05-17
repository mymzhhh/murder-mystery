// Admin API routes

const { getRedis, scanKeys } = require("../modules/redis-client");
const { createSession, getSession, addMessage, listSessions, deleteSession } = require("../modules/history-manager");
const { parseScript } = require("../modules/script-parser");
const { listUsers, setRole, deleteUser } = require("../modules/auth");
const { writeScript } = require("../modules/script-writer");
const { reviewScript, reviewAndRevise } = require("../modules/script-reviewer");
const { splitScript, getSplitData } = require("../modules/script-splitter");
const { optimizePrompt } = require("../modules/prompt-agent");
const { createGameRoom } = require("../modules/game-room-creator");
const { getRoom, getPlayers, deleteRoom: deleteGameRoom } = require("../modules/game-manager");
const { applyPatchesAndReSplit } = require("../modules/script-patch-applier");

// SSE 辅助：带超时保护 + AbortController 的 SSE 连接
function sseResponse(req, res, timeoutMs = 5 * 60 * 1000) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  const controller = new AbortController();

  const timer = setTimeout(() => {
    if (!closed) {
      controller.abort();
      try { res.write('event: error\ndata: {"message":"操作超时"}\n\n'); } catch (_) {}
      try { res.end(); } catch (_) {}
      closed = true;
    }
  }, timeoutMs);

  req.on("close", () => {
    controller.abort();
    closed = true;
  });

  return {
    isClosed: () => closed,
    signal: controller.signal,
    send: (event, data) => {
      if (!closed) {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { closed = true; }
      }
    },
    end: () => {
      if (!closed) { controller.abort(); clearTimeout(timer); try { res.end(); } catch (_) {} closed = true; }
    },
  };
}

function setupAdminRoutes(app, authMiddleware, adminMiddleware, io) {

  // 辅助：确保 session 存在，用原始 id 避免生成重复条目
  async function ensureSession(id) {
    let s = await getSession(id);
    if (s) return s;
    // Session 不存在：从 PG 或 Redis split meta 重建，以原始 id 为 key
    let markdown = "";
    let topic = "";
    try {
      const { getScript } = require("../modules/db");
      const pg = await getScript(id);
      if (pg && pg.original_markdown) { markdown = pg.original_markdown; topic = pg.title; }
    } catch (e) { /* ignore */ }
    if (!markdown) {
      const meta = await getRedis().hgetall(`split:${id}:meta`);
      if (meta && meta.originalMarkdown) { markdown = meta.originalMarkdown; topic = meta.title; }
    }
    if (!markdown) return null;
    // 直接用原始 id 写入 session（不用 createSession 的 uuidv4），
    // 这样不会在剧本列表中产生新条目
    const r2 = getRedis();
    const now = new Date().toISOString();
    const ts = Date.now();
    await r2.multi()
      .hset(`session:${id}`, { sessionId: id, createdAt: now, updatedAt: now, textType: "murder-mystery", topic: topic || "剧本杀", templateName: "剧本杀" })
      .rpush(`session:${id}:messages`, JSON.stringify({ role: "user", content: topic || "", timestamp: now }))
      .rpush(`session:${id}:messages`, JSON.stringify({ role: "assistant", content: markdown, timestamp: now }))
      .zadd("sessions:index", ts, id)
      .exec();
    return await getSession(id);
  }


  // 剧本列表（含未切分 session + 已切分 split 数据）
  app.get("/api/admin/scripts", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const scripts = [];
      // PG 为主源
      try {
        const { listScripts } = require("../modules/db");
        const pgList = await listScripts();
        pgList.forEach(s => scripts.push({
          sessionId: s.id, topic: s.title, textType: "murder-mystery",
          createdAt: s.split_at || s.created_at,
          characterCount: s.player_count || 0, messageCount: s.clue_count || 0, isSplit: true,
        }));
      } catch (e) { /* PG不可用，跳过 */ }

      // session（未切分）
      const sessions = await listSessions();
      sessions.filter(s => s.textType === "murder-mystery").forEach(s => {
        if (!scripts.find(x => x.sessionId === s.sessionId)) {
          scripts.push({ ...s, characterCount: s.messageCount || undefined });
        }
      });

      // Redis 补充（未在PG中的切分数据）
      try {
        const r2 = getRedis();
        const splitIds = await r2.smembers("scripts:split");
        for (const id of splitIds) {
          if (!scripts.find(x => x.sessionId === id)) {
            const meta = await r2.hgetall(`split:${id}:meta`);
            if (meta?.title) scripts.push({
              sessionId: id, topic: meta.title, textType: "murder-mystery",
              createdAt: meta.splitAt || "", characterCount: parseInt(meta.playerCount) || 0,
              messageCount: parseInt(meta.clueCount) || 0, isSplit: true,
            });
          }
        }
      } catch (e) { console.warn("[admin] PG scripts list failed:", e.message); }

      res.json({ scripts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 生成剧本（SSE — 使用 script-writer Agent）
  app.post("/api/admin/scripts/generate", authMiddleware, adminMiddleware, async (req, res) => {
    const { input, config } = req.body;
    if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
    const sse = sseResponse(req, res);
    try {
      const result = await writeScript(input, (stage, msg) => sse.send("progress", { stage, message: msg }), config);
      if (sse.isClosed()) return;
      if (!result.ok) { sse.send("error", { message: result.error }); return sse.end(); }
      sse.send("complete", { sessionId: result.sessionId, summary: result.summary });
    } catch (err) { if (!sse.isClosed()) sse.send("error", { message: err.message }); }
    sse.end();
  });

  app.delete("/api/admin/scripts/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const sid = req.params.id;
      let deleted = false;

      // 1. 优先删除 PG 数据
      try {
        const { deleteScript: pgDelete } = require("../modules/db");
        await pgDelete(sid);
        deleted = true;
      } catch (e) { console.warn("[admin] PG deleteScript failed:", e.message); }

      // 2. 清理 Redis session
      if (await deleteSession(sid)) deleted = true;

      // 3. 清理 Redis split 数据
      const r2 = getRedis();
      const patterns = [`split:${sid}:*`, `split:${sid}`];
      for (const pattern of patterns) {
        try {
          const keys = await scanKeys(pattern);
          if (keys.length > 0) {
            await r2.del(...keys);
            deleted = true;
          }
        } catch (e) { console.warn(`[delete] scanKeys(${pattern}) 失败:`, e.message); }
      }
      await r2.srem("scripts:split", sid);

      if (!deleted) return res.status(404).json({ error: "剧本不存在" });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ===== 流水线 API =====

  // Step 1: 优化提示词
  app.post("/api/admin/pipeline/optimize", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { input } = req.body;
      if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
      const result = await optimizePrompt(input);
      res.json(result.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Step 2-5: 完整流水线（生成→评测→切分，SSE）
  app.post("/api/admin/pipeline/run", authMiddleware, adminMiddleware, async (req, res) => {
    const { input, config } = req.body;
    if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });

    const sse = sseResponse(req, res);
    let currentSessionId = null;

    try {
      currentSessionId = require("uuid").v4();
      sse.send("phase", { phase: "write", message: "正在生成剧本...", sessionId: currentSessionId });

      const writeResult = await writeScript(input, (stage, msg) => sse.send("progress", { stage, message: msg }), config);
      if (sse.isClosed()) return;

      if (!writeResult.ok) { sse.send("error", { message: writeResult.error, phase: "write", sessionId: currentSessionId }); return sse.end(); }
      currentSessionId = writeResult.sessionId;
      sse.send("phase", { phase: "write_done", sessionId: currentSessionId, summary: writeResult.summary });

      sse.send("phase", { phase: "review", message: "正在评测剧本..." });
      const reviewResult = await reviewAndRevise(currentSessionId, (stage, msg) => {
        sse.send("progress", { stage: "review_" + stage, message: msg });
      });
      if (sse.isClosed()) return;

      if (!reviewResult.ok) { sse.send("error", { message: reviewResult.error, phase: "review" }); return sse.end(); }
      sse.send("phase", { phase: "review_done", passed: reviewResult.passed, score: reviewResult.finalScore, rounds: reviewResult.totalRounds });

      if (!reviewResult.passed) {
        sse.send("complete", { status: "review_failed", message: `${reviewResult.totalRounds}轮评测后仍未通过（${reviewResult.finalScore}分）` });
        return sse.end();
      }

      sse.send("phase", { phase: "split", message: "剧本已评测通过并完成切分！" });
      sse.send("complete", { status: "done", sessionId: reviewResult.sessionId });

    } catch (e) { if (!sse.isClosed()) sse.send("error", { message: e.message }); }
    sse.end();
  });

  // 评测剧本（单次）
  app.post("/api/admin/scripts/:id/review", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const s = await ensureSession(req.params.id);
      if (!s) return res.status(404).json({ error: "剧本不存在" });
      const result = await reviewScript(s.sessionId);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result.review);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 应用评测建议的局部修改
  app.post("/api/admin/scripts/:id/apply-patches", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { patches } = req.body;
      if (!patches || !patches.length) return res.status(400).json({ error: "无修改项" });
      const result = await applyPatchesAndReSplit(req.params.id, patches);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 评测+重新生成循环（SSE，最多3轮）
  app.post("/api/admin/scripts/:id/review-revise", authMiddleware, adminMiddleware, async (req, res) => {
    const sse = sseResponse(req, res);
    try {
      const s = await ensureSession(req.params.id);
      if (!s) { sse.send("error", { message: "剧本不存在" }); return sse.end(); }
      const result = await reviewAndRevise(s.sessionId, (stage, msg) => sse.send("progress", { stage, message: msg }));
      if (!sse.isClosed()) sse.send("complete", result);
    } catch (e) { if (!sse.isClosed()) sse.send("error", { message: e.message }); }
    sse.end();
  });

  // 切分剧本（SSE）
  function extractTitleFromMarkdown(md) {
    const m1 = md.match(/\*\*剧本名称\*\*[：:]\s*《?(.+?)》?/);
    if (m1 && m1[1].length >= 2) return m1[1].trim();
    const m2 = md.match(/剧本名称[：:]\s*《?(.+?)》?/);
    if (m2 && m2[1].length >= 2) return m2[1].trim();
    const m3 = md.match(/^#\s*《(.+?)》/m);
    if (m3) return m3[1].trim();
    const m4 = md.match(/^#\s*(?!剧本杀完整剧本)(\S.{2,30})(?:\n|$)/m);
    if (m4) return m4[1].trim();
    return "";
  }

  app.post("/api/admin/scripts/:id/split", authMiddleware, adminMiddleware, async (req, res) => {
    const sse = sseResponse(req, res);
    try {
      const sid = req.params.id;
      // 先尝试从split meta恢复原始剧本（session可能已被删除）
      let result;
      const session = await getSession(sid);
      if (session) {
        result = await splitScript(sid, (stage, msg) => sse.send("progress", { stage, message: msg }));
      } else {
        // Session不存在，从 PG / Redis split meta 获取 originalMarkdown 重建临时 session
        let fallbackMarkdown = "";
        let fallbackTopic = "";
        try {
          const { getScript } = require("../modules/db");
          const pg = await getScript(sid);
          if (pg && pg.original_markdown) { fallbackMarkdown = pg.original_markdown; fallbackTopic = pg.title; }
        } catch (e) { /* ignore */ }
        if (!fallbackMarkdown) {
          const meta = await getRedis().hgetall(`split:${sid}:meta`);
          if (meta && meta.originalMarkdown) { fallbackMarkdown = meta.originalMarkdown; fallbackTopic = meta.title; }
        }
        if (!fallbackMarkdown) {
          sse.send("error", { message: "剧本不存在" });
          return sse.end();
        }
        // 创建临时session
        // 用原始 sid 重建 session（不生成新 UUID，避免剧本列表重复）
        const r = getRedis();
        const now = new Date().toISOString();
        const ts = Date.now();
        await r.multi()
          .hset(`session:${sid}`, { sessionId: sid, createdAt: now, updatedAt: now, textType: "murder-mystery", topic: fallbackTopic || "剧本杀", templateName: "剧本杀" })
          .del(`session:${sid}:messages`)
          .rpush(`session:${sid}:messages`, JSON.stringify({ role: "user", content: fallbackTopic || "", timestamp: now }))
          .rpush(`session:${sid}:messages`, JSON.stringify({ role: "assistant", content: fallbackMarkdown, timestamp: now }))
          .zadd("sessions:index", ts, sid)
          .exec();

        // 清除旧 split 数据，直接切分（用 sid 作为 key）
        const oldKeys = await scanKeys(`split:${sid}:*`);
        if (oldKeys.length > 0) await r.del(...oldKeys);

        const splitResult = await splitScript(sid, (stage, msg) => sse.send("progress", { stage, message: msg }));
        if (!splitResult.ok) { sse.send("error", { message: splitResult.error }); return sse.end(); }

        // 修复标题：从原始markdown直接提取
        const titleFromMD = extractTitleFromMarkdown(fallbackMarkdown || "");
        if (titleFromMD && titleFromMD.length >= 2) {
          await r.hset(`split:${sid}:meta`, "title", titleFromMD);
        }

        sse.send("complete", { ok: true, result: splitResult.result });
        return sse.end();
      }
      if (!result.ok) { sse.send("error", { message: result.error }); return sse.end(); }
      sse.send("complete", { ok: true, result });
    } catch (e) { if (!sse.isClosed()) sse.send("error", { message: e.message }); }
    sse.end();
  });

  // 获取已切分数据
  app.get("/api/admin/scripts/:id/split", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const data = await getSplitData(req.params.id);
      if (!data) return res.status(404).json({ error: "未找到切分数据" });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/admin/scripts/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      let markdown = "";
      let topic = "";

      // 1. 优先 PostgreSQL
      try {
        const { getScript } = require("../modules/db");
        const pg = await getScript(req.params.id);
        if (pg && pg.original_markdown) {
          markdown = pg.original_markdown;
          topic = pg.title;
        }
      } catch (e) { /* PG不可用 */ }

      // 2. 回退 Session
      if (!markdown) {
        const s = await getSession(req.params.id);
        if (s) {
          markdown = s.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
          topic = s.metadata?.topic || "";
        }
      }

      // 3. 回退 Redis split meta
      if (!markdown) {
        const meta = await getRedis().hgetall(`split:${req.params.id}:meta`);
        if (meta?.title) {
          if (meta.originalMarkdown && meta.originalMarkdown.length > 100) {
            markdown = meta.originalMarkdown;
            topic = meta.title;
          } else {
            const charKeys = await scanKeys(`split:${req.params.id}:char:*`);
            const pipe = getRedis().pipeline();
            charKeys.forEach(k => pipe.hgetall(k));
            const results = await pipe.exec();
            let text = '# ' + (meta.title || '') + '\n\n';
            text += '时代: ' + (meta.era || '') + ' | 地点: ' + (meta.location || '') + '\n\n';
            for (const [err, d] of results) {
              if (d && d.name) {
                text += '## ' + (d.roleType === 'npc' ? 'NPC' : '玩家') + ': ' + d.name + '\n';
                text += (d.playerScript || '') + '\n\n';
                if (d.secret) text += '秘密: ' + d.secret + '\n\n';
              }
            }
            markdown = text;
            topic = meta.title;
          }
        }
      }

      if (!markdown) return res.status(404).json({ error: "剧本不存在" });
      const parsed = parseScript(markdown);
      res.json({ session: { sessionId: req.params.id, createdAt: "", topic }, parsed, markdown });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 查看切分后的剧本文件
  app.get("/api/admin/scripts/:id/split-view", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      let meta = null;
      let characters = [];
      let clues = [];
      let dmData = {};

      // 1. 优先 PostgreSQL
      try {
        const { getScript } = require("../modules/db");
        const pg = await getScript(req.params.id);
        if (pg && pg.title) {
          meta = {
            title: pg.title, era: pg.era || "", location: pg.location || "",
            playerCount: String(pg.player_count || 0), npcCount: String(pg.npc_count || 0),
            clueCount: String(pg.clue_count || 0), characterNames: "[]",
          };
          characters = (pg.characters || []).map(c => ({
            name: c.name, roleType: c.role_type || "player",
            isMurderer: c.is_murderer, occupation: c.occupation || "",
            script: c.player_script || "", secret: c.secret || "",
          }));
          clues = (pg.clues || []).map(c => ({
            id: c.clue_id, content: (c.content || "").substring(0, 300),
            round: c.round, location: c.location || "",
          }));
          dmData = {
            murdererName: pg.dm?.murderer_name || "",
            murdererMotive: pg.dm?.murderer_motive || "",
            truthReveal: pg.dm?.truth_reveal || "",
          };
        }
      } catch (e) { /* PG不可用 */ }

      // 2. 回退 Redis split 数据
      if (!meta || !meta.title) {
        const r2 = getRedis();
        meta = await r2.hgetall(`split:${req.params.id}:meta`);
        if (meta && meta.title) {
          const charKeys = await scanKeys(`split:${req.params.id}:char:*`);
          const clueKeys = await scanKeys(`split:${req.params.id}:clue:*`);
          dmData = await r2.hgetall(`split:${req.params.id}:dm`) || {};

          const pipeline = r2.pipeline();
          charKeys.forEach(k => pipeline.hgetall(k));
          clueKeys.forEach(k => pipeline.hgetall(k));
          const results = await pipeline.exec();

          for (let i = 0; i < results.length; i++) {
            const d = results[i][1];
            if (!d) continue;
            if (i < charKeys.length) {
              characters.push({
                name: d.name || "",
                roleType: d.roleType || "player",
                isMurderer: d.isMurderer === "1",
                occupation: d.occupation || "",
                script: d.playerScript || "",
                secret: d.secret || "",
              });
            } else {
              clues.push({ id: d.id, content: (d.content || "").substring(0, 300), round: d.round, location: d.location || "" });
            }
          }
        }
      }

      if (!meta || !meta.title) return res.status(404).json({ error: "切分数据不存在" });
      res.json({
        meta: { ...meta, characterNames: JSON.parse(meta.characterNames || "[]") },
        characters, clues, dm: dmData || {},
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 用户管理
  app.get("/api/admin/users", authMiddleware, adminMiddleware, async (req, res) => res.json({ users: await listUsers() }));
  app.put("/api/admin/users/:name/role", authMiddleware, adminMiddleware, async (req, res) => {
    const { role } = req.body;
    if (!["admin", "player"].includes(role)) return res.status(400).json({ error: "无效的角色" });
    if (!(await setRole(req.params.name, role))) return res.status(404).json({ error: "用户不存在" });
    res.json({ success: true });
  });
  app.delete("/api/admin/users/:name", authMiddleware, adminMiddleware, async (req, res) => {
    if (req.params.name === req.user.username) return res.status(400).json({ error: "不能删除自己" });
    await deleteUser(req.params.name);
    res.json({ success: true });
  });

  // 数据导出
  app.get("/api/admin/export", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      // Redis 全量导出
      const r = getRedis();
      const keys = await scanKeys("*");
      const redisData = {};
      for (const key of keys) {
        const type = await r.type(key);
        if (type === "string") redisData[key] = { type, val: await r.get(key) };
        else if (type === "hash") redisData[key] = { type, val: await r.hgetall(key) };
        else if (type === "set") redisData[key] = { type, val: await r.smembers(key) };
        else if (type === "zset") { const items = await r.zrange(key, 0, -1, "WITHSCORES"); redisData[key] = { type, val: items }; }
        else if (type === "list") redisData[key] = { type, val: await r.lrange(key, 0, -1) };
        redisData[key].ttl = await r.ttl(key);
      }

      // PG 数据导出
      let pgData = null;
      try {
        const { listScripts, listUsers } = require("../modules/db");
        const pgScripts = await listScripts();
        const pgUsers = await listUsers();
        pgData = { scripts: pgScripts, users: pgUsers };
      } catch (e) { pgData = { error: e.message }; }

      res.json({
        redis: { keys: Object.keys(redisData).length, data: redisData },
        pg: pgData,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 数据导入
  app.post("/api/admin/import", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { data } = req.body;
      if (!data) return res.status(400).json({ error: "无数据" });
      const r = getRedis();
      let count = 0;
      for (const [key, info] of Object.entries(data)) {
        if (info.type === "string") await r.set(key, info.val);
        else if (info.type === "hash" && info.val) await r.hset(key, info.val);
        else if (info.type === "set" && info.val?.length) await r.sadd(key, ...info.val);
        else if (info.type === "zset" && info.val?.length) await r.zadd(key, ...info.val);
        else if (info.type === "list" && info.val?.length) await r.rpush(key, ...info.val);
        if (info.ttl > 0) await r.expire(key, info.ttl);
        count++;
      }
      res.json({ imported: count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 房间管理
  app.post("/api/admin/rooms", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { scriptSessionId, maxPlayers } = req.body;
      if (!scriptSessionId) return res.status(400).json({ error: "请选择剧本" });
      const result = await createGameRoom(scriptSessionId, maxPlayers);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/admin/rooms/:code", authMiddleware, adminMiddleware, async (req, res) => {
    const r2 = getRedis();
    await r2.srem("rooms:open", req.params.code);
    await deleteGameRoom(req.params.code);
    io.to(req.params.code).emit("game_ended", { message: "房间已被管理员关闭" });
    res.json({ success: true });
  });

  app.get("/api/admin/rooms", authMiddleware, adminMiddleware, async (req, res) => {
    const r2 = getRedis();
    const codes = await r2.smembers("rooms:open");
    const rooms = [];
    for (const code of codes) {
      const room = await getRoom(code);
      if (room) {
        const players = await getPlayers(code);
        rooms.push({ roomCode: code, status: room.status, phase: room.phase, scriptTitle: JSON.parse(room.parsedScript || "{}").title, playerCount: players.length });
      }
    }
    res.json({ rooms });
  });
}
module.exports = { setupAdminRoutes };
