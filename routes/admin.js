// Admin API routes

const { createSession, getSession, addMessage, listSessions, deleteSession } = require("../modules/history-manager");
const { parseScript } = require("../modules/script-parser");
const { listUsers, setRole, deleteUser } = require("../modules/auth");
const { writeScript } = require("../modules/script-writer");
const { reviewScript, reviewAndRevise } = require("../modules/script-reviewer");
const { splitScript, getSplitData } = require("../modules/script-splitter");
const { optimizePrompt } = require("../modules/prompt-agent");
const { createRoom, getRoom, updateRoom, deleteRoom: deleteGameRoom, addPlayer, getPlayers, removePlayer, loadClues } = require("../modules/game-manager");

function setupAdminRoutes(app, authMiddleware, adminMiddleware, io) {
  // 剧本列表（含未切分 session + 已切分 split 数据）
  app.get("/api/admin/scripts", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const sessions = await listSessions();
      const scripts = sessions.filter(s => s.textType === "murder-mystery").map(s => ({
        ...s,
        characterCount: s.messageCount || undefined, // session暂用messageCount占位
      }));

      // 同时读取已切分的剧本（原始session已被删除但split数据保留）
      const { getRedis } = require("../modules/game-manager");
      const r2 = await getRedis();
      const splitIds = await r2.smembers("scripts:split");
      for (const id of splitIds) {
        // 避免重复（如果session还在列表中）
        if (!scripts.find(s => s.sessionId === id)) {
          const meta = await r2.hgetall(`split:${id}:meta`);
          if (meta && meta.title) {
            scripts.push({
              sessionId: id,
              topic: meta.title,
              textType: "murder-mystery",
              createdAt: meta.splitAt || "",
              characterCount: parseInt(meta.playerCount) || 0,
              messageCount: parseInt(meta.clueCount) || 0,
              isSplit: true,
            });
          }
        }
      }

      res.json({ scripts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 生成剧本（SSE — 使用 script-writer Agent）
  app.post("/api/admin/scripts/generate", authMiddleware, adminMiddleware, async (req, res) => {
    const { input, config } = req.body;
    if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    try {
      const result = await writeScript(input, (stage, msg) => send("progress", { stage, message: msg }), config);
      if (!result.ok) { send("error", { message: result.error }); return res.end(); }
      send("complete", { sessionId: result.sessionId, summary: result.summary });
    } catch (err) { send("error", { message: err.message }); }
    res.end();
  });

  app.delete("/api/admin/scripts/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const sid = req.params.id;
      let deleted = false;
      // 删除 session 数据
      if (await deleteSession(sid)) deleted = true;
      // 删除 split 数据（同时尝试多种 key pattern）
      const { getRedis } = require("../modules/game-manager");
      const r2 = await getRedis();
      if (r2.status !== "ready" && r2.status !== "connecting") await r2.connect();
      const patterns = [
        `split:${sid}:*`,
        `split:${sid}`,
      ];
      for (const pattern of patterns) {
        try {
          const keys = await r2.keys(pattern);
          if (keys.length > 0) {
            await r2.del(...keys);
            deleted = true;
            console.log(`[delete] 已删除 ${keys.length} 个 key (pattern: ${pattern})`);
          }
        } catch (e) { console.warn(`[delete] keys(${pattern}) 失败:`, e.message); }
      }
      // 从索引中移除
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

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);

    let currentSessionId = null;

    try {
      // 提前创建 session 以便出错时能重试
      currentSessionId = require("uuid").v4();
      send("phase", { phase: "write", message: "正在生成剧本...", sessionId: currentSessionId });

      // Step 2: 生成
      const writeResult = await writeScript(input, (stage, msg) => send("progress", { stage, message: msg }), config);

      if (!writeResult.ok) { send("error", { message: writeResult.error, phase: "write", sessionId: currentSessionId }); return res.end(); }
      currentSessionId = writeResult.sessionId;
      send("phase", { phase: "write_done", sessionId: currentSessionId, summary: writeResult.summary });

      // Step 3: 评测 + 修复
      send("phase", { phase: "review", message: "正在评测剧本..." });
      const reviewResult = await reviewAndRevise(currentSessionId, (stage, msg) => {
        send("progress", { stage: "review_" + stage, message: msg });
        // 追踪最新的 sessionId（重生成会更新）
        if (stage === "passed" || stage === "failed") {
          // reviewAndRevise 在内部更新 currentSessionId
        }
      });

      if (!reviewResult.ok) { send("error", { message: reviewResult.error, phase: "review" }); return res.end(); }
      send("phase", { phase: "review_done", passed: reviewResult.passed, score: reviewResult.finalScore, rounds: reviewResult.totalRounds });

      if (!reviewResult.passed) {
        send("complete", { status: "review_failed", message: `${reviewResult.totalRounds}轮评测后仍未通过（${reviewResult.finalScore}分）` });
        return res.end();
      }

      // Step 4: 切分（reviewAndRevise 已自动切分）
      send("phase", { phase: "split", message: "剧本已评测通过并完成切分！" });
      send("complete", { status: "done", sessionId: reviewResult.sessionId });

    } catch (e) { send("error", { message: e.message }); }
    res.end();
  });

  // 评测剧本（单次）
  app.post("/api/admin/scripts/:id/review", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const result = await reviewScript(req.params.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result.review);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 评测+重新生成循环（SSE，最多3轮）
  app.post("/api/admin/scripts/:id/review-revise", authMiddleware, adminMiddleware, async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    try {
      const result = await reviewAndRevise(req.params.id, (stage, msg) => send("progress", { stage, message: msg }));
      send("complete", result);
    } catch (e) { send("error", { message: e.message }); }
    res.end();
  });

  // 切分剧本（SSE）
  app.post("/api/admin/scripts/:id/split", authMiddleware, adminMiddleware, async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    try {
      const sid = req.params.id;
      // 先尝试从split meta恢复原始剧本（session可能已被删除）
      let result;
      const session = await getSession(sid);
      if (session) {
        result = await splitScript(sid, (stage, msg) => send("progress", { stage, message: msg }));
      } else {
        // Session不存在，从split meta的originalMarkdown创建临时session再切分
        const { getRedis } = require("../modules/game-manager");
        const r = await getRedis();
        const meta = await r.hgetall(`split:${sid}:meta`);
        if (!meta || !meta.originalMarkdown) {
          send("error", { message: "剧本不存在" });
          return res.end();
        }
        // 创建临时session
        const s = await createSession({ textType: "murder-mystery", topic: meta.title || "剧本杀", templateName: "剧本杀" });
        await addMessage(s.sessionId, "user", meta.title || "");
        await addMessage(s.sessionId, "assistant", meta.originalMarkdown);

        // 先用splitScript正常切分（有进度显示）
        const splitResult = await splitScript(s.sessionId, (stage, msg) => send("progress", { stage, message: msg }));
        if (!splitResult.ok) { send("error", { message: splitResult.error }); return res.end(); }

        // 把切分结果从临时id迁移到原sid（先清旧数据再迁移）
        const { scanKeys } = require("../modules/redis-client");
        const oldKeys = await scanKeys(`split:${sid}:*`);
        if (oldKeys.length > 0) await r.del(...oldKeys);

        const tempKeys = await scanKeys(`split:${s.sessionId}:*`);
        const pipe2 = r.pipeline();
        for (const k of tempKeys) {
          const newKey = k.replace(s.sessionId, sid);
          const data = await r.hgetall(k);
          if (data && Object.keys(data).length > 0) {
            // 用hmset确保所有字段都写入
            pipe2.hset(newKey, data);
          }
          pipe2.del(k);
        }
        await pipe2.exec();
        await r.srem("scripts:split", s.sessionId);
        await r.sadd("scripts:split", sid);

        // 更新meta中的标题
        const updatedMeta = await r.hgetall(`split:${sid}:meta`);
        if (updatedMeta && updatedMeta.title === "剧本杀完整剧本" && meta.title) {
          await r.hset(`split:${sid}:meta`, "title", meta.title);
        }

        // 清理临时session
        await deleteSession(s.sessionId);

        send("complete", { ok: true, result: splitResult.result });
        return res.end();
      }
      if (!result.ok) { send("error", { message: result.error }); return res.end(); }
      send("complete", { ok: true, result });
    } catch (e) { send("error", { message: e.message }); }
    res.end();
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
    const s = await getSession(req.params.id);
    let markdown = "";
    let topic = "";
    if (s) {
      markdown = s.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
      topic = s.metadata?.topic || "";
    }
    // 如果session不存在，从split meta中读取保存的原始剧本
    if (!markdown) {
      const { getRedis } = require("../modules/game-manager");
      const r = await getRedis();
      const meta = await r.hgetall(`split:${req.params.id}:meta`);
      if (meta?.title) {
        if (meta.originalMarkdown && meta.originalMarkdown.length > 100) {
          markdown = meta.originalMarkdown;
          topic = meta.title;
        } else {
          // 回退：从切分数据重建
          const charKeys = await r.keys(`split:${req.params.id}:char:*`);
          const pipe = r.pipeline();
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
  });

  // 查看切分后的剧本文件
  app.get("/api/admin/scripts/:id/split-view", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { getRedis } = require("../modules/game-manager");
      const r2 = await getRedis();
      const meta = await r2.hgetall(`split:${req.params.id}:meta`);
      if (!meta || !meta.title) return res.status(404).json({ error: "切分数据不存在" });

      const charKeys = await r2.keys(`split:${req.params.id}:char:*`);
      const clueKeys = await r2.keys(`split:${req.params.id}:clue:*`);
      const dmData = await r2.hgetall(`split:${req.params.id}:dm`);

      const pipeline = r2.pipeline();
      charKeys.forEach(k => pipeline.hgetall(k));
      clueKeys.forEach(k => pipeline.hgetall(k));
      const results = await pipeline.exec();

      const characters = [];
      const clues = [];
      for (let i = 0; i < results.length; i++) {
        const d = results[i][1];
        if (!d) continue;
        if (i < charKeys.length && d.playerScript) {
          characters.push({
            name: d.name,
            roleType: d.roleType || "player",
            isMurderer: d.isMurderer === "1",
            occupation: d.occupation || "",
            script: d.playerScript || "",
            secret: d.secret || "",
          });
        } else if (i >= charKeys.length) {
          clues.push({ id: d.id, content: (d.content || "").substring(0, 300), round: d.round, location: d.location || "" });
        }
      }

      res.json({
        meta: { ...meta, characterNames: JSON.parse(meta.characterNames || "[]") },
        characters,
        clues,
        dm: dmData || {},
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
      const { getRedis } = require("../modules/game-manager");
      const r = await getRedis();
      const keys = await r.keys("*");
      const data = {};
      for (const key of keys) {
        const type = await r.type(key);
        if (type === "string") data[key] = { type, val: await r.get(key) };
        else if (type === "hash") data[key] = { type, val: await r.hgetall(key) };
        else if (type === "set") data[key] = { type, val: await r.smembers(key) };
        else if (type === "zset") { const items = await r.zrange(key, 0, -1, "WITHSCORES"); data[key] = { type, val: items }; }
        else if (type === "list") data[key] = { type, val: await r.lrange(key, 0, -1) };
        data[key].ttl = await r.ttl(key);
      }
      res.json({ keys: Object.keys(data).length, data });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 数据导入
  app.post("/api/admin/import", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { data } = req.body;
      if (!data) return res.status(400).json({ error: "无数据" });
      const { getRedis } = require("../modules/game-manager");
      const r = await getRedis();
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
    const { getRedis } = require("../modules/game-manager");
    const r2 = await getRedis();
    await r2.srem("rooms:open", req.params.code);
    await deleteGameRoom(req.params.code);
    io.to(req.params.code).emit("game_ended", { message: "房间已被管理员关闭" });
    res.json({ success: true });
  });

  app.get("/api/admin/rooms", authMiddleware, adminMiddleware, async (req, res) => {
    const { getRedis } = require("../modules/game-manager");
    const r2 = await getRedis();
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

// 共享的房间创建逻辑（优先使用切分数据）
async function createGameRoom(scriptSessionId, maxPlayers) {
  const { getRedis } = require("../modules/game-manager");
  const r2 = await getRedis();

  // 尝试从 split 数据加载
  const meta = await r2.hgetall(`split:${scriptSessionId}:meta`);
  let parsed;
  let allClues = [];
  let characterNames = [];

  if (meta && meta.title) {
    // 使用切分数据
    const charKeys = await r2.keys(`split:${scriptSessionId}:char:*`);
    const clueKeys = await r2.keys(`split:${scriptSessionId}:clue:*`);
    const dmData = await r2.hgetall(`split:${scriptSessionId}:dm`);

    const pipeline = r2.pipeline();
    charKeys.forEach(k => pipeline.hgetall(k));
    clueKeys.forEach(k => pipeline.hgetall(k));
    const results = await pipeline.exec();

    const characters = [];
    for (let i = 0; i < results.length; i++) {
      const d = results[i][1];
      if (!d) continue;
      if (d.playerScript !== undefined) {
        characters.push({ name: d.name, isMurderer: d.isMurderer === "1", occupation: d.occupation, roleType: d.roleType || "player", script: { story: d.playerScript, secret: d.secret } });
        characterNames.push(d.name);
      } else {
        allClues.push(d);
      }
    }

    parsed = {
      title: meta.title,
      setting: { era: meta.era, location: meta.location },
      characters,
      clues: { round1: allClues.filter(c => c.round === "1"), round2: allClues.filter(c => c.round === "2"), round3: allClues.filter(c => c.round === "3"), redHerrings: [] },
      murderer: { name: dmData?.murdererName || "", motive: dmData?.murdererMotive || "", method: dmData?.murdererMethod || "" },
      dmGuide: { truthReveal: dmData?.truthReveal || "", openingMonologue: dmData?.openingMonologue || "" },
      victim: {},
      layoutDescription: meta.layoutDescription || "",
    };
  } else {
    // 回退：从旧 session 解析
    const session = await getSession(scriptSessionId);
    if (!session) throw new Error("剧本不存在");
    const markdown = session.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
    parsed = parseScript(markdown);
    allClues = [...(parsed.clues?.round1 || []), ...(parsed.clues?.round2 || []), ...(parsed.clues?.round3 || [])];
    characterNames = parsed.characters?.map(c => c.name) || [];
  }

  const room = await createRoom("system_dm", "AI_DM");
  await updateRoom(room.roomCode, { scriptSessionId, parsedScript: JSON.stringify(parsed), murdererName: parsed.murderer?.name || "", dmType: "ai", maxPlayers: maxPlayers || 6 });
  if (allClues.length > 0) await loadClues(room.roomCode, allClues);
  await r2.sadd("rooms:open", room.roomCode);
  await removePlayer(room.roomCode, "system_dm");
  const onlyPlayerNames = (parsed.characters || []).filter(c => c.roleType !== "npc").map(c => c.name);
  return { roomCode: room.roomCode, title: parsed.title, characterCount: onlyPlayerNames.length, characters: onlyPlayerNames };
}

module.exports = { setupAdminRoutes, createGameRoom };
