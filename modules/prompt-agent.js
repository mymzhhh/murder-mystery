// Prompt Agent — 理解和优化用户的剧本需求（v2：输出结构化剧本属性）

const { generate } = require("./generator");

const PROMPT_SYSTEM = `你是一个剧本杀需求分析专家。你需要分析用户的自然语言需求，输出一个结构化的剧本生成配置。

## 核心规则

### 角色数量约束（不可违反）
- **玩家角色**：2-6人（最少2人，最多6人）
- **NPC嫌疑人**：0-3人
- **总角色数**：≤9人
- 如果用户要求超过限制，自动调整为最接近的合法值

### 游戏模式判断
- **PVE（侦探对抗）**：有NPC嫌疑人参与（1-3个NPC），玩家通过搜证推理找出凶手
- **PVP（玩家互疑）**：所有角色都是玩家（0个NPC），玩家之间互相猜疑
- 用户提到"侦探"、"推理"、"探案"、"NPC"、"嫌疑人"、"对抗" → 倾向PVE
- 用户提到"互相猜"、"各自为战"、"内鬼"、"没有主持人" → 倾向PVP
- 默认根据是否有NPC来判断：有NPC→PVE，无NPC→PVP

### 时代背景
- 识别用户指定的时代：古代(含具体朝代)、民国、现代、未来/科幻、架空
- 如未指定，根据故事风格推断并给出建议

## 输出格式（JSON）
{
  "title": "剧本暂定名",
  "summary": "50字以内的故事概要",
  "era": "时代背景(具体到朝代/年代)",
  "location": "主要场景地点",
  "style": "本格/变格/恐怖/悬疑/情感/欢乐/古风/民国/现代",
  "isPVE": true,
  "gameMode": "PVE",
  "playerCount": 4,
  "npcCount": 2,
  "optimized": "完整的、专业的剧本生成指令（200-400字），必须包含：\\n【游戏模式】PVE侦探对抗 或 PVP玩家互疑\\n【故事背景】具体时代和场景\\n【死者信息】身份和死因\\n【玩家角色】X名玩家角色的设定方向\\n【NPC嫌疑人】Y名NPC的基本设定（PVP模式下写'无'）\\n【核心要求】风格、推理难度、特殊机制\\n【角色总数】明确标注恰好X名玩家+Y名NPC=Z人的总角色数",
  "notes": "补充说明或建议"
}`;

async function optimizePrompt(userInput) {
  const prompt = `用户原始需求：${userInput}\n\n请分析并输出优化后的JSON。严格遵守：玩家2-6人，NPC 0-3人，总人数≤9人。注意判断是PVE还是PVP模式。`;

  try {
    const result = await generate(PROMPT_SYSTEM, prompt, { maxTokens: 2048, temperature: 0.4 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const data = JSON.parse(cleaned);

    // 强制人数约束
    if (data.playerCount > 6) data.playerCount = 6;
    if (data.playerCount < 2) data.playerCount = 4;
    if (data.npcCount > 3) data.npcCount = 3;
    if (data.npcCount < 0) data.npcCount = 0;

    // 推导游戏模式
    if (!data.gameMode) {
      data.gameMode = data.isPVE ? "PVE" : (data.npcCount > 0 ? "PVE" : "PVP");
    }
    if (data.isPVE === undefined || data.isPVE === null) {
      data.isPVE = data.gameMode === "PVE" || data.npcCount > 0;
    }

    // 模式一致性修正
    if (data.gameMode === "PVP" && data.npcCount > 0) {
      data.npcCount = 0;
      data.notes = (data.notes || "") + "（已自动修正：PVP模式下NPC数量设为0）";
    }
    if (data.isPVE && data.npcCount === 0 && data.gameMode === "PVE") {
      data.npcCount = 2;
      data.notes = (data.notes || "") + "（已自动修正：PVE模式下建议至少2个NPC嫌疑人）";
    }

    return { ok: true, data };
  } catch (e) {
    return {
      ok: true,
      data: {
        title: "未命名剧本",
        summary: userInput.substring(0, 50),
        era: "", location: "", style: "本格",
        isPVE: /NPC|侦探|探案|对抗|嫌疑人/.test(userInput),
        gameMode: /NPC|侦探|探案|对抗|嫌疑人/.test(userInput) ? "PVE" : "PVP",
        playerCount: 4,
        npcCount: /NPC|侦探|探案|对抗|嫌疑人/.test(userInput) ? 2 : 0,
        optimized: userInput,
        notes: "优化解析异常，请手动修改需求后重试",
      },
    };
  }
}

module.exports = { optimizePrompt };
