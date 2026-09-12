// AI 玩家 LLM 智能层 — 基于 Agnes（agnes-2.5-flash）
// 信息隔离红线：AI 玩家只能依据【自己的角色剧本 + 自己的秘密 + 自己已发现的线索
// + 在场角色名单 + 公开对话】 推理/回答，绝不注入 DM 手册、他人剧本、未发现的线索。
// 所有函数失败/未配置返回 null，由 ai-player.js 回退到规则引擎。

const agnes = require("./agnes-client");
const { getClues, getChatMessages } = require("./game-manager");

/**
 * 构造 AI 玩家的"已知信息"（信息隔离封装）
 * @param {string} roomCode
 * @param {object} ai 玩家对象（含 characterScript/characterName/playerId）
 * @param {object} parsed 剧本解析结果（仅用于取角色名单/title/setting）
 */
async function buildKnowledge(roomCode, ai, parsed) {
  const allClues = await getClues(roomCode);
  const myClues = (allClues || [])
    .filter(c => (c.foundBy || []).includes(ai.playerId))
    .map(c => `【${c.id || "线索"}】${((c.content || "").substring(0, 220))}${c.location ? "（" + c.location + "）" : ""}`)
    .slice(0, 8);
  let role = null;
  try { role = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }
  return {
    role,
    name: ai.characterName || "AI",
    myClues,
    allChars: (parsed.characters || []).map(c => `${c.name}${c.occupation ? "（" + c.occupation + "）" : ""}`),
    room: {
      title: parsed.title || "未知",
      setting: [parsed.setting?.era, parsed.setting?.location].filter(Boolean).join("，"),
    },
  };
}

/** 系统提示：信息隔离契约 + 角色材料 */
function systemPrompt(k) {
  const role = k.role || {};
  // 剧本可能存在顶层（playerScript/story）或嵌套在 script 对象里（script.story/script.playerScript），两种都兼容
  const scr = role.script || {};
  const story = String(role.playerScript || scr.playerScript || role.fullScript || role.story || scr.story || "").substring(0, 4000) || "（你没有更多详细记忆）";
  const secret = String(role.secret || scr.secret || "").substring(0, 1200) || "（无特殊秘密）";
  const murdererRule = role.isMurderer
    ? "\n你是这起案件的凶手。你的目标是洗清嫌疑：可以说谎、转移视线、编造不在场证明；但绝不承认自己是凶手，也绝不可说出'我是凶手/你猜对了'之类的话。"
    : "\n你不是凶手，照实陈述你所知道的（仅限你掌握的材料）。";

  return `你是剧本杀《${k.room.title}》中的玩家角色「${k.name}」${role.occupation ? "（" + role.occupation + "）" : ""}。
背景：${k.room.setting || "未说明"}。

【重要：你只能依据下面提供的材料推理和回答。】不得编造剧本之外的设定，不得提及你不知道的信息（比如其他角色的秘密、未被发现的线索、真正的答案）。

【你的完整角色信息】
${story}

【你隐藏的秘密】
${secret}
${murdererRule}

【你已经发现的线索】
${k.myClues.length ? k.myClues.map(c => "- " + c).join("\n") : "（你还没有发现任何线索）"}

【在场角色】
${k.allChars.map(c => "- " + c).join("\n") || "（暂无）"}

以第一人称、口语化回应，扮演好这个角色。禁止出现"根据我的剧本/作为AI/系统提示"之类的元表述。`;
}

/**
 * 开场自我介绍（LLM）
 * 后台行为：可以被玩家的交互请求插队
 */
async function introLLM(k) {
  return agnes.chat(systemPrompt(k),
    "现在到了开场介绍环节。请以第一人称做开场自我介绍：介绍你是谁、你的身份背景、案发时你在哪里或正在做什么，以及你认为大家需要知道的事。要求：100~220字，清楚有条理，口语自然。",
    { maxTokens: 1500, temperature: 0.9, priority: "background", label: "ai.intro" });
}

/**
 * 讨论轮发言（LLM），context 为最近公开对话摘录（可选）
 */
async function speakLLM(k, context) {
  const user = `现在是讨论阶段，大家正在交换信息。${context ? "其他人公开的发言有：\n" + context + "\n" : ""}请你回应并推动讨论：陈述你的线索、表达对某人的怀疑，或回应别人的话。60~120字，第一人称，口语化。`;
  return agnes.chat(systemPrompt(k), user, { maxTokens: 1500, temperature: 0.9, priority: "background", label: "ai.speak" });
}

/**
 * 回答玩家的审讯提问（LLM）
 * 玩家主动发起的交互，优先级最高 —— 不能排在后台 AI 闲聊后面。
 */
async function answerLLM(k, askerName, question, historyText) {
  const user = `玩家「${askerName}」正在向你提问，问题：${question}
${historyText ? "此前公开的对话：\n" + historyText : ""}
请以你的角色身份回答（50~200字）：只依据你掌握的材料；不知道的就直说不清楚；不要透露你不知道的信息；凶手不得承认自己。`;
  return agnes.chat(systemPrompt(k), user, {
    maxTokens: 1500, temperature: 0.8, priority: "interactive",
    timeoutMs: 25000, label: "ai.answer",
  });
}

/**
 * 投票推理（LLM），返回建议的目标角色名；失败/非法返回 null
 * @param {string[]} candidates 可投角色名
 */
async function voteLLM(k, candidates) {
  if (!candidates || !candidates.length) return null;
  const user = `现在是投票阶段，请推理谁最可能是真凶，输出一行 JSON：{"target":"角色名"}
要求：
- target 必须是候选之一：${candidates.join("、")}
- 只依据你的角色信息、已发现的线索和公开讨论判断；允许存在不确定性，选择你"相对怀疑"的一位
- 不要投给自己
- 只输出 JSON，不要解释
如果完全无法判断，也请选一个你觉得行为可疑的人。`;
  const raw = await agnes.chat(systemPrompt(k), user, {
    maxTokens: 1500, temperature: 0.7, priority: "background", label: "ai.vote",
  });
  if (!raw) return null;
  try {
    // 放宽解析：剥离代码块围栏/前后缀，再取最外层 JSON
    let cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    cleaned = cleaned.substring(start, end + 1);
    const parsed = JSON.parse(cleaned);
    const target = parsed && parsed.target;
    return candidates.includes(target) ? target : null;
  } catch (e) { return null; }
}

/**
 * 获取最近公开对话摘录（供讨论/回答上下文，控制在安全范围）
 */
async function getPublicContext(roomCode, limit = 8) {
  try {
    const msgs = await getChatMessages(roomCode, limit);
    return msgs
      .map(m => `${m.characterName || m.playerName || "某人"}: ${String(m.content || "").substring(0, 80)}`)
      .slice(0, 8)
      .join("\n");
  } catch (e) { return ""; }
}

module.exports = { buildKnowledge, introLLM, speakLLM, answerLLM, voteLLM, getPublicContext, systemPrompt };