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
};
