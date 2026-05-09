// 剧本杀多阶段生成流水线

const { generate } = require("./generator");
const path = require("path");

// 获取剧本杀模板的 stages
const tplPath = path.join(__dirname, "..", "templates", "murder-mystery.js");
const MURDER_TPL = require(tplPath);
const stages = MURDER_TPL.stages;
const TOKENS_PER_STAGE = 8192;

/**
 * 生成完整剧本杀剧本
 * @param {string} userInput - 用户的需求描述
 * @param {function} onProgress - 进度回调 (stage, message, content)
 * @returns {Promise<{fullScript: string, stages: object}>}
 */
async function buildMurderMystery(userInput, onProgress) {
  const report = {};

  // ========== 阶段 1：故事框架 ==========
  onProgress("framework", "正在设计故事框架、角色和凶手设定...");
  const frameworkPrompt = `请根据以下需求创作剧本杀故事框架：\n\n${userInput}\n\n请按照模板完整输出所有部分，确保故事逻辑严密、凶手手法合理、线索链完整。`;
  const frameworkResult = await generate(stages.framework, frameworkPrompt, { maxTokens: TOKENS_PER_STAGE });
  report.framework = frameworkResult.content;

  // 解析角色名称（调用模型以结构化格式输出）
  onProgress("extract", "正在解析角色列表...");
  const characterNames = await extractCharacterNames(report.framework);
  // 检测每个角色的类型（玩家/NPC）
  const charTypes = {};
  for (const name of characterNames) {
    // 在框架中搜索该角色附近的NPC/玩家标记
    const idx = report.framework.indexOf(name);
    const ctx = idx >= 0 ? report.framework.substring(Math.max(0, idx - 200), Math.min(report.framework.length, idx + 500)) : "";
    charTypes[name] = /【NPC】|NPC嫌疑人/.test(ctx) ? "npc" : "player";
  }

  const playerChars = characterNames.filter(n => charTypes[n] === "player");
  const npcChars = characterNames.filter(n => charTypes[n] === "npc");
  onProgress("characters", `即将撰写 ${playerChars.length} 个玩家剧本 + ${npcChars.length} 个NPC剧本...`);

  const characterScripts = {};
  const allChars = [...playerChars, ...npcChars]; // 先玩家后NPC
  for (let i = 0; i < allChars.length; i++) {
    const name = allChars[i];
    const type = charTypes[name];
    const icon = type === "npc" ? "[NPC]" : "[玩家]";
    onProgress(type === "npc" ? "npc_script" : "player_script",
      `撰写${icon}角色剧本 (${i + 1}/${allChars.length}): ${name}`);
    const charPrompt = stages.characterScript
      .replace("{characterName}", name)
      .replace("{frameworkSummary}", frameworkSummary);
    const result = await generate(
      getCharSystemPrompt(name, report.framework),
      charPrompt,
      { maxTokens: TOKENS_PER_STAGE }
    );
    characterScripts[name] = result.content;
  }
  report.characterScripts = characterScripts;

  // ========== 阶段 3：线索系统 ==========
  onProgress("clues", "正在设计线索系统和证据链...");
  const cluesPrompt = stages.clues.replace("{frameworkSummary}", frameworkSummary);
  const cluesResult = await generate(
    getCluesSystemPrompt(report.framework),
    cluesPrompt,
    { maxTokens: TOKENS_PER_STAGE }
  );
  report.clues = cluesResult.content;

  // ========== 阶段 4：DM 手册 ==========
  onProgress("dmGuide", "正在撰写 DM 完整手册（时间线、真相复盘、结局）...");
  const dmPrompt = stages.dmGuide.replace("{frameworkSummary}", frameworkSummary);
  const dmResult = await generate(
    getDMSystemPrompt(report.framework),
    dmPrompt,
    { maxTokens: TOKENS_PER_STAGE }
  );
  report.dmGuide = dmResult.content;

  // ========== 组装完整剧本 ==========
  onProgress("assemble", "正在组装完整剧本...");
  const fullScript = assembleScript(report, userInput);

  onProgress("done", "剧本杀生成完毕！");
  return { fullScript, stages: report };
}

async function extractCharacterNames(framework) {
  const prompt = `请从以下剧本杀故事框架中提取所有角色姓名，以 JSON 数组格式返回，不要其他内容。

格式示例：["张明", "李芳", "王强", "陈雪", "林峰", "赵雨"]

故事框架：
${framework.substring(0, 6000)}

请只输出 JSON 数组：`;

  try {
    const result = await generate(
      "你是一个数据提取工具。从文本中提取角色姓名，只输出 JSON 数组。",
      prompt,
      { maxTokens: 512, temperature: 0.1 }
    );
    const names = JSON.parse(result.content.trim());
    if (Array.isArray(names) && names.length > 0) {
      return names.filter(n => typeof n === "string" && n.length >= 2 && n.length <= 8).slice(0, 8);
    }
  } catch (e) {
    console.error("角色名提取失败，使用默认值：", e.message);
  }
  return ["角色A", "角色B", "角色C", "角色D", "角色E", "角色F"];
}

function summarizeFramework(framework) {
  // 提取框架关键部分作为各阶段的上下文
  const maxLen = 4000;
  if (framework.length <= maxLen) return framework;

  // 截取关键部分
  const sections = framework.split(/(?=##?\s*[一二三四五六七八九十])/);
  const importantSections = sections.filter(s =>
    /角色|凶手|时间线|死者|设定|关系/.test(s.substring(0, 30))
  );
  const summary = importantSections.join("\n\n");
  return summary.length > maxLen ? summary.substring(0, maxLen) + "\n...(已截断)" : summary;
}

function getCharSystemPrompt(name, framework) {
  // 判断该角色是否为凶手
  let isMurderer = false;
  try {
    isMurderer = framework.includes(name) && (
      framework.includes("凶手" + name) ||
      framework.includes("凶手：" + name) ||
      framework.includes("凶手是" + name) ||
      framework.includes(name + "是凶手") ||
      new RegExp(name + ".{0,5}凶手").test(framework)
    );
  } catch (e) { /* regex fallthrough */ }

  let prompt = "你是剧本杀角色剧本写作专家。现在为 \"" + name + "\" 撰写个人剧本。\n\n";
  if (isMurderer) {
    prompt += "**重要：该角色是凶手。** 需要在剧本中巧妙隐藏作案事实，同时埋下细微的破绽线索。\n";
  }
  prompt += "输出需包含完整的故事背景、秘密、时间线、目标、掌握的信息、物品清单、谎言建议和辩护策略。总字数 2000-4000 字。";
  return prompt;
}

function getCluesSystemPrompt(framework) {
  return `你是剧本杀线索设计专家。确保每条线索都有意义且可以串联成完整证据链。线索要分层次：从公开到深入，从误导到真相。输出 40-50 条线索，分为三轮。`;
}

function getDMSystemPrompt(framework) {
  return `你是剧本杀 DM 手册撰写专家。请输出完整的主持人手册，包括游戏流程、开场白、完整时间线、真相复盘、多种结局和注意事项。需详细严谨，DM 能直接使用。`;
}

function assembleScript(report, userInput) {
  const parts = [];

  parts.push(`# 剧本杀完整剧本\n`);
  parts.push(`> 用户需求：${userInput}\n`);
  parts.push(`> 生成时间：${new Date().toISOString()}\n`);
  parts.push(`---\n`);

  parts.push(`# 第一部分：故事框架\n`);
  parts.push(report.framework);
  parts.push(`\n---\n`);

  parts.push(`# 第二部分：角色个人剧本\n`);
  const names = Object.keys(report.characterScripts);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    parts.push(`## 角色 ${i + 1}：${name}\n`);
    parts.push(report.characterScripts[name]);
    parts.push(`\n`);
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
  parts.push(`- 总字数：约 ${Math.round(totalChars * 0.7).toLocaleString()} 字（含标点和格式标记）\n`);
  parts.push(`- 角色数量：${names.length} 人\n`);
  parts.push(`- 线索总数：约 40-50 条\n`);

  return parts.join("\n");
}

module.exports = { buildMurderMystery };
