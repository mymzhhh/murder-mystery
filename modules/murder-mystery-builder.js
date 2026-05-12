// 剧本杀多阶段生成流水线（v3：动态玩家数2-6、NPC 0-3）

const { generate } = require("./generator");
const path = require("path");

const tplPath = path.join(__dirname, "..", "templates", "murder-mystery.js");
const MURDER_TPL = require(tplPath);
const stages = MURDER_TPL.stages;
const LIMITS = MURDER_TPL.limits || { minPlayers: 2, maxPlayers: 6, maxNpc: 3, maxTotal: 9 };
const TOKENS_PER_STAGE = 10240;  // 4000-6000字中文剧本需要更大token预算

/**
 * 生成完整剧本杀剧本
 * @param {string} userInput - 用户的需求描述
 * @param {function} onProgress - 进度回调 (stage, message)
 * @param {object} [config] - 可选：{playerCount, npcCount, isPVE}
 * @returns {Promise<{fullScript: string, stages: object, characters: Array}>}
 */
async function buildMurderMystery(userInput, onProgress, config) {
  const report = {};
  const cfg = {
    playerCount: config?.playerCount || LIMITS.maxPlayers,
    npcCount: config?.npcCount ?? (config?.isPVE ? 2 : 0),
    isPVE: config?.isPVE ?? (config?.npcCount > 0),
  };
  // 约束到合法范围
  cfg.playerCount = Math.max(LIMITS.minPlayers, Math.min(LIMITS.maxPlayers, cfg.playerCount));
  cfg.npcCount = Math.max(0, Math.min(LIMITS.maxNpc, cfg.npcCount));

  // ========== 阶段 1：故事框架 ==========
  onProgress("framework", `正在设计故事框架（${cfg.playerCount}玩家${cfg.npcCount > 0 ? ' + ' + cfg.npcCount + 'NPC' : ''}）...`);
  const frameworkPrompt = buildFrameworkPrompt(userInput, cfg);
  let frameworkResult;
  try {
    frameworkResult = await generate(stages.framework, frameworkPrompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.75 });
  } catch (e) {
    console.error("[framework] 生成失败:", e.message, e.name, e.status, e.code);
    throw new Error("故事框架生成失败: " + (e.message || "网络超时，请重试"));
  }
  report.framework = frameworkResult.content;

  // ========== 阶段 1.4：提取场景布局 ==========
  onProgress("extract_layout", "正在提取场景布局图...");
  const layout = extractLayout(report.framework);
  report.layout = layout;
  onProgress("extract_layout", layout ? `场景布局提取完成：${layout.rooms?.length || 0}个房间` : "未检测到布局数据");

  // ========== 阶段 1.5：结构化提取角色列表 ==========
  onProgress("extract", "正在解析角色列表（区分玩家/NPC/凶手）...");
  const characters = await extractCharactersStructured(report.framework, cfg);
  let playerChars = characters.filter(c => c.type === "player");
  let npcChars = characters.filter(c => c.type === "npc");

  // 强制按配置截断角色数量（LLM可能生成过多）
  if (playerChars.length > cfg.playerCount) {
    console.warn(`[builder] 玩家角色超限 ${playerChars.length}/${cfg.playerCount}，截断到${cfg.playerCount}`);
    playerChars = playerChars.slice(0, cfg.playerCount);
  }
  if (npcChars.length > cfg.npcCount) {
    console.warn(`[builder] NPC超限 ${npcChars.length}/${cfg.npcCount}，截断到${cfg.npcCount}`);
    npcChars = npcChars.slice(0, cfg.npcCount);
  }

  report.characters = [...playerChars, ...npcChars];

  onProgress("characters", `角色解析完成：${playerChars.length}名玩家 + ${npcChars.length}名NPC（凶手：${characters.find(c => c.isMurderer)?.name || "未知"}）`);

  // ========== 阶段 2：角色内容 ==========
  const characterResults = {};
  const isSolo = cfg.playerCount === 1;

  // 从框架中提取时代背景和死者姓名
  const eraMatch = report.framework.match(/时代背景[：:]\s*(.+?)(?:\n|$)/);
  const locMatch = report.framework.match(/地点场景[：:]\s*(.+?)(?:\n|$)/);
  const victimMatch = report.framework.match(/死者信息[\s\S]*?姓名与身份[：:]\s*(.+?)(?:\n|$)/);
  cfg.era = eraMatch ? eraMatch[1].trim() : "";
  cfg.location = locMatch ? locMatch[1].trim() : "";
  cfg.victim = victimMatch ? victimMatch[1].trim() : "死者";

  for (let i = 0; i < playerChars.length; i++) {
    const ch = playerChars[i];
    const label = isSolo ? "侦探" : "玩家";
    onProgress("player_script", `撰写${label}角色剧本 (${i + 1}/${playerChars.length}): ${ch.name}`);
    if (isSolo) {
      // 单人侦探模式：用专用模板
      const instructions = stages.soloDetectiveInstruction.replace("{characterName}", ch.name);
      const prompt = `请为【侦探角色】撰写调查者剧本。\n\n## 角色基本信息\n- 姓名：${ch.name}\n- 身份：调查者/侦探\n\n## 完整故事框架（供参考）\n${report.framework.substring(0, 5000)}\n\n## 要求\n${instructions}\n\n请直接输出剧本内容。`;
      const systemPrompt = `你是剧本杀写作专家。现在为【调查者】"${ch.name}"撰写侦探剧本。使用第一人称，重点是调查视角和初步线索。`;
      const result = await generate(systemPrompt, prompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 });
      characterResults[ch.name] = result.content;
    } else {
      const prompt = buildCharacterPrompt(ch, report.framework, i + 1, playerChars.length);
      const systemPrompt = buildCharacterSystemPrompt(ch);
      const result = await generate(systemPrompt, prompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 });
      characterResults[ch.name] = result.content;
    }
  }

  for (let i = 0; i < npcChars.length; i++) {
    const ch = npcChars[i];
    onProgress("npc_script", `撰写NPC信息 (${i + 1}/${npcChars.length}): ${ch.name}`);
    const prompt = buildNpcPrompt(ch, report.framework, i + 1, npcChars.length, cfg.isPVE, cfg.npcCount);
    const isWitness = !cfg.isPVE;
    const systemPrompt = buildNpcSystemPrompt(ch, { era: cfg?.era, location: cfg?.location, victim: cfg?.victim }, isWitness);
    // 单人本NPC需要更丰富内容，token加量
    const npcTokens = isSolo ? TOKENS_PER_STAGE * 1.5 : TOKENS_PER_STAGE;
    const result = await generate(systemPrompt, prompt, { maxTokens: Math.floor(npcTokens), temperature: 0.7 });
    characterResults[ch.name] = result.content;
  }
  report.characterScripts = characterResults;

  const frameworkSummary = buildStructuredSummary(report);

  // 注入房间列表到线索/DM 阶段
  const roomNames = (report.layout?.rooms || []).map(r => r.name).join('、');
  const layoutContext = roomNames ? `\n\n## 场景布局（所有线索和行动必须对应以下房间）\n可用房间：${roomNames}\n案发现场：${(report.layout?.rooms || []).filter(r => r.isCrimeScene).map(r => r.name).join('、') || '未指定'}\n` : '';

  // ========== 阶段 3：线索系统 ==========
  onProgress("clues", "正在设计线索系统和证据链...");
  try {
    const cluesPrompt = stages.clues.replace("{frameworkSummary}", frameworkSummary.substring(0, 6000) + layoutContext);
    const cluesResult = await generate(getCluesSystemPrompt(), cluesPrompt, { maxTokens: 6144 });
    report.clues = cluesResult.content;
  } catch (e) {
    console.error("[clues] 生成失败:", e.message, e.name, e.status);
    throw new Error("线索系统生成失败: " + (e.message || "未知错误"));
  }

  // ========== 阶段 4：DM 手册 ==========
  onProgress("dmGuide", "正在撰写DM完整手册（时间线、真相复盘、结局）...");
  try {
    const dmPrompt = stages.dmGuide.replace("{frameworkSummary}", frameworkSummary.substring(0, 6000) + layoutContext);
    const dmResult = await generate(getDMSystemPrompt(), dmPrompt, { maxTokens: 6144 });
    report.dmGuide = dmResult.content;
  } catch (e) {
    console.error("[dmGuide] 生成失败:", e.message, e.name, e.status);
    throw new Error("DM手册生成失败: " + (e.message || "未知错误"));
  }

  // ========== 组装 ==========
  onProgress("assemble", "正在组装完整剧本...");
  const fullScript = assembleScript(report, userInput);

  onProgress("done", `剧本生成完毕：${playerChars.length}名玩家 + ${npcChars.length}名NPC`);
  return { fullScript, stages: report, characters };
}

// ==================== 框架 Prompt 构建 ====================

function buildFrameworkPrompt(userInput, cfg) {
  const { playerCount, npcCount, isPVE } = cfg;

  const npcLabel = isPVE ? "NPC嫌疑人" : (npcCount > 0 ? "NPC目击者/关系人" : "");
  const npcline = npcCount > 0 ? `+ ${npcCount}名${npcLabel}` : "";
  const npcConstraint = npcCount > 0
    ? `NPC角色恰好${npcCount}人（${npcLabel}），编号NPC1-NPC${npcCount}`
    : "无NPC（纯PVP玩家互疑）";

  // NPC章节（简洁列表，详细剧本在后续阶段单独生成）
  const npcSection = npcCount > 0
    ? `（${npcCount}人，${npcLabel}）\n用表格列出每个NPC的：编号、姓名、性别、年龄、职业/身份、与死者的关系、角色定位（${npcLabel}）、掌握的信息类型（目击什么/知道什么）。不需要展开详写，后续阶段会为每个NPC单独生成完整剧本。`
    : "（本次无NPC）";

  const murdererSection = "\n\n## ";
  const timelineSection = npcCount > 0 ? "六" : "五";

  const totalChars = playerCount + npcCount + 1; // 玩家+NPC+死者（1人）
  const minRooms = totalChars + 2; // 至少2个公共区域
  const maxRooms = Math.min(totalChars + 5, 14);

  return `【角色数量约束 — 必须严格遵守】
玩家角色：恰好${playerCount}人
${npcConstraint}
游戏模式：${isPVE ? 'PVE侦探对抗' : 'PVP玩家互疑'}
总人数：${playerCount + npcCount}人（不超过${LIMITS.maxTotal}人）

【房间数量约束】
专属房间：${totalChars}个（${playerCount}玩家 + ${npcCount}NPC + 1死者）
公共区域：2-3个（如大厅、厨房、前院等，不包括走廊/过道/楼梯间）
总房间数：${minRooms}-${maxRooms}个

【用户需求】
${userInput}`;
}

// ==================== 结构化角色提取 ====================

function extractLayout(framework) {
  try {
    // 新格式：{floors: [{level, label, rooms: [...]}]}
    const floorsMatch = framework.match(/\{\s*"floors"\s*:\s*\[[\s\S]*?\}\s*\]\s*\}/);
    if (floorsMatch) {
      const data = JSON.parse(floorsMatch[0]);
      if (data.floors) return normalizeLayout(data);
    }
    // 旧格式兼容：{rooms: [...]}
    const roomsMatch = framework.match(/\{\s*"rooms"\s*:\s*\[[\s\S]*?\}\s*\]\s*\}/);
    if (roomsMatch) {
      const data = JSON.parse(roomsMatch[0]);
      if (data.rooms) return { floors: [{ level: 1, label: "一层", rooms: data.rooms.slice(0, 14) }] };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// 规范化：确保所有房间有id
function normalizeLayout(data) {
  var idx = 1;
  (data.floors || []).forEach(function(f) {
    (f.rooms || []).forEach(function(r) {
      if (!r.id) r.id = 'R' + (idx++);
      else idx = Math.max(idx, parseInt(r.id.substring(1)) || 0);
    });
  });
  return data;
}

async function extractCharactersStructured(framework, cfg) {
  const minExpected = cfg.playerCount || LIMITS.minPlayers;

  const prompt = `请从以下剧本杀故事框架中提取所有角色的结构化信息。以 JSON 格式返回，不要其他内容。

格式要求：
[
  {
    "name": "角色姓名",
    "type": "player 或 npc",
    "isMurderer": true或false,
    "occupation": "职业/身份"
  }
]

规则：
1. 必须提取框架中出现的**每一个**角色（包括玩家和NPC），一个都不能漏
2. 【玩家】角色 type = "player"，位于"玩家角色设定"章节
3. 【NPC嫌疑人】角色 type = "npc"，位于"NPC角色列表"章节（无此章节则全部为player）
4. 凶手有且仅有一个，isMurderer = true
5. 按玩家先、NPC后的顺序排列

故事框架：
${framework.substring(0, 8000)}

请提取所有角色，只输出 JSON 数组：`;

  try {
    const result = await generate(
      "你是一个数据提取工具。从剧本框架中提取角色信息，只输出 JSON 数组。",
      prompt,
      { maxTokens: 1024, temperature: 0.1 }
    );
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{[]*\[/, "[").replace(/\][^}\]]*$/, "]");

    const chars = JSON.parse(cleaned);
    if (Array.isArray(chars) && chars.length >= 2) {
      return chars.map(c => ({
        name: String(c.name || "").trim(),
        type: c.type === "npc" ? "npc" : "player",
        isMurderer: Boolean(c.isMurderer),
        occupation: String(c.occupation || "").trim(),
      })).filter(c => c.name.length >= 2 && c.name.length <= 8);
    }
  } catch (e) {
    console.error("结构化角色提取失败，回退到传统方法：", e.message);
  }

  return extractCharactersFallback(framework, minExpected);
}

function extractCharactersFallback(framework, minExpected) {
  minExpected = minExpected || LIMITS.minPlayers;
  const chars = [];

  const playerPattern = /(?:玩家\d|玩家[一二三四五六])[：:]\s*(.{2,6})/g;
  let m;
  while ((m = playerPattern.exec(framework)) !== null) {
    const name = m[1].trim().replace(/[【\[].*$/, "");
    if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "player", isMurderer: false, occupation: "" });
    }
  }

  const npcPattern = /(?:NPC\d|NPC嫌疑人|NPC\s*\d)[：:\s]+(.{2,6})/g;
  while ((m = npcPattern.exec(framework)) !== null) {
    const name = m[1].trim().replace(/[【\[].*$/g, "").replace(/\s*\[.*$/, "");
    if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
    }
  }

  // 补充：从NPC嫌疑人章节提取 - **姓名**：xxx 格式
  const npcSection = (framework.match(/NPC嫌疑人设定[\s\S]*?(?=凶手设定|##\s*[五六七八九]、|重要约束)/) || [])[0] || "";
  if (npcSection && chars.filter(c => c.type === "npc").length === 0) {
    const namePattern = /\*\*姓名\*\*[：:]\s*(.{2,6})/g;
    let nm;
    while ((nm = namePattern.exec(npcSection)) !== null) {
      const name = nm[1].trim();
      if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
        chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
      }
    }
  }

  if (chars.length < minExpected) {
    const genericPattern = /(?:###\s+)?角色[一二三四五六七八\d]+[：:]\s*(.{2,6})/g;
    while ((m = genericPattern.exec(framework)) !== null) {
      const name = m[1].trim().replace(/[【\[].*$/, "");
      if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
        const isNpc = /NPC/.test(framework.substring(Math.max(0, m.index - 100), m.index + 200));
        chars.push({ name, type: isNpc ? "npc" : "player", isMurderer: false, occupation: "" });
      }
    }
  }

  // 不够 minExpected 时补齐占位
  while (chars.length < minExpected) {
    chars.push({ name: `角色${chars.length + 1}`, type: "player", isMurderer: false, occupation: "" });
  }

  const murdererRegex = /凶手[姓名]*[：:]\s*(.{2,6})/;
  const murMatch = framework.match(murdererRegex);
  if (murMatch) {
    const murName = murMatch[1].trim();
    const found = chars.find(c => c.name === murName || murName.includes(c.name) || c.name.includes(murName));
    if (found) found.isMurderer = true;
  }

  return chars.slice(0, LIMITS.maxTotal);
}

// ==================== Prompt 构建 ====================

function buildCharacterPrompt(ch, framework, index, total) {
  const instructions = stages.playerInstruction
    .replace("{characterName}", ch.name)
    .replace("{isMurdererExtra}", ch.isMurderer
      ? `### 七、作案过程
以下是事件发生时你实际所做的一切。详细记录你从策划到实施、再到善后的每一步行动。包括：具体的作案手法、使用的工具、制造不在场证明的方式、以及你可能留下的痕迹。用第一人称如实叙述，不掺杂任何自我评价或掩饰建议。`
      : "");

  return `请为【玩家${index}/${total}】角色撰写完整个人剧本。

## 角色基本信息
- 姓名：${ch.name}
- 身份：${ch.occupation || "详见框架"}
- 是否是凶手：${ch.isMurderer ? "是" : "否"}

## 完整故事框架（供参考，确保一致性）
${framework.substring(0, 6000)}

## 要求
${instructions}

请直接输出角色剧本内容，不需要 JSON 包装。`;
}

function extractNpcRelevantSection(framework, npcName) {
  const parts = [];
  // 死者信息单独提取（每个NPC必须围绕同一死者）
  const victimSection = framework.match(/##\s*二、\s*死者信息[\s\S]*?(?=##\s*[三四五六七八九]、|$)/);
  if (victimSection) {
    parts.push('## 【核心】死者信息（所有NPC必须与此死者相关）\n' + victimSection[0].substring(0, 1500));
  }
  // 基本设定+时代背景（前2000字）
  parts.push('## 时代背景与场景\n' + framework.substring(0, 2000));

  // NPC嫌疑人设定章节
  const npcChapter = framework.match(/##\s*[四五六]、\s*NPC嫌疑人设定[\s\S]*?(?=##\s*[五六七八]、|\n## 重要约束|$)/);
  if (npcChapter) {
    // 提取与该NPC相关的具体条目
    parts.push('## NPC嫌疑人章节\n' + npcChapter[0].substring(0, 2500));
  }

  // 凶手设定章节
  const murdererChapter = framework.match(/##\s*[五六]、\s*凶手设定[\s\S]*?(?=##\s*[六七八]、|\n## 重要约束|$)/);
  if (murdererChapter) parts.push(murdererChapter[0].substring(0, 2000));

  // 时间线中提及该NPC的段落
  const timelineChapter = framework.match(/##\s*[六七八]、\s*故事时间线[\s\S]*?(?=##\s*[七八九]、|\n## 重要约束|$)/);
  if (timelineChapter) {
    const lines = timelineChapter[0].split('\n');
    const relevantLines = lines.filter(l => l.includes(npcName));
    if (relevantLines.length > 0) {
      parts.push('## 时间线（' + npcName + '相关行）\n' + relevantLines.join('\n'));
    } else {
      parts.push('## 故事时间线（完整）\n' + timelineChapter[0].substring(0, 1500));
    }
  }

  // 角色关系图
  const relationChapter = framework.match(/##\s*[七八九]、\s*角色关系图[\s\S]*?(?=##\s*[八九十]、|\n## 重要约束|$)/);
  if (relationChapter) parts.push(relationChapter[0].substring(0, 2000));

  return parts.join('\n\n').substring(0, 8000);
}

function buildNpcPrompt(ch, framework, index, total, isPVE, npcCount) {
  // 提取与NPC相关的框架段落
  const npcSection = extractNpcRelevantSection(framework, ch.name);
  // PVP模式下NPC用目击者模板，PVE用嫌疑人模板
  const npcTemplate = (!isPVE && npcCount > 0) ? stages.npcWitnessInstruction : stages.npcInstruction;
  const isWitness = !isPVE;
  const instructions = npcTemplate
    .replace("{characterName}", ch.name)
    .replace("{isMurdererExtra}", ch.isMurderer
      ? `### ${isWitness ? '六' : '六'}、完整的作案过程（800-1200字，仅供DM掌握）
该NPC是凶手。详细描述完整的谋杀经过：
- 作案的时间、地点、使用的工具和方法
- 从策划到实施的每一个步骤
- 如何伪造不在场证明、如何处理证据
- 作案中出现的意外情况及其应对
- 留下的破绽（必须与线索系统中的具体线索对应）
- 案发后的伪装策略和心理状态
此节仅供DM掌握真相，不会被玩家直接看到。`
      : "");

  return `请为【NPC嫌疑人${index}/${total}】撰写详尽角色信息。

## NPC基本信息
- 姓名：${ch.name}
- 身份：${ch.occupation || "详见框架"}
- 是否是凶手：${ch.isMurderer ? "是（凶手是NPC！）" : "否"}

## 与该NPC相关的故事段落（必须基于此信息撰写）
${npcSection}

## 要求
${instructions}

严格约束：生成的内容必须与上述故事段落一致，不要编造与框架冲突的信息。

请直接输出NPC信息内容，不需要 JSON 包装。`;
}

function buildCharacterSystemPrompt(ch) {
  return ch.isMurderer
    ? `你是剧本杀角色剧本作家。为【玩家角色 — 凶手】"${ch.name}"撰写4000-6000字的深度个人剧本。使用第一人称纯叙事——只陈述角色的故事、经历和事实，不包含任何"你应该怎样玩"的指导。让扮演者基于故事自主决定如何行动。凶手角色的作案细节自然融入时间线和故事中，作为客观事实呈现。`
    : `你是剧本杀角色剧本作家。为【玩家角色】"${ch.name}"撰写4000-6000字的深度个人剧本。使用第一人称纯叙事——只讲述角色的完整人生故事，刻画性格、经历和人际关系。不包含任何策略建议或玩法指导，由玩家自行判断和决策。`;
}

function buildNpcSystemPrompt(ch, setting, isWitness) {
  const era = setting?.era || "";
  const location = setting?.location || "";
  const victimName = setting?.victim || "死者";
  const settingContext = `故事发生在${era}的${location}。死者是${victimName}。`;

  if (isWitness) {
    return `你是剧本杀角色剧本作家。${settingContext}为【NPC目击者/关系人】"${ch.name}"撰写一份1500-2500字的角色档案。该NPC不是凶手，但他的目击信息和个人秘密让他显得可疑。重点写他看到了什么、听到了什么，以及有什么个人秘密使他表现紧张。**所有内容必须围绕死者${victimName}展开。** 时代背景${era}。`;
  }

  return ch.isMurderer
    ? `你是剧本杀角色剧本作家。${settingContext}为【NPC嫌疑人 — 凶手】"${ch.name}"撰写一份3000-4000字的详尽角色档案（第三人称纯叙事）。必须严格遵循下方模板中的结构（一至六），逐一详细填写。作案过程必须写明具体手法、时间、地点和留下的破绽。**所有内容必须围绕死者${victimName}展开。** 内容必须与${era}的时代背景一致。`
    : `你是剧本杀角色剧本作家。${settingContext}为【NPC嫌疑人】"${ch.name}"撰写一份3000-4000字的详尽角色档案（第三人称纯叙事）。必须严格遵循下方模板中的结构（一至五），逐一详细填写。包含充分的作案动机、完整时间线和秘密，使其成为有说服力的嫌疑人。**所有内容必须围绕死者${victimName}展开。** 内容必须与${era}的时代背景一致。`;
}

function getCluesSystemPrompt() {
  return `你是剧本杀线索设计专家。确保每条线索都有意义且可以串联成完整证据链。线索要分层次：从公开到深入，从误导到真相。输出40-50条线索，分为三轮。`;
}

function getDMSystemPrompt() {
  return `你是剧本杀DM手册撰写专家。请输出完整的主持人手册，包括游戏流程、开场白、完整时间线、真相复盘、多种结局和注意事项。需详细严谨，DM能直接使用。`;
}

// ==================== 摘要与组装 ====================

function buildStructuredSummary(report) {
  const chars = report.characters || [];
  const players = chars.filter(c => c.type === "player");
  const npcs = chars.filter(c => c.type === "npc");
  const murderer = chars.find(c => c.isMurderer);

  let summary = "## 角色结构摘要\n\n";
  summary += `### 玩家角色（${players.length}人）\n`;
  players.forEach((c, i) => {
    summary += `- 玩家${i + 1}：${c.name}（${c.occupation || "待定"}）${c.isMurderer ? "【凶手】" : ""}\n`;
  });

  if (npcs.length > 0) {
    summary += `\n### NPC嫌疑人（${npcs.length}人）\n`;
    npcs.forEach((c, i) => {
      summary += `- NPC${i + 1}：${c.name}（${c.occupation || "待定"}）${c.isMurderer ? "【凶手】" : ""}\n`;
    });
  } else {
    summary += `\n### NPC嫌疑人\n（无 — PVP模式）\n`;
  }

  summary += `\n### 凶手\n- 凶手：${murderer?.name || "未知"}（${murderer?.type === "npc" ? "NPC嫌疑人" : "玩家"}）\n\n`;

  const fw = report.framework || "";
  const importantSections = [];
  const sectionPatterns = [
    /(?:##\s*[一二三四五六七八九十]、[^\n]+)[\s\S]*?(?=##\s*[一二三四五六七八九十]、|$)/g,
  ];

  for (const pattern of sectionPatterns) {
    let match;
    while ((match = pattern.exec(fw)) !== null) {
      const section = match[0];
      if (/(?:死者|凶手|时间线|关系)/.test(section.substring(0, 30))) {
        importantSections.push(section.substring(0, 1500));
      }
    }
  }

  const extra = importantSections.length > 0
    ? importantSections.join("\n\n")
    : fw.substring(0, 3000);

  return summary + "\n## 框架关键信息\n\n" + extra;
}

function assembleScript(report, userInput) {
  const parts = [];
  const chars = report.characters || [];
  const players = chars.filter(c => c.type === "player");
  const npcs = chars.filter(c => c.type === "npc");

  parts.push(`# 剧本杀完整剧本\n`);
  parts.push(`> 生成时间：${new Date().toISOString()}\n`);
  parts.push(`> 角色结构：${players.length}名玩家 + ${npcs.length}名NPC\n`);
  parts.push(`---\n`);

  parts.push(`# 第一部分：故事框架\n`);
  parts.push(report.framework);
  parts.push(`\n---\n`);

  parts.push(`# 第二部分：角色内容\n`);
  parts.push(`## 玩家角色剧本\n\n`);
  for (let i = 0; i < players.length; i++) {
    const name = players[i].name;
    const tag = players[i].isMurderer ? " [凶手]" : "";
    parts.push(`### 玩家角色 ${i + 1}：${name}${tag}\n`);
    parts.push(report.characterScripts[name] || "(内容缺失)");
    parts.push(`\n`);
  }

  if (npcs.length > 0) {
    parts.push(`---\n`);
    parts.push(`## NPC嫌疑人信息\n\n`);
    for (let i = 0; i < npcs.length; i++) {
      const name = npcs[i].name;
      const tag = npcs[i].isMurderer ? " [凶手]" : "";
      parts.push(`### NPC ${i + 1}：${name}${tag}\n`);
      parts.push(report.characterScripts[name] || "(内容缺失)");
      parts.push(`\n`);
    }
  }

  parts.push(`---\n`);
  parts.push(`# 第三部分：线索系统\n`);
  parts.push(report.clues);
  parts.push(`\n---\n`);

  parts.push(`# 第四部分：DM 手册\n`);
  parts.push(report.dmGuide);
  parts.push(`\n---\n`);

  parts.push(`\n# 剧本统计\n`);
  const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
  parts.push(`- 总字数：约 ${Math.round(totalChars * 0.7).toLocaleString()} 字\n`);
  parts.push(`- 玩家角色：${players.length} 人\n`);
  parts.push(`- NPC嫌疑人：${npcs.length} 人\n`);
  parts.push(`- 线索总数：约 40-50 条\n`);

  return parts.join("\n");
}

module.exports = { buildMurderMystery, LIMITS };
