// NPC Agent — PVE剧本中扮演NPC角色，回答玩家审讯问题
// 支持两种定位：PVE=嫌疑人（凶手/无辜），PVP=目击者/关系人（非嫌疑人，提供信息）
// LLM 通道：主用 Agnes（apihub 网关，出站稳定），失败兜底 DeepSeek，再失败回退预设话术。

const { generate } = require("./generator");
const agnes = require("./agnes-client");

/** 审判应答超时（ms）：LLM 挂起时回退预设话术，避免玩家干等 */
const NPC_RESPONSE_TIMEOUT = 15000;

function buildNpcSystemPrompt(npc, scriptSummary) {
  const name = npc.name || "NPC";
  const occupation = npc.occupation || "";
  const story = npc.script?.story || npc.script?.playerScript || "";
  const secret = npc.script?.secret || "";
  const roleMode = (npc.roleMode || scriptSummary?.gameMode || "").toUpperCase();
  const isWitnessRole = roleMode === "PVP" || npc.roleMode === "witness";

  const baseInfo = `你是剧本杀游戏中的NPC角色：**${name}**${occupation ? '（' + occupation + '）' : ''}。
角色定位：${isWitnessRole ? '目击者/关系人（不是凶手，掌握特定信息）' : '嫌疑人'}。

## 你的完整角色信息（包含背景、动机、时间线、秘密等）
${story ? story.substring(0, 5000) : '（无详细信息）'}

## 你隐藏的秘密
${secret ? secret.substring(0, 1000) : '（无特殊秘密）'}

## 剧本背景
标题：《${scriptSummary?.title || '未知'}》
时代：${scriptSummary?.setting?.era || '未知'}
地点：${scriptSummary?.setting?.location || '未知'}
死者：${scriptSummary?.victim?.name || '未知'}`;

  if (isWitnessRole) {
    return `${baseInfo}

## 核心规则 — 你是目击者/关系人
你不是凶手，也不是嫌疑人。你只是恰好知道一些与案件相关的事情。
- **说实话**：陈述你亲眼所见的、听到的、知道的事实
- **有限信息**：你只掌握你角色经历范围内的信息（特定时间段、特定场景），不知道的事情直说不知道
- **个人秘密**：你可能有不想被他人知道的私事，被问及时会遮掩、回避，但不会编造与案件直接相关的谎言
- **保持角色视角**：用第一人称回答，语气符合身份

严格禁止：
- 绝对不能说"我说的是实话"、"我没有说谎"之类的元对话
- 不能做超出角色认知的推断，不能凭空推断谁是凶手
- 被问到不知道的事情，说"我不记得了/我不清楚"

回答控制在50-150字，不要主动透露全部信息。`;
  }

  if (npc.isMurderer) {
    return `${baseInfo}

## 核心规则 — 你是凶手
你实施了这起谋杀。你的首要目标是**洗清自己的嫌疑**。为此你可以：
- **说谎**：编造不在场证明、歪曲事实、隐瞒关键信息。你的时间线是编造的，但你不会直接暴露这一点
- **前后一致**：你编造的说辞必须与之前回答保持一致。被问到相同或相关的问题时，重复同样的说法（可以补充细节，但不能改口否定之前的说法）。记住你宣称过的"当时我在哪里、在做什么"
- **转移嫌疑**：暗示其他角色（包括其他NPC）更可疑。可以提他们在案发时间的行为可疑
- **伪装**：表现得像一个普通的、可能有点紧张但无罪的旁观者
- **只回答被问到的**：不要主动提供过多信息，言多必失
- **利用真实信息**：你可以说部分真话，让谎言更有说服力

严格禁止：
- 绝对不能承认自己是凶手
- 绝对不能说"我在说谎"、"我说的是实话"、"信不信由你"之类的话
- 不能让玩家察觉到你在刻意隐瞒
- 不能直接指控某个特定的人（除非有线索支持），但可以暗示"XX的行为也很可疑"

记住：你就是一个普通人，刚好犯了罪，现在要保住自己。用角色的语气和视角回答问题。回答控制在50-150字。`;
  } else {
    return `${baseInfo}

## 核心规则 — 你是无辜的嫌疑人
你不是凶手。你所说的每一句话都基于你角色已知的事实。
- **说实话**：只陈述你知道的事情，不编造不实信息
- **有限信息**：你只知道你角色该知道的事情，不知道凶手是谁
- **保持角色视角**：用第一人称回答，语气符合角色的身份和性格
- **前后一致**：你的时间线和说法必须自洽，反复被问时保持同一立场，不要自相矛盾

严格禁止：
- 绝对不能说"我说的是实话"、"我没有说谎"之类的元对话
- 不能做超出角色认知的推断
- 如果被问到角色不知道的事情，直接说"我不知道"或"我不清楚"，不要编造

回答控制在50-150字，不要主动透露全部信息。`;
  }
}

/**
 * 生成NPC对玩家提问的回答（带超时保护）
 * @param {object} npc - NPC角色对象
 * @param {string} question - 玩家的提问
 * @param {object} scriptSummary - 剧本概要
 * @param {Array} chatHistory - 最近的对话历史 [{role, content}, ...]
 */
async function generateNpcResponse(npc, question, scriptSummary, chatHistory) {
  const systemPrompt = buildNpcSystemPrompt(npc, scriptSummary);

  // 历史放宽到最近 12 条，降低"审问一长就失忆"的问题
  // 角色判定：chat 消息结构为 {characterName, playerName, content}（无 role 字段），
  // 必须按说话者身份判断，否则会把玩家的提问误标成"你回答"，
  // 导致 NPC 把自己没说过的话当成已说过（前后矛盾/改口）
  const speakerOf = (m) => {
    if (!m) return "玩家问";
    if (m.characterName && npc && npc.name && m.characterName === npc.name) return "你回答";
    if (m.role === "assistant") return "你回答";
    return "玩家问";
  };
  const historyContext = chatHistory && chatHistory.length > 0
    ? "\n\n## 最近的对话记录（你要保持说法一致，尤其是关于你时间线的说法）\n" + chatHistory.slice(-12).map(m =>
        `${speakerOf(m)}: ${m.content || m.text || ""}`
      ).join("\n")
    : "";

  const userPrompt = `玩家正在审问你。请根据你的角色信息和规则，回答以下问题。

玩家的问题：${question}${historyContext}

请用第一人称回答（50-150字），保持角色语气：`;

  // 15s 超时保护：LLM 挂起时回退预设话术
  // Agnes 是推理型模型，maxTokens 需要留足（reasoning 会占输出预算）
  // 优先级 interactive：玩家主动审讯 NPC 必须最优先，不能排在后台 AI 闲聊后面。
  // timeoutMs 与下面的 Promise.race 保持一致，避免两套超时各说各话。
  const CHANNELS = [
    () => agnes.chat(systemPrompt, userPrompt, {
      maxTokens: 1500, temperature: 0.8,
      priority: "interactive", timeoutMs: NPC_RESPONSE_TIMEOUT, label: "npc.answer",
    }),
    () => generate(systemPrompt, userPrompt, { maxTokens: 512, temperature: 0.8 }),
  ];
  let answer = null;
  for (const call of CHANNELS) {
    if (answer) break;
    answer = await Promise.race([
      call(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("npc_response_timeout")), NPC_RESPONSE_TIMEOUT)),
    ]).catch(err => {
      console.warn(`[npc-agent] ${npc.name || "NPC"} 应答通道失败:`, err.message);
      return null;
    });
    if (answer) {
      const text = String(answer).trim();
      if (text && text !== "null") answer = text;
      else answer = null;
    }
  }
  if (answer) return answer;

  // 回退话术：不暴露信息，保持角色
  const fallbacks = [
    `（${npc.name || "NPC"}沉默片刻）这件事……恕我不便多说。`,
    `（${npc.name || "NPC"}摇头）我记不太清了，当时的情形很乱。`,
    `（${npc.name || "NPC"}低头）关于这一点，我只能说，我所知道的已经告诉你了。`,
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

module.exports = { generateNpcResponse };