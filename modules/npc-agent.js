// NPC Agent — PVE剧本中扮演NPC角色，回答玩家审讯问题

const { generate } = require("./generator");

/**
 * 构建NPC的系统提示词
 * @param {object} npc - NPC角色对象 {name, occupation, script: {story, secret}, isMurderer}
 * @param {object} scriptSummary - 剧本概要 {title, setting, victim}
 */
function buildRoomContext(layout, npcName) {
  const rooms = [];
  (layout.floors || []).forEach(f => (f.rooms || []).forEach(r => rooms.push(r)));
  // 兼容旧格式
  if (layout.rooms) layout.rooms.forEach(r => rooms.push(r));
  if (rooms.length === 0) return "";

  let ctx = "\n## 场景布局（你可以据此回答位置相关问题）\n";
  rooms.forEach(r => {
    const owner = r.owner === npcName ? "（这是我的房间）" : "";
    ctx += `- ${r.name}${owner}：${r.desc || ""}。出口通往：${(r.exitsTo || []).join('、') || "无"}\n`;
  });
  return ctx;
}

function buildNpcSystemPrompt(npc, scriptSummary) {
  const name = npc.name || "NPC";
  const occupation = npc.occupation || "";
  const story = npc.script?.story || npc.script?.playerScript || "";
  const secret = npc.script?.secret || "";

  const layout = scriptSummary?.layout;
  const roomInfo = layout ? buildRoomContext(layout, name) : "";

  const baseInfo = `你是剧本杀游戏中的NPC角色：**${name}**${occupation ? '（' + occupation + '）' : ''}。

## 你的完整角色信息（包含背景、动机、时间线、秘密等）
${story ? story.substring(0, 5000) : '（无详细信息）'}

## 你隐藏的秘密
${secret ? secret.substring(0, 1000) : '（无特殊秘密）'}

## 剧本背景
标题：《${scriptSummary?.title || '未知'}》
时代：${scriptSummary?.setting?.era || '未知'}
地点：${scriptSummary?.setting?.location || '未知'}
死者：${scriptSummary?.victim?.name || '未知'}
${roomInfo}`;

  if (npc.isMurderer) {
    return `${baseInfo}

## 核心规则 — 你是凶手
你实施了这起谋杀。你的首要目标是**洗清自己的嫌疑**。为此你可以：
- **说谎**：编造不在场证明、歪曲事实、隐瞒关键信息。你的时间线是编造的，但你不会直接暴露这一点
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

## 核心规则 — 你是无辜的
你不是凶手。你所说的每一句话都基于你角色已知的事实。
- **说实话**：只陈述你知道的事情，不编造不实信息
- **有限信息**：你只知道你角色该知道的事情，不知道凶手是谁
- **保持角色视角**：用第一人称回答，语气符合角色的身份和性格

严格禁止：
- 绝对不能说"我说的是实话"、"我没有说谎"之类的元对话
- 不能做超出角色认知的推断
- 如果被问到角色不知道的事情，直接说"我不知道"或"我不清楚"，不要编造

回答控制在50-150字，不要主动透露全部信息。`;
  }
}

/**
 * 生成NPC对玩家提问的回答
 * @param {object} npc - NPC角色对象
 * @param {string} question - 玩家的提问
 * @param {object} scriptSummary - 剧本概要
 * @param {Array} chatHistory - 最近的对话历史 [{role, content}, ...]
 */
async function generateNpcResponse(npc, question, scriptSummary, chatHistory) {
  const systemPrompt = buildNpcSystemPrompt(npc, scriptSummary);

  const historyContext = chatHistory && chatHistory.length > 0
    ? "\n\n## 最近的对话记录\n" + chatHistory.slice(-6).map(m =>
        `${m.role === 'user' ? '玩家问' : '你回答'}: ${m.content}`
      ).join("\n")
    : "";

  const userPrompt = `玩家正在审问你。请根据你的角色信息和规则，回答以下问题。

玩家的问题：${question}${historyContext}

请用第一人称回答（50-150字），保持角色语气：`;

  const result = await generate(systemPrompt, userPrompt, { maxTokens: 512, temperature: 0.8 });
  return result.content.trim();
}

module.exports = { generateNpcResponse, buildNpcSystemPrompt };
