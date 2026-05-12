// AI DM Agent — 全自动游戏主持人（v2：剧本自适应，含NPC管理）

const { generate } = require("./generator");

const DM_SYSTEM_PROMPT = `你是一位专业剧本杀DM（主持人），负责主持一场谋杀之谜游戏。

你的核心职责：
1. **营造氛围**：根据剧本的时代背景和场景，用生动的文字描述环境
2. **引导玩家**：在搜证阶段提示玩家可以调查的方向，但不直接指出关键线索
3. **管理节奏**：适时推进游戏，保持紧张感和趣味性
4. **保持中立**：不偏袒任何玩家，不暗示凶手身份
5. **融入NPC**：如果剧本中有NPC嫌疑人，在适当的阶段提及他们的存在，将其自然融入叙事
6. **戏剧化呈现**：在关键节点（投票、真相揭露）营造戏剧性效果

重要禁令：
- **绝对不能说"凶手就在你们之中"或类似暗示凶手一定是玩家的话**。凶手可能是NPC嫌疑人
- 投票阶段必须明确提醒：所有角色（包括NPC嫌疑人）都在投票范围内
- 如果存在NPC嫌疑人，必须将他们列为可能的凶手

语言风格：
- 与剧本的时代背景保持一致
- 使用第二人称"你"来称呼全体玩家
- 描述具体、有画面感
- 保持神秘感和悬念

绝不能泄露凶手身份、关键线索内容或其他玩家不知道的信息。`;

/**
 * 生成阶段开场叙事
 */
function getRoomNames(script) {
  const layout = script.layout;
  if (!layout || !layout.floors) return [];
  const names = [];
  (layout.floors || []).forEach(f => (f.rooms || []).forEach(r => names.push(r.name)));
  // 兼容旧格式
  if (layout.rooms) layout.rooms.forEach(r => names.push(r.name));
  return names;
}

async function generatePhaseNarrative(script, phase, gameState) {
  const npcs = (script.characters || []).filter(c => c.roleType === "npc");
  const players = (script.characters || []).filter(c => c.roleType !== "npc");
  const npcNames = npcs.map(c => c.name).join("、");
  const npcInfo = npcs.length > 0
    ? `\n**NPC嫌疑人（由DM扮演）**：${npcNames}\n这些NPC是案件的重要嫌疑人，他们不会主动发言，但DM会在适当时机提供关于他们的信息。`
    : "";
  const roomNames = getRoomNames(script);
  const roomList = roomNames.length > 0 ? `\n**场景房间**：${roomNames.join('、')}` : "";
  const crimeScene = roomNames.length > 0 ? (roomNames.find(n => n.includes('书') || n.includes('房') || n.includes('室')) || roomNames[0]) : "案发现场";

  const phaseDescriptions = {
    reading: `玩家们正在阅读各自的角色剧本。请生成一段简短的开场白，欢迎玩家进入游戏。${npcInfo}${roomList}`,

    round1_investigation: `第一轮搜证开始。请生成一段叙事，描述${crimeScene}的基本情况。
${npcInfo}${roomList}
引导玩家调查以下具体地点：${roomNames.slice(0, 5).join('、')}等。${npcs.length > 0 ? '同时提醒玩家：可以向DM询问NPC嫌疑人的相关信息。' : ''}
列出3-4个可以调查的具体地点。
剧本设定：${script.setting?.location || '未知地点'}，时代：${script.setting?.era || '未知'}，死者：${script.victim?.name || '未知'}。`,

    round1_discussion: `第一轮讨论开始。玩家们可以分享各自发现的线索。${npcs.length > 0 ? '提醒玩家：NPC嫌疑人' + npcNames + '虽然不会发言，但他们的一举一动也是重要的推理线索。' : ''}
请生成2-3个引导性问题，帮助玩家整理线索、交流发现。不要直接指出凶手。`,

    round2_investigation: `第二轮搜证开始。请生成一段叙事，描述深入调查的过程。
${npcInfo}${roomList}
引导玩家调查每个人的房间：${[...players.slice(0, 3).map(c => c.name + '的房间'), ...(npcs.length > 0 ? npcs.map(c => c.name + '的房间') : [])].join('、')}。
列出新的可调查方向。`,

    round2_discussion: `第二轮讨论开始。${npcs.length > 0 ? '经过深入调查，NPC嫌疑人' + npcNames + '的可疑之处逐渐浮现。' : ''}
请生成引导问题，帮助玩家深入分析动机和不在场证明。`,

    round3: `最后一轮搜证和讨论。请生成紧张感逐渐上升的叙事。
${npcs.length > 0 ? '此时，玩家对NPC嫌疑人' + npcNames + '的了解应该已经很深入了。' : ''}
提醒玩家这是最后的机会。引导关注关键线索和矛盾点。`,

    voting: `投票阶段。请生成一段紧张、严肃的叙事。
${npcs.length > 0 ? '提醒玩家：NPC嫌疑人' + npcNames + '也在投票范围内。请根据所有已知线索，投出你最怀疑的人。' : ''}
要求每位玩家投出自己的一票。营造倒计时的紧迫感。`,

    truth_reveal: "真相即将揭晓。请根据DM手册中的真相复盘，用戏剧化的方式揭示真正的凶手和作案过程。",
  };

  const desc = phaseDescriptions[phase] || "请生成适合当前阶段的引导内容。";
  const userPrompt = `${desc}\n\n剧本标题：《${script.title || '未命名'}》\n时代背景：${script.setting?.era || ''}\n地点：${script.setting?.location || ''}\n死者：${script.victim?.name || ''}，死因：${script.victim?.causeOfDeath || ''}\n角色：${getCharacterNames(script).join('、')}${npcInfo}\n\n请输出100-300字的叙事内容：`;

  const result = await generate(DM_SYSTEM_PROMPT, userPrompt, { maxTokens: 1024, temperature: 0.8 });
  return result.content;
}

/**
 * AI 决策：为玩家选择线索
 */
async function decideClueForPlayer(script, playerCharacter, availableClues, playerClues, round, phase) {
  if (!availableClues || availableClues.length === 0) return null;
  if (availableClues.length === 1) return availableClues[0];
  if (availableClues.length <= 3) {
    return availableClues[Math.floor(Math.random() * availableClues.length)];
  }

  const sysPrompt = `你是剧本杀线索分配决策助手。根据当前游戏状态，为玩家选择合适的线索。优先选择：1) 与该玩家角色相关的线索 2) 能推进推理的线索 3) 先给普通线索再给关键线索。只输出选中线索的ID，不要解释。`;

  const userPrompt = `玩家角色：${playerCharacter?.name || '未知'}\n当前轮次：第${round || 1}轮\n该玩家已获得的线索ID：${(playerClues || []).map(c => c.id).join(',') || '无'}\n本轮可用线索：\n${availableClues.map(c => `- ${c.id}: ${(c.content || '').substring(0, 60)}`).join('\n')}\n\n请选择一个最合适的线索ID：`;

  try {
    const result = await generate(sysPrompt, userPrompt, { maxTokens: 64, temperature: 0.5 });
    const chosenId = result.content.trim().match(/[A-C]\d+/);
    if (chosenId) {
      const found = availableClues.find(c => c.id === chosenId[0]);
      if (found) return found;
    }
  } catch (e) { /* fallback to random */ }

  return availableClues[Math.floor(Math.random() * availableClues.length)];
}

/**
 * 生成投票阶段结果叙事
 */
async function generateVoteReveal(script, votes, outcome) {
  const sysPrompt = `你是剧本杀DM。投票结果已出，请用戏剧化的方式公布结果。根据outcome类型：true_accusation表示抓对真凶，wrong_accusation表示冤枉了好人，tie表示平票。请营造相应的戏剧效果。`;

  const voterNames = Object.keys(votes || {}).length;
  const topTarget = outcome?.name || "";
  const murderer = script.murderer?.name || "未知";

  const userPrompt = `剧本：《${script.title || ''}》\n投票人数：${voterNames}\n最高票指向：${topTarget}\n真正的凶手：${murderer}\n结果：${outcome?.outcome || 'unknown'}\n\n请生成100-200字的公布结果叙事：`;

  const result = await generate(sysPrompt, userPrompt, { maxTokens: 512, temperature: 0.8 });
  return result.content;
}

/**
 * 生成完整的真相复盘
 */
async function generateTruthReveal(script, votes, outcome) {
  const npcs = (script.characters || []).filter(c => c.roleType === "npc");
  const npcContext = npcs.length > 0
    ? `\nNPC嫌疑人：${npcs.map(c => c.name + '(' + (c.occupation || '') + ')').join('、')}`
    : "";

  const sysPrompt = `你是剧本杀DM。游戏结束，请做完整的真相复盘。内容包括：凶手的完整作案过程、动机、手法、关键线索的串联。${npcs.length > 0 ? '如果凶手是NPC，需要特别说明NPC的作案过程。' : ''}语言要有戏剧性和感染力。`;

  const userPrompt = `剧本完整信息：
标题：《${script.title || ''}》
背景：${script.setting?.era || ''} - ${script.setting?.location || ''}
死者：${script.victim?.name || ''}，${script.victim?.causeOfDeath || ''}
凶手：${script.murderer?.name || '未知'}
动机：${script.murderer?.motive || ''}
手法：${script.murderer?.method || ''}${npcContext}
投票结果：${JSON.stringify(votes || {})}
结局：${outcome?.outcome || 'unknown'}

DM手册中的真相：
${script.dmGuide?.truthReveal || ''}

请生成300-500字的戏剧化真相复盘：`;

  const result = await generate(sysPrompt, userPrompt, { maxTokens: 1536, temperature: 0.8 });
  return result.content;
}

function getCharacterNames(script) {
  if (!script.characters) return ["未知角色"];
  return script.characters.map(c => c.name).filter(Boolean);
}

module.exports = {
  generatePhaseNarrative,
  decideClueForPlayer,
  generateVoteReveal,
  generateTruthReveal,
};
