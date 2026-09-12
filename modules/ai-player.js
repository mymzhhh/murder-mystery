// AI 玩家行为执行器 — 真人选完角色后，剩余玩家槽位角色自动由 AI 扮演
// 纯规则引擎（不调用 LLM）：
//   - 选角补位：computeAiFillers 计算剩余角色，syncAiFillers 差量创建/释放 AI 玩家
//   - 搜证：复用 game-engine 的 searchClues / pickRandomClue + assignClue
//   - 讨论：基于自己已发现线索的模板发言
//   - 投票：线索指向加权 + 随机噪声（AI 若为凶手则绝不投自己）
// 公平性红线：所有 AI 决策只读【公开信息】（已发现线索 / 角色名单），不读凶手答案。

const { getRoom, getPlayers, addPlayer, updatePlayer, removePlayer, getClues, assignClue, recordVote, getVotes, addChatMessage, addIntroduction } = require("./game-manager");
const { getAvailableCluesForPlayer, pickRandomClue, searchClues, getPhaseRound } = require("./game-engine");
const llm = require("./ai-player-llm");

// ==================== 纯逻辑（可单测） ====================

/**
 * 计算需要 AI 扮演的剩余角色
 * @param {Array} humans 真人玩家（!isNPC）
 * @param {Array} characters 剧本全部角色（含 roleType: player / npc）
 * @returns {Array} 剩余未被真人选择的玩家槽位角色
 */
function computeAiFillers(humans, characters) {
  const taken = new Set((humans || []).map(p => p && p.characterName).filter(Boolean));
  return (characters || []).filter(c => c && c.roleType !== "npc" && !taken.has(c.name));
}

/**
 * AI 投票目标选择（只读公开线索）
 * @param {object|null} aiScript AI 玩家的角色信息（characterScript 解析后，含 isMurderer）
 * @param {Array} publicClues 已发现的公开线索 [{content, location, id, foundBy}]
 * @param {Array} candidates 候选目标角色名数组（不含自己）
 * @returns {string} 目标角色名
 */
function chooseVoteTarget(aiScript, publicClues, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  // 30% 概率完全随机（模拟真人随意/甩票）
  if (Math.random() < 0.3) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  // 线索指向加权：角色名在公开线索内容/地点中出现次数
  const weights = {};
  for (const c of candidates) weights[c] = Math.random() * 1.5; // 噪声底分
  for (const clue of publicClues) {
    const text = ((clue.content || "") + " " + (clue.location || "") + " " + (clue.id || "")).toLowerCase();
    for (const c of candidates) {
      if (text.includes(c.toLowerCase())) weights[c] += 2;
    }
  }
  // 候选列表已排除自己（voteCandidates 传入 selfName），无需额外凶手压制逻辑。
  // 对手里权重最高的施加轻微随机，模拟真人"疑邻盗斧"的倾向。
  let best = candidates[0];
  let bestW = -Infinity;
  for (const c of candidates) {
    // 略偏"疑邻盗斧"：权重越高越可能投
    const noise = weights[c];
    const v = noise + Math.random() * 1.2;
    if (v > bestW) { bestW = v; best = c; }
  }
  return best;
}

/** 从候选里挑一个"非自己"的角色名列表（含真人/AI/审讯NPC），供投票用 */
function voteCandidates(players, characters, selfName, excludeNpcs) {
  const names = new Set();
  for (const p of (players || [])) {
    if (p.characterName && p.characterName !== selfName) names.add(p.characterName);
  }
  for (const c of (characters || [])) {
    // excludeNpcs=true（PVP）：NPC 是目击者/关系人，不进投票
    if (excludeNpcs && c.roleType === "npc") continue;
    if (c.name && c.name !== selfName) names.add(c.name);
  }
  return [...names];
}

/**
 * AI 讨论发言模板（基于自己发现的线索）
 * @param {Array} myClues AI 自己找到的线索
 * @param {Array} allChars 全部角色（用于随机提及）
 * @returns {string}
 */
function buildAiSpeech(myClues, allChars) {
  const chars = (allChars || []).map(c => c.name).filter(Boolean);
  const hint = (myClues && myClues[0] && myClues[0].content || "").trim().substring(0, 24);
  const someone = chars.length ? chars[Math.floor(Math.random() * chars.length)] : "某人";
  const templates = [
    `我查了下线索${hint ? "，" + hint + "…" : ""}，觉得${someone}有点问题。`,
    `目前我掌握的信息还不多，但${someone}的举动很可疑。`,
    `我这边线索指向不太明确，大家怎么看${someone}？`,
    hint ? `这条线索${hint}，让我对${someone}多了几分怀疑。` : `这个阶段先不做结论，我继续观察。`,
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

// ==================== 房间级操作（依赖 io / Redis） ====================

/**
 * AI 开场介绍：基于角色公开信息（姓名/职业/故事首段），绝不引用 secret
 */
function buildAiIntro(aiScript) {
  const name = (aiScript && aiScript.name) || "神秘人";
  const occupation = (aiScript && aiScript.occupation) || "";
  const scr = (aiScript && aiScript.script) || {};
  const story = (aiScript && (aiScript.playerScript || scr.playerScript || aiScript.fullScript || aiScript.story || scr.story)) || "";
  // 取故事开头第一段（自我介绍视角），截断
  const firstPart = String(story).split(/\n{2,}/)[0].trim().substring(0, 160);
  return `我是${name}${occupation ? "（" + occupation + "）" : ""}。${firstPart || "在这个特殊的日子里，我有幸来到案发现场。"}`;
}

/**
 * 同步 AI 补位玩家：保证"真人已选角色"之外的所有玩家槽位都有 AI 扮演（差量增删）
 * 进程内房间级互斥锁：并发 join_room / select_character 时会重入，
 * 若不加锁会造成重复创建/覆盖错乱，串行化后天然幂等。
 * @returns {Promise<Array>} 更新后的完整玩家列表
 */
const syncLocks = {}; // roomCode → Promise

async function syncAiFillers(roomCode) {
  if (!syncLocks[roomCode]) {
    syncLocks[roomCode] = (async () => {
      const players = await getPlayers(roomCode);
      const humans = players.filter(p => !p.isNPC);
      const room = await getRoom(roomCode);
      if (!room) return players;
      const parsed = JSON.parse(room.parsedScript || "{}");
      const wanted = computeAiFillers(humans, parsed.characters);

      const wantedNames = new Set(wanted.map(c => c.name));
      // 释放：被真人抢走 / 不再需要的 AI
      const ais = players.filter(p => p.isNPC && p.isAI);
      for (const ai of ais) {
        if (!wantedNames.has(ai.characterName)) {
          await removePlayer(roomCode, ai.playerId).catch(() => {});
          console.log(`[ai-player] 释放 AI 角色: ${ai.characterName || ai.playerId}`);
        }
      }

      // 补充：缺失的 AI（差值）
      const curAis = new Set((await getPlayers(roomCode)).filter(p => p.isNPC && p.isAI).map(p => p.characterName));
      for (const c of wanted) {
        if (curAis.has(c.name)) continue;
        const aiId = "ai_" + roomCode + "_" + (c.name || "x").replace(/\s+/g, "");
        await addPlayer(roomCode, aiId, "AI 玩家", false);
        await updatePlayer(roomCode, aiId, {
          characterName: c.name,
          characterScript: JSON.stringify(c),
          isNPC: true,
          isAI: true,
          connected: true,
        });
        console.log(`[ai-player] ${c.name} 由 AI 扮演 (${aiId})`);
      }
    })().finally(() => { delete syncLocks[roomCode]; });
  }
  return syncLocks[roomCode].then(() => getPlayers(roomCode));
}

/** 房间的 AI 定时器组 */
const timers = {};

// 每轮每 AI 搜证上限（防止异常数据死循环；正常剧本单轮线索通常少于 8 条）
const SEARCH_MAX_PER_ROUND = 8;
const searchCounts = {}; // `${roomCode}:${round}` → { aiId → count }

function scheduleDelay(roomCode, fn, delayMs) {
  const t = setTimeout(async () => {
    try { await fn(); } catch (e) { console.warn("[ai-player] 行动失败:", e.message); }
  }, delayMs);
  if (t.unref) t.unref();
  if (!timers[roomCode]) timers[roomCode] = [];
  timers[roomCode].push(t);
}

/** 清除某房间所有 AI 定时器 */
function cancelRoom(roomCode) {
  const list = timers[roomCode];
  if (list) { for (const t of list) clearTimeout(t); delete timers[roomCode]; }
  // 清理该房间的搜证计数
  for (const k of Object.keys(searchCounts)) {
    if (k.startsWith(roomCode + ":")) delete searchCounts[k];
  }
}

/**
 * 进入新阶段时为房间内所有 AI 玩家排定行动
 * 由 game.js 在 phase 切换（start_game / ready 推进 / 超时推进）后调用
 */
function scheduleRoom(io, roomCode, phase) {
  cancelRoom(roomCode);
  if (!phase || phase === "reading" || phase === "lobby") return;
  getPlayers(roomCode).then(async (players) => {
    const ais = players.filter(p => p.isAI && p.characterName);
    if (!ais.length) return;
    const room = await getRoom(roomCode);
    if (!room || room.phase !== phase) return; // 阶段已变，作废
    const parsed = JSON.parse(room.parsedScript || "{}");
    const allChars = parsed.characters || [];
    const round = getPhaseRound(phase);

    for (const ai of ais) {
      // 开场介绍：AI 自动作自我介绍
      // 错峰延迟保持"不像机器人同时开口"的效果，但原来 5-15s / 10-30s / 30-120s 太长：
      // 单次 LLM 本身要 5-9 秒（实测 6 路并发 9.1 秒全部返回，服务端不排队），
      // 再叠加三四十秒的排队延迟，玩家感知就是"AI 半天不说话"。
      // 现在把窗口收窄，总时长从最坏约 40 秒降到约 15 秒。
      if (phase === "intro") {
        scheduleDelay(roomCode, () => actIntro(io, roomCode, ai), 2000 + Math.random() * 5000);   // 2-7s
      }
      // 合并轮（round1/round2 = 搜证+讨论）：AI 搜证 + 发言
      if (round > 0) {
        scheduleDelay(roomCode, () => actInvestigate(io, roomCode, ai), 1200 + Math.random() * 4000);  // 1.2-5.2s
        scheduleDelay(roomCode, () => actSpeak(io, roomCode, ai, allChars), 3000 + Math.random() * 8000); // 3-11s
      }
      // 投票轮：延迟随机后投票
      if (phase === "voting") {
        scheduleDelay(roomCode, () => actVote(io, roomCode, ai, allChars), 8000 + Math.random() * 20000); // 8-28s
      }
    }
  }).catch(() => {});
}

async function actIntro(io, roomCode, ai) {
  const room = await getRoom(roomCode);
  if (!room || room.phase !== "intro") return;
  let aiScript = null;
  try { aiScript = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }
  // 优先 LLM 生成清晰自我介绍，失败回退规则模板
  let text = null;
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    text = await llm.introLLM(k);
  } catch (e) { console.warn("[ai-player] intro LLM 失败:", e.message); }
  if (!text) text = buildAiIntro(aiScript);

  const who = ai.characterName || "AI";
  await addIntroduction(roomCode, who, text);
  // 与真人玩家同一条路径：只发聊天消息（会被持久化），不再额外 emit intro_statement，
  // 否则前端两条都渲染，自我介绍会显示两遍。
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + who, who, `📣【自我介绍】${text}`, room.phase);
  io.to(roomCode).emit("chat_message", msg);
  console.log(`[ai-player] ${who} 开场介绍完成`);
}

async function actInvestigate(io, roomCode, ai) {
  const room = await getRoom(roomCode);
  if (!room) return;
  const round = getPhaseRound(room.phase);
  if (!round) return;

  // 防御计数：本轮搜证次数上限
  const ck = roomCode + ":" + round;
  if (!searchCounts[ck]) searchCounts[ck] = {};
  const cnt = (searchCounts[ck][ai.playerId] || 0) + 1;
  searchCounts[ck][ai.playerId] = cnt;
  if (cnt > SEARCH_MAX_PER_ROUND) { delete searchCounts[ck][ai.playerId]; return; }

  const allClues = await getClues(roomCode);
  if (!allClues || !allClues.length) return;
  const available = getAvailableCluesForPlayer(allClues, ai.playerId, round);
  if (!available.length) return;

  const searchResult = searchClues("", available); // 随机发放
  const clue = searchResult && searchResult.clue ? searchResult.clue : pickRandomClue(available);
  if (!clue) return;
  await assignClue(roomCode, clue.id, ai.playerId);
  // AI 搜到线索：仅广播线索事件（进入玩家线索列表），不刷聊天框
  io.to(roomCode).emit("clue_received", { clue, foundBy: ai.characterName || "AI" });

  // 续搜：本轮还有未被发现的线索 → 稍后继续，直到没有线索为止
  try {
    const latest = await getClues(roomCode);
    const remaining = getAvailableCluesForPlayer(latest, ai.playerId, round);
    if (remaining.length > 0) {
      scheduleDelay(roomCode, () => actInvestigate(io, roomCode, ai), 4000 + Math.random() * 8000);
    } else {
      console.log(`[ai-player] ${ai.characterName} 已搜完本轮全部线索(${round})`);
    }
  } catch (e) { /* 忽略 */ }
}

async function actSpeak(io, roomCode, ai, allChars) {
  const room = await getRoom(roomCode);
  if (!room || !getPhaseRound(room.phase)) return;
  let text = null;
  // 优先 LLM：基于自己的角色/线索 + 公开对话发言
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    const context = await llm.getPublicContext(roomCode, 8);
    text = await llm.speakLLM(k, context);
  } catch (e) { console.warn("[ai-player] speak LLM 失败:", e.message); }
  if (!text) {
    const allClues = await getClues(roomCode);
    const myClues = (allClues || []).filter(c => (c.foundBy || []).includes(ai.playerId));
    text = "🤖 " + buildAiSpeech(myClues, allChars);
  }
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", text, room.phase);
  io.to(roomCode).emit("chat_message", msg);
}

async function actVote(io, roomCode, ai, allChars) {
  const room = await getRoom(roomCode);
  if (!room || room.phase !== "voting") return;
  // 已投过则跳过
  const votes = await getVotes(roomCode);
  if (votes && votes[ai.playerId]) return;

  let aiScript = null;
  try { aiScript = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }
  const players = await getPlayers(roomCode);
  let excludeNpcs = false;
  try {
    const roomParsed = JSON.parse(room.parsedScript || "{}");
    excludeNpcs = (roomParsed.setting?.gameMode || "").toUpperCase() === "PVP";
  } catch (e) { /* ignore */ }
  const candidates = voteCandidates(players, allChars, ai.characterName, excludeNpcs);
  if (!candidates.length) return;

  const publicClues = (await getClues(roomCode) || []).filter(c => c.foundBy && c.foundBy.length);
  // 优先 LLM 推理投票（只读自己的知识），失败回退规则加权
  let target = null;
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    target = await llm.voteLLM(k, candidates);
  } catch (e) { console.warn("[ai-player] vote LLM 失败:", e.message); }
  if (!target) target = chooseVoteTarget(aiScript, publicClues, candidates);
  if (!target) return;

  await recordVote(roomCode, ai.playerId, target);
  // 与人类投票一致：广播给房间（用最新票数，避免并发快照重复）
  const afterVotes = await getVotes(roomCode);
  const humans = players.filter(p => !p.isNPC);
  io.to(roomCode).emit("vote_update", { count: Object.keys(afterVotes).length, total: humans.length + players.filter(p => p.isAI).length, aiVoted: true });
  io.to(roomCode).emit("chat_message", await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI",
    `🤖 我投票给 ${target}`, room.phase));
  console.log(`[ai-player] ${ai.characterName} 投票给 ${target}`);
}

/**
 * 真相揭晓前为所有未投票的 AI 补投（兜底：玩家可能提前推进 voting 阶段，
 * 仅靠 30-120s 定时器不够）。
 * @returns {Promise<number>} 补投数量
 */
async function voteForAllPending(io, roomCode) {
  const room = await getRoom(roomCode);
  if (!room) return 0;
  const players = await getPlayers(roomCode);
  const ais = players.filter(p => p.isAI && p.characterName);
  const votes = await getVotes(roomCode);
  let count = 0;
  for (const ai of ais) {
    if (votes && votes[ai.playerId]) continue;
    try {
      const parsed = JSON.parse(room.parsedScript || "{}");
      await actVote(io, roomCode, ai, parsed.characters || []);
      count++;
    } catch (e) { console.warn("[ai-player] 补投失败:", ai.characterName, e.message); }
  }
  return count;
}

module.exports = {
  computeAiFillers, chooseVoteTarget, voteCandidates, buildAiSpeech, buildAiIntro,
  syncAiFillers, scheduleRoom, cancelRoom, voteForAllPending,
};