// 剧本切分 Agent — 将剧本拆分为玩家可见的纯净内容，存入 Redis

const { getSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");

const SPLIT_SYSTEM_PROMPT = `你是一个剧本杀内容处理专家。你需要将剧本的各个模块拆分为"玩家可见"和"DM专用"两部分。

## 拆分原则

**玩家剧本** — 只保留玩家自己的信息，移除所有提示性的指引：
- 保留：故事背景、时间线（个人行动）、目标/任务、掌握的信息、随身物品
- 移除：谎言建议、辩护策略、"如果你是凶手"提示、推理提示
- 语言：保持角色视角（第一人称），不包含任何元信息

**线索卡** — 只保留线索本身的信息：
- 保留：线索编号、名称、内容描述、发现地点
- 移除：指向角色/事件、推理提示、推理价值、线索类型标签
- 语言：纯描述性文字，不包含任何分析性内容

**DM手册** — 保留完整信息供DM参考。

## 输出格式（JSON）

对于每个角色剧本，输出：
{
  "playerScript": "纯化的玩家剧本内容...",
  "secret": "该角色的秘密（仅DM可见）",
  "isMurderer": false
}

对于每条线索，输出：
{
  "id": "A1",
  "name": "线索名称",
  "content": "纯化的线索内容（无提示）",
  "location": "发现地点",
  "round": 1
}

对于DM内容：
{
  "openingMonologue": "...",
  "fullTimeline": "...",
  "truthReveal": "...",
  "endings": { "trueEnding": "...", "escapeEnding": "...", "wrongEnding": "..." }
}`;

/**
 * 使用 LLM 纯化一段玩家剧本
 */
async function purifyPlayerScript(characterName, rawScript, isMurderer) {
  const prompt = `请纯化角色"${characterName}"的剧本。移除所有提示性、引导性内容（如"谎言建议"、"辩护策略"、"推理提示"等），只保留角色自身的故事背景、个人时间线、任务目标、掌握的信息和随身物品。使用第一人称视角。

${isMurderer ? '注意：该角色是凶手，请在剧本中保留其作案相关的真实时间线和动机，但不要添加任何额外的标注或提示。' : ''}

原始剧本内容：
${rawScript.substring(0, 5000)}

请输出纯化后的玩家剧本（纯文本，不要JSON包装）：`;

  const result = await generate(SPLIT_SYSTEM_PROMPT, prompt, { maxTokens: 4096, temperature: 0.4 });
  return result.content.trim();
}

/**
 * 纯化单条线索
 */
async function purifyClue(clue, round) {
  const prompt = `请纯化以下线索卡。只保留线索编号、内容描述和发现地点，移除所有分析性内容（如"指向角色"、"推理提示"、"推理价值"等）。

线索编号：${clue.id}
线索内容：${clue.content || ""}
线索类型：${clue.clueType || ""}
发现地点：${clue.location || "未知"}
指向：${clue.pointsTo || ""}

请输出JSON（只输出JSON，不要其他内容）：
{"id":"${clue.id}","name":"","content":"纯化后的线索描述","location":"发现地点","round":${round}}`;

  try {
    const result = await generate(SPLIT_SYSTEM_PROMPT, prompt, { maxTokens: 512, temperature: 0.3 });
    const cleaned = result.content.trim().replace(/```json\n?/g, "").replace(/```\n?/g, "");
    return JSON.parse(cleaned);
  } catch (e) {
    // 解析失败时使用原始数据
    return {
      id: clue.id,
      name: "",
      content: (clue.content || "").substring(0, 500),
      location: clue.location || "",
      round,
    };
  }
}

/**
 * 切分已通过评测的剧本
 */
async function splitScript(sessionId, onProgress) {
  const session = await getSession(sessionId);
  if (!session) return { ok: false, error: "剧本不存在" };

  const messages = session.messages || [];
  const markdown = messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
  if (!markdown || markdown.length < 500) return { ok: false, error: "剧本内容为空" };

  // 解析剧本
  onProgress("parse", "正在解析剧本结构...");
  const parsed = parseScript(markdown);

  const result = {
    sessionId,
    meta: {
      title: parsed.title,
      era: parsed.setting?.era || "",
      location: parsed.setting?.location || "",
      victim: parsed.victim,
      characterNames: parsed.characters?.map(c => c.name) || [],
      clueCount: (parsed.clues?.round1?.length || 0) + (parsed.clues?.round2?.length || 0) + (parsed.clues?.round3?.length || 0),
    },
    characters: {},
    clues: [],
    dm: {},
  };

  // 1. 切分角色剧本（区分玩家/NPC）
  const characters = parsed.characters || [];
  const playerChars = characters.filter(c => c.roleType !== "npc");
  const npcChars = characters.filter(c => c.roleType === "npc");

  // 先处理玩家角色
  for (let i = 0; i < playerChars.length; i++) {
    const char = playerChars[i];
    onProgress("player_script", `纯化玩家剧本 (${i + 1}/${playerChars.length}): ${char.name}`);
    const rawScript = char.script?.fullScript || char.script?.story || JSON.stringify(char);
    const purified = await purifyPlayerScript(char.name, rawScript, char.isMurderer);

    result.characters[char.name] = {
      playerScript: purified,
      secret: char.script?.secret || char.secret || "",
      isMurderer: char.isMurderer || false,
      occupation: char.occupation || "",
      age: char.age || "",
      roleType: "player",
    };
  }

  // 再处理NPC（简化版本）
  for (let i = 0; i < npcChars.length; i++) {
    const char = npcChars[i];
    onProgress("npc_script", `纯化NPC信息 (${i + 1}/${npcChars.length}): ${char.name}`);
    const rawScript = char.script?.fullScript || char.script?.story || JSON.stringify(char);
    const purified = await purifyPlayerScript(char.name, rawScript, char.isMurderer);

    result.characters[char.name] = {
      playerScript: purified.substring(0, 2000), // NPC剧本精简
      secret: char.script?.secret || char.secret || "",
      isMurderer: char.isMurderer || false,
      occupation: char.occupation || "",
      age: char.age || "",
      roleType: "npc",
    };
  }
  }

  // 2. 切分线索
  const allClues = [
    ...(parsed.clues?.round1 || []).map(c => ({ ...c, round: 1 })),
    ...(parsed.clues?.round2 || []).map(c => ({ ...c, round: 2 })),
    ...(parsed.clues?.round3 || []).map(c => ({ ...c, round: 3 })),
  ];

  onProgress("clue", `纯化线索 (共 ${allClues.length} 条)...`);
  // 线索较多，批量处理：每5条并发一次
  for (let i = 0; i < allClues.length; i += 5) {
    const batch = allClues.slice(i, i + 5);
    const purified = await Promise.all(batch.map(c => purifyClue(c, c.round)));
    result.clues.push(...purified);
    onProgress("clue", `纯化线索 (${Math.min(i + 5, allClues.length)}/${allClues.length})`);
  }

  // 3. DM 手册
  onProgress("dm", "整理 DM 手册...");
  result.dm = {
    openingMonologue: parsed.dmGuide?.openingMonologue || "",
    fullTimeline: parsed.dmGuide?.fullTimeline || "",
    truthReveal: parsed.dmGuide?.truthReveal || "",
    endings: parsed.dmGuide?.endings || {},
    murdererInfo: {
      name: parsed.murderer?.name || "",
      motive: parsed.murderer?.motive || "",
      method: parsed.murderer?.method || "",
    },
  };

  // 4. 存入 Redis
  onProgress("save", "正在存入 Redis...");
  await saveToRedis(sessionId, result);

  onProgress("done", `切分完成：${characters.length} 个角色、${result.clues.length} 条线索、DM 手册`);
  return { ok: true, result };
}

/**
 * 将切分结果存入 Redis
 */
async function saveToRedis(sessionId, result) {
  const { getRedis } = require("./game-manager");
  const redis = await getRedis();
  if (redis.status !== "ready" && redis.status !== "connecting") await redis.connect();

  const pipeline = redis.pipeline();

  // 角色剧本
  for (const [name, data] of Object.entries(result.characters)) {
    pipeline.hset(`split:${sessionId}:char:${name}`, {
      name,
      playerScript: data.playerScript || "",
      secret: data.secret || "",
      isMurderer: data.isMurderer ? "1" : "0",
      roleType: data.roleType || "player",
      occupation: data.occupation || "",
      age: data.age || "",
    });
  }

  // 线索
  for (const clue of result.clues) {
    pipeline.hset(`split:${sessionId}:clue:${clue.id}`, clue);
  }

  // DM 手册
  pipeline.hset(`split:${sessionId}:dm`, {
    openingMonologue: result.dm.openingMonologue?.substring(0, 5000) || "",
    fullTimeline: result.dm.fullTimeline?.substring(0, 5000) || "",
    truthReveal: result.dm.truthReveal?.substring(0, 5000) || "",
    murdererName: result.dm.murdererInfo?.name || "",
    murdererMotive: result.dm.murdererInfo?.motive?.substring(0, 2000) || "",
    murdererMethod: result.dm.murdererInfo?.method?.substring(0, 2000) || "",
  });

  // 元数据
  pipeline.hset(`split:${sessionId}:meta`, {
    title: result.meta.title || "",
    era: result.meta.era || "",
    location: result.meta.location || "",
    characterNames: JSON.stringify(result.meta.characterNames),
    clueCount: String(result.meta.clueCount),
    splitAt: new Date().toISOString(),
  });

  // 索引：将 sessionId 加入已切分剧本集合
  pipeline.sadd("scripts:split", sessionId);

  await pipeline.exec();
}

/**
 * 获取已切分的剧本数据
 */
async function getSplitData(sessionId) {
  const { getRedis } = require("./game-manager");
  const redis = await getRedis();

  const meta = await redis.hgetall(`split:${sessionId}:meta`);
  if (!meta || !meta.title) return null;

  // 查找所有角色和线索 key
  const charKeys = await redis.keys(`split:${sessionId}:char:*`);
  const clueKeys = await redis.keys(`split:${sessionId}:clue:*`);
  const dm = await redis.hgetall(`split:${sessionId}:dm`);

  const pipeline = redis.pipeline();
  charKeys.forEach(k => pipeline.hgetall(k));
  clueKeys.forEach(k => pipeline.hgetall(k));
  const results = await pipeline.exec();

  const characters = {};
  const clues = [];
  const charCount = charKeys.length;

  for (let i = 0; i < results.length; i++) {
    const data = results[i][1];
    if (!data) continue;
    if (i < charCount) {
      characters[data.name] = {
        playerScript: data.playerScript,
        secret: data.secret,
        isMurderer: data.isMurderer === "1",
        occupation: data.occupation,
        age: data.age,
      };
    } else {
      clues.push(data);
    }
  }

  return {
    meta: {
      ...meta,
      characterNames: JSON.parse(meta.characterNames || "[]"),
      clueCount: parseInt(meta.clueCount) || 0,
    },
    characters,
    clues: clues.sort((a, b) => (a.id || "").localeCompare(b.id || "")),
    dm,
  };
}

module.exports = { splitScript, getSplitData };
