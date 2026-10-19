// 剧本切分 Agent — 将剧本拆分为玩家可见的纯净内容，存入 Redis（优化版）

const { getSession, getSessionArtifacts } = require("../core/history-manager");
const { parseScript, checkCharacterCoverage } = require("./script-parser");

/**
 * 纯化一段玩家剧本
 */
function extractLayoutDescription(markdown) {
  const headingPatterns = [
    /#{1,3}\s*(?:场景布局|场景布局图|平面布局|平面图|房间布局|建筑布局|地点布局|布局图|地图|场景地图|位置图|空间布局)\s*\n([\s\S]*?)(?=\n#{1,3}\s+(?!-|\d+\.)|\n---\s*\n|$)/i,
    /#{1,3}\s*房间位置描述\s*\n([\s\S]*?)(?=\n#{1,3}\s+(?!-|\d+\.)|\n---\s*\n|$)/i,
    /\*\*(?:场景布局|场景布局图|平面布局|场景地图|布局图|房间分布|空间结构)\*\*[：:]\s*([\s\S]*?)(?=\n\*\*|\n#{1,3}|$)/i,
    /(?:场景布局|场景布局图|平面布局|房间分布|地图|场景地形)[：:]\s*([\s\S]*?)(?=\n(?:#{1,3}\s|[一二三四五六七八九]、|\*\*角色|\*\*凶手|$))/i,
    // 兜底：匹配包含典型布局关键词的段落
    /\n((?:(?:[一二三四五六七八九]楼|[地上地下下][一二三四五六七八九]层|房间|大厅|厨房|书房|卧室|阳台|走廊|楼梯|花园|密室|客厅|餐厅|卫生间|浴室|储藏室|车库|阁楼|地下室).{0,200}(?:\n|$)){2,})/i,
  ];

  for (const pattern of headingPatterns) {
    const match = markdown.match(pattern);
    if (match) {
      let text = (match[1] || match[0]).trim();
      text = text.replace(/^#{1,3}\s*(?:场景布局|场景布局图|平面布局|平面图|房间布局|建筑布局|地点布局|布局图|地图|场景地图|位置图|空间布局|房间位置描述)[^\n]*\n?/i, "").trim();
      const cutMarks = [
        /\n#{1,3}\s+(?!-|\d+\.)/,
        /\n---\s*\n/,
        /\n(?:玩家角色剧本|NPC嫌疑人信息|NPC目击者\/关系人信息|第[一二三四五六七八九]部分)/i,
        /\n\*\*重要约束/,
        /\n#{1,3}\s*(?:线索|证据|DM|真相|复盘|凶手|故事背景|角色介绍)/i,
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

  // 中间产物（推理链/大纲/交叉校验问题）：生成阶段落的盘，这里随切分数据一起带走，
  // 之后由 pg-sync 写进 PG → 管理端剧本详情页可事后复核。
  // 取不到（旧剧本、或落盘失败）就是 null，切分照常进行。
  let artifacts = null;
  try {
    artifacts = await getSessionArtifacts(sessionId);
  } catch (e) { console.warn("[split] 读取中间产物失败（不影响切分）:", e.message); }

  // 解析剧本
  onProgress("parse", "正在解析剧本结构...");
  const parsed = parseScript(markdown);

  // 护栏：**标题里有的角色，解析器必须都认出来。**
  // 曾经因为名字长度上限（2~6 字），9 字的 `玛格丽特·伦诺克斯` 被整条丢掉，
  // 而流程一路绿灯，直到"切分完成：3玩家+2NPC"才在日志里露出来 ——
  // 被丢的角色在游戏里会彻底缺席（选角选不到、AI 补位补不上）。
  // 现在解析完当场比对标题数，少一个就喊出来。
  const cov = checkCharacterCoverage(markdown, parsed.characters);
  if (cov.dropped > 0) {
    const warn = `⚠ ${cov.dropped} 个角色标题没被解析出来（标题 ${cov.headingCount} / 解析 ${cov.parsedCount}），这些角色会在游戏里缺席 —— 请回查 script-parser 的名字规则`;
    console.warn("[split]", warn);
    onProgress("parse", warn);
  }

  // 从 markdown 中提取场景布局描述（extractLayoutDescription + parseScript 互补）
  const layoutDescription = extractLayoutDescription(markdown) || parsed.layoutDescription || "";

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
      gameMode: parsed.setting?.gameMode || "",
      artifacts,                             // 中间产物（可能为 null）
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
      // personality/goal 由大纲生成，经 assembleScript 写进剧本、parseScript 解析回来。
      // 必须在这里透传，否则 AI 扮演时拿不到语气、复盘也无从判定支线任务。
      personality: char.personality || "",
      goal: char.goal || "",
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
      personality: char.personality || "",
      goal: char.goal || "",
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
    // 地点兜底：空 location 的线索在游戏里**永远搜不到**（搜证池按 location 生成）。
    // 实测《停表的修表铺》44 条里 6 条因缺「发现地点」落成空串，玩家少拿 14% 的线索。
    const { fillMissingClueLocations } = require("./clue-locations");
    const layoutPlaces = String(parsed.layoutDescription || parsed.meta?.layoutDescription || "")
      .split(/[｜|\/、,，\n]/).map((s) => s.trim()).filter(Boolean);
    const { clues: filledClues, filled } = fillMissingClueLocations(allClues, {
      places: layoutPlaces,
      fallback: "现场",
    });
    if (filled.length) {
      console.warn(`[splitter] 补全了 ${filled.length} 条缺失地点的线索：` +
        filled.map((f) => `${allClues[f.index].id}→${f.location}(${f.reason})`).join("，"));
    }
    // 地点收敛：把"维修间挂钟转轴""死者指甲缝"这类子位置并回房间级。
    // 实测生成稿 40 条线索碎成 36 个地点（每轮 18-20 个搜证点），玩家挑不过来；
    // 真本《吉普赛女郎之死》是 45 条 / 7 个地点。合并只动 location，线索一条不丢。
    const { collapseClueLocations } = require("./location-collapse");
    const col = collapseClueLocations(filledClues, { places: layoutPlaces, maxLocations: 7 });
    if (col.before !== col.after) {
      console.warn(`[splitter] 地点收敛 ${col.before} → ${col.after} 个` +
        (col.warnings.length ? `（${col.warnings.join("；")}）` : ""));
    }
    for (const c of col.clues) {
      result.clues.push({
        id: c.id, name: "", content: (c.content || "").substring(0, 500),
        location: c.location || "现场", round: c.round, clueType: c.clueType || "", hiddenContent: c.hiddenContent || "", diggable: !!c.diggable, hiddenBehind: c.hiddenBehind || ""
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
  const { getRedis, scanKeys } = require("../core/redis-client");
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
      personality: data.personality || "",
      goal: data.goal || "",
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
    truthReveal: result.dm.truthReveal?.substring(0, 12000) || "",
    murdererName: result.dm.murdererInfo?.name || "",
    murdererMotive: result.dm.murdererInfo?.motive?.substring(0, 2000) || "",
    murdererMethod: result.dm.murdererInfo?.method?.substring(0, 2000) || "",
  });

  // 元数据
  const playerCount = Object.values(result.characters).filter(c => c.roleType === "player").length;
  const npcCount = Object.values(result.characters).filter(c => c.roleType === "npc").length;

  // 中间产物（推理链/大纲等）。取不到时**不能**用空串覆盖旧值：
  // 生成成功后 admin 会删掉生成会话（routes/admin.js 的 deleteSession），
  // 于是"重新切分"走的是 originalMarkdown 重建临时会话那条路，session 上已经没有 artifacts 了 ——
  // 若此时写空串，会把上一次切分时存进 PG/Redis 的中间产物抹掉。
  let artifactsJson = result.meta.artifacts ? JSON.stringify(result.meta.artifacts) : "";
  if (!artifactsJson) {
    try { artifactsJson = (await redis.hget(`split:${sessionId}:meta`, "artifacts")) || ""; } catch (e) { artifactsJson = ""; }
  }

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
    gameMode: result.meta.gameMode || "",
    originalMarkdown: (result.meta.originalMarkdown || "").substring(0, 50000),
    artifacts: artifactsJson,
  });

  // 索引：将 sessionId 加入已切分剧本集合
  pipeline.sadd("scripts:split", sessionId);
  await pipeline.exec();

  // 双写 PostgreSQL → 异步同步队列（不阻塞切分流程；失败自动重试/挂起）
  try {
    const { enqueueSync } = require("../core/pg-sync");
    enqueueSync(sessionId);
  } catch (e) {
    console.warn("[split] 加入 PG 同步队列失败（Redis 已保存）:", e.message);
  }
}

/**
 * 获取已切分的剧本数据
 */
/**
 * 把 Redis hash 里的线索字段还原成正确的类型。
 *
 * ⚠️ 这是个真实事故（2026-10-19）：Redis hash 的字段值**都是字符串**，
 * 之前的 `clues.push(data)` 直接把原始 hash 塞回去，于是
 *   diggable: "false"、round: "1"
 * 到了落库时 `!!clue.diggable` → `!!"false"` → **true**，
 * 结果《冬至钟影》《沪西照相馆除夕谜案》两本都是"全部 46 条线索都可深入调查"，
 * 玩家对任意线索点「深入调查」都会报错。
 * 布尔/数字字段必须在这里显式归一化，不能指望下游用 !! 判断。
 */
function normalizeSplitClue(raw) {
  const d = raw || {};
  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";
  return {
    id: d.id,
    name: d.name || "",
    content: d.content || "",
    location: d.location || "",
    round: Number(d.round) || 1,
    clueType: d.clueType || d.clue_type || "",
    hiddenContent: d.hiddenContent || d.hidden_content || "",
    diggable: truthy(d.diggable),
    hiddenBehind: d.hiddenBehind || d.hidden_behind || "",
  };
}
async function getSplitData(sessionId) {
  const { getRedis, scanKeys } = require("../core/redis-client");
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
        personality: data.personality || "",
        goal: data.goal || "",
        age: data.age,
      };
    } else {
      clues.push(normalizeSplitClue(data));
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

module.exports = { splitScript, getSplitData, normalizeSplitClue };
