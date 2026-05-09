// 剧本撰写 Agent — 含查重、人数校验、Redis 存储

const { buildMurderMystery } = require("./murder-mystery-builder");
const { createSession, addMessage, listSessions, getSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
const { splitScript } = require("./script-splitter");

const MAX_PLAYERS = 6;

/**
 * 提取已有剧本的特征摘要用于查重
 */
async function getExistingScriptsSummary() {
  const sessions = await listSessions();
  const scripts = sessions.filter(s => s.textType === "murder-mystery");
  if (scripts.length === 0) return [];

  const summaries = [];
  for (const s of scripts.slice(0, 10)) {
    try {
      const full = await getSession(s.sessionId);
      if (!full) continue;
      const markdown = (full.messages || []).filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
      if (!markdown || markdown.length < 200) continue;

      // 提取关键特征：标题、时代背景、死者信息、凶手动机、手法
      const parsed = parseScript(markdown);
      summaries.push({
        sessionId: s.sessionId,
        title: parsed.title || s.topic,
        era: parsed.setting?.era || "",
        victim: parsed.victim?.name || "",
        causeOfDeath: parsed.victim?.causeOfDeath || "",
        murderer: parsed.murderer?.name || "",
        motive: (parsed.murderer?.motive || "").substring(0, 300),
        method: (parsed.murderer?.method || "").substring(0, 300),
        characters: parsed.characters?.map(c => c.name) || [],
      });
    } catch (e) { /* skip broken scripts */ }
  }
  return summaries;
}

/**
 * 查重检查：检测新剧本需求是否与已有剧本雷同
 */
async function checkDuplication(userInput, existingSummaries) {
  if (existingSummaries.length === 0) return { ok: true };

  const sysPrompt = `你是剧本杀查重专家。检测新需求是否与已有剧本雷同。雷同标准：1) 时代背景+核心动机相同 2) 凶手手法高度相似 3) 死者身份+死因组合重复。只输出JSON格式：{ "duplicated": true/false, "reason": "重复原因或OK", "similarTo": "相似剧本标题" }`;

  const existText = existingSummaries.map((s, i) =>
    `${i + 1}. 《${s.title}》| ${s.era} | 死者:${s.victim}(${s.causeOfDeath}) | 凶手:${s.murderer} | 动机:${s.motive.substring(0, 100)} | 手法:${s.method.substring(0, 100)}`
  ).join("\n");

  const prompt = `已有剧本：\n${existText}\n\n新需求：${userInput}\n\n请检测是否存在雷同：`;

  try {
    const result = await generate(sysPrompt, prompt, { maxTokens: 256, temperature: 0.2 });
    const json = JSON.parse(result.content.trim());
    return { ok: !json.duplicated, reason: json.reason || "", similarTo: json.similarTo || "" };
  } catch (e) {
    // 解析失败时保守处理，允许通过
    return { ok: true, reason: "查重检测跳过（解析异常）" };
  }
}

/**
 * 检测用户请求的玩家数量
 */
function detectPlayerCount(input) {
  // 匹配各种人数表达
  const patterns = [
    /(\d+)\s*人/, /(\d+)\s*个?玩家/, /(\d+)\s*个?角色/,
    /(\d+)人本/, /[七八九十百千]+人/,
    /[一二三四五六七八九十]+人本/,
  ];

  const digitMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };

  for (const p of patterns) {
    const m = input.match(p);
    if (m) {
      if (m[1] && /^\d+$/.test(m[1])) return parseInt(m[1]);
      if (m[1]) {
        let count = 0;
        for (const ch of m[1]) {
          if (digitMap[ch]) count += digitMap[ch];
        }
        return count || 0;
      }
      if (m[0]) {
        for (const [ch, v] of Object.entries(digitMap)) {
          if (m[0].includes(ch + "人")) return v;
        }
      }
    }
  }
  return 0; // 未指定
}

/**
 * 主入口：撰写剧本
 */
async function writeScript(userInput, onProgress) {
  // 1. 人数检测
  const playerCount = detectPlayerCount(userInput);
  if (playerCount > MAX_PLAYERS) {
    return {
      ok: false,
      error: `暂不支持生成 ${playerCount} 人剧本，最大支持 ${MAX_PLAYERS} 人。请减少角色数量后重试。`,
    };
  }

  // 2. 查重
  onProgress("check", "正在检查已有剧本，避免雷同...");
  const existing = await getExistingScriptsSummary();
  const dupCheck = await checkDuplication(userInput, existing);

  if (!dupCheck.ok) {
    return {
      ok: false,
      error: `该剧本与已有剧本《${dupCheck.similarTo}》存在雷同风险：${dupCheck.reason}\n请修改需求后重试。`,
      similarTo: dupCheck.similarTo,
    };
  }

  // 3. 构建增强的 prompt（注入去重约束）
  let enhancedInput = userInput;
  if (playerCount > 0) {
    enhancedInput += `\n\n【硬性要求：角色数量必须精确为 ${playerCount} 人，不能多也不能少】`;
  } else {
    enhancedInput += `\n\n【硬性要求：角色数量不能超过 ${MAX_PLAYERS} 人】`;
  }

  if (existing.length > 0) {
    const avoidList = existing.map(s => `- 避免：${s.murderer ? s.murderer + '用' + s.method?.substring(0, 50) : ''} - 《${s.title}》`).join("\n");
    enhancedInput += `\n\n【创作约束 — 必须避免以下已有剧本的设定和手法：】\n${avoidList}\n请创作全新的故事，手法和动机必须有明显差异。`;
  }

  // 4. 创建会话并生成
  onProgress("init", "正在创建剧本会话...");
  const session = await createSession({
    textType: "murder-mystery",
    topic: userInput.slice(0, 100),
    templateName: "剧本杀",
  });
  await addMessage(session.sessionId, "user", userInput);

  // 5. 多阶段生成
  onProgress("generate", "正在多阶段生成剧本...");
  const result = await buildMurderMystery(enhancedInput, (stage, msg) => {
    onProgress(stage, msg);
  });

  // 6. 保存原始剧本到 Redis
  const contentToSave = result.fullScript.substring(0, 50000);
  await addMessage(session.sessionId, "assistant", contentToSave);

  // 7. 解析并缓存元数据
  const parsed = parseScript(result.fullScript);
  const characterNames = parsed.characters?.map(c => c.name) || [];

  // 8. 自动切分：纯化角色剧本和线索，存入 split:* 命名空间
  onProgress("split", "正在自动切分剧本...");
  const splitResult = await splitScript(session.sessionId, (stage, msg) => {
    onProgress("split_" + stage, msg);
  });

  // 9. 切分完成后清理原始数据（只保留 split 版本）
  if (splitResult.ok) {
    await deleteSession(session.sessionId);
    // 清理 script_meta 缓存（如果存在）
    const { getRedis } = require("./game-manager");
    try { await (await getRedis()).del(`script_meta:${session.sessionId}`); } catch (e) { /* skip */ }
  }

  return {
    ok: true,
    sessionId: session.sessionId,
    splitSessionId: splitResult.ok ? session.sessionId : null,
    summary: {
      title: parsed.title,
      characterCount: parsed.characters?.length || 0,
      characterNames: characterNames,
      era: parsed.setting?.era || "",
      clueCount: (parsed.clues?.round1?.length || 0) + (parsed.clues?.round2?.length || 0) + (parsed.clues?.round3?.length || 0),
      splitted: splitResult.ok,
    },
  };
}

module.exports = { writeScript, getExistingScriptsSummary, MAX_PLAYERS };
