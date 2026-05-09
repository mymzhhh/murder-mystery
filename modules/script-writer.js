// 剧本撰写 Agent — 含查重、人数校验、Redis 存储

const { buildMurderMystery } = require("./murder-mystery-builder");
const { createSession, addMessage, listSessions, getSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
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
  // 直接匹配数字
  var dm = input.match(/(\d+)\s*(?:人|个?玩家|个?角色|人本)/);
  if (dm) { var n = parseInt(dm[1]); if (n >= 1 && n <= 20) return n; }

  // 中文数字
  var digits = { "一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,"双":2 };
  var cm = input.match(/([一两二三四五六七八九十双]+)\s*(?:人|个?玩家|个人|人本)/);
  if (cm) {
    var str = cm[1], count = 0;
    if (str === "十") return 10;
    if (str.startsWith("十")) count = 10 + (digits[str[1]] || 0);
    else if (str.endsWith("十")) count = (digits[str[0]] || 0) * 10;
    else count = digits[str] || 0;
    if (count >= 1 && count <= 20) return count;
  }

  return 0;
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

  // 3. 构建增强的 prompt
  let enhancedInput = userInput;
  const isPVE = /NPC|PVE|对抗|嫌疑人|侦探|探案|推理者/.test(userInput);

  if (playerCount > 0) {
    if (isPVE) {
      enhancedInput += `\n\n【硬性要求】这是一个 ${playerCount} 人游玩的PVE剧本。剧本中只有 ${playerCount} 个玩家角色（侦探/调查员），其余为NPC嫌疑人。所有角色（玩家+NPC）总数不得超过 ${MAX_PLAYERS} 人。`;
    } else {
      enhancedInput += `\n\n【硬性要求：角色总数必须精确为 ${playerCount} 人，不能多也不能少。每增加一个角色都会导致剧本无法使用！】`;
    }
  } else {
    enhancedInput += `\n\n【硬性要求：角色总数不能超过 ${MAX_PLAYERS} 人，且必须包含至少2个角色。】`;
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

  // 7. 验证角色数量
  const parsed = parseScript(result.fullScript);
  const characterNames = parsed.characters?.map(c => c.name) || [];
  const actualCount = characterNames.length;

  // 非PVE模式：角色数必须匹配
  if (playerCount > 0 && !isPVE && actualCount > 0 && actualCount !== playerCount) {
    // 删除不合格会话
    await deleteSession(session.sessionId);
    return {
      ok: false,
      error: `剧本生成的角色数为 ${actualCount} 人，但您要求的是 ${playerCount} 人。请重新生成并明确指定角色数量。`,
      actualCount, expectedCount: playerCount,
    };
  }

  // PVE模式：总角色数不能超限
  if (isPVE && actualCount > MAX_PLAYERS) {
    await deleteSession(session.sessionId);
    return {
      ok: false,
      error: `剧本生成了 ${actualCount} 个角色，超过最大限制 ${MAX_PLAYERS} 人。请尝试重新生成。`,
      actualCount, maxPlayers: MAX_PLAYERS,
    };
  }

  return {
    ok: true,
    sessionId: session.sessionId,
    script: result.fullScript,
    summary: {
      title: parsed.title,
      characterCount: parsed.characters?.length || 0,
      characterNames: characterNames,
      era: parsed.setting?.era || "",
      clueCount: (parsed.clues?.round1?.length || 0) + (parsed.clues?.round2?.length || 0) + (parsed.clues?.round3?.length || 0),
    },
  };
}

module.exports = { writeScript, getExistingScriptsSummary, MAX_PLAYERS };
