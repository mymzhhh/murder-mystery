// 剧本撰写 Agent — 含查重、人数校验、Redis 存储

const { buildMurderMystery } = require("./murder-mystery-builder");
const { createSession, addMessage, listSessions, getSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
const MAX_PLAYERS = 6;
const MAX_NPC = 3;

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

  // 3. 构建增强的 prompt（强制人数约束）
  let enhancedInput = userInput;
  const isPVE = /NPC|PVE|对抗|嫌疑人|侦探|探案|推理者/.test(userInput);

  // 人数约束（前置到最前面，最强优先级）
  const actualPlayerCount = playerCount > 0 ? Math.min(playerCount, MAX_PLAYERS) : MAX_PLAYERS;
  const npcCountHint = isPVE ? `+ NPC嫌疑人2-${MAX_NPC}人` : "";
  const countOverride = `【必须严格遵守 — 不可违反的角色数量约束】
1. 玩家角色数量：恰好 ${actualPlayerCount} 人 ${npcCountHint}
2. 总角色数不超过 ${MAX_PLAYERS} 人
3. 在"角色设定"章节中，玩家角色标注【玩家】，NPC标注【NPC】
4. 角色数量不符合要求的剧本将被直接拒绝！请务必清点角色数量后再输出。`;

  enhancedInput = countOverride + "\n\n" + enhancedInput;
  // 进一步加强：用分隔线强调
  enhancedInput = "========================================\n" + enhancedInput + "\n========================================";

  if (existing.length > 0) {
    const avoidList = existing.map(s => `- 避免：${s.murderer ? s.murderer + '用' + s.method?.substring(0, 50) : ''} - 《${s.title}》`).join("\n");
    enhancedInput += `\n\n【创作约束 — 必须避免以下已有剧本的设定和手法：】\n${avoidList}\n请创作全新的故事，手法和动机必须有明显差异。`;
  }

  // 4. 生成（最多重试2次确保人数正确）
  let result, session, parsed, characterNames, actualCount;
  const MAX_GEN_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_GEN_RETRIES; attempt++) {
    onProgress("init", attempt > 0 ? `第${attempt+1}次生成（修正角色数量）...` : "正在创建剧本会话...");
    session = await createSession({ textType: "murder-mystery", topic: userInput.slice(0, 100), templateName: "剧本杀" });
    await addMessage(session.sessionId, "user", userInput);

    let genInput = enhancedInput;
    if (attempt > 0) {
      genInput = `【警告：上一次生成因为角色数量不符合要求被拒绝。必须严格遵守角色数量约束，不得自行增减角色！】\n\n${enhancedInput}`;
    }

    onProgress("generate", "正在多阶段生成剧本...");
    result = await buildMurderMystery(genInput, (stage, msg) => onProgress(stage, msg));
    await addMessage(session.sessionId, "assistant", result.fullScript.substring(0, 50000));

    parsed = parseScript(result.fullScript);
    characterNames = parsed.characters?.map(c => c.name) || [];
    actualCount = characterNames.length;

    // 检查人数
    const maxTotal = isPVE ? (actualPlayerCount + MAX_NPC) : actualPlayerCount;
    const minTotal = isPVE ? (actualPlayerCount + 2) : actualPlayerCount;

    if (actualCount > maxTotal || actualCount < minTotal) {
      if (attempt < MAX_GEN_RETRIES) {
        await deleteSession(session.sessionId);
        onProgress("retry", `角色数不符合要求（${actualCount}人，期望${minTotal}-${maxTotal}人），重新生成...`);
        continue;
      }
      await deleteSession(session.sessionId);
      return { ok: false, error: `经过${MAX_GEN_RETRIES+1}次尝试，剧本角色数仍为 ${actualCount} 人（期望 ${minTotal}-${maxTotal} 人）。请修改需求后重试。`, actualCount, expectedMin: minTotal, expectedMax: maxTotal };
    }

    // 检查通过
    break;
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
