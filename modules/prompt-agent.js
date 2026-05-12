// Prompt Agent — 理解和优化用户的剧本需求（v3：含故事/NPC/场景结构）

const { generate } = require("./generator");

const PROMPT_SYSTEM = `你是一个剧本杀需求分析专家。你需要分析用户的自然语言需求，输出结构化的剧本生成配置。

## 核心规则

### 角色数量约束
- **玩家角色**：1-6人（1人为单人侦探本）
- **NPC**：0-3人
- **总角色数**：≤9人

### 游戏模式判断
- **PVE（侦探对抗）**：NPC作为嫌疑人，玩家搜证+审讯找出真凶
- **PVP（玩家互疑）**：玩家之间互相猜疑。NPC可选，作为提供信息的工具人（见证者/关系人），增加推理复杂度
- 用户提到"侦探"、"推理"、"探案"、"嫌疑人" → 倾向PVE
- 用户提到"互相猜"、"各自为战"、"内鬼" → 倾向PVP
- **PVP模式也可以有NPC**：NPC不是嫌疑人，而是目击者、亲友、仆人等，玩家可审问获取线索

### NPC角色定位
- **PVE模式**：NPC是嫌疑人，凶手可能在NPC中
- **PVP模式**：NPC是信息提供者（目击者/关系人/仆人），每个NPC掌握特定时间点的信息，可适当给予嫌疑增加迷惑性
- NPC都拥有一小段剧本（背景、目击信息、秘密）

## 输出格式（JSON）
{
  "title": "剧本暂定名（4-10字，能体现核心内容）",
  "summary": "50字内的故事概要",
  "era": "时代背景(具体到朝代/年代)",
  "location": "主要场景地点（200字描述）",
  "style": "本格/变格/恐怖/悬疑/情感/欢乐/古风/民国/现代",
  "isPVE": true,
  "gameMode": "PVE",
  "playerCount": 4,
  "npcCount": 2,
  "npcRole": "嫌疑人或目击者/关系人",
  "storyBackground": "故事大背景（100-150字）：时代局势、社会氛围、核心矛盾",
  "victimInfo": "死者：姓名、身份、死因、死亡地点（100字）",
  "playerBrief": "玩家角色的设定方向（50-100字）：身份、与死者的关系类型",
  "npcBrief": "NPC的设定方向（50-100字）：身份、角色定位（嫌疑人/目击者/关系人）、掌握的独特信息",
  "optimized": "完整的剧本生成指令（200-400字），必须包含：\\n【游戏模式】PVE/PVP\\n【故事背景】时代+场景+氛围\\n【死者信息】身份和死因\\n【玩家角色】X名玩家+设定方向\\n【NPC角色】Y名NPC+角色定位（信息提供者/嫌疑人）\\n【核心要求】风格、推理难度、特殊机制",
  "notes": "补充说明"
}`;

async function optimizePrompt(userInput) {
  const prompt = `用户原始需求：${userInput}\n\n请分析并输出优化后的JSON。玩家1-6人，NPC 0-3人，总人数≤9人。PVP模式也可以有NPC作为信息提供者。`;

  try {
    const result = await generate(PROMPT_SYSTEM, prompt, { maxTokens: 2048, temperature: 0.4 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const data = JSON.parse(cleaned);

    // 强制人数约束
    if (data.playerCount > 6) data.playerCount = 6;
    if (data.playerCount < 1) data.playerCount = 4;
    if (data.npcCount > 3) data.npcCount = 3;
    if (data.npcCount < 0) data.npcCount = 0;

    // 推导游戏模式
    if (!data.gameMode) {
      data.gameMode = data.isPVE ? "PVE" : "PVP";
    }
    if (data.isPVE === undefined || data.isPVE === null) {
      data.isPVE = data.gameMode === "PVE";
    }

    // PVP模式允许NPC（作为目击者/信息提供者），不再强制清零
    if (!data.npcRole) {
      data.npcRole = data.gameMode === "PVE" ? "嫌疑人" : (data.npcCount > 0 ? "目击者/关系人" : "无");
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
        npcRole: /NPC|侦探|探案|对抗|嫌疑人/.test(userInput) ? "嫌疑人" : "无",
        storyBackground: "", victimInfo: "", playerBrief: "", npcBrief: "",
        optimized: userInput,
        notes: "优化解析异常，请手动修改需求后重试",
      },
    };
  }
}

module.exports = { optimizePrompt };
