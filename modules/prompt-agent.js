// Prompt Agent — 理解和优化用户的剧本需求

const { generate } = require("./generator");

const OPTIMIZE_SYSTEM_PROMPT = `你是一个剧本杀需求分析专家。用户会用自然语言描述他们想要的剧本，你需要分析并输出一个结构化的、优化的剧本生成指令。

## 分析维度
1. **故事要素**：时代背景、场景地点、核心事件（死亡方式）
2. **角色要求**：玩家数量、角色关系、特殊角色要求
3. **风格偏好**：恐怖/悬疑/本格/变格/欢乐/情感/民国/古风
4. **特殊需求**：PVE模式、NPC要求、特殊机制等

## 输出格式（JSON）
{
  "title": "为剧本拟一个吸引人的暂定名",
  "optimized": "优化后的完整剧本生成指令（200-500字），包含：明确的时代背景、场景描述、死者信息、角色数量要求、风格要求、所有特殊需求。要用清晰的具体描述代替模糊的表达。",
  "extracted": {
    "era": "时代背景",
    "playerCount": 数字,
    "style": "风格类型",
    "isPVE": true/false,
    "hasSpecificMechanism": "特殊机制描述或空"
  },
  "questions": ["如果信息不足，列出需要用户补充的问题"]
}

## 规则
- playerCount 最多6，如果用户提到的数字超过6，设为6并提示
- 如果用户没指定人数，默认建议4-5人
- 如果用户提到的背景模糊，给出具体建议（如"古代"→建议"明朝嘉靖年间"）
- optimized字段要写得像一个专业的剧本需求文档`;

/**
 * 优化用户输入
 */
async function optimizePrompt(userInput) {
  const prompt = `用户需求：${userInput}\n\n请分析并输出优化后的JSON：`;

  try {
    const result = await generate(OPTIMIZE_SYSTEM_PROMPT, prompt, { maxTokens: 2048, temperature: 0.5 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const parsed = JSON.parse(cleaned);

    // 限制人数
    if (parsed.extracted && parsed.extracted.playerCount > 6) {
      parsed.extracted.playerCount = 6;
      parsed.optimized += "\n\n（注：原始需求超过6人，已自动限制为6人）";
    }

    return { ok: true, data: parsed };
  } catch (e) {
    // 降级：直接返回原始输入作为优化结果
    return {
      ok: true,
      data: {
        title: "未命名剧本",
        optimized: userInput,
        extracted: { era: "", playerCount: 0, style: "", isPVE: false, hasSpecificMechanism: "" },
        questions: [],
      },
    };
  }
}

module.exports = { optimizePrompt };
