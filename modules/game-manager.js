// 游戏房间管理 — Redis 持久化（并发安全版）
// 使用 WATCH+MULTI 乐观锁 + 独立 key 设计避免误冲突
const { getRedis, scanKeys, ensureRedis } = require("./redis-client");
const { v4: uuidv4 } = require("uuid");

async function ensureConn() { return ensureRedis(); }

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
  const now = Date.now();
  for (let attempt = 0; attempt < 20; attempt++) {
    code = genRoomCode();
    await r.watch(`game:${code}`);
    const exists = await r.exists(`game:${code}`);
    if (!exists) {
      const room = {
        roomCode: code, status: "lobby", phase: "lobby",
        createdAt: now, dmPlayerId, maxPlayers: 8,
        scriptSessionId: "", parsedScript: "",
        murdererName: "", phaseStartedAt: now, phaseDurationSec: 0,
      };
      const result = await r.multi()
        .hset(`game:${code}`, room)
        .zadd("games:index", now, code)
        .exec();
      if (result) break;
    } else {
      await r.unwatch();
    }
  }
  // DM 作为第一个玩家加入
  await addPlayer(code, dmPlayerId, dmName, true);
  const room = await getRoom(code);
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
  const allKeys = await scanKeys(`game:${code}*`);
  if (allKeys.length > 0) {
    await r.del(...allKeys);
  }
  await r.zrem("games:index", code);
}


// ==================== 玩家管理 ====================

/** 每个玩家独立 key：game:{code}:player:{playerId}，避免同 hash 不同 field 的 WATCH 误冲突 */

function playerKey(code, playerId) {
  return `game:${code}:player:${playerId}`;
}

async function addPlayer(code, playerId, name, isDM = false) {
  const r = await ensureConn();
  const player = {
    playerId, playerName: name, characterName: "",
    characterScript: "", isDM, isAlive: true, connected: true,
    joinedAt: new Date().toISOString(),
  };
  await r.set(playerKey(code, playerId), JSON.stringify(player));
  return player;
}

async function getPlayers(code) {
  const r = await ensureConn();
  const playerKeys = await scanKeys(`game:${code}:player:*`);
  if (!playerKeys.length) return [];
  const pipe = r.pipeline();
  playerKeys.forEach(k => pipe.get(k));
  const results = await pipe.exec();
  return results.map(([err, raw]) => {
    if (err || !raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }).filter(Boolean);
}

async function getPlayer(code, playerId) {
  const r = await ensureConn();
  const raw = await r.get(playerKey(code, playerId));
  return raw ? JSON.parse(raw) : null;
}

async function updatePlayer(code, playerId, fields) {
  const r = await ensureConn();
  const key = playerKey(code, playerId);
  for (let attempt = 0; attempt < 10; attempt++) {
    await r.watch(key);
    const raw = await r.get(key);
    if (!raw) { await r.unwatch(); return null; }
    const player = JSON.parse(raw);
    Object.assign(player, fields);
    const result = await r.multi().set(key, JSON.stringify(player)).exec();
    if (result) return player;
  }
  throw new Error("updatePlayer: 并发冲突，重试耗尽");
}

async function removePlayer(code, playerId) {
  const r = await ensureConn();
  await r.del(playerKey(code, playerId));
}


// ==================== 线索管理 ====================

/** 每条线索独立 key：game:{code}:clue:{clueId} + foundBy 用 SET 原子操作 */

function clueKey(code, clueId) {
  return `game:${code}:clue:${clueId}`;
}

function clueFoundByKey(code, clueId) {
  return `game:${code}:clue:${clueId}:foundBy`;
}

async function loadClues(code, clues) {
  const r = await ensureConn();
  const pipe = r.pipeline();
  clues.forEach((c, i) => {
    const id = c.id || `clue_${i}`;
    // 线索内容存为 JSON 字符串
    pipe.set(clueKey(code, id), JSON.stringify({
      ...c, id,
    }));
    // 清空 foundBy 集合
    pipe.del(clueFoundByKey(code, id));
  });
  await pipe.exec();
}

async function getClues(code, round) {
  const r = await ensureConn();
  const clueKeys = await scanKeys(`game:${code}:clue:*`);
  // 过滤掉 :foundBy 后缀的辅助 key
  const contentKeys = clueKeys.filter(k => !k.endsWith(":foundBy"));
  if (!contentKeys.length) return [];
  const pipe = r.pipeline();
  contentKeys.forEach(k => { pipe.get(k); pipe.smembers(k + ":foundBy"); });
  const results = await pipe.exec();
  let clues = [];
  for (let i = 0; i < contentKeys.length; i++) {
    const raw = results[i * 2][1];
    const foundByResult = results[i * 2 + 1][1];
    if (!raw) continue;
    try {
      const clue = JSON.parse(raw);
      clue.foundBy = Array.isArray(foundByResult) ? foundByResult : [];
      clues.push(clue);
    } catch (e) { /* skip bad data */ }
  }
  if (round) clues = clues.filter(c => c.round == round);
  return clues;
}

async function assignClue(code, clueId, playerId) {
  const r = await ensureConn();
  const contentKey = clueKey(code, clueId);
  const foundByKey = clueFoundByKey(code, clueId);

  // 检查线索是否存在
  const exists = await r.exists(contentKey);
  if (!exists) return null;

  // SADD 原子操作：天然去重，无竞态条件
  await r.sadd(foundByKey, playerId);

  // 重构并返回更新后的线索对象
  const raw = await r.get(contentKey);
  if (!raw) return null;
  const clue = JSON.parse(raw);
  const foundBy = await r.smembers(foundByKey);
  clue.foundBy = foundBy || [];
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
  createRoom, getRoom, updateRoom, deleteRoom,
  addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer,
  loadClues, getClues, assignClue, getPlayerClues,
  recordVote, getVotes, clearVotes,
  addChatMessage, getChatMessages,
  getRedis,
};
