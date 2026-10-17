// Prompt Agent — 理解和优化用户的剧本需求（v3：含故事/NPC/场景结构）

const { generate } = require("../llm/generator");

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

### 进阶风格档位（advancedMode）
- **standard**：标准本格，线索直给、逻辑自洽即可
- **hardcore**：硬核进阶——要求"线索多重指向性"（一条线索含可被推翻的伪证细节）、抗推位均衡、逻辑链更严密、误导可被合理解释排除。用户提到"硬核""烧脑""难""多重解答""线索伪证""杠精""抗推" → hardcore
- **emotional**：情感沉浸——要求情感反转设计（复盘阶段时间差/身世反转/遗书煽情），更重人物情感与结局冲击力。用户提到"情感""感人""哭""反转身世""立意""治愈"（且与推理难度无关）→ emotional
- 用户同时强调推理难度和情感，取 hardcore；两者都不明显 → standard
- 档位必须写入 advancedMode 字段，三选一

### NPC角色定位
- **PVE模式**：NPC是嫌疑人，凶手可能在NPC中
- **PVP模式**：NPC是信息提供者（目击者/关系人/仆人），每个NPC掌握特定时间点的信息，可适当给予嫌疑增加迷惑性
- NPC都拥有一小段剧本（背景、目击信息、秘密）

## 输出纪律
- 直接输出最终 JSON，不要输出推理过程、不要解释、不要多余开场白。
- JSON 必须完整闭合、可被 JSON.parse 解析，不要用 markdown 代码块包裹以外的形式，不要截断。

## 输出格式（JSON）
{
  "title": "剧本暂定名（4-10字，能体现核心内容）",
  "summary": "50字内的故事概要",
  "era": "时代背景(具体到朝代/年代)",
  "location": "主要场景地点（200字描述）",
  "style": "本格/变格/恐怖/悬疑/情感/欢乐/古风/民国/现代",
  "advancedMode": "standard",
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

/** 多策略 JSON 解析：直接 parse → 代码块 → 最外层对象提取 */
function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* 继续尝试 */ }
  let cand = text;
  const fenced = cand.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) cand = fenced[1];
  try { return JSON.parse(cand); } catch (e) { /* 继续 */ }
  const start = cand.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < cand.length; i++) {
      if (cand[i] === "{") depth++;
      else if (cand[i] === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cand.slice(start, i + 1)); } catch (e) { break; }
        }
      }
    }
  }
  return null;
}

async function optimizePrompt(userInput) {
  const prompt = `用户原始需求：${userInput}\n\n请分析并输出优化后的JSON。玩家1-6人，NPC 0-3人，总人数≤9人。PVP模式也可以有NPC作为信息提供者。`;

  // 网络类/DNS 失败（瞬时抖动）自动重试 2 次，避免单次抖动导致整个优化失败
  const isNetErr = (err) => {
    const m = String((err && (err.message || err.code)) || "").toLowerCase();
    return /getaddrinfo|enotfound|econn|refused|network|timeout|socket|dns|fetch failed/i.test(m);
  };

  try {
    let result = null;
    for (let a = 0; a <= 2; a++) {
      try {
        result = await generate(PROMPT_SYSTEM, prompt, { maxTokens: 8192, temperature: 0.4 });
        break;
      } catch (err) {
        if (a < 2 && isNetErr(err)) {
          console.warn(`[prompt-agent] LLM 网络失败(${err.message})，第${a + 1}次重试...`);
          await new Promise(r => setTimeout(r, 1500 * (a + 1)));
          continue;
        }
        throw err;
      }
    }
    const cleaned = String(result.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .replace(/^[^{]*\{/, "{")
      .replace(/\}[^}]*$/, "}");

    const data = tryParseJson(cleaned);
    if (!data) {
      console.warn("[prompt-agent] 解析失败，原始返回长度=", (result.content || "").length, "前800字=", String(result.content || "").substring(0, 800));
      throw new Error("优化结果不是有效JSON");
    }

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

    // 归一化 advancedMode（标准/硬核/情感），并补关键词兜底识别
    if (!["standard", "hardcore", "emotional"].includes(data.advancedMode)) {
      data.advancedMode = detectAdvancedMode(userInput + " " + (data.optimized || "") + " " + (data.summary || ""));
    }

    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: `需求解析失败：${e?.message || "未知错误"}`,
      raw: userInput,
      data: null,
    };
  }
}

/** 关键词兜底：识别用户期望的进阶风格档位 */
function detectAdvancedMode(text) {
  const t = String(text || "");
  const hardcoreWords = ["硬核", "烧脑", "极难", "高难度", "本格推理", "多重解答", "伪证", "抗推", "杠精", "逻辑严密", "很难"];
  const emotionalWords = ["情感", "感人", "催泪", "哭", "立意", "反转身世", "治愈", "亲情", "爱情", "沉浸式情感"];
  const isHard = hardcoreWords.some(w => t.includes(w));
  const isEmo = emotionalWords.some(w => t.includes(w));
  if (isHard) return "hardcore";       // 二者冲突优先硬核
  if (isEmo) return "emotional";
  return "standard";
}

module.exports = { optimizePrompt };
