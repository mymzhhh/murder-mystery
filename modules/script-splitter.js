// 剧本切分 Agent — 将剧本拆分为玩家可见的纯净内容，存入 Redis（优化版）

const { getSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");

const SPLIT_SYSTEM_PROMPT = `你是一个剧本杀内容处理专家。你需要将剧本的各个模块拆分为"玩家可见"和"DM专用"两部分。

## 拆分原则

**玩家剧本** — 只保留玩家自己的信息，移除所有提示性的指引：
- 保留：故事背景、时间线（个人行动）、目标/任务、掌握的信息、随身物品
- 移除：谎言建议、辩护策略、"如果你是凶手"提示、推理提示
- 语言：保持第一人称视角，不包含任何元信息

**NPC嫌疑人信息** — 精简为DM参考卡片，不需要玩家视角内容：
- 保留：背景故事、秘密、与案件相关的客观信息、时间线摘要
- 移除：目标、谎言、辩护、物品清单等玩家专属段落
- 语言：第三人称客观叙述
- 字数：保留原文完整内容，不截断

**线索卡** — 只保留线索本身的信息：
- 保留：线索编号、名称、内容描述、发现地点
- 移除：指向角色/事件、推理提示、推理价值、线索类型标签
- 语言：纯描述性文字，不包含任何分析性内容

**DM手册** — 保留完整信息供DM参考。

## 输出格式（JSON）

对于每个玩家角色剧本，输出：
{
  "playerScript": "纯化的玩家剧本内容...",
  "secret": "该角色的秘密（仅DM可见）",
  "isMurderer": false
}

对于每个NPC嫌疑人，输出：
{
  "playerScript": "NPC信息精简版...",
  "secret": "该NPC的秘密",
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
 * 纯化一段玩家剧本
 */
function extractLayoutFromMarkdown(markdown) {
  try {
    const jsonMatch = markdown.match(/\{\s*"rooms"\s*:\s*\[[\s\S]*?\}\s*\]\s*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      if (data.rooms && data.rooms.length > 0) return data;
    }
  } catch (e) { /* fall through */ }
  return null;
}

async function purifyPlayerScript(characterName, rawScript, isMurderer) {
  const prompt = `请纯化玩家角色"${characterName}"的剧本。移除所有提示性、引导性内容（如"谎言建议"、"辩护策略"、"推理提示"、"如何圆谎"等），只保留角色自身的故事背景、个人时间线、任务目标、掌握的信息和随身物品。使用第一人称视角。

${isMurderer ? '注意：该角色是凶手，请在剧本中保留其作案相关的真实时间线和动机，但不要添加任何额外的标注或提示。' : ''}

原始剧本内容：
${rawScript.substring(0, 5000)}

请输出纯化后的玩家剧本（纯文本，不要JSON包装）：`;

  const result = await generate(SPLIT_SYSTEM_PROMPT, prompt, { maxTokens: 4096, temperature: 0.4 });
  return result.content.trim();
}

/**
 * 纯化NPC信息（精简版）
 */
async function purifyNpcInfo(characterName, rawScript, isMurderer) {
  const prompt = `请保留以下NPC嫌疑人"${characterName}"的完整信息。只需要：
1. 删除所有策略性指导（如有"你应该"、"建议"等）
2. 删除空的章节（无实际内容）
3. 保留所有故事、动机、秘密、时间线、物品、作案过程等完整内容
4. 保持第三人称客观叙述
5. 保持原有的章节结构和完整性，不要缩写或精简内容
6. ${isMurderer ? '该NPC是凶手，必须完整保留作案过程。' : ''}

原始内容：
${rawScript.substring(0, 8000)}

请输出保留完整的NPC信息：`;

  const result = await generate(SPLIT_SYSTEM_PROMPT, prompt, { maxTokens: 8192, temperature: 0.3 });
  return result.content.trim();
}

/**
 * 纯化单条线索
 */
async function purifyClue(clue, round) {
  const prompt = `请纯化以下线索卡。只保留线索编号、内容描述和发现地点，移除所有分析性内容（如"指向角色"、"推理提示"、"推理价值"、"线索类型"等）。

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

  // 从 markdown 中提取场景布局
  const layout = extractLayoutFromMarkdown(markdown);

  const result = {
    sessionId,
    meta: {
      title: parsed.title,
      era: parsed.setting?.era || "",
      location: parsed.setting?.location || "",
      victim: parsed.victim,
      characterNames: parsed.characters?.map(c => c.name) || [],
      clueCount: (parsed.clues?.round1?.length || 0) + (parsed.clues?.round2?.length || 0) + (parsed.clues?.round3?.length || 0),
      layout,
    },
    characters: {},
    clues: [],
    dm: {},
  };

  // 1. 切分角色内容（区分玩家/NPC）
  const characters = parsed.characters || [];
  const playerChars = characters.filter(c => c.roleType !== "npc");
  const npcChars = characters.filter(c => c.roleType === "npc");

  // 处理玩家角色（完整剧本纯化）
  for (let i = 0; i < playerChars.length; i++) {
    const char = playerChars[i];
    onProgress("player_script", `提取玩家剧本 (${i + 1}/${playerChars.length}): ${char.name}`);
    const rawScript = char.script?.fullScript || char.script?.story || '';
if (!rawScript) continue;
    result.characters[char.name] = {
      playerScript: rawScript,
      secret: char.script?.secret || char.secret || "",
      isMurderer: char.isMurderer || false,
      occupation: char.occupation || "",
      age: char.age || "",
      roleType: "player",
    };
  }

  // 处理NPC（精简信息，更短的prompt上下文）
  for (let i = 0; i < npcChars.length; i++) {
    const char = npcChars[i];
    onProgress("npc_script", `提取NPC信息 (${i + 1}/${npcChars.length}): ${char.name}`);
    const rawScript = char.script?.fullScript || char.script?.story || '';
if (!rawScript) continue;
    result.characters[char.name] = {
      playerScript: rawScript,
      secret: char.script?.secret || char.secret || "",
      isMurderer: char.isMurderer || false,
      occupation: char.occupation || "",
      age: char.age || "",
      roleType: "npc",
    };
  }

  // 2. 线索（直接使用，无需LLM纯化）
  const allClues = [
    ...(parsed.clues?.round1 || []).map(c => ({ ...c, round: 1 })),
    ...(parsed.clues?.round2 || []).map(c => ({ ...c, round: 2 })),
    ...(parsed.clues?.round3 || []).map(c => ({ ...c, round: 3 })),
  ];

  if (allClues.length > 0) {
    onProgress("clue", `提取线索 (共 ${allClues.length} 条)...`);
    for (const c of allClues) {
      result.clues.push({
        id: c.id, name: "", content: (c.content || "").substring(0, 500),
        location: c.location || "", round: c.round, clueType: c.clueType || ""
      });
    }
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
  // 把原始markdown挂在result上供saveToRedis使用
  result.meta.originalMarkdown = markdown;
  await saveToRedis(sessionId, result);

  onProgress("done", `切分完成：${playerChars.length}玩家+${npcChars.length}NPC、${result.clues.length}条线索`);
  return { ok: true, result };
}

/**
 * 将切分结果存入 Redis
 */
async function saveToRedis(sessionId, result) {
  const { getRedis, scanKeys } = require("./redis-client");
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
  const playerCount = Object.values(result.characters).filter(c => c.roleType === "player").length;
  const npcCount = Object.values(result.characters).filter(c => c.roleType === "npc").length;

  pipeline.hset(`split:${sessionId}:meta`, {
    title: result.meta.title || "",
    era: result.meta.era || "",
    location: result.meta.location || "",
    characterNames: JSON.stringify(result.meta.characterNames),
    playerCount: String(playerCount),
    npcCount: String(npcCount),
    clueCount: String(result.meta.clueCount),
    splitAt: new Date().toISOString(),
    layout: result.meta.layout ? JSON.stringify(result.meta.layout) : "",
    originalMarkdown: (result.meta.originalMarkdown || "").substring(0, 50000),
  });

  // 索引：将 sessionId 加入已切分剧本集合
  pipeline.sadd("scripts:split", sessionId);

  await pipeline.exec();
}

/**
 * 获取已切分的剧本数据
 */
async function getSplitData(sessionId) {
  const { getRedis, scanKeys } = require("./redis-client");
  const redis = await getRedis();

  const meta = await redis.hgetall(`split:${sessionId}:meta`);
  if (!meta || !meta.title) return null;

  const charKeys = await scanKeys(`split:${sessionId}:char:*`);
  const clueKeys = await scanKeys(`split:${sessionId}:clue:*`);
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
        roleType: data.roleType || "player",
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
