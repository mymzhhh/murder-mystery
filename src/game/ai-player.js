// AI 玩家行为执行器 — 真人选完角色后，剩余玩家槽位角色自动由 AI 扮演
// 纯规则引擎（不调用 LLM）：
//   - 选角补位：computeAiFillers 计算剩余角色，syncAiFillers 差量创建/释放 AI 玩家
//   - 搜证：按地点搜（search-locations）+ assignClue，与人类共用同一份配额
//   - 讨论：基于自己已发现线索的模板发言
//   - 投票：线索指向加权 + 随机噪声（AI 若为凶手则绝不投自己）
// 公平性红线：所有 AI 决策只读【公开信息】（已发现线索 / 角色名单），不读凶手答案。

const { getRoom, getPlayers, addPlayer, updatePlayer, removePlayer, getClues, assignClue, recordVote, getVotes, addChatMessage, addIntroduction, claimClue, consumeSearchQuota, getSearchQuota, hasSearchBudget } = require("./game-manager");
const { buildSearchLocations, cluesAtLocation, pickClueAtLocation } = require("./search-locations");
const { getPhaseRound, PHASE_DEADLINE_MS } = require("./game-engine");
const llm = require("./ai-player-llm");
const { recordTurn, recordError, bumpRoundAction, readRoundActions } = require("./ai-observability");

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

// AI 在 reading 阶段预先写好的自我介绍，键 `${roomCode}:${ai.playerId}`。
// 为什么要预备：reading 阶段玩家在读本，AI 调 LLM 不占用任何人的等待时间；
// 等 round1 开始再现场生成，就会和其他搜证/发言请求挤在一起，玩家感知是"AI 卡着不说话"。
const preparedIntros = {};

// 搜证次数上限已统一到 game-manager（Redis，人类与 AI 共用同一份配额）。
// 这里原来有一份**内存**计数器，重启即丢、且与人类路径不对称
// （人类当时根本没有上限），已移除。

/** 最近一次 scheduleRoom 拿到的 io。
 *  为什么记下来：搜证/被点名回话这些走 scheduleDelay 的路径拿不到 io，
 *  一旦它们失败，异常就只能进容器日志 —— 而"AI 为什么不出手"恰恰是管理员判断
 *  "剧本有问题"还是"LLM 抖了"的关键。 */
let currentIo = null;

/**
 * 报告一次 AI 异常：写进 Redis（测试报告要统计）+ 实时发给房间（旁观页要看）。
 * 事件名用 ai_error：玩家端不订阅它，所以真人局里不会有人看到（不会破坏沉浸感）。
 */
function reportAiError(roomCode, { name, kind, message }) {
  try { recordError(roomCode, { name, kind, message }); } catch (e) { /* 观测失败不影响对局 */ }
  try {
    if (currentIo) currentIo.to(roomCode).emit("ai_error", {
      at: Date.now(), name: name || "?", kind: kind || "?", message: String(message || "").slice(0, 200),
    });
  } catch (e) { /* 忽略 */ }
}

function scheduleDelay(roomCode, fn, delayMs) {
  const t = setTimeout(async () => {
    try { await fn(); } catch (e) {
      console.warn("[ai-player] 行动失败:", e.message);
      reportAiError(roomCode, { name: "?", kind: "延迟行动（搜证/回话）", message: e.message });
    }
  }, delayMs);
  if (t.unref) t.unref();
  if (!timers[roomCode]) timers[roomCode] = [];
  timers[roomCode].push(t);
}

// 同类 AI 动作的时间片预约表：`${roomCode}` → { [kind]: 下一个可用时刻 }
//
// 为什么需要它：AI 的行动原本是各自算一个随机延迟，于是同一批 AI 的延迟窗口高度重叠。
// 4 个 AI 的"回答提问"几乎同时入队，而 LLM 闸门按"排队 + 执行"总算 25 秒超时 ——
// 队列一旦积压，排在后面的回答就被直接摘掉、返回 null，表现为"有的 AI 点名了却不回答"。
// 预约表保证同类动作之间至少隔开 gapMs，从源头避免积压。
const actionSlots = {};

// 回合链代次：`${roomCode}` → number。阶段切换 / 房间删除时 +1，
// 正在跑的回合链据此放弃剩余回合（见 cancelRoom 与 runTurnChain）。
const turnGenerations = {};

/**
 * 预约一个时间片，返回应延迟的毫秒数。纯函数（就地推进 state），便于测试。
 * 保证：同类动作彼此至少间隔 gapMs，且不早于 now + baseMs。
 */
function reserveSlot(state, kind, now, baseMs, gapMs) {
  const at = Math.max(now + baseMs, state[kind] || 0);
  state[kind] = at + gapMs;
  return at - now;
}

/** 取该房间的动作时间片表（顺带清理） */
function slotsOf(roomCode) {
  if (!actionSlots[roomCode]) actionSlots[roomCode] = {};
  return actionSlots[roomCode];
}

// ==================== AI 发言/提问的顺序：座位序 + 严格轮流 ====================
//
// 背景（用户反馈）：多位 AI 会"同时"发言/提问——公屏上几条 AI 消息挤在一起、
// 或者几个 AI 一起向同一目标发问。原因有两层：
//   ① `scheduleRoom` 给每个 AI 各自算一个**随机延迟**（发言 3–11s），窗口高度重叠；
//   ② **只把"预约时刻"错开是不够的**：LLM 闸门 `MAX_CONCURRENCY=6` 是并发的，
//      生成快的 AI 会后发先至——消息落地的顺序并不由预约时刻决定，所谓"排序"就成了摆设。
// 所以这里改成"**座位序 + 严格轮流**"：上一位 AI 说完，下一位才开口。
//
// 座位序 = 剧本 `parsed.characters` 的数组下标（就是"玩家角色 1/2/3…"的编号），
// 天然、稳定，且玩家读本时看到的顺序就是它。
// ⚠️ **不能拿 `getPlayers()` 的返回顺序当顺序**：它底层是 Redis SCAN，顺序不保证稳定
// （同一房间两次调用都可能不同）——排序依据必须来自剧本，而不是扫描顺序。

/** 回合之间的呼吸间隔：开场白/投票这些"每人一次"的回合用它错开 */
const TURN_GAP_MS = 2500;

/**
 * 一个 AI **两次出手之间的周期**：每位 AI 每 5 分钟有一次"发言或提问"的机会。
 *
 * 为什么要有这个节奏（用户要求"让 AI 更接近真人"）：原来一个阶段开头两分钟里，
 * 5 个 AI 会连着把"自我介绍 + 发言 + 提问"全说完，然后整段沉默——
 * 真人不是这样的，真人是隔一阵说一句、彼此插得上话。
 * 现在把机会按周期摊开：每人每 cycle 一次，全场按座位序轮流，
 * 于是 5 个 AI 的节奏是每 cycle/5 一条（默认 5 分钟 → 每 60 秒一条）。
 */
const TURN_CYCLE_MS = Math.max(30 * 1000, (Number(process.env.AI_TURN_CYCLE_MIN || 5) || 5) * 60 * 1000);

/** 每位 AI 每轮最多出手几次（兜底上限；用户指定 5） */
const MAX_TURNS_PER_ROUND = Math.max(1, Number(process.env.AI_MAX_TURNS_PER_ROUND || 5) || 5);

/**
 * 搜证 : 发言 的配比 —— 每 1 次发言/提问允许 N 次搜证。
 *
 * 为什么需要它（实测报告 15 / 房间 5PFT2F）：四个 AI 的 `search` 是 6/10/8/10，
 * `speak` **全是 0** —— "搜证与讨论"阶段里讨论一次都没发生。
 * 成因是两条机制叠加：actTurn「先搜证，搜到就 return」+ actInvestigate 的自我续搜，
 * 于是一个 AI 能把整轮的全部回合都烧在搜证上。
 *
 * 为什么**不能**靠"限制搜证次数"来解决（配额代码里已经踩过）：曾经设过 3 次/轮，
 * 实测 42 条线索只翻出 6 条，推理没有证据、整局走不通。所以这里只改**配比**，
 * 不动总容量：搜证仍是主要动作，但每搜 N 次就必须先说话。
 *
 * 默认 2：5 个回合变成 3 搜证 + 2 发言（实测原来 5 个回合全是搜证）。
 */
const SEARCH_PER_TALK = Math.max(1, parseInt(process.env.AI_SEARCH_PER_TALK, 10) || 2);

/**
 * 这一手该去搜证吗？（纯判据，便于单测）
 *
 * 规则：`已搜证次数 <= 已发言次数 * N` 才允许搜证。
 * 取 N=2 时序列是 搜 说 搜 搜 说 搜 搜 说…（每 2 次搜证夹 1 次发言）。
 * 起始 0 <= 0 成立 → 先搜证（搜证仍是主要动作，符合"先搜证再讨论"）。
 */
function searchWanted(mix, perTalk) {
  const n = Math.max(1, Number(perTalk) || 2);
  const search = (mix && mix.search) || 0;
  const talk = (mix && mix.talk) || 0;
  return search <= talk * n;
}

/**
 * 管理端"测试剧本"（全 AI 对局）用的**压缩节奏**。
 *
 * 为什么单独一套：真人局的节奏是"每人每 5 分钟一次机会 + 阶段兜底 10 分钟"，
 * 跑完一局（reading→round1→round2→voting→真相）要 40 分钟以上 —— 拿来测剧本太慢。
 * 测试房用这套压缩值（见 `socket/test-run.js`），一局几分钟就能走完，
 * 而**阶段机、回合链、AI 出手逻辑全都是同一套**（只换节奏参数），所以测出来的问题是真的。
 */
const TEST_TURN_CYCLE_MS = Math.max(5 * 1000, (Number(process.env.TEST_RUN_CYCLE_SEC || 45) || 45) * 1000);
const TEST_PHASE_MS = Math.max(30 * 1000, (Number(process.env.TEST_RUN_PHASE_MIN || 4) || 4) * 60 * 1000);

/**
 * 按座位序排列 AI 玩家（纯函数：任何输入都给确定顺序，且不改动入参）
 * 不在剧本里的角色（异常数据）排到末尾，按角色名兜底比较，保证顺序可复现。
 * @param {Array} ais AI 玩家
 * @param {Array} allChars 剧本角色列表（parsed.characters）
 * @returns {Array} 新数组
 */
function orderAiPlayers(ais, allChars) {
  const rank = new Map();
  (allChars || []).forEach((c, i) => { if (c && c.name) rank.set(String(c.name), i); });
  const rankOf = (p) => {
    const n = String((p && p.characterName) || "");
    return rank.has(n) ? rank.get(n) : Number.MAX_SAFE_INTEGER;
  };
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...(ais || [])].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    const na = String((a && a.characterName) || ""), nb = String((b && b.characterName) || "");
    if (na !== nb) return cmpStr(na, nb);          // 不在剧本里的：按角色名兜底
    return cmpStr(String((a && a.playerId) || ""), String((b && b.playerId) || ""));
  });
}

/**
 * 一轮里 AI 回合的序列（纯函数）。
 *
 * 结构 = **开场白**（只有第一轮，每人一次；文案在阅读阶段已备好，几乎不耗时）
 *      + **"发言或提问"轮转**（按座位序，每人每 cycleMs 一次机会，每轮最多 maxPerRound 次）。
 *
 * 每次出手**只做一件事**（发言或提问，由 AI 自己选，见 `llm.turnLLM`），
 * 所以"同时发言/同时提问"从结构上就不可能发生。
 *
 * 轮转次数由**阶段时长**推出来：`floor(阶段时长 / cycle)`，再被 maxPerRound 截断
 * ——默认 10 分钟阶段 + 5 分钟周期 + 上限 5 → 每人 2 次机会（上限是兜底，平时不生效）。
 * 每人两次机会之间天然隔着 cycleMs，而**相邻两次出手**只隔 `cycleMs / 人数`
 * （5 个 AI、5 分钟 → 每 60 秒一条），这样整个阶段都有动静，而不是开头挤一堆、后面全静默。
 *
 * @param {Array} orderedAis orderAiPlayers 的结果
 * @param {string} phase 当前阶段
 * @param {object} [opts] {cycleMs, maxPerRound, phaseMs}——供测试注入
 */
function buildTurnPlan(orderedAis, phase, opts) {
  const o = opts || {};
  const list = Array.isArray(orderedAis) ? orderedAis : [];
  const plan = [];
  if (phase === "voting") {
    // 投票是"每人恰好一次"，不参与节奏轮转
    for (const ai of list) plan.push({ ai, kind: "vote", delayMs: TURN_GAP_MS });
    return plan;
  }
  const round = getPhaseRound(phase);
  if (!round) return plan;   // reading / lobby / truth_reveal 等：不排回合
  // 自我介绍只在第一轮发一遍
  if (round === 1) {
    for (const ai of list) plan.push({ ai, kind: "intro", delayMs: TURN_GAP_MS });
  }
  if (!list.length) return plan;
  const cycleMs = o.cycleMs > 0 ? o.cycleMs : TURN_CYCLE_MS;
  const maxPerRound = o.maxPerRound > 0 ? o.maxPerRound : MAX_TURNS_PER_ROUND;
  const phaseMs = o.phaseMs > 0 ? o.phaseMs : PHASE_DEADLINE_MS;
  const intervalMs = Math.max(1000, Math.round(cycleMs / list.length));
  const cycles = Math.max(1, Math.min(maxPerRound, Math.floor(phaseMs / cycleMs)));
  for (let c = 0; c < cycles; c++) {
    for (const ai of list) plan.push({ ai, kind: "turn", delayMs: intervalMs });
  }
  return plan;
}

/**
 * 顺序执行回合链（**严格轮流**：上一个 run 完成之后才轮到下一个）。
 *
 * 每个回合开始前复核阶段；阶段一变（玩家推进 / 超时推进 / 房间被删）就放弃剩余回合——
 * 否则旧阶段的 AI 会跑到新阶段里继续说话。
 * `deps` 全部可注入，便于单测：{isPhaseCurrent, sleep, gapMs, initialDelayMs, onError}
 * @returns {Promise<number>} 实际执行的回合数
 */
async function runTurnChain(turns, deps) {
  const d = deps || {};
  const sleep = d.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gap = d.gapMs == null ? TURN_GAP_MS : d.gapMs;
  const list = Array.isArray(turns) ? turns : [];
  let done = 0;
  if (d.initialDelayMs > 0) await sleep(d.initialDelayMs);
  for (let i = 0; i < list.length; i++) {
    // 节奏：每个回合自己带 delayMs（"这次出手距离上一次出手多久"），
    // 没带就用默认呼吸间隔。这是"每人每 5 分钟一次机会"落地的地方——
    // 间隔由 buildTurnPlan 算好写在回合上，而不是让每个 AI 自己随机。
    if (i > 0) {
      const want = list[i].delayMs != null ? list[i].delayMs : gap;
      if (want > 0) await sleep(want);
    }
    if (typeof d.isPhaseCurrent === "function" && !(await d.isPhaseCurrent())) return done;
    try {
      await list[i].run();
      done++;
    } catch (e) {
      // 单个回合失败不能拖垮整条链（否则后面的 AI 整轮都不说话）
      if (typeof d.onError === "function") d.onError(e, list[i]);
    }
  }
  return done;
}

/** 阶段是否已经变了（动作耗时期间阶段可能被推进）。
 *
 * 为什么每个动作发公屏前都要复核一次：`runTurnChain` 只在**回合开始前**复核阶段，
 * 而一个回合可能要跑几十秒（LLM 生成）。若期间阶段被推进，这个"已飞在路上"的回合
 * 会把消息发到**新阶段的公屏**上——实测（2026-10-14 端到端）：
 * 投票阶段的第一票 +195.7s，紧接着 +195.8s 冒出一句上一轮的讨论（只隔 83ms），
 * 而且这条发言会被记在旧阶段的 phase 字段里。旧阶段的发言不该发到新阶段，直接丢弃。
 */
async function phaseChanged(roomCode, phase0) {
  const cur = await getRoom(roomCode);
  return !cur || cur.phase !== phase0;
}

/** 按回合类型分发到具体动作 */
function runAiTurn(io, roomCode, turn, allChars) {
  const ai = turn && turn.ai;
  switch (turn && turn.kind) {
    case "intro": return publishIntro(io, roomCode, ai);
    case "turn": return actTurn(io, roomCode, ai, allChars);
    case "vote": return actVote(io, roomCode, ai, allChars);
    default: return Promise.resolve();
  }
}

/**
 * 造一个"等稍后那个动作做完"的等待器（回合链用）。
 *
 * 用途：AI 提问后，被问的若也是 AI，回答是**稍后**才执行的（要错峰）。
 * 让提问这个回合一直等到回答结束，公屏上就是"问 → 答 → 下一个问"，
 * 而不是几条回答与提问挤在一起（实测：严格轮流后仍有 2 处 <1.2s 的碰撞，
 * 全部来自"回答车道"与回合链平行）。
 *
 * ⚠️ 必须有超时兜底：被等的动作可能因为**房间被删/阶段切换**而永远不会执行
 * （定时器被 clearTimeout），没有兜底就会让回合链永久悬住。
 * @returns {{promise:Promise<void>, finish:Function}}
 */
function makeTurnWaiter(timeoutMs, setT, clearT) {
  const setTimer = setT || setTimeout;
  const clearTimer = clearT || clearTimeout;
  let settled = false;
  let timer = null;
  let finish = () => {};
  const promise = new Promise((resolve) => {
    const done = () => { if (settled) return; settled = true; if (timer) clearTimer(timer); resolve(); };
    finish = done;
    timer = setTimer(done, timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return { promise, finish: () => finish() };
}

/** 清掉该房间的 AI 定时器 / 时间片 / 回合链代次（**不动已预备的自我介绍**） */
function resetRoomTimers(roomCode) {
  const list = timers[roomCode];
  if (list) { for (const t of list) clearTimeout(t); delete timers[roomCode]; }
  delete actionSlots[roomCode];
  // 回合链不在 timers 里（它是 async 串行的），用"代次"作废：
  // 代次一变，正在跑的那条链在下一个回合前就会发现并放弃剩余回合。
  turnGenerations[roomCode] = (turnGenerations[roomCode] || 0) + 1;
}

/**
 * 房间的 AI 活动整体结束（真人走光 / 房间被删）时调用。
 * ⚠️ **阶段切换不能调它**：reading 阶段备好的自我介绍必须活到 round1 才用得上。
 * 原来 `scheduleRoom` 每次阶段切换都调 cancelRoom，把预备内容一起抹掉了；
 * 再叠加上面那句"reading 直接 return"，这条"阅读阶段预备自我介绍"的优化**一直是死的**
 * ——每个 AI 的自我介绍都变成 round1 现场生成，正是它想避免的拥塞点。
 */
function cancelRoom(roomCode) {
  resetRoomTimers(roomCode);
  for (const k of Object.keys(preparedIntros)) {
    if (k.startsWith(roomCode + ":")) delete preparedIntros[k];
  }
}

// 房间被删除时（含生命周期扫描器回收、管理端删除）释放本模块的内存态。
try {
  require("./room-cleanup-hooks").onRoomDeleted((code) => cancelRoom(code));
} catch (e) { /* 钩子模块不可用时不影响主流程 */ }

/**
 * 进入新阶段时为房间内所有 AI 玩家排定行动
 * 由 game.js 在 phase 切换（start_game / ready 推进 / 超时推进）后调用
 */
function scheduleRoom(io, roomCode, phase) {
  currentIo = io;   // 供 scheduleDelay 路径上的异常上报使用（见 reportAiError）
  // 只重置定时器 / 时间片 / 回合链代次，**不清预备好的自我介绍**
  // （reading 备好的内容要活到 round1 才用得上，见 cancelRoom 的注释）
  resetRoomTimers(roomCode);
  if (!phase || phase === "lobby") return;
  getPlayers(roomCode).then(async (players) => {
    const ais = players.filter(p => p.isAI && p.characterName);
    if (!ais.length) return;
    const room = await getRoom(roomCode);
    if (!room || room.phase !== phase) return; // 阶段已变，作废
    const parsed = JSON.parse(room.parsedScript || "{}");
    const allChars = parsed.characters || [];
    const round = getPhaseRound(phase);
    // 座位序（剧本角色顺序）：后面所有 AI 动作都按它排，保证顺序稳定且可预期
    const ordered = orderAiPlayers(ais, allChars);

    // 阅读阶段：AI 在玩家读本的时间里边读边写好自我介绍，**不发出来**。
    // 延迟给得宽松（玩家读本通常要几分钟），目的是把 LLM 调用挪出 round1 的拥塞点。
    if (phase === "reading") {
      for (const ai of ordered) {
        scheduleDelay(roomCode, () => prepareIntro(io, roomCode, ai), 3000 + Math.random() * 8000); // 3-11s
      }
      return;
    }

    // 搜证不参与"发言顺序"（它不是公屏发言），仍各自随机并行；
    // 但必须赶在发言之前完成，AI 才有东西可说：最迟 5.2s，
    // 而第一个发言回合排在全部开场白之后（≥ 2.5s × AI 人数），天然满足。
    if (round > 0) {
      for (const ai of ordered) {
        scheduleDelay(roomCode, () => actInvestigate(io, roomCode, ai), 1200 + Math.random() * 4000); // 1.2-5.2s
      }
    }

    // 公屏动作（自我介绍 / 出手 / 投票）走**同一条回合链**：严格轮流，
    // 上一位说完下一位才开口。为什么不再用"各自随机延迟 + 时间片预约"：
    // 见 buildTurnPlan / runTurnChain 上方的注释（LLM 闸门是并发的，错开时刻并不定序）。
    // 测试房（管理端"测试剧本"，全 AI 对局）用压缩节奏，否则跑完一局要 40 分钟以上
    const planOpts = room.testRun ? { cycleMs: TEST_TURN_CYCLE_MS, phaseMs: TEST_PHASE_MS } : undefined;
    const plan = buildTurnPlan(ordered, phase, planOpts);
    if (!plan.length) return;
    const gen = turnGenerations[roomCode] || 0;
    const isPhaseCurrent = async () => {
      if ((turnGenerations[roomCode] || 0) !== gen) return false;   // 已被新阶段/房间结束取消
      const cur = await getRoom(roomCode);
      return !!cur && cur.phase === phase;
    };
    // ⚠️ 必须把 delayMs 一起带过去（`...t`）：节奏就写在回合自己身上，
    // 只取 {ai, kind} 会让"每人每 5 分钟一次机会"退回成"挤在一起连说"。
    const runs = plan.map((t) => ({ ...t, run: () => runAiTurn(io, roomCode, t, allChars) }));
    runTurnChain(runs, {
      isPhaseCurrent,
      initialDelayMs: 800,   // 让阶段切换的界面先落地，再开口
      onError: (e, t) => {
        const nm = (t.ai && t.ai.characterName) || "?";
        console.warn(`[ai-player] 回合失败（${t.kind}/${nm}）:`, e.message);
        reportAiError(roomCode, { name: nm, kind: t.kind, message: e.message });
      },
    }).then((n) => {
      console.log(`[ai-player] ${roomCode} ${phase}：回合链执行 ${n}/${runs.length} 个回合（座位序 ${ordered.map(a => a.characterName).join(" → ")}，出手间隔约 ${Math.round((plan.find((t) => t.kind === "turn") || {}).delayMs / 1000) || "-"}s）`);
    }).catch(() => {});
  }).catch(() => {});
}

/** 生成自我介绍并缓存，不发送。仅在 reading 阶段有效。 */
async function prepareIntro(io, roomCode, ai) {
  const room = await getRoom(roomCode);
  // 阶段已变（比如 DM 提前推进）就不必再写了
  if (!room || room.phase !== "reading") return;
  const key = `${roomCode}:${ai.playerId}`;
  if (preparedIntros[key]) return; // 已经写好，别重复花额度

  let text = null;
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    text = await llm.introLLM(k);
  } catch (e) { console.warn("[ai-player] 自我介绍预备失败:", e.message); }

  let aiScript = null;
  try { aiScript = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }
  if (!text) text = buildAiIntro(aiScript);

  // 房间可能在这几秒里被删掉了，避免把内容留在内存里
  const still = await getRoom(roomCode);
  if (!still) return;
  preparedIntros[key] = text;
  console.log(`[ai-player] ${ai.characterName} 已在阅读阶段备好自我介绍`);
}

/**
 * 把预备好的自我介绍发到公屏。
 * 如果 reading 阶段没来得及预备（晚加入、LLM 当时挂了），这里现场补生成一次 ——
 * 宁可慢一点，也不能让 AI 整局不开口。
 */
async function publishIntro(io, roomCode, ai) {
  const room = await getRoom(roomCode);
  if (!room || !getPhaseRound(room.phase)) return; // 只在搜证/讨论轮发
  const phase0 = room.phase;
  const key = `${roomCode}:${ai.playerId}`;
  let text = preparedIntros[key];
  if (!text) {
    try {
      const parsed = JSON.parse(room.parsedScript || "{}");
      const k = await llm.buildKnowledge(roomCode, ai, parsed);
      text = await llm.introLLM(k);
    } catch (e) { console.warn("[ai-player] 自我介绍补生成失败:", e.message); }
  }
  let aiScript = null;
  try { aiScript = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }
  if (!text) text = buildAiIntro(aiScript);
  delete preparedIntros[key]; // 只发一次

  if (await phaseChanged(roomCode, phase0)) return;   // 生成期间阶段已推进 → 旧阶段的自我介绍不发
  const who = ai.characterName || "AI";
  await addIntroduction(roomCode, who, text);
  // 与真人玩家同一条路径：只发聊天消息（会被持久化），不再额外 emit intro_statement，
  // 否则前端两条都渲染，自我介绍会显示两遍。
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + who, who, `📣【自我介绍】${text}`, room.phase);
  io.to(roomCode).emit("chat_message", msg);
  recordTurn(roomCode, who, "intro");
  console.log(`[ai-player] ${who} 自我介绍已发布`);
}

async function actInvestigate(io, roomCode, ai) {
  let acted = false;   // 本次是否真的搜到并认领了一条线索（供 actTurn 判断"先搜证"）
  const room = await getRoom(roomCode);
  if (!room) return;
  const round = getPhaseRound(room.phase);
  if (!round) return;

  const allClues = await getClues(roomCode);
  if (!allClues || !allClues.length) return;

  const parsed = JSON.parse(room.parsedScript || "{}");
  const locations = buildSearchLocations(allClues, parsed.layoutDescription);
  if (!locations.length) return;

  // 按"该地点还剩多少线索"排序，在前三里随机挑一个。
  // 不纯随机：AI 的定位是能陪玩的对手，乱撞会显得很蠢、拖累整局体验；
  // 但也不总挑最优的那一个，否则它会像开了天眼一样每次都命中。
  const ranked = locations
    .map(loc => ({ loc, n: cluesAtLocation(allClues, loc, round).length }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!ranked.length) return; // 本轮已被搜空
  const chosen = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].loc;

  // 与人类玩家共用同一份配额（Redis）。按 playerName 计，跨重连稳定。
  const quotaId = ai.playerName || ai.playerId;
  const quota = await consumeSearchQuota(roomCode, round, quotaId);
  if (!quota.allowed) {
    console.log(`[ai-player] ${ai.characterName} 本轮搜证次数已用完(${round})`);
    return acted;
  }

  // ⚠ 必须和人类玩家走同一套原子抢占（claimClue）。
  //   原来这里是"读可用列表 → 直接 assignClue"，而人类路径已经用 SET NX 加固 ——
  //   AI 与真人同时搜证时，AI 会拿着读到的旧快照去写一条已经被抢走的线索，
  //   结果同一条线索出现两个发现者。抽成共用助手就是为了不再出现这种"只加固一半"。
  let clue = null;
  let pool = cluesAtLocation(allClues, chosen, round);
  for (let i = 0; i < 6 && pool.length; i++) {
    const cand = pickClueAtLocation(pool, chosen, round);
    if (!cand) break;
    if (await claimClue(roomCode, cand.id, ai.playerId)) { clue = cand; break; }
    pool = pool.filter(c => c.id !== cand.id); // 已被抢走，换下一条
  }
  if (!clue) {
    // 搜空是正常结果，不重试同一地点
    return acted;
  }
  await assignClue(roomCode, clue.id, ai.playerId);
  acted = true;
  recordTurn(roomCode, ai.characterName, "search");   // 搜证也要进赛场统计（报告此前没有这一列）          // 已搜到并认领 → 本次算"搜证成功"
  bumpRoundAction(roomCode, round, ai.characterName, "search");   // 本轮配比计数（决定下一手是搜证还是发言）
  // 一搜到就自动公开（与人类路径一致，见 socket/game.js 的 investigate）。
  // AI 不是真实 socket，所以直接把公开后的线索广播给全房 —— 线索本来就是公开信息。
  try {
    await require("./game-manager").revealClue(roomCode, clue.id, ai.playerId);
  } catch (e) { /* 公开失败不影响已入账的线索 */ }
  io.to(roomCode).emit("clue_received", { clue, foundBy: ai.characterName || "AI", revealed: true });

  // 续搜：本轮还有剩余次数、且场上仍有线索 → 稍后继续
  try {
    const latestQuota = await getSearchQuota(roomCode, round, quotaId);
    // ⚠️ 用 hasSearchBudget 而不是 `remaining <= 0`：不限次数时 remaining 恒为 0，
    // 直接比大小会让每个 AI 每轮只搜一次就停手（实测：50 条线索只翻出 6 条）。
    if (!hasSearchBudget(latestQuota)) return;
    const latest = await getClues(roomCode);
    const stillAvailable = buildSearchLocations(latest, parsed.layoutDescription)
      .some(loc => cluesAtLocation(latest, loc, round).length > 0);
    // ⚠️ 自我续搜也必须过**配比闸门**：否则"续搜"这条路径会绕开 actTurn 的限制，
    // 一个 AI 仍能把整轮烧在搜证上（这正是实测 speak=0 的第二个成因）。
    const mix = (await readRoundActions(roomCode, round))[ai.characterName] || null;
    if (stillAvailable && searchWanted(mix, SEARCH_PER_TALK)) {
      scheduleDelay(roomCode, () => actInvestigate(io, roomCode, ai), 4000 + Math.random() * 8000);
    } else if (!stillAvailable) {
      console.log(`[ai-player] ${ai.characterName} 已搜完本轮全部线索(${round})`);
    } else {
      console.log(`[ai-player] ${ai.characterName} 本轮搜证已达配比(${mix ? mix.search : "?"} 搜 / ${mix ? mix.talk : "?"} 说)，先让位给发言`);
    }
  } catch (e) { /* 忽略 */ }
  return acted;
}

/**
 * 一次"出手"：由 AI 自己决定这次是**发言**还是**提问**（二选一，见 `llm.turnLLM`）。
 *
 * 为什么合成一个动作：用户要的是"每 5 分钟有一次**发言或提问**的机会"——机会是一次，
 * 一次只做一件事。原来调度侧固定"先发言、再提问"，等于每人每轮必定说两条，
 * 既不像真人，提问也变成走过场。
 *
 * 提问若指向另一位 AI，则**等对方答完**再轮到下一位（公屏是"问 → 答 → 下一个"）。
 */
async function actTurn(io, roomCode, ai, allChars) {
  const room = await getRoom(roomCode);
  if (!room || !getPhaseRound(room.phase)) return;
  const phase0 = room.phase;
  const players = await getPlayers(roomCode);
  // 可问对象：除自己以外的玩家角色（NPC 不参与玩家间问答）
  // 用户指定的顺序：**先搜证，搜到无可搜再进入发言/讨论**。
  // actInvestigate 自带"无可搜地点 / 本轮次数用完"的早退，返回 true 表示它真的认领了一条线索。
  // ⚠️ 但不能"能搜就一直搜"：实测那样做会让四个 AI 的 speak 全是 0（讨论从未发生），
  // 所以再加一道**配比闸门** —— 搜满配比就先说话（见 searchWanted / SEARCH_PER_TALK）。
  // ⚠️ 测试房例外：那里搜证由**代码**扫完（game/auto-search），AI 的回合只用于发言/提问/投票，
  //    这样"线索能不能被搜到"和"AI 会不会讨论"不再互相挤压（用户指定）。
  try {
    const mix = (await readRoundActions(roomCode, getPhaseRound(room.phase)))[ai.characterName] || null;
    if (!room.testRun && searchWanted(mix, SEARCH_PER_TALK)) {
      const searched = await actInvestigate(io, roomCode, ai);
      if (searched) return;   // 这一手用去搜证了 → 本轮不发言（下一手再说话）
    }
  } catch (e) { console.warn("[ai-player] 先搜证失败（继续走发言）:", e.message); }
  const candidates = (allChars || [])
    .filter(c => c && c.roleType !== "npc" && c.name && c.name !== ai.characterName)
    .map(c => c.name);

  let decision = null;
  // 提问账本：让 AI 知道自己问过谁、问过什么，并在扎堆时强制换目标。
  // 2026-10-20 用户实测：一局里 8 次提问全砸在同一个人身上，且反复问同一段 5 分钟。
  let ledger = null;
  const roundNow = getPhaseRound(phase0) || getPhaseRound(room.phase) || 1;
  try {
    const ah = require("./ask-history");
    ledger = await ah.readAsks(roomCode, roundNow);
  } catch (e) { ledger = null; }
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    // ⚠️ 不再单独取"最近公屏"：buildKnowledge 的 transcript 已经是同一份数据，
    // 重复投喂每次要多付最多 2500 字（见 ai-player-llm 的 knowledgePrompt）。
    // ⚠️ 没有可问的人时**也要**调用：发言不需要候选人。
    // （写成"有候选人才调"会让 candidates 为空的房间彻底说不了话；
    //   而"提问"的合法性由 parseTurnOutput 自己校验——目标不在候选里就返回 null。）
    decision = await llm.turnLLM(k, candidates, undefined, ledger ? { ledger, askerName: ai.characterName } : undefined);

    // 轮转判定：先算"从这个 AI 自己视角看，各人有多可疑"——
    // 用户校准过：嫌疑大的可以连续追问，只有"没证据还盯着一个人问"才要拦。
    if (decision && decision.action === "ask" && ledger) {
      const ah = require("./ask-history");
      const mine = (ledger.byAsker || {})[ai.characterName] || {};
      const askedByMe = Object.fromEntries(Object.entries(mine).map(([t, qs]) => [t, (qs || []).length]));
      const prevQs = mine[decision.target] || [];
      const maxSim = prevQs.reduce((m, q) => Math.max(m, ah.questionSimilarity(q, decision.question)), 0);
      let suspicion = 0;
      try {
        const sus = ah.scoreSuspects({
          clueLines: k.myClues || [],
          transcript: k.transcript || "",
          candidates,
        });
        suspicion = Number((sus[decision.target] || {}).score || 0);
      } catch (e) { suspicion = 0; }
      const rotate = ah.shouldRotate({
        target: decision.target,
        askerName: ai.characterName,
        candidates,
        targetCounts: ledger.targetCounts || {},
        askedByMe,
        askedQuestionsOfTarget: { similarity: maxSim },
        lastTarget: (ledger.lastByAsker || {})[ai.characterName] || "",
        suspicion,
      });
      if (rotate) {
        const ranked = ah.rankTargets({ candidates, targetCounts: ledger.targetCounts || {}, askedByMe });
        const forced = ranked.find((n) => n !== decision.target) || ranked[0];
        if (forced) {
          const retry = await llm.turnLLM(k, candidates, undefined,
            { ledger, askerName: ai.characterName, forcedTarget: forced });
          // 重试拿到合法提问就用它；否则退回"发言"，绝不再问同一个人
          decision = retry && retry.action === "ask" && retry.target === forced ? retry : null;
        }
      }
    }
  } catch (e) { console.warn("[ai-player] 出手 LLM 失败:", e.message); }

  if (decision && decision.action === "ask") {
    recordTurn(roomCode, ai.characterName, "ask");
    bumpRoundAction(roomCode, getPhaseRound(phase0) || getPhaseRound(room.phase), ai.characterName, "talk");
    return askTurn(io, roomCode, ai, players, decision, phase0);
  }
  // 统计口径：能走到这里就是"发了一次言"（decision 为空时走的是模板兜底发言，
  // 那也是一次实际发生的发言）。LLM 失败本身另有 error 记录，两者互不掩盖。
  recordTurn(roomCode, ai.characterName, "speak");
  bumpRoundAction(roomCode, getPhaseRound(phase0) || getPhaseRound(room.phase), ai.characterName, "talk");
  return speakTurn(io, roomCode, ai, allChars, decision, phase0);
}

/** 提问：发问；被问的若也是 AI，就等它答完再轮到下一位 */
async function askTurn(io, roomCode, ai, players, decision, phase0) {
  const target = decision.target;
  const text = `❓ 我想问 ${target}：${decision.question}`;
  if (await phaseChanged(roomCode, phase0)) return;   // 生成期间阶段已推进 → 这个提问作废
  // 记账：谁问了谁、问了什么。下一手的 prompt 会带「你已经问过 X×2」，
  // 并对被扎堆的目标做轮转（2026-10-20 用户实测：一局里 AI 全在问同一个人）。
  try {
    const { recordAsk } = require("./ask-history");
    await recordAsk(roomCode, getPhaseRound(phase0) || 1, ai.characterName || "AI", target, decision.question);
  } catch (e) { /* 记账失败不影响对局 */ }
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", text, phase0);
  io.to(roomCode).emit("chat_message", msg);

  // 被问的如果也是 AI，稍后作答（真人则自行在聊天里回复）。
  const targetPlayer = players.find(p => p.characterName === target);
  if (targetPlayer && targetPlayer.isAI) {
    // 回答同样要错峰：多位 AI 被点名时若同时入队，排在后面的会被闸门的
    // "排队 + 执行共 25s" 超时摘掉，返回 null，表现为"AI 被点名却不回答"。
    const replyDelay = reserveSlot(slotsOf(roomCode), "reply", Date.now(), 2500 + Math.random() * 2500, 5000);
    // ⚠️ 这里**返回**一个"等回答结束"的 Promise，而不是 scheduleDelay 完就走：
    // 回合链会因此等在这里，公屏上是"问 → 答 → 下一个问"。
    // 实测（不这样做的版本）：严格轮流之后仍有 2 处相邻消息 <1.2s 的碰撞，
    // 全部来自"回答车道"与回合链平行——回答和别人的提问一起冒出来。
    const waiter = makeTurnWaiter(45000);
    scheduleDelay(roomCode, async () => {
      try {
        await actReplyToQuestion(io, roomCode, targetPlayer, ai.characterName || "AI", decision.question);
      } finally {
        waiter.finish();   // 无论成功失败都要放行，否则整条回合链卡死
      }
    }, replyDelay);
    return waiter.promise;
  }
}

/**
 * 发言：LLM 定了发言就用它的稿子；LLM 没给出（失败/未配置）则回退规则模板。
 * 注意回退是**发言**而不是提问——降级时"说一句基于公开线索的话"比"瞎问一个人"更安全
 * （瞎问会让被问的 AI 花一次 LLM 去答一个无意义的问题）。
 */
async function speakTurn(io, roomCode, ai, allChars, decision, phase0) {
  let text = decision && decision.action === "speak" ? decision.speech : null;
  if (!text) {
    const allClues = await getClues(roomCode);
    // 回退也要对齐玩家视角：用全场已公开的线索，而不是只有自己那几条
    const publicClues = (allClues || []).filter(c => (c.foundBy || []).length > 0);
    text = "🤖 " + buildAiSpeech(publicClues, allChars);
  }
  if (await phaseChanged(roomCode, phase0)) return;   // 生成期间阶段已推进 → 这条发言作废
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", text, phase0);
  io.to(roomCode).emit("chat_message", msg);
}

/**
 * 被点名提问后作答（AI 之间互问）
 * @param {number} attempt 已重试次数：拿不到内容时退一步重试，避免直接沉默
 */
async function actReplyToQuestion(io, roomCode, ai, askerName, question, attempt = 0) {
  const room = await getRoom(roomCode);
  if (!room || !getPhaseRound(room.phase)) return;
  const phase0 = room.phase;
  let text = null;
  try {
    const parsed = JSON.parse(room.parsedScript || "{}");
    const k = await llm.buildKnowledge(roomCode, ai, parsed);
    text = await llm.replyToQuestionLLM(k, askerName, question);
  } catch (e) { console.warn("[ai-player] replyToQuestion LLM 失败:", e.message); }
  if (!text) {
    // 拿不到内容多半不是"答不出来"，而是被 LLM 闸门超时摘掉了
    // （deadline 从入队就计时，排队 + 执行共用 25 秒）。
    // 原来这里直接 return 沉默，玩家看到的就是"有的 AI 被点名了却不回答"。
    // 退一步换个时间片重试一次；第二次仍失败才放弃，并留下日志便于定位。
    if (attempt < 1) {
      const retryDelay = reserveSlot(slotsOf(roomCode), "reply", Date.now(), 4000 + Math.random() * 3000, 5000);
      scheduleDelay(roomCode, () => actReplyToQuestion(io, roomCode, ai, askerName, question, attempt + 1), retryDelay);
    } else {
      console.warn(`[ai-player] ${ai.characterName} 两次都未能回答 ${askerName} 的提问，放弃`);
    }
    return;
  }
  if (await phaseChanged(roomCode, phase0)) return;   // 生成期间阶段已推进 → 这条回答作废
  const msg = await addChatMessage(roomCode, ai.playerId, "AI:" + (ai.characterName || ""), ai.characterName || "AI", text, phase0);
  io.to(roomCode).emit("chat_message", msg);
}

/**
 * 真人玩家在聊天里点名某位 AI 角色时，让该 AI 作答。
 * 由 socket/game.js 的 chat 处理器调用；只认"点名 + 像问题"的消息，避免 AI 对每句话都插嘴。
 * @returns {Promise<boolean>} 是否触发了作答
 */
async function maybeAnswerMention(io, roomCode, content, askerName) {
  try {
    const text = String(content || "");
    if (!text.includes("?") && !text.includes("？")) return false;
    const room = await getRoom(roomCode);
    // 只在这些阶段响应点名（intro 已废弃，保留判断是为了兼容部署瞬间的旧房间）
    if (!room || !["intro", "round1", "round2"].includes(room.phase)) return false;
    const players = await getPlayers(roomCode);
    const named = players.find(p => p.isAI && p.characterName && text.includes(p.characterName));
    if (!named || named.characterName === askerName) return false;
    // 作答也要走"reply 时间片"：真人连着点名好几位 AI 时，
    // 原来各自随机 1.5-4.5s 会几乎同时入队 → 公屏上几条回答一起冒出来，
    // 而且排在后面的会被 LLM 闸门的"排队+执行共 25s"超时摘掉（表现为"被点名却不回答"）。
    const replyDelay = reserveSlot(slotsOf(roomCode), "reply", Date.now(), 1500 + Math.random() * 2000, 5000);
    scheduleDelay(roomCode, () => actReplyToQuestion(io, roomCode, named, askerName, text.substring(0, 200)), replyDelay);
    return true;
  } catch (e) { return false; }
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

  // 生成期间阶段已推进（voting 结束）→ 这一票作废：truth_reveal 前有 voteForAllPending 兜底补投，
  // 而把迟到的票写进真相阶段会让结算多出一票。
  if (await phaseChanged(roomCode, "voting")) return;
  await recordVote(roomCode, ai.playerId, target);
  // 投满票 → 立即推进（用户实测：全员投完后房间会卡在投票阶段）
  setImmediate(() => { try { require("../game/vote-advance").advanceIfAllVoted(io, roomCode).catch(() => {}); } catch (e) {} });
  recordTurn(roomCode, ai.characterName, "vote");
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
  maybeAnswerMention,
  reserveSlot, // 时间片预约（纯函数，供测试）
  // 发言/提问的顺序与节奏（座位序 + 严格轮流 + 每 5 分钟一次机会）—— 纯函数，供测试
  orderAiPlayers, buildTurnPlan, runTurnChain, makeTurnWaiter, runAiTurn, phaseChanged,
  // "搜证 : 发言"配比（纯函数，供测试）
  searchWanted, SEARCH_PER_TALK,
  TURN_GAP_MS, TURN_CYCLE_MS, MAX_TURNS_PER_ROUND, TEST_TURN_CYCLE_MS, TEST_PHASE_MS,
};