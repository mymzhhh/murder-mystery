// 剧本切分 Agent — 将剧本拆分为玩家可见的纯净内容，存入 Redis（优化版）

const { getSession } = require("./history-manager");
const { parseScript } = require("./script-parser");

/**
 * 纯化一段玩家剧本
 */
function extractLayoutDescription(markdown) {
  // 匹配多种常见的布局章节标题
  const headingPatterns = [
    /#{1,3}\s*(?:场景布局|场景布局图|平面布局|平面图|房间布局|建筑布局|地点布局|布局图|地图|场景地图|位置图|空间布局)\s*\n([\s\S]*?)(?=\n#{1,3}\s+(?!-|\d+\.)|\n---\s*\n|$)/i,
    /#{1,3}\s*房间位置描述\s*\n([\s\S]*?)(?=\n#{1,3}\s+(?!-|\d+\.)|\n---\s*\n|$)/i,
    /\*\*(?:场景布局|场景布局图|平面布局|场景地图|布局图)\*\*[：:]\s*([\s\S]*?)(?=\n\*\*|\n#{1,3}|$)/i,
    /(?:场景布局|场景布局图|平面布局)[：:]\s*([\s\S]*?)(?=\n(?:#{1,3}\s|[一二三四五六七八九]、|\*\*角色|\*\*凶手|$))/i,
  ];

  for (const pattern of headingPatterns) {
    const match = markdown.match(pattern);
    if (match) {
      let text = (match[1] || match[0]).trim();
      // 去掉首行可能残留的标题
      text = text.replace(/^#{1,3}\s*(?:场景布局|场景布局图|平面布局|平面图|房间布局|建筑布局|地点布局|布局图|地图|场景地图|位置图|空间布局|房间位置描述)[^\n]*\n?/i, "").trim();
      // 截断尾部不相干内容
      const cutMarks = [
        /\n#{1,3}\s+(?!-|\d+\.)/,
        /\n---\s*\n/,
        /\n(?:玩家角色剧本|NPC嫌疑人信息|第[一二三四五六七八九]部分)/i,
        /\n\*\*重要约束/,
      ];
      for (const cut of cutMarks) {
        const idx = text.search(cut);
        if (idx > 0) { text = text.substring(0, idx).trim(); break; }
      }
      if (text.length > 20) return text;
    }
  }
  return "";
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

  // 从 markdown 中提取场景布局描述
  const layoutDescription = extractLayoutDescription(markdown);

  const result = {
    sessionId,
    meta: {
      title: parsed.title,
      era: parsed.setting?.era || "",
      location: parsed.setting?.location || "",
      victim: parsed.victim,
      characterNames: parsed.characters?.map(c => c.name) || [],
      clueCount: (parsed.clues?.round1?.length || 0) + (parsed.clues?.round2?.length || 0) + (parsed.clues?.round3?.length || 0),
      layoutDescription,
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
    layoutDescription: result.meta.layoutDescription || "",
    originalMarkdown: (result.meta.originalMarkdown || "").substring(0, 50000),
  });

  // 索引：将 sessionId 加入已切分剧本集合
  pipeline.sadd("scripts:split", sessionId);
  await pipeline.exec();

  // 双写 PostgreSQL（持久存储）
  try {
    const { saveSplitScript } = require("./db");
    await saveSplitScript(sessionId,
      { title: result.meta.title, era: result.meta.era, location: result.meta.location,
        playerCount, npcCount, clueCount: result.meta.clueCount,
        layoutDescription: result.meta.layoutDescription || "",
        originalMarkdown: result.meta.originalMarkdown || "" },
      result.characters, result.clues, result.dm);
    console.log("[split] PostgreSQL 同步完成:", result.meta.title);
  } catch (e) {
    console.warn("[split] PostgreSQL 写入失败（Redis 已保存）:", e.message);
  }
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
