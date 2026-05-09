// Prompt Agent — 理解和优化用户的剧本需求

const { generate } = require("./generator");

const PROMPT_SYSTEM = `你是一个剧本杀需求分析专家。你需要分析用户的自然语言需求，输出一个结构化的、详细的剧本生成指令。

## 硬性约束（不可违反）
- 玩家角色：1-6人
- NPC嫌疑人：0-3人
- 总角色数：≤9人
- 如果用户要求超过限制，自动调整并说明

## 输出格式（JSON）
{
  "title": "剧本暂定名",
  "summary": "50字以内的故事概要",
  "era": "时代背景(具体到朝代/年代)",
  "location": "主要场景地点",
  "style": "本格/变格/恐怖/悬疑/情感/欢乐/古风/民国/现代",
  "playerCount": 4,
  "npcCount": 2,
  "optimized": "完整的、专业的剧本生成指令（200-400字），必须包含：\n【故事背景】具体时代和场景\n【死者信息】身份和死因\n【玩家角色】X名玩家角色的设定方向\n【NPC嫌疑人】Y名NPC的基本设定\n【核心要求】风格、推理难度、特殊机制\n【角色总数】明确标注恰好X名玩家+Y名NPC=Z人的总角色数",
  "notes": "补充说明或建议"
}`;

async function optimizePrompt(userInput) {
  const prompt = `用户原始需求：${userInput}\n\n请分析并输出优化后的JSON。严格按照约束：玩家≤6人，NPC≤3人。`;

  try {
    const result = await generate(PROMPT_SYSTEM, prompt, { maxTokens: 2048, temperature: 0.4 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const data = JSON.parse(cleaned);

    // 强制人数约束
    if (data.playerCount > 6) data.playerCount = 6;
    if (data.npcCount > 3) data.npcCount = 3;
    if (data.playerCount < 1) data.playerCount = 4;

    return { ok: true, data };
  } catch (e) {
    return {
      ok: true,
      data: {
        title: "未命名剧本",
        summary: userInput.substring(0, 50),
        era: "", location: "", style: "本格",
        playerCount: 4, npcCount: 2,
        optimized: userInput,
        notes: "优化解析异常，请手动修改需求后重试",
      },
    };
  }
}

module.exports = { optimizePrompt };
