// Admin API routes

const { getRedis, scanKeys } = require("../core/redis-client");
const { createSession, getSession, addMessage, listSessions, deleteSession } = require("../core/history-manager");
const { parseScript } = require("../script/script-parser");
const { listUsers, setRole, deleteUser } = require("../core/auth");
const { writeScript } = require("../script/script-writer");
const { reviewScript } = require("../script/script-reviewer");
const { splitScript, getSplitData } = require("../script/script-splitter");
const { optimizePrompt } = require("../script/prompt-agent");
const { createGameRoom } = require("../game/game-room-creator");
const { getRoom, getPlayers, deleteRoom: deleteGameRoom } = require("../game/game-manager");
const contentGuard = require("../llm/content-guard");

/**
 * 生成类端点的统一入口审核。
 * 返回 true 表示放行；false 表示已自行写过响应（block 时 400）。
 * review 级不拦，仅记警告供运营复核 —— 历史/民国题材天然涉及真实人物，拦掉会误伤正常题材。
 */
function passesGenerationGuard(input, res) {
  const verdict = contentGuard.screenGenerationRequest(input);
  if (verdict.action === "block") {
    res.status(400).json({ error: verdict.reason, categories: verdict.categories });
    return false;
  }
  if (verdict.action === "review") {
    console.warn(`[content-guard] 生成需求需人工复核（${verdict.categories.join(",")}）: ${String(input).slice(0, 80)}`);
  }
  return true;
}

// 判断出站目标是否为内网/环回/链路本地地址（SSRF 防护）
async function isUnsafeOutboundHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // 字面量 IP 直接判断
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIp(h);
  if (h.includes(":")) return true; // IPv6 一律拒绝（含 ::1）
  // 域名 → 解析后检查（防 DNS 指向内网）
  try {
    const dns = require("dns").promises;
    const addrs = await dns.lookup(h, { all: true });
    return addrs.some(a => isPrivateIp(a.address));
  } catch (e) {
    return true; // 解析失败 → 拒绝
  }
}

function isPrivateIp(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;              // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;     // 私有
  if (a === 192 && b === 168) return true;              // 私有
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  if (a >= 224) return true;                            // 组播/保留
  return false;
}

// SSE 辅助：带超时保护 + AbortController 的 SSE 连接
// - 总时长 2 小时兜底（仅防异常泄漏；生成步骤是确定序列总会结束）
// - 静默超时 10 分钟：最后一条真实事件后无任何进度才判卡死（容忍单次 LLM 上限 5 分钟
//   + 网络抖动重试；心跳注释行不算事件）
function sseResponse(req, res, timeoutMs = 120 * 60 * 1000, idleMs = 10 * 60 * 1000) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let idleTimer = null;
  const controller = new AbortController();

  function fail(msg) {
    if (closed) return;
    controller.abort();
    try { res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`); } catch (_) {}
    try { res.end(); } catch (_) {}
    closed = true;
  }

  // 总时长兜底
  const timer = setTimeout(() => fail(`生成耗时过长(${Math.round(timeoutMs / 60000)}分钟)，已自动终止，请重试`), timeoutMs);

  // 静默超时：收到真实事件时重置；心跳注释行不算事件
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail("生成长时间无响应，已自动终止，请重试"), idleMs);
  }
  armIdle();

  // SSE 心跳：维持连接活跃（注释行，不触发前端事件）
  // 关键：心跳也会重置 idle 计时器——LLM 单次生成可能耗时 3-5 分钟甚至更长，
  // 期间没有"真实事件"只有心跳；若不重置 idle，任何等待超过 10 分钟的生成都会被误杀。
  const heartbeat = setInterval(() => {
    if (!closed) {
      armIdle();
      try { res.write(": keep-alive\n\n"); } catch (_) { closed = true; }
    }
  }, 15000);

  req.on("close", () => {
    controller.abort();
    clearInterval(heartbeat);
    clearTimeout(idleTimer);
    closed = true;
  });

  return {
    isClosed: () => closed,
    signal: controller.signal,
    send: (event, data) => {
      if (!closed) {
        armIdle();
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { closed = true; }
      }
    },
    end: () => {
      if (!closed) { controller.abort(); clearTimeout(timer); clearInterval(heartbeat); clearTimeout(idleTimer); try { res.end(); } catch (_) {} closed = true; }
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
      const { getScript } = require("../core/db");
      const pg = await getScript(id);
      if (pg && pg.original_markdown) { markdown = pg.original_markdown; topic = pg.title; }
    } catch (e) { console.warn("[admin] ensureSession PG fallback failed:", e.message); }
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


  // 剧本列表（含未切分 session + 已切分 split 数据），支持分页与关键词搜索
  app.get("/api/admin/scripts", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      // 分页 & 搜索参数
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
      const q = String(req.query.q || "").trim().toLowerCase();

      const scripts = [];
      // PG 为主源
      try {
        const { listScripts } = require("../core/db");
        const pgList = await listScripts();
        pgList.forEach(s => scripts.push({
          sessionId: s.id, topic: s.title, textType: "murder-mystery",
          createdAt: s.split_at || s.created_at,
          characterCount: Number(s.real_player_count) || Number(s.player_count) || 0, messageCount: s.clue_count || 0, isSplit: true,
          // 管理端能看到并切换：false = 只在管理端可见（玩家大厅不出现）
          isPublic: s.is_public !== false,
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
              createdAt: meta.splitAt || "", 
              characterCount: parseInt(meta.playerCount) || (JSON.parse(meta.characterNames || "[]") || []).length || 0,
              messageCount: parseInt(meta.clueCount) || 0, isSplit: true,
            });
          }
        }
      } catch (e) { console.warn("[admin] PG scripts list failed:", e.message); }

      // 关键词过滤 + 按创建时间倒序 + 分页
      const filtered = q
        ? scripts.filter(s => (s.topic || "").toLowerCase().includes(q) || (s.sessionId || "").toLowerCase().includes(q))
        : scripts;
      filtered.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const total = filtered.length;
      const start = (page - 1) * pageSize;
      const items = filtered.slice(start, start + pageSize);

      res.json({ scripts: items, total, page, pageSize });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 生成剧本（SSE — 使用 script-writer Agent）
  app.post("/api/admin/scripts/generate", authMiddleware, adminMiddleware, async (req, res) => {
    const { input, config } = req.body;
    if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
    if (!passesGenerationGuard(input, res)) return;
    const sse = sseResponse(req, res);
    try {
      const result = await writeScript(input, (stage, msg) => sse.send("progress", { stage, message: msg }), config);
      if (sse.isClosed()) return;
      if (!result.ok) { sse.send("error", { message: result.error }); return sse.end(); }
      sse.send("complete", { sessionId: result.sessionId, summary: result.summary });
    } catch (err) { if (!sse.isClosed()) sse.send("error", { message: err.message }); }
    sse.end();
  });

  // 上架/下架：is_public=false 时玩家大厅看不到、也建不了房；管理端一切照旧
  app.patch("/api/admin/scripts/:id/visibility", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { setScriptPublic } = require("../core/db");
      const isPublic = req.body && req.body.isPublic;
      if (typeof isPublic !== "boolean") return res.status(400).json({ error: "isPublic 必须是布尔值" });
      const row = await setScriptPublic(req.params.id, isPublic);
      if (!row) return res.status(404).json({ error: "剧本不存在" });
      console.log(`[audit] 剧本可见性 by=${(req.user && req.user.username) || "?"} id=${req.params.id} is_public=${row.is_public}`);
      res.json({ ok: true, id: row.id, isPublic: row.is_public });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/admin/scripts/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const sid = req.params.id;
      // 审计留痕：删剧本会**外键级联**带走 characters / clues / dm_manuals，
      // 而这张表只按 id 单条删。实测代价（2026-10-17）：整个剧本库被删空，
      // `test_reports`（6 条）与 `users`（9 条）完好、四张内容表全 0 ——
      // 正是"逐条 deleteScript + 级联"的形态，但**没有任何留痕**，
      // 查不出是谁删的、什么时候删的、删了几本。这里在删除之前把规模问出来记一行。
      let deleted = false;
      try {
        const { query } = require("../core/db");
        const g = await query(
          "SELECT s.title, (SELECT count(*) FROM characters WHERE script_id=s.id) AS chars, (SELECT count(*) FROM clues WHERE script_id=s.id) AS clues FROM scripts s WHERE s.id=$1", [sid]);
        const row = g.rows[0];
        console.warn(`[audit] 删除剧本 by=${(req.user && req.user.username) || "?"} id=${sid} ` +
          `title=《${(row && row.title) || "（库里没有这条）"}》 级联 characters=${(row && Number(row.chars)) || 0} clues=${(row && Number(row.clues)) || 0}`);
      } catch (e) { console.warn(`[audit] 删除剧本 by=${(req.user && req.user.username) || "?"} id=${sid}（审计查询失败：${e.message}）`); }

      // 1. 优先删除 PG 数据
      try {
        const { deleteScript: pgDelete } = require("../core/db");
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
      // LLM 分析可能较久（推理型模型长 JSON 任务 30~180s），放宽到 5 分钟，
      // 覆盖全局 30s 空闲超时
      res.setTimeout(5 * 60 * 1000);
      const { input } = req.body;
      if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
      if (!passesGenerationGuard(input, res)) return;
      const result = await optimizePrompt(input);
      if (!result.ok) return res.status(422).json({ error: result.error || "需求解析失败" });
      res.json(result.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Step 2-5: 完整流水线（生成→评测→切分，SSE）
  app.post("/api/admin/pipeline/run", authMiddleware, adminMiddleware, async (req, res) => {
    const { input, config } = req.body;
    if (!input?.trim()) return res.status(400).json({ error: "请输入剧本需求" });
    if (!passesGenerationGuard(input, res)) return;

    const sse = sseResponse(req, res);
    let currentSessionId = null;

    try {
      currentSessionId = require("uuid").v4();
      sse.send("phase", { phase: "outline", message: "正在生成剧本大纲（锁定诡计、人物、关系网与时间线）...", sessionId: currentSessionId });

      // writeScript 阶段：拦截 outine_done / trick_done 进度 → 转成独立的 SSE 事件（供前端可视化）
      const writeResult = await writeScript(input, (stage, msg) => {
        if (stage === "outline_done") {
          try {
            sse.send("outline", JSON.parse(msg));
            sse.send("phase", { phase: "write", message: "大纲已锁定，正在生成完整剧本..." });
          } catch (e) { console.warn("[admin] outline 事件转发失败:", e.message); }
          return;
        }
        // 核心诡计设计（推理链：机制/物理可行性/目击条件/最弱处/证明链）——与 outline 同一套机制
        if (stage === "trick_done") {
          try { sse.send("trick", JSON.parse(msg)); }
          catch (e) { console.warn("[admin] trick 事件转发失败:", e.message); }
          return;
        }
        sse.send("progress", { stage, message: msg });
      }, config);
      if (sse.isClosed()) return;

      if (!writeResult.ok) { sse.send("error", { message: writeResult.error, phase: "write", sessionId: currentSessionId }); return sse.end(); }
      currentSessionId = writeResult.sessionId;
      if (writeResult.summary) sse.send("phase", { phase: "write_done", sessionId: currentSessionId, summary: writeResult.summary });

      // 评测：AI 扮演挑剔玩家输出纯文本漏洞报告（不做多轮重写）
      sse.send("phase", { phase: "review", message: "正在评测剧本（查找逻辑漏洞）..." });
      const reviewResult = await reviewScript(currentSessionId, (stage, msg) => {
        sse.send("progress", { stage: "review_" + stage, message: msg });
      });
      if (sse.isClosed()) return;

      if (!reviewResult.ok) { sse.send("error", { message: reviewResult.error, phase: "review" }); return sse.end(); }
      sse.send("phase", { phase: "review_done", message: "评测完成，正在切分剧本..." });

      // 自动切分（评测报告仅作参考，不阻塞入库）
      sse.send("phase", { phase: "split", message: "正在切分剧本..." });
      const splitResult = await splitScript(currentSessionId, (stage, msg) => sse.send("progress", { stage, message: msg }));
      if (sse.isClosed()) return;
      if (!splitResult.ok) { sse.send("error", { message: splitResult.error, phase: "split", sessionId: currentSessionId }); return sse.end(); }

      await deleteSession(currentSessionId);
      sse.send("phase", { phase: "split_done", message: "剧本已切分完成！" });
      sse.send("complete", { status: "done", sessionId: currentSessionId });

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

  // 评测剧本并自动切分（SSE）— 单轮评测 + 切分，无多轮重写
  app.post("/api/admin/scripts/:id/review-split", authMiddleware, adminMiddleware, async (req, res) => {
    const sse = sseResponse(req, res);
    try {
      const s = await ensureSession(req.params.id);
      if (!s) { sse.send("error", { message: "剧本不存在" }); return sse.end(); }
      sse.send("phase", { phase: "review", message: "正在评测剧本（查找逻辑漏洞）..." });
      const reviewResult = await reviewScript(s.sessionId, (stage, msg) => sse.send("progress", { stage, message: msg }));
      if (sse.isClosed()) return;
      if (!reviewResult.ok) { sse.send("error", { message: reviewResult.error, phase: "review" }); return sse.end(); }
      sse.send("phase", { phase: "split", message: "评测完成，正在切分剧本..." });
      const splitResult = await splitScript(s.sessionId, (stage, msg) => sse.send("progress", { stage, message: msg }));
      if (sse.isClosed()) return;
      if (!splitResult.ok) { sse.send("error", { message: splitResult.error, phase: "split" }); return sse.end(); }
      await deleteSession(s.sessionId);
      sse.send("complete", { status: "done", sessionId: s.sessionId });
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
          const { getScript } = require("../core/db");
          const pg = await getScript(sid);
          if (pg && pg.original_markdown) { fallbackMarkdown = pg.original_markdown; fallbackTopic = pg.title; }
        } catch (e) { console.warn("[admin] split fallback PG failed:", e.message); }
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
        const { getScript } = require("../core/db");
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
      let artifacts = null;   // 中间产物（推理链/大纲/交叉校验问题），供详情页复核"这稿弱在哪"

      // 1. 优先 PostgreSQL
      try {
        const { getScript } = require("../core/db");
        const pg = await getScript(req.params.id);
        if (pg && pg.title) {
          artifacts = pg.artifacts || null;   // jsonb 由 pg 驱动直接还原成对象
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
          // Redis 侧存的是 JSON 串；解析失败就当没有（旧剧本本就没有这一步）
          if (meta.artifacts) {
            try { artifacts = JSON.parse(meta.artifacts); }
            catch (e) { console.warn("[admin] 中间产物解析失败:", e.message); }
          }
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
      // artifacts 单独返回：Redis 路径下 meta 是原始 hash，里面那串 JSON 若跟着展开
      // 会在响应里出现两份（一份字符串、一份对象），白白把响应撑大一倍。
      const { artifacts: _rawArtifacts, ...metaRest } = meta;
      res.json({
        meta: { ...metaRest, characterNames: JSON.parse(meta.characterNames || "[]") },
        characters, clues, dm: dmData || {}, artifacts,
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

  // ============ 仪表盘统计 ============
  // 用户 / 剧本 / 房间数量 + LLM token 消耗（进程内累计）
  app.get("/api/admin/stats", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { getUsageStats } = require("../llm/generator");
      const llm = getUsageStats();

      let userCount = 0;
      try { userCount = (await listUsers()).length; } catch (e) { /* 忽略 */ }

      // 剧本数：PG 入库 ∪ Redis 切分 ∪ 未切分 session，去重统计
      const scriptIds = new Set();
      try {
        const { listScripts } = require("../core/db");
        (await listScripts()).forEach(s => scriptIds.add(s.id));
      } catch (e) { /* 忽略 */ }
      try {
        const r = getRedis();
        (await r.smembers("scripts:split")).forEach(id => scriptIds.add(id));
      } catch (e) { /* 忽略 */ }
      try {
        (await listSessions()).forEach(s => scriptIds.add(s.sessionId));
      } catch (e) { /* 忽略 */ }

      let roomCount = 0;
      try { roomCount = (await getRedis().smembers("rooms:open")).length; } catch (e) { /* 忽略 */ }

      res.json({
        users: userCount,
        scripts: scriptIds.size,
        rooms: roomCount,
        llm: {
          calls: llm.calls,
          inputTokens: llm.inputTokens,
          outputTokens: llm.outputTokens,
          totalTokens: llm.inputTokens + llm.outputTokens,
        },
        uptime: process.uptime(),
        updatedAt: new Date().toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PG 异步同步队列状态
  app.get("/api/admin/sync-status", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { pendingIds } = require("../core/pg-sync");
      const r = getRedis();
      const failed = await r.smembers("sync:failed").catch(() => []);
      const pending = pendingIds();
      res.json({ pending, pendingCount: pending.length, failed, failedCount: failed.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 手动触发 PG 同步（队列 + 挂起失败项；body.reconcileAll=true 时全量对账缺失剧本）
  app.post("/api/admin/sync-now", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { syncOne, pendingIds } = require("../core/pg-sync");
      const r = getRedis();
      const body = req.body || {};
      const targets = new Set(pendingIds());
      (await r.smembers("sync:failed").catch(() => [])).forEach(id => targets.add(id));
      if (body.reconcileAll) {
        const splitIds = await r.smembers("scripts:split").catch(() => []);
        let pgIds = new Set();
        try {
          const { listScripts } = require("../core/db");
          pgIds = new Set((await listScripts()).map(s => s.id));
        } catch (e) { /* 忽略 */ }
        splitIds.forEach(id => { if (!pgIds.has(id)) targets.add(id); });
      }
      const ids = [...targets];
      if (ids.length === 0) return res.json({ synced: [], failed: [], note: "无需同步" });
      const synced = [];
      const failed = [];
      for (const id of ids) {
        try {
          await syncOne(id);
          synced.push(id);
          await r.srem("sync:failed", id);
        } catch (e) {
          failed.push({ id, error: e.message });
        }
      }
      res.json({ synced, failed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============ 数据备份 / 恢复 ============
  // 业务数据 key 白名单（排除 token 等临时/敏感数据，避免全量导出扫描生产 Redis）
  const DATA_KEY_PREFIXES = ["split:", "user:", "session:", "game:", "sessions:index", "scripts:split", "rooms:open"];
  const DATA_MAX_KEYS = 50000;          // 单次导出/导入 key 数量上限
  const DATA_IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
  const DATA_TTL_MAX = 30 * 24 * 3600;  // 导入 TTL 上限：30 天

  function isBusinessKey(key) {
    if (key.startsWith("token:")) return false;
    return DATA_KEY_PREFIXES.some(p => key.startsWith(p));
  }

  // 数据导出（仅业务数据，带上限保护）
  app.get("/api/admin/export", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const r = getRedis();
      const allKeys = await scanKeys("*");
      const keys = allKeys.filter(isBusinessKey);
      if (keys.length > DATA_MAX_KEYS) {
        return res.status(413).json({ error: `可导出的数据量过大(${keys.length} keys > ${DATA_MAX_KEYS})，请先清理旧数据再导出` });
      }
      const redisData = {};
      for (const key of keys) {
        const type = await r.type(key);
        if (type === "string") redisData[key] = { type, val: await r.get(key) };
        else if (type === "hash") {
          const h = await r.hgetall(key);
          // 用户数据脱敏：绝不导出密码哈希
          if (key.startsWith("user:") && h && h.password !== undefined) delete h.password;
          redisData[key] = { type, val: h };
        }
        else if (type === "set") redisData[key] = { type, val: await r.smembers(key) };
        else if (type === "zset") { const items = await r.zrange(key, 0, -1, "WITHSCORES"); redisData[key] = { type, val: items }; }
        else if (type === "list") redisData[key] = { type, val: await r.lrange(key, 0, -1) };
        redisData[key].ttl = await r.ttl(key);
      }

      // PG 数据导出
      let pgData = null;
      try {
        const { listScripts, listUsers } = require("../core/db");
        const pgScripts = await listScripts();
        const pgUsers = await listUsers();
        pgData = { scripts: pgScripts, users: pgUsers };
      } catch (e) { pgData = { error: e.message }; }

      res.json({
        redis: { keys: Object.keys(redisData).length, skipped: allKeys.length - keys.length, data: redisData },
        pg: pgData,
        exportedAt: new Date().toISOString(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 数据导入（key 白名单 + 类型校验 + 大小限制，防止覆写敏感数据）
  app.post("/api/admin/import", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { data } = req.body;
      if (!data || typeof data !== "object") return res.status(400).json({ error: "无数据" });
      const entries = Object.entries(data);
      if (entries.length === 0) return res.status(400).json({ error: "数据为空" });
      if (entries.length > DATA_MAX_KEYS) {
        return res.status(413).json({ error: `导入的 key 数量(${entries.length})超过上限(${DATA_MAX_KEYS})` });
      }
      const sizeBytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
      if (sizeBytes > DATA_IMPORT_MAX_BYTES) {
        return res.status(413).json({ error: `导入数据过大(${(sizeBytes / 1024 / 1024).toFixed(1)}MB > 2MB)` });
      }
      const r = getRedis();
      const allowedTypes = ["string", "hash", "set", "zset", "list"];
      let count = 0;
      let rejected = 0;
      for (const [key, info] of entries) {
        // key 白名单：只允许业务数据，防止覆写 token / 未知 key
        if (!isBusinessKey(key)) { rejected++; continue; }
        if (!info || typeof info !== "object" || !allowedTypes.includes(info.type)) { rejected++; continue; }
        if (info.type === "string" && typeof info.val !== "string") { rejected++; continue; }
        if (info.type !== "string" && !(Array.isArray(info.val) || typeof info.val === "object")) { rejected++; continue; }
        if (info.type === "string") await r.set(key, info.val);
        else if (info.type === "hash" && info.val) await r.hset(key, info.val);
        else if (info.type === "set" && info.val && info.val.length) await r.sadd(key, ...info.val);
        else if (info.type === "zset" && info.val && info.val.length) await r.zadd(key, ...info.val);
        else if (info.type === "list" && info.val && info.val.length) await r.rpush(key, ...info.val);
        const ttl = info.ttl;
        if (Number.isFinite(ttl) && ttl > 0 && ttl <= DATA_TTL_MAX) await r.expire(key, Math.floor(ttl));
        count++;
      }
      res.json({ imported: count, rejected });
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

  // ============ 测试剧本（全 AI 对局，管理员旁观） ============
  // 与"房间管理"分开：这些房间是**测试房**（room.testRun），不进公开房间列表、
  // 有独立的压缩节奏与自动推进，只允许管理员旁观。见 socket/test-run.js。
  app.post("/api/admin/test-runs", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { scriptSessionId, phaseMinutes } = req.body || {};
      if (!scriptSessionId) return res.status(400).json({ error: "请选择剧本" });
      const { startTestRun } = require("../socket/test-run");
      res.json(await startTestRun(io, scriptSessionId, { phaseMinutes }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 在跑/已跑完的测试局。登记在 Redis 里，所以服务重启后这里仍然读得到（并会被自动接着推进）。
  app.get("/api/admin/test-runs", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { listTestRuns } = require("../socket/test-run");
      res.json({ runs: await listTestRuns() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ==================== 测试报告（一局跑完落库，管理端可回看） ====================
  // 为什么落 PG 而不是房间里的 Redis：房间 6 小时后会被生命周期回收，
  // 而"这局测出了什么"是结论，要能长期回看。
  app.get("/api/admin/test-reports", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { listTestReports } = require("../core/test-report-repo");
      res.json({ reports: await listTestReports(req.query.limit || 50) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/admin/test-reports/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { getTestReport } = require("../core/test-report-repo");
      const r = await getTestReport(Number(req.params.id));
      if (!r) return res.status(404).json({ error: "报告不存在" });
      res.json({ report: r });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/admin/test-reports/:id", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { deleteTestReport } = require("../core/test-report-repo");
      const id = await deleteTestReport(Number(req.params.id));
      if (!id) return res.status(404).json({ error: "报告不存在" });
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * 测试房里**全部角色的剧本**（含秘密与真凶标记）—— 管理员旁观时要能对照"AI 有没有照着剧本演"。
   *
   * 只对测试房开放：真人局里有别人的秘密，这个接口在那边等于越权读全场。
   * 正文用 normalizeCharacterScript 归一化：角色正文在不同来源下形态不一致
   * （parseScript 是 {story,secret,fullScript}、split 路径是 {story,secret}、旧数据是字符串），
   * 自己写 `c.script || ""` 会拿到对象、拼进页面就是 "[object Object]"。
   */
  app.get("/api/admin/test-runs/:code/scripts", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const room = await getRoom(req.params.code);
      if (!room) return res.status(404).json({ error: "房间不存在或已结束" });
      if (!room.testRun) return res.status(403).json({ error: "只能查看测试房的剧本" });
      const parsed = JSON.parse(room.parsedScript || "{}");
      const { normalizeCharacterScript } = require("../script/script-parser");
      res.json({
        title: parsed.title || "",
        caseDate: parsed.caseDate || "",
        victim: parsed.victim || null,
        scene: String(parsed.layoutDescription || "").slice(0, 1200),
        murderer: parsed.murderer || { name: room.murdererName || "" },
        dmGuide: parsed.dmGuide || null,
        characters: (parsed.characters || []).map((c) => {
          const n = normalizeCharacterScript(c);
          return {
            name: c.name, occupation: c.occupation || "", roleType: c.roleType || "player",
            isMurderer: !!c.isMurderer, personality: c.personality || "", goal: c.goal || "",
            script: n.script, secret: n.secret,
          };
        }),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/api/admin/test-runs/:code", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { closeTestRun } = require("../socket/test-run");
      await closeTestRun(io, req.params.code);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ============ 模型管理（生成大模型切换） ============
  const { listModels, upsertModel, removeModel, setActive, getAllModels } = require("../llm/model-manager");

  /** 额外请求头：接受对象或 JSON 字符串；写错要报错而不是静默丢弃，
   *  否则"配了 x-opencode-session 却一直 401"这种问题极难排查。 */
  function parseExtraHeaders(v) {
    if (v === undefined || v === null || v === "") return {};
    if (typeof v === "object") return v;
    const s = String(v).trim();
    if (!s) return {};
    let o;
    try { o = JSON.parse(s); } catch (e) { throw new Error("额外请求头必须是合法 JSON，例如 {\"x-opencode-session\":\"abc\"}"); }
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("额外请求头必须是 JSON 对象");
    for (const [k, val] of Object.entries(o)) {
      if (typeof val !== "string" && typeof val !== "number") throw new Error(`请求头 ${k} 的值必须是字符串`);
    }
    return o;
  }

  // 列出全部通道模型（含环境默认项）
  app.get("/api/admin/models", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      res.json(await getAllModels());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 添加/更新模型
  app.post("/api/admin/models/:channel", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { channel } = req.params;
      const { name, apiKey, baseUrl, model, note, extraHeaders } = req.body || {};
      // extraHeaders 原先在这个路由被直接丢掉，导致像 opencode.ai/zen/go 这种
      // 要求 x-opencode-session 的网关在管理端根本配不出来（注册表里那条 mimo-v2.5
      // 备注写着"需 x-opencode-session 头"，却从来没有这个字段）。
      const result = await upsertModel(channel, name, { apiKey, baseUrl, model, note, extraHeaders: parseExtraHeaders(extraHeaders) });
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 删除模型
  app.delete("/api/admin/models/:channel/:name", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { channel, name } = req.params;
      res.json(await removeModel(channel, decodeURIComponent(name)));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 设置当前生效模型（name = "env" 表示环境默认）
  app.post("/api/admin/models/:channel/active", authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { channel } = req.params;
      const { name } = req.body || {};
      res.json(await setActive(channel, name));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 测试模型连通（对指定模型发一条最小请求，报告可用性）
  // 安全：仅接受 POST（凭据不进 URL/日志），并校验 baseUrl 目标（禁内网/环回，防 SSRF）
  app.post("/api/admin/models/:channel/test", authMiddleware, adminMiddleware, async (req, res) => {
    const sse = sseResponse(req, res, 60 * 1000, 55 * 1000);
    try {
      const { channel } = req.params;
      const b = req.body || {};
      const name = String(b.name || "");
      // 若填了已登记模型的名称且未重新输入密钥，就用该模型自己存储的配置来测。
      // 历史行为：apiKey 留空时回退到"通道的环境密钥"，于是从界面上测试一个已登记的
      // opencode 模型必然 401（用的是 Agnes 的密钥打 opencode 的网关）。
      let reg = null;
      if (name) {
        try {
          const { getRedis } = require("../core/redis-client");
          const rr = await getRedis();
          const raw = await rr.hget(`model:registry:${channel}`, name);
          if (raw) reg = JSON.parse(raw);
        } catch (e) { /* 读不到就按未登记处理 */ }
      }
      const apiKey = String(b.apiKey || "") || (reg && reg.apiKey) || "";
      const baseUrl = String(b.baseUrl || "") || (reg && reg.baseUrl) || "";
      const model = String(b.model || "") || (reg && reg.model) || "";
      // 测试连通也要带自定义请求头，否则 opencode 这类网关在界面上永远测不通
      const extraHeaders = { ...((reg && reg.extraHeaders) || {}), ...parseExtraHeaders(b.extraHeaders) };
      const https = require("https");
      const http = require("http");
      const base = (baseUrl || (channel === "reasoning" ? (process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1") : (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"))).replace(/\/+$/, "");
      const key = apiKey || (channel === "reasoning" ? process.env.AGNES_API_KEY : process.env.DEEPSEEK_API_KEY);
      const mdl = model || (channel === "reasoning" ? (process.env.AGNES_MODEL || "agnes-2.5-flash") : (process.env.DEFAULT_MODEL || "deepseek-v4-flash"));

      // SSRF 防护：只允许 http/https 且目标主机解析后不得是内网/环回/链路本地地址
      let u;
      try { u = new URL(base + "/chat/completions"); } catch (e) {
        sse.send("error", { message: "Base URL 格式非法" }); return sse.end();
      }
      if (!["http:", "https:"].includes(u.protocol)) {
        sse.send("error", { message: "仅支持 http/https 地址" }); return sse.end();
      }
      const unsafe = await isUnsafeOutboundHost(u.hostname);
      if (unsafe) {
        sse.send("error", { message: "出于安全考虑，禁止测试内网/环回地址" }); return sse.end();
      }
      const mod = u.protocol === "http:" ? http : https;
      const body = JSON.stringify({ model: mdl, messages: [{ role: "user", content: "回复OK两个字母" }], max_tokens: 50 });
      const result = await new Promise((resolve) => {
        const req2 = mod.request({
          hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
          path: u.pathname + u.search, method: "POST",
          headers: {
            "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
            "Authorization": "Bearer " + (key || ""),
            "User-Agent": "murder-mystery/1.0",
            ...extraHeaders,
          },
          timeout: 45000, agent: new mod.Agent({ keepAlive: false }),
        }, res2 => {
          const chunks = [];
          res2.on("data", c => chunks.push(c));
          res2.on("end", () => resolve({ status: res2.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req2.on("error", err => resolve({ status: 0, error: err.message }));
        req2.on("timeout", () => { req2.destroy(); resolve({ status: 0, error: "timeout" }); });
        req2.write(body);
        req2.end();
      });
      if (!result || result.status === 0) {
        sse.send("error", { message: "连接失败: " + (result && result.error || "未知错误") });
        return sse.end();
      }
      if (result.status !== 200) {
        sse.send("error", { message: "HTTP " + result.status + ": " + String(result.body || "").substring(0, 200) });
        return sse.end();
      }
      let content = "";
      try { content = JSON.parse(result.body)?.choices?.[0]?.message?.content || ""; } catch (e) {}
      sse.send("complete", { status: "ok", httpStatus: result.status, model: mdl, reply: String(content || "").substring(0, 100) });
      return sse.end();
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
      else { try { res.write("event: error\ndata: " + JSON.stringify({ message: e.message }) + "\n\n"); } catch (_) {} try { res.end(); } catch (_) {} }
    }
  });
}
module.exports = { setupAdminRoutes };
