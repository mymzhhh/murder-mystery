// 历史会话管理模块 — Redis 存储
const { getRedis } = require("./redis-client");
const { v4: uuidv4 } = require("uuid");

/**
 * 创建新会话
 */
async function createSession(metadata = {}) {
  const r = getRedis();
  const sessionId = uuidv4();
  const now = new Date().toISOString();
  const timestamp = Date.now();

  // 基础字段 + 所有额外 metadata 字段
  const sessionData = {
    sessionId,
    createdAt: now,
    updatedAt: now,
    textType: metadata.textType || "marketing",
    topic: metadata.topic || "",
    templateName: metadata.templateName || "",
  };

  // 将额外 metadata 字段（如 playerCount, npcCount, isPVE）也存入 hash
  for (const [key, value] of Object.entries(metadata)) {
    if (!sessionData[key] && value !== undefined) {
      sessionData[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  await r
    .multi()
    .hset(`session:${sessionId}`, sessionData)
    .zadd("sessions:index", timestamp, sessionId)
    .exec();

  return {
    sessionId,
    createdAt: now,
    updatedAt: now,
    messages: [],
    metadata: sessionData,
  };
}

/**
 * 获取单个会话（含消息）
 */
async function getSession(sessionId) {
  const r = getRedis();
  const exists = await r.exists(`session:${sessionId}`);
  if (!exists) return null;

  const [meta, messagesRaw] = await Promise.all([
    r.hgetall(`session:${sessionId}`),
    r.lrange(`session:${sessionId}:messages`, 0, -1),
  ]);

  const messages = messagesRaw.map((m) => JSON.parse(m));

  return {
    sessionId: meta.sessionId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messages,
    metadata: meta,
  };
}

/**
 * 添加消息到会话
 */
async function addMessage(sessionId, role, content) {
  const r = getRedis();
  const exists = await r.exists(`session:${sessionId}`);
  if (!exists) return null;

  const now = new Date().toISOString();
  const timestamp = Date.now();

  const message = JSON.stringify({ role, content, timestamp: now });

  await r
    .multi()
    .rpush(`session:${sessionId}:messages`, message)
    .hset(`session:${sessionId}`, "updatedAt", now)
    .zadd("sessions:index", timestamp, sessionId)
    .exec();

  // 如果是用户消息且较短，更新主题
  if (role === "user" && content.length < 200) {
    await r.hset(`session:${sessionId}`, "topic", content);
  }

  return getSession(sessionId);
}

/**
 * 列出所有会话（按更新时间倒序）
 */
async function listSessions() {
  const r = getRedis();

  // 从有序集合中按时间倒序获取所有 session ID
  const ids = await r.zrevrange("sessions:index", 0, -1);
  if (ids.length === 0) return [];

  // 批量获取每个会话的元数据
  const pipeline = r.pipeline();
  ids.forEach((id) => {
    pipeline.hgetall(`session:${id}`);
    pipeline.llen(`session:${id}:messages`);
  });
  const results = await pipeline.exec();

  const sessions = [];
  for (let i = 0; i < ids.length; i++) {
    const meta = results[i * 2][1];
    const msgCount = results[i * 2 + 1][1];
    if (meta && meta.sessionId) {
      sessions.push({
        sessionId: meta.sessionId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        topic: meta.topic || "(无标题)",
        textType: meta.textType || "marketing",
        messageCount: msgCount || 0,
      });
    }
  }

  return sessions;
}

/**
 * 保存会话的中间产物（推理链/大纲/交叉校验问题）。
 *
 * ⚠️ 必须用**独立 key**，不能塞进 `session:<id>` 这个 hash：
 * listSessions 会对每个会话做一次 hgetall，把几十 KB 的 JSON 放进 hash 会把列表接口拖垮。
 * 产物随切分流程一起进 PG（见 pg-sync），这里存的是切分前的第一手副本。
 */
async function saveSessionArtifacts(sessionId, artifacts) {
  if (!sessionId || !artifacts) return false;
  const r = getRedis();
  const exists = await r.exists(`session:${sessionId}`);
  if (!exists) return false;
  await r.set(`session:${sessionId}:artifacts`, JSON.stringify(artifacts));
  return true;
}

/** 读取会话的中间产物（解析失败/不存在都返回 null，绝不抛） */
async function getSessionArtifacts(sessionId) {
  if (!sessionId) return null;
  try {
    const raw = await getRedis().get(`session:${sessionId}:artifacts`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    console.warn("[history] 中间产物解析失败:", e.message);
    return null;
  }
}

/**
 * 删除会话
 */
async function deleteSession(sessionId) {
  const r = getRedis();
  const exists = await r.exists(`session:${sessionId}`);
  if (!exists) return false;

  await r
    .multi()
    .del(`session:${sessionId}`)
    .del(`session:${sessionId}:messages`)
    .del(`session:${sessionId}:artifacts`)   // 一并清掉，避免孤儿 key
    .zrem("sessions:index", sessionId)
    .exec();

  return true;
}

module.exports = {
  createSession,
  getSession,
  addMessage,
  listSessions,
  deleteSession,
  saveSessionArtifacts,
  getSessionArtifacts,
};
