// 游戏房间管理 — Redis 持久化

const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let redis = null;

function getRedis() {
  if (!redis) {
    var opts = { maxRetriesPerRequest: 2, retryStrategy: function(t) { return Math.min(t * 1000, 10000); }, lazyConnect: true, enableOfflineQueue: true };
    if (REDIS_URL.startsWith("rediss://") || process.env.RAILWAY_ENVIRONMENT) opts.tls = { rejectUnauthorized: false };
    redis = new Redis(REDIS_URL, opts);
    redis.on("error", function() {});
  }
  return redis;
}

async function ensureConn() {
  const r = getRedis();
  if (r.status !== "ready" && r.status !== "connecting") await r.connect();
  return r;
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ==================== 房间 CRUD ====================

async function createRoom(dmPlayerId, dmName) {
  const r = await ensureConn();
  let code;
  do { code = genRoomCode(); } while (await r.exists(`game:${code}`));

  const now = Date.now();
  const room = {
    roomCode: code, status: "lobby", phase: "lobby",
    createdAt: now, dmPlayerId, maxPlayers: 8,
    scriptSessionId: "", parsedScript: "",
    murdererName: "", phaseStartedAt: now, phaseDurationSec: 0,
  };

  await r.multi()
    .hset(`game:${code}`, room)
    .zadd("games:index", now, code)
    .exec();

  // DM 作为第一个玩家加入
  await addPlayer(code, dmPlayerId, dmName, true);

  return { ...room, players: await getPlayers(code) };
}

async function getRoom(code) {
  const r = await ensureConn();
  const room = await r.hgetall(`game:${code}`);
  if (!room || !room.roomCode) return null;
  return room;
}

async function updateRoom(code, fields) {
  const r = await ensureConn();
  await r.hset(`game:${code}`, fields);
}

async function deleteRoom(code) {
  const r = await ensureConn();
  await r.multi()
    .del(`game:${code}`)
    .del(`game:${code}:players`)
    .del(`game:${code}:clues`)
    .del(`game:${code}:votes`)
    .del(`game:${code}:chat`)
    .zrem("games:index", code)
    .exec();
}

async function listRooms() {
  const r = await ensureConn();
  const codes = await r.zrevrange("games:index", 0, 19);
  if (!codes.length) return [];
  const pipe = r.pipeline();
  codes.forEach(c => pipe.hgetall(`game:${c}`));
  const results = await pipe.exec();
  return results.map(r => r[1]).filter(Boolean);
}

// ==================== 玩家管理 ====================

async function addPlayer(code, playerId, name, isDM = false) {
  const r = await ensureConn();
  const player = JSON.stringify({
    playerId, playerName: name, characterName: "",
    characterScript: "", isDM, isAlive: true, connected: true,
    joinedAt: new Date().toISOString(),
  });
  await r.hset(`game:${code}:players`, playerId, player);
  return JSON.parse(player);
}

async function getPlayers(code) {
  const r = await ensureConn();
  const raw = await r.hgetall(`game:${code}:players`);
  if (!raw) return [];
  return Object.values(raw).map(v => JSON.parse(v));
}

async function getPlayer(code, playerId) {
  const r = await ensureConn();
  const raw = await r.hget(`game:${code}:players`, playerId);
  return raw ? JSON.parse(raw) : null;
}

async function updatePlayer(code, playerId, fields) {
  const r = await ensureConn();
  const player = await getPlayer(code, playerId);
  if (!player) return null;
  Object.assign(player, fields);
  await r.hset(`game:${code}:players`, playerId, JSON.stringify(player));
  return player;
}

async function removePlayer(code, playerId) {
  const r = await ensureConn();
  await r.hdel(`game:${code}:players`, playerId);
}

// ==================== 线索管理 ====================

async function loadClues(code, clues) {
  const r = await ensureConn();
  const pipe = r.pipeline();
  clues.forEach((c, i) => {
    pipe.hset(`game:${code}:clues`, c.id || `clue_${i}`, JSON.stringify({
      ...c, id: c.id || `clue_${i}`, foundBy: [],
    }));
  });
  await pipe.exec();
}

async function getClues(code, round) {
  const r = await ensureConn();
  const raw = await r.hgetall(`game:${code}:clues`);
  if (!raw) return [];
  let clues = Object.values(raw).map(v => JSON.parse(v));
  if (round) clues = clues.filter(c => c.round === round);
  return clues;
}

async function assignClue(code, clueId, playerId) {
  const r = await ensureConn();
  const raw = await r.hget(`game:${code}:clues`, clueId);
  if (!raw) return null;
  const clue = JSON.parse(raw);
  if (!clue.foundBy.includes(playerId)) {
    clue.foundBy.push(playerId);
    await r.hset(`game:${code}:clues`, clueId, JSON.stringify(clue));
  }
  return clue;
}

async function getPlayerClues(code, playerId) {
  const all = await getClues(code);
  return all.filter(c => c.foundBy.includes(playerId));
}

// ==================== 投票 ====================

async function recordVote(code, playerId, target) {
  const r = await ensureConn();
  await r.hset(`game:${code}:votes`, playerId, target);
}

async function getVotes(code) {
  const r = await ensureConn();
  const raw = await r.hgetall(`game:${code}:votes`);
  return raw || {};
}

async function clearVotes(code) {
  const r = await ensureConn();
  await r.del(`game:${code}:votes`);
}

// ==================== 聊天 ====================

async function addChatMessage(code, playerId, playerName, characterName, content, phase) {
  const r = await ensureConn();
  const msg = JSON.stringify({
    messageId: uuidv4(), playerId, playerName, characterName,
    content, phase, timestamp: new Date().toISOString(),
  });
  await r.multi()
    .lpush(`game:${code}:chat`, msg)
    .ltrim(`game:${code}:chat`, 0, 499)
    .exec();
  return JSON.parse(msg);
}

async function getChatMessages(code, limit = 100) {
  const r = await ensureConn();
  const raw = await r.lrange(`game:${code}:chat`, 0, limit - 1);
  return raw.map(v => JSON.parse(v)).reverse();
}

module.exports = {
  createRoom, getRoom, updateRoom, deleteRoom, listRooms,
  addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer,
  loadClues, getClues, assignClue, getPlayerClues,
  recordVote, getVotes, clearVotes,
  addChatMessage, getChatMessages,
  getRedis,
};
