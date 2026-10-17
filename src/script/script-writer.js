// 剧本撰写 Agent — 查重、人数校验、按 prompt-agent 属性生成（v3）

const { buildMurderMystery, LIMITS } = require("./murder-mystery-builder");
const { createSession, addMessage, listSessions, getSession, deleteSession, saveSessionArtifacts } = require("../core/history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("../llm/generator");
const contentGuard = require("../llm/content-guard");

const MIN_PLAYERS = LIMITS.minPlayers;  // 1（单人侦探本）
const MAX_PLAYERS = LIMITS.maxPlayers;  // 6
const MAX_NPC = LIMITS.maxNpc;          // 3
const MAX_TOTAL = LIMITS.maxTotal;      // 9
const MAX_GEN_RETRIES = 2;

/** 剥离代码块围栏后取 JSON（查重/解析通用） */
function extractJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(s); } catch (e) { /* 继续 */ }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.substring(start, end + 1)); } catch (e) { /* 继续 */ }
  }
  return null;
}

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
    } catch (e) { /* skip */ }
  }
  return summaries;
}

/**
 * 查重检测
 */
async function checkDuplication(userInput, existingSummaries) {
  if (existingSummaries.length === 0) return { ok: true };

  const sysPrompt = `你是剧本杀查重专家。检测新需求是否与已有剧本雷同。雷同标准：1) 时代背景+核心动机相同 2) 凶手手法高度相似 3) 死者身份+死因组合重复。只输出JSON：{ "duplicated": true/false, "reason": "重复原因或OK", "similarTo": "相似剧本标题" }`;

  const existText = existingSummaries.map((s, i) =>
    `${i + 1}. 《${s.title}》| ${s.era} | 死者:${s.victim}(${s.causeOfDeath}) | 凶手:${s.murderer} | 动机:${s.motive.substring(0, 100)} | 手法:${s.method.substring(0, 100)}`
  ).join("\n");

  try {
    const result = await generate(sysPrompt, `已有剧本：\n${existText}\n\n新需求：${userInput}\n\n请检测是否存在雷同：`, { maxTokens: 256, temperature: 0.2 });
    const json = extractJson(result.content);
    if (!json) return { ok: true, reason: "查重检测跳过（解析失败）" };
    return { ok: !json.duplicated, reason: json.reason || "", similarTo: json.similarTo || "" };
  } catch (e) {
    return { ok: true, reason: "查重检测跳过（调用失败）" };
  }
}

/**
 * 从用户输入中检测玩家数量（无 config 时的回退逻辑）
 *
 * ⚠️ 实测漏判（本会话）：需求里写「4名玩家 + 1名NPC」时解析返回 0 →
 * 上层静默退回人数上限 6 → 用户要 4 人却拿到 6 人。
 * 根因是分类词只认「人/个/个玩家」，**不认「名」「位」**——而"4名玩家"是中文最常见的写法。
 */
function detectPlayerCount(input) {
  const s = String(input || "");
  // 阿拉伯数字：4名玩家 / 4位玩家 / 4个玩家 / 4玩家 / 4人 / 4人本
  // 分类词可选，后面必须跟"玩家/角色/人/人本"，所以「1名NPC」「1935年」都不会被误计。
  const dm = s.match(/(\d+)\s*(?:名|位|个)?\s*(?:玩家|角色|人本|人)/);
  if (dm) { const n = parseInt(dm[1], 10); if (n >= 1 && n <= 20) return n; }

  const digits = { "一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,"双":2 };
  const cm = s.match(/([一两二三四五六七八九十双]+)\s*(?:名|位|个)?\s*(?:玩家|角色|个人|人本|人)/);
  if (cm) {
    const str = cm[1]; let count = 0;
    if (str === "十") return 10;
    if (str.startsWith("十")) count = 10 + (digits[str[1]] || 0);
    else if (str.endsWith("十")) count = (digits[str[0]] || 0) * 10;
    else count = digits[str] || 0;
    if (count >= 1 && count <= 20) return count;
  }
  return 0;
}

/**
 * 从用户输入中检测 NPC 数量。
 *
 * 为什么需要它：回退路径以前**根本不解析 NPC 数**，一律由 isPVE 决定（PVE→2，否则 0）；
 * 而 isPVE 又只要正文出现「NPC」就算真 —— 于是"4名玩家 + 1名NPC"被变成"6玩家 + 2NPC"。
 * 需求里**明确写了** NPC 数量时，必须用它，不能被模式推断覆盖。
 * @returns {number|null} null = 需求里没写
 */
function detectNpcCount(input) {
  const s = String(input || "");
  const m = s.match(/(\d+)\s*(?:名|位|个|人)?\s*(?:NPC|npc|非玩家角色)/);
  if (m) { const n = parseInt(m[1], 10); if (n >= 0 && n <= 20) return n; }
  const digits = { "一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,"双":2 };
  const cm = s.match(/([一两二三四五六七八九十双]+)\s*(?:名|位|个|人)?\s*(?:NPC|npc|非玩家角色)/);
  if (cm) { const n = digits[cm[1]]; if (n !== undefined && n <= 20) return n; }
  return null;
}

/**
 * 检测是否为PVE模式（玩家是侦探，NPC 是嫌疑人）。
 *
 * ⚠️ 实测误判（本会话）：以前只要正文出现「NPC」就判 PVE ——
 * 但 PVP 本里 NPC 是**目击者/关系人**（实测《灰雾庄园》就是"4名玩家 + 3NPC"的 PVP），
 * 提到 NPC 恰恰是 PVP 的常见写法。改用真正指向 PVE 的词，
 * 并把「PVP/对抗/玩家互疑」这类明确信号作为否定。
 */
function detectPVE(input) {
  const s = String(input || "");
  if (/PVP|玩家对抗|玩家互疑|无NPC|不要NPC/i.test(s)) return false;
  return /PVE|侦探本|侦探|探案|推理者|嫌疑人|调查者/i.test(s);
}

/**
 * 构建角色约束前缀
 */
function buildConstraints(userInput, playerCount, npcCount, isPVE, existingSummaries) {
  const pc = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount || MAX_PLAYERS));
  const nc = Math.max(0, Math.min(MAX_NPC, npcCount ?? 0));
  const npcLabel = isPVE ? "NPC嫌疑人" : (nc > 0 ? "NPC目击者/关系人（非嫌疑人，提供信息）" : "");

  let constraints = `## 【角色数量硬约束 — 必须严格遵守，违者不合格】

1. **玩家角色**：恰好 ${pc} 人（编号 玩家1-玩家${pc}）
2. **NPC角色**：${nc > 0 ? `恰好 ${nc} 人（编号 NPC1-NPC${nc}，角色定位：${npcLabel}）` : '0人'}
3. **总人数**：${pc + nc} 人（不超过 ${MAX_TOTAL} 人）
4. 在"玩家角色设定"${nc > 0 ? '和"NPC角色设定"两个独立章节' : '章节'}中输出
5. 凶手有且仅有一个（可以是玩家${nc > 0 ? '或NPC' : ''}）${!isPVE ? '（PVP模式下通常凶手在玩家中）' : ''}
`;

  if (existingSummaries && existingSummaries.length > 0) {
    constraints += `\n## 创作约束 — 避免雷同
${existingSummaries.map(s => `- 避免：凶手${s.murderer || '?'}的手法 — 《${s.title}》`).join("\n")}
请创作全新的故事，时代背景、作案动机和手法必须有明显差异。
`;
  }

  return constraints + "\n---\n\n## 用户需求\n" + userInput;
}

/**
 * 主入口：撰写剧本
 * @param {string} userInput - 用户需求（原始文本 或 prompt-agent 优化后的文本）
 * @param {function} onProgress - 进度回调
 * @param {object} [scriptConfig] - 可选：prompt-agent 输出的 {playerCount, npcCount, isPVE}
 */
async function writeScript(userInput, onProgress, scriptConfig) {
  // 0. 内容审核 —— 放在最前面，作为所有调用方的统一卡点
  // （路由层也会先拦一次以便返回规范的 400；这里是防止绕过路由直接调用的安全网）
  const verdict = contentGuard.screenGenerationRequest(userInput);
  if (verdict.action === "block") {
    return { ok: false, error: verdict.reason, blocked: true, categories: verdict.categories };
  }
  if (verdict.action === "review") {
    console.warn(`[content-guard] 生成需求需人工复核（${verdict.categories.join(",")}）: ${String(userInput).slice(0, 80)}`);
  }

  // 1. 解析配置：优先使用 scriptConfig（来自 prompt-agent），否则从文本检测
  let playerCount, npcCount, isPVE;

  if (scriptConfig && typeof scriptConfig.playerCount === "number") {
    // 使用 prompt-agent 给出的结构化配置
    playerCount = scriptConfig.playerCount;
    npcCount = scriptConfig.npcCount ?? (scriptConfig.isPVE ? 2 : 0);
    isPVE = scriptConfig.isPVE ?? (npcCount > 0);
  } else {
    // 回退：从文本中检测
    playerCount = detectPlayerCount(userInput);
    const explicitNpc = detectNpcCount(userInput);   // 需求里明确写了 NPC 数就用它
    isPVE = detectPVE(userInput);
    npcCount = explicitNpc !== null ? explicitNpc : null;   // 没写时交给 isPVE 决定
    // 解析不出来时**必须出声音**：以前静默退回人数上限，
    // 用户要 4 人拿到 6 人却没有任何提示（实测"4名玩家"因不认"名"而返回 0）。
    if (!playerCount) {
      const warnMsg = `⚠ 未能从需求中解析出玩家数量，将按上限 ${MAX_PLAYERS} 人生成（需求里请写清"X 名玩家"）`;
      console.warn("[script-writer]", warnMsg);
      if (typeof onProgress === "function") onProgress("check", warnMsg);
    }
    if (explicitNpc !== null && typeof onProgress === "function") {
      onProgress("check", `从需求中读取：${playerCount || MAX_PLAYERS} 名玩家 + ${explicitNpc} 名NPC`);
    }
  }

  // 人数越界检查（在 clamp 之前，明确反馈而不是静默截断）
  if (playerCount !== undefined && playerCount !== null && playerCount !== 0) {
    if (playerCount > MAX_PLAYERS) {
      return { ok: false, error: `玩家数量不能超过 ${MAX_PLAYERS} 人（您要求 ${playerCount} 人）。请调整后重试。` };
    }
    if (playerCount < MIN_PLAYERS) {
      return { ok: false, error: `玩家数量不能少于 ${MIN_PLAYERS} 人（您要求 ${playerCount} 人）。请调整后重试。` };
    }
  }
  if (npcCount !== undefined && npcCount !== null && npcCount > MAX_NPC) {
    return { ok: false, error: `NPC 数量不能超过 ${MAX_NPC} 人（您要求 ${npcCount} 人）。请调整后重试。` };
  }

  // 单人侦探本：强制 PVE 且必须有 NPC（否则玩家无人可审问、游戏无法进行）
  const isSinglePlayer = playerCount === 1 || (playerCount === undefined && /单人|侦探本|1人/.test(String(userInput || "")));
  if (isSinglePlayer) {
    isPVE = true;
    if (npcCount === undefined || npcCount === null || npcCount === 0) npcCount = 3;
  }

  // 约束到合法范围
  playerCount = playerCount > 0 ? Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount)) : MAX_PLAYERS;
  npcCount = Math.max(0, Math.min(MAX_NPC, npcCount ?? (isPVE ? 2 : 0)));

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

  // 3. 构建生成配置
  const genConfig = {
    playerCount,
    npcCount,
    isPVE,
    advancedMode: ["hardcore", "emotional"].includes(scriptConfig?.advancedMode) ? scriptConfig.advancedMode : "standard",
  };
  const enhancedInput = buildConstraints(userInput, playerCount, npcCount, isPVE, existing);

  let result, session, characters;

  for (let attempt = 0; attempt <= MAX_GEN_RETRIES; attempt++) {
    onProgress("init", attempt > 0 ? `第${attempt + 1}次生成（修正角色数量）...` : `正在创建剧本会话（${playerCount}玩家${npcCount > 0 ? ' + ' + npcCount + 'NPC' : ''}）...`);
    session = await createSession({
      textType: "murder-mystery",
      topic: (typeof userInput === "string" ? userInput : "").slice(0, 100),
      templateName: "剧本杀",
      playerCount: String(playerCount),
      npcCount: String(npcCount),
      isPVE: String(isPVE),
    });
    await addMessage(session.sessionId, "user", userInput);

    let genInput = enhancedInput;
    if (attempt > 0) {
      genInput = `!!! 警告：上一次生成因角色数量不符合要求被拒绝。必须严格遵守：\n- 玩家恰好${playerCount}人\n- NPC恰好${npcCount}人\n- 总人数${playerCount + npcCount}人 ≤ ${MAX_TOTAL}人\n请重新生成 !!!\n\n${enhancedInput}`;
    }

    onProgress("generate", "正在多阶段生成剧本...");
    try {
      result = await buildMurderMystery(genInput, (stage, msg) => onProgress(stage, msg), genConfig);
    } catch (e) {
      // 区分错误类型：只有角色数量/结构校验失败才算"校验未通过"；
      // 网络/超时/LLM 错误（socket hang up、ENOTFOUND、timeout 等）是临时故障，
      // 重试文案要如实反映，避免误导用户以为角色数有问题。
      const msg = String((e && e.message) || "").toLowerCase();
      const isValidation = /超限|符合|校验|恰好|expected|超出|不足|invalid|actly/.test(msg);
      const isNetErr = /socket hang up|econn|enotfound|getaddrinfo|timeout|refused|network|aborted|fetch failed|dns/i.test(msg);

      if (attempt < MAX_GEN_RETRIES) {
        await deleteSession(session.sessionId);
        if (isNetErr && !isValidation) {
          onProgress("retry", `第${attempt + 1}次生成因网络故障中断（${e.message}），正在重试...`);
        } else if (isValidation) {
          onProgress("retry", `第${attempt + 1}次生成未通过角色校验（${e.message}），重新生成...`);
        } else {
          onProgress("retry", `第${attempt + 1}次生成失败（${e.message}），正在重试...`);
        }
        continue;
      }
      await deleteSession(session.sessionId);
      return { ok: false, error: `经过${MAX_GEN_RETRIES + 1}次尝试，剧本生成仍失败：${e.message || "未知错误"}` };
    }
    // 产物审核：落库前过一遍，拦住模型被诱导输出的违规内容。
    // 只判 block 级 —— 产物是长文本，review 级规则在长文上噪声太大。
    const outVerdict = contentGuard.screenGeneratedScript(result.fullScript);
    if (outVerdict.action === "block") {
      await deleteSession(session.sessionId);
      console.warn(`[content-guard] 生成产物被拦截（${outVerdict.categories.join(",")}），已丢弃会话 ${session.sessionId}`);
      return { ok: false, error: `${outVerdict.reason}。已丢弃本次生成结果，请调整需求后重试。`, blocked: true, categories: outVerdict.categories };
    }

    // 完整保存剧本（不截尾——截尾会让后续 split/review 读到的剧本缺 DM 真相与结局）
    await addMessage(session.sessionId, "assistant", result.fullScript);

    // 中间产物落盘：推理链（trickDesign）/大纲/交叉校验问题。
    // 此前它们只在内存的 report 里——刷新或进程结束即失，管理端事后无法复核
    // "这稿的诡计为什么这么设计、弱在哪"。这里存第一手副本，切分时随 split 数据一起进 PG。
    // 落盘是附带动作：任何失败都只告警，绝不影响出本。
    try {
      const { buildArtifacts } = require("./artifacts");
      const artifacts = buildArtifacts(result.stages);
      if (artifacts) {
        const saved = await saveSessionArtifacts(session.sessionId, artifacts);
        if (saved) {
          const bytes = Buffer.byteLength(JSON.stringify(artifacts), "utf8");
          console.log(`[writer] 中间产物已落盘：trickDesign=${artifacts.trickDesign ? "有" : "无"} outline=${artifacts.outline ? "有" : "无"} ${(bytes / 1024).toFixed(1)}KB`);
        }
      }
    } catch (e) {
      console.warn("[writer] 中间产物落盘失败（不影响出本）:", e.message);
    }

    // 4. 验证角色数量
    characters = result.characters || [];
    const players = characters.filter(c => c.type === "player");
    const npcs = characters.filter(c => c.type === "npc");

    const valid = players.length === playerCount
      && npcs.length === npcCount
      && (players.length + npcs.length) <= MAX_TOTAL;

    if (!valid) {
      if (attempt < MAX_GEN_RETRIES) {
        await deleteSession(session.sessionId);
        onProgress("retry",
          `角色结构不符合要求（${players.length}玩家+${npcs.length}NPC，期望${playerCount}玩家${npcCount > 0 ? '+' + npcCount + 'NPC' : ''}），重新生成...`);
        continue;
      }
      await deleteSession(session.sessionId);
      return {
        ok: false,
        error: `经过${MAX_GEN_RETRIES + 1}次尝试，角色结构仍不符合要求（当前：${players.length}玩家+${npcs.length}NPC，期望：${playerCount}玩家${npcCount > 0 ? '+' + npcCount + 'NPC' : ''}）。请修改需求后重试。`,
      };
    }

    break;
  }

  return {
    ok: true,
    sessionId: session.sessionId,
    script: result.fullScript,
    config: genConfig,
    summary: {
      // 标题/时代以大纲（锁定后的最终设定）为权威，framework 仅作兜底
      // ——避免"剧本列表显示的标题"与"剧本内部标题"不一致
      title: result.stages?.outline?.title
        || (result.stages?.framework ? (result.stages.framework.match(/剧本名称[：:]\s*《?(.+?)》?/) || [])[1] : null)
        || "未命名",
      characterCount: characters.length,
      playerCount: characters.filter(c => c.type === "player").length,
      npcCount: characters.filter(c => c.type === "npc").length,
      characterNames: characters.map(c => `${c.name}(${c.type})`),
      murderer: characters.find(c => c.isMurderer)?.name || "未知",
      era: result.stages?.outline?.era
        || (result.stages?.framework ? (result.stages.framework.match(/时代背景[：:]\s*(.+)/) || [])[1] : "")
        || "",
    },
  };
}

// 导出三个纯解析函数供单测钉住：
// "4名玩家 + 1名NPC" 曾因不认"名"而返回 0 玩家、并被"正文提到NPC"误判成 PVE，
// 最终把用户要的 4+1 静默变成 6+2 —— 这类回归必须由测试锁死。
module.exports = { writeScript, detectPlayerCount, detectNpcCount, detectPVE };
