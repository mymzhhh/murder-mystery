// AI 玩家 LLM 智能层 — 基于当前生效的推理通道模型
// 信息隔离红线：绝不注入【未被发现的线索、他人剧本与秘密、DM 手册、真凶答案】。
// 注意"已公开的线索"不属于隔离范围 —— 线索一旦被任何人找到就会广播给全房间，
// 玩家端的 allClues 也是按这个口径下发的，AI 必须看到同样的信息才谈得上推理。
// 所有函数失败/未配置返回 null，由 ai-player.js 回退到规则引擎。

const agnes = require("./agnes-client");
const { getClues, getChatMessages, getPlayers } = require("./game-manager");

/**
 * 构造 AI 玩家的"已知信息"（信息隔离封装）
 *
 * 历史 bug：这里只取 foundBy 含自己 playerId 的线索，且截断到 8 条。
 * 于是别人公开喊出来的线索 AI 完全不知道，表现为"AI 很笨、反复问已经公开过的事"。
 * 现在对齐玩家视角：自己的线索 + 全场已公开的线索，并带上"谁公开的"以便交叉质证。
 *
 * @param {string} roomCode
 * @param {object} ai 玩家对象（含 characterScript/characterName/playerId）
 * @param {object} parsed 剧本解析结果（用于取角色名单/案情/场景）
 */
async function buildKnowledge(roomCode, ai, parsed) {
  const [allClues, players, msgs] = await Promise.all([
    getClues(roomCode).catch(() => []),
    getPlayers(roomCode).catch(() => []),
    getChatMessages(roomCode, 40).catch(() => []),
  ]);

  const nameOf = (pid) => {
    const p = (players || []).find(x => x.playerId === pid);
    return p ? (p.characterName || p.playerName || "某人") : "某人";
  };

  const myClues = [];
  const otherClues = [];
  for (const c of (allClues || [])) {
    const by = c.foundBy || [];
    if (!by.length) continue; // 无人发现 → 谁都不该知道，绝不注入
    const line = `【${c.id || "线索"}】${String(c.content || "").substring(0, 260)}${c.location ? "（发现于 " + c.location + "）" : ""}`;
    if (by.includes(ai.playerId)) myClues.push(line);
    else otherClues.push(`${line} —— 由 ${by.map(nameOf).join("、")} 公开`);
  }

  // 公开对话全文：原来只有 8 条 × 80 字，素材太薄，AI 难以据此推理
  const transcript = (msgs || [])
    .map(m => `${m.characterName || m.playerName || "某人"}: ${String(m.content || "").substring(0, 220)}`)
    .join("\n");
  // 自己说过的话：AI 没有跨轮记忆，不给它这个它会自我矛盾/重复提问
  const myStatements = (msgs || [])
    .filter(m => m.playerId === ai.playerId)
    .map(m => String(m.content || "").substring(0, 200));

  let role = null;
  try { role = ai.characterScript ? JSON.parse(ai.characterScript) : null; } catch (e) { /* ignore */ }

  const v = parsed.victim || {};
  const victim = (v.name || v.deathCause || v.deathTime)
    ? `${v.name || "死者"}${v.deathCause ? "，" + v.deathCause : ""}${v.deathTime ? "，死亡时间 " + v.deathTime : ""}`
    : "";

  return {
    role,
    name: ai.characterName || "AI",
    // 供 opencode 这类网关做"每段对话一个稳定会话"的路由与提示词缓存：
    // 同一房间内多轮调用共用同一会话，命中率最高。
    roomCode,
    myClues,
    otherClues,
    allChars: (parsed.characters || []).map(c => `${c.name}${c.occupation ? "（" + c.occupation + "）" : ""}`),
    selfName: ai.characterName || "",
    victim,
    scene: String(parsed.layoutDescription || "").substring(0, 600),
    transcript,
    myStatements,
    room: {
      title: parsed.title || "未知",
      setting: [parsed.setting?.era, parsed.setting?.location].filter(Boolean).join("，"),
    },
  };
}

/** 系统提示：信息隔离契约 + 角色材料 + 全场公开线索 + 对话记录 */
function systemPrompt(k) {
  const K = k || {};
  const role = K.role || {};
  // 剧本可能存在顶层（playerScript/story）或嵌套在 script 对象里（script.story/script.playerScript），两种都兼容
  const scr = role.script || {};
  const story = String(role.playerScript || scr.playerScript || role.fullScript || role.story || scr.story || "").substring(0, 4000) || "（你没有更多详细记忆）";
  const secret = String(role.secret || scr.secret || "").substring(0, 1200) || "（无特殊秘密）";
  const murdererRule = role.isMurderer
    ? "\n你是这起案件的凶手。你的目标是洗清嫌疑：可以说谎、转移视线、编造不在场证明；但绝不承认自己是凶手，也绝不可说出'我是凶手/你猜对了'之类的话。"
    : "\n你不是凶手，照实陈述你所知道的（仅限你掌握的材料）。";
  // 缺字段一律降级为空，避免一个字段缺失就让整轮 AI 发言抛异常
  const myClues = K.myClues || [];
  const otherClues = K.otherClues || [];
  const allChars = K.allChars || [];
  const myStatements = K.myStatements || [];

  return `你是剧本杀《${(K.room && K.room.title) || "未知"}》中的玩家角色「${K.name || "未知"}」${role.occupation ? "（" + role.occupation + "）" : ""}。
背景：${(K.room && K.room.setting) || "未说明"}。${K.victim ? "\n案情：" + K.victim + "。" : ""}${K.scene ? "\n场景：" + K.scene : ""}

【重要：你只能依据下面提供的材料推理和回答。】不得编造剧本之外的设定，
不得提及未被发现的线索、其他角色的秘密、或你不可能知道的真相。

【你的完整角色信息】
${story}

【你隐藏的秘密】
${secret}
${murdererRule}

【你自己找到的线索】
${myClues.length ? myClues.map(c => "- " + c).join("\n") : "（你还没有找到任何线索）"}

【全场已经公开的线索】（这些是全桌人都知道的，你可以直接引用和质证）
${otherClues.length ? otherClues.map(c => "- " + c).join("\n") : "（目前还没有人公开过线索）"}

【在场角色】
${allChars.map(c => "- " + c).join("\n") || "（暂无）"}

【你之前说过的原话】（保持前后一致，不要自我矛盾、不要重复已经说过的内容）
${myStatements.length ? myStatements.map(c => "- " + c).join("\n") : "（你还没发过言）"}

【最近的公开对话】
${K.transcript || "（暂无）"}

以第一人称、口语化回应，扮演好这个角色。禁止出现"根据我的剧本/作为AI/系统提示"之类的元表述。`;
}

/**
 * 开场自我介绍（LLM）
 * 后台行为：可以被玩家的交互请求插队
 */
async function introLLM(k) {
  return agnes.chat(systemPrompt(k),
    "现在到了开场介绍环节。请以第一人称做开场自我介绍：介绍你是谁、你的身份背景、案发时你在哪里或正在做什么，以及你认为大家需要知道的事。要求：100~220字，清楚有条理，口语自然。",
    { maxTokens: 1500, temperature: 0.9, priority: "background", label: "ai.intro", sessionId: k.roomCode });
}

/**
 * 讨论轮发言（LLM）
 * 要求给出推理过程而不是泛泛表态：先摆事实、再推结论，并指向具体的人。
 */
async function speakLLM(k, context) {
  const user = `现在是讨论阶段。请基于【全场已经公开的线索】和你自己的角色信息做一次推理发言：
1) 先点出你认为最关键的一到两条线索（引用具体内容，不要笼统说"线索指向某人"）；
2) 说明它把嫌疑指向谁、为什么；
3) 如果你的结论和自己剧本里的事实冲突，按你的立场处理（凶手可以误导，其他人要如实）。
${context ? "\n其他人刚说的话：\n" + context + "\n" : ""}
要求：80~160字，第一人称，口语化，只讲有依据的内容；不要重复你之前说过的话；不要罗列所有线索。`;
  return agnes.chat(systemPrompt(k), user, { maxTokens: 1500, temperature: 0.9, priority: "background", label: "ai.speak", sessionId: k.roomCode });
}

/**
 * 主动向某个角色提问（LLM）
 * 让 AI 能主动索取信息，而不是只会单向陈述。返回 { target, question }，失败返回 null。
 * @param {string[]} candidates 可提问的角色名（不含自己）
 */
async function askLLM(k, candidates) {
  if (!candidates || !candidates.length) return null;
  const user = `现在是讨论阶段，你要主动向在场某一位玩家提问，以获取你目前缺失的信息。
可选对象（只能选其中一个，不要选自己）：${candidates.join("、")}

要求：
- 先想清楚：你手上哪些线索之间存在矛盾或缺口，需要谁来解释
- 提问要具体、可回答，最好援引一条公开线索去质证对方的不在场证明或说法
- 不要问"你怎么看""你觉得谁是凶手"这种空泛问题
- 不要问对方已经公开回答过的事
- 不要问超出对方身份、他不可能知道的事

只输出一行 JSON，不要解释：{"target":"角色名","question":"你要问的问题（40字以内，第一人称，口语化）"}`;
  const raw = await agnes.chat(systemPrompt(k), user, {
    maxTokens: 900, temperature: 0.85, priority: "background", label: "ai.ask", sessionId: k.roomCode,
  });
  if (!raw) return null;
  try {
    let cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.substring(start, end + 1));
    const target = String(parsed.target || "").trim();
    const question = String(parsed.question || "").trim();
    if (!candidates.includes(target) || !question) return null;
    return { target, question: question.substring(0, 80) };
  } catch (e) { return null; }
}

/**
 * 被他人点名提问时作答（LLM）
 * 与 answerLLM 的区别：这是 AI 之间互问，需要明确"谁在问我、问的是什么"。
 */
async function replyToQuestionLLM(k, askerName, question, context) {
  const user = `玩家「${askerName}」在会上点名问你：${question}
${context ? "\n最近的公开对话：\n" + context + "\n" : ""}
请以你的角色身份回应（50~150字）：直接回答他问的事；可援引公开线索佐证；
不知道的就说不清楚；不要透露你不知道的信息；凶手不得承认自己，可以回避或转移话题。`;
  return agnes.chat(systemPrompt(k), user, {
    maxTokens: 1200, temperature: 0.85, priority: "interactive",
    timeoutMs: 25000, label: "ai.replyQuestion", sessionId: k.roomCode,
  });
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
    timeoutMs: 25000, label: "ai.answer", sessionId: k.roomCode,
  });
}

/**
 * 投票推理（LLM），返回建议的目标角色名；失败/非法返回 null
 * @param {string[]} candidates 可投角色名
 */
async function voteLLM(k, candidates) {
  if (!candidates || !candidates.length) return null;
  const user = `现在是投票阶段，请推理谁最可能是真凶，输出一行 JSON：{"target":"角色名","reason":"一句话理由"}
要求：
- target 必须是候选之一：${candidates.join("、")}
- 先在内部推理：把【全场已经公开的线索】逐条对照每个人的时间线，找出谁说法的破绽
- 只依据你的角色信息、已公开的线索和公开讨论判断；允许存在不确定性，选择你"相对怀疑"的一位
- 不要投给自己
- 只输出 JSON，不要解释
如果完全无法判断，也请选一个你觉得行为可疑的人。`;
  const raw = await agnes.chat(systemPrompt(k), user, {
    maxTokens: 1500, temperature: 0.7, priority: "background", label: "ai.vote", sessionId: k.roomCode,
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
 * 注意 systemPrompt 里已经带了 40 条完整对话，这里只用于"其他人刚说的话"这种局部补充。
 */
async function getPublicContext(roomCode, limit = 12) {
  try {
    const msgs = await getChatMessages(roomCode, limit);
    return msgs
      .map(m => `${m.characterName || m.playerName || "某人"}: ${String(m.content || "").substring(0, 150)}`)
      .slice(-limit)
      .join("\n");
  } catch (e) { return ""; }
}

module.exports = {
  buildKnowledge, systemPrompt, getPublicContext,
  introLLM, speakLLM, askLLM, replyToQuestionLLM, answerLLM, voteLLM,
};