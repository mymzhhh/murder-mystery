// 游戏房间管理 — Redis 持久化（并发安全版）
// 使用 WATCH+MULTI 乐观锁 + 独立 key 设计避免误冲突
const { getRedis, scanKeys, ensureRedis } = require("./redis-client");
const { v4: uuidv4 } = require("uuid");
const { isRoomExpired } = require("./room-lifecycle");

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
  let code = null;
  const now = Date.now();
  // 用 SET NX 占位键保证房间号唯一（替代共享连接上的 WATCH/MULTI——
  // ioredis 的事务是连接级状态，并发调用会互相污染）
  for (let attempt = 0; attempt < 20; attempt++) {
    const cand = genRoomCode();
    const lockKey = `game:${cand}:creating`;
    const claimed = await r.set(lockKey, "1", "EX", 10, "NX");
    if (!claimed) continue;
    try {
      if (await r.exists(`game:${cand}`)) continue;
      const room = {
        roomCode: cand, status: "lobby", phase: "lobby",
        createdAt: now, dmPlayerId, maxPlayers: 8,
        scriptSessionId: "", parsedScript: "",
        murdererName: "", phaseStartedAt: now, phaseDurationSec: 0,
      };
      await r.hset(`game:${cand}`, room);
      await r.zadd("games:index", now, cand);
      code = cand;
      break;
    } finally {
      await r.del(lockKey).catch(() => {});
    }
  }
  if (!code) throw new Error("createRoom: 房间号生成失败，请重试");
  // DM 作为第一个玩家加入
  await addPlayer(code, dmPlayerId, dmName, true);
  const room = await getRoom(code);
  return { ...room, players: await getPlayers(code) };
}

async function getRoom(code) {
  const r = await ensureConn();
  const room = await r.hgetall(`game:${code}`);
  if (!room || !room.roomCode) return null;
  // 超过最大存活时间的房间一律视为不存在。
  // 放在这里是因为 getRoom 是所有入口（加入/列表/每个动作/阶段推进）唯一的收口点，
  // 只要这一处拦住，过期房间就不可能再被进入；实际删除交给 room-lifecycle 的扫描器。
  if (isRoomExpired(room)) return null;
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
  await r.srem("rooms:open", code);
  // 通知各模块释放该房间的内存态（AI 定时器、阶段计时器、语音成员……）。
  // 放在这里而不是各个调用点：删房间有四条路径（断线超时/主动离开/管理端/生命周期扫描器），
  // 以前只有前两条做了内存清理，扫描器与管理端删除会留下永不释放的内存条目。
  try { require("./room-cleanup-hooks").runRoomDeleted(code); } catch (e) { /* 清理失败不影响删除 */ }
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

// 原子合并玩家字段（Lua 脚本，避免共享连接上的 WATCH/MULTI 事务互相污染）
const UPDATE_PLAYER_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local obj = cjson.decode(raw)
local patch = cjson.decode(ARGV[1])
for k, v in pairs(patch) do obj[k] = v end
local out = cjson.encode(obj)
redis.call('SET', KEYS[1], out)
return out
`;

async function updatePlayer(code, playerId, fields) {
  const r = await ensureConn();
  const key = playerKey(code, playerId);
  const out = await r.eval(UPDATE_PLAYER_LUA, 1, key, JSON.stringify(fields || {}));
  return out ? JSON.parse(out) : null;
}

async function removePlayer(code, playerId) {
  const r = await ensureConn();
  await r.del(playerKey(code, playerId));
  // 顺带释放该玩家占用的角色占位。不释放的话，人走了角色还锁着，
  // 其他人再也选不了那个角色（房间还活着的整段时间都受影响）。
  try { await releaseCharacterClaims(code, playerId); } catch (e) { /* 不影响移除 */ }
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

// ==================== 并发抢占（原子占位） ====================
// 线索与角色都必须"先原子抢到、再落库"，否则并发下会出现
// "读的时候还是空闲、写的时候已经被别人拿走了"（TOCTOU）。
// 人类玩家路径原本已经用 SET NX 加固，但 AI 的搜证路径漏了同一套保护 ——
// 抽成共用助手就是为了杜绝"加固了一条路径、忘了另一条"。

/** 原子抢一条线索。true = 抢到（或本来就是自己占的）。 */
async function claimClue(code, clueId, playerId, ttlSec = 3600) {
  const r = await ensureConn();
  const key = `game:${code}:claim:${clueId}`;
  const ok = await r.set(key, playerId, "EX", ttlSec, "NX");
  if (ok === "OK") return true;
  return (await r.get(key)) === playerId;
}

/**
 * 原子占一个角色。true = 占成功。
 * 用 HSETNX 而不是"先查后写"：两名玩家同时选同一个角色时，
 * 原来的 check-then-act 会双双通过校验、双双写入（实测复现过）。
 */
async function claimCharacter(code, characterName, playerId) {
  const r = await ensureConn();
  const key = `game:${code}:charclaims`;
  const created = await r.hsetnx(key, characterName, playerId);
  if (created === 1) return true;
  return (await r.hget(key, characterName)) === playerId;
}

/** 释放某个角色占位（只有持有者本人能释放）。true = 确实释放了。 */
async function releaseCharacterClaim(code, characterName, playerId) {
  const r = await ensureConn();
  const key = `game:${code}:charclaims`;
  const holder = await r.hget(key, characterName);
  if (holder !== playerId) return false;
  await r.hdel(key, characterName);
  return true;
}

/** 释放该玩家占用的全部角色（换角、离开房间时用）。返回被释放的角色名。 */
async function releaseCharacterClaims(code, playerId) {
  const r = await ensureConn();
  const key = `game:${code}:charclaims`;
  const all = await r.hgetall(key).catch(() => ({}));
  const mine = Object.entries(all || {}).filter(([, pid]) => pid === playerId).map(([name]) => name);
  if (mine.length) await r.hdel(key, ...mine);
  return mine;
}

async function assignClue(code, clueId, playerId) {  const r = await ensureConn();
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


// ==================== 开场介绍 ====================

async function addIntroduction(code, characterName, content) {
  const r = await ensureConn();
  await r.hset(`game:${code}:intro`, characterName, content);
}

async function getIntroductions(code) {
  const r = await ensureConn();
  return (await r.hgetall(`game:${code}:intro`)) || {};
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

// ==================== 玩家便签（私有，仅本人可读写） ====================

// 便签按【玩家名（登录用户名）】而不是 playerId 存储：
// playerId 是 socket.id，断线重连会换一个，用它做键会让玩家一掉线笔记就丢失。
// 这也是 ready 计数采用 playerName 作为稳定成员标识的同一个理由。
const NOTES_MAX = 30;
const NOTES_TITLE_MAX = 120;
const NOTES_BODY_MAX = 4000;
const NOTES_TOTAL_MAX = 60000;

function notesKey(code, playerName) {
  // encodeURIComponent 兜住用户名里的冒号/空格等，避免污染 Redis 键空间
  return `game:${code}:notes:${encodeURIComponent(String(playerName || ""))}`;
}

async function getNotes(code, playerName) {
  const r = await ensureConn();
  const raw = await r.get(notesKey(code, playerName));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

/** 便签清洗：截断、去空、限制总长度。抽成纯函数以便离线单测（不依赖 Redis）。 */
function normalizeNotes(notes) {
  const list = Array.isArray(notes) ? notes.slice(0, NOTES_MAX) : [];
  let total = 0;
  const clean = [];
  for (const n of list) {
    if (!n || typeof n !== "object") continue;
    const body = String(n.content || "").slice(0, NOTES_BODY_MAX);
    const title = String(n.title || "").slice(0, NOTES_TITLE_MAX);
    if (!title && !body.trim()) continue; // 全空的便签不存，避免留下空壳
    if (total + title.length + body.length > NOTES_TOTAL_MAX) break;
    total += title.length + body.length;
    clean.push({
      id: String(n.id || uuidv4()).slice(0, 64),
      title,
      content: body,
      updatedAt: new Date().toISOString(),
    });
  }
  return clean;
}

async function saveNotes(code, playerName, notes) {
  const r = await ensureConn();
  const clean = normalizeNotes(notes);
  await r.set(notesKey(code, playerName), JSON.stringify(clean));
  return clean;
}

module.exports = {
  createRoom, getRoom, updateRoom, deleteRoom,
  addPlayer, getPlayers, getPlayer, updatePlayer, removePlayer,
  loadClues, getClues, assignClue, getPlayerClues,
  claimClue, claimCharacter, releaseCharacterClaim, releaseCharacterClaims,
  recordVote, getVotes, clearVotes,
  addIntroduction, getIntroductions,
  addChatMessage, getChatMessages,
  getNotes, saveNotes, normalizeNotes,
  getRedis,
};
