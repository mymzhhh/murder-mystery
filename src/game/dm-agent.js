// AI DM Agent — 全自动游戏主持人（v2：剧本自适应，含NPC管理）

const { generate } = require("../llm/generator");

const DM_SYSTEM_PROMPT = `你是一位专业剧本杀DM（主持人），负责主持一场谋杀之谜游戏。

你的核心职责：
1. **营造氛围**：根据剧本的时代背景和场景，用生动的文字描述环境
2. **引导玩家**：在搜证阶段提示玩家可以调查的方向，但不直接指出关键线索
3. **管理节奏**：适时推进游戏，保持紧张感和趣味性
4. **保持中立**：不偏袒任何玩家，不暗示凶手身份
5. **融入NPC**：如果剧本中有NPC（嫌疑人或目击者/关系人），在适当的阶段提及他们的存在，将其自然融入叙事
6. **戏剧化呈现**：在关键节点（投票、真相揭露）营造戏剧性效果

重要禁令：
- **绝对不能说"凶手就在你们之中"或类似暗示凶手一定是玩家的话**。PVE模式下凶手可能是NPC嫌疑人；PVP模式下凶手在玩家中
- 投票阶段按剧本模式提醒投票范围：PVE剧本中NPC嫌疑人参与投票；PVP剧本中NPC目击者/关系人不参与投票，凶手在玩家之间
- 如果存在NPC嫌疑人（PVE），必须将他们列为可能的凶手

语言风格：
- 与剧本的时代背景保持一致
- 使用第二人称"你"来称呼全体玩家
- 描述具体、有画面感
- 保持神秘感和悬念

绝不能泄露凶手身份、关键线索内容或其他玩家不知道的信息。`;

/**
 * 生成阶段开场叙事
 */
async function generatePhaseNarrative(script, phase, gameState) {
  // 检查缓存（key 加入剧本内容指纹，防止同名剧本跨房串叙事）
  const { getRedis } = require("../core/redis-client");
  const cacheKey = narrativeCacheKey(script, phase);
  try {
    const r = getRedis();
    const cached = await r.get(cacheKey);
    if (cached) return cached;
  } catch (e) { /* Redis 不可用，跳过缓存 */ }

  // NPC 定位：PVE=嫌疑人，PVP=目击者/关系人（与 prompt-agent / builder 设定对齐）
  const gameMode = (script.setting?.gameMode || "").toUpperCase();
  const isPVE = gameMode ? gameMode === "PVE" : ((script.characters || []).some(c => c.roleType === "npc" && c.isMurderer));
  const npcLabel = isPVE ? "NPC嫌疑人" : "NPC目击者/关系人";
  const npcs = (script.characters || []).filter(c => c.roleType === "npc");
  const players = (script.characters || []).filter(c => c.roleType !== "npc");
  const npcNames = npcs.map(c => c.name).join("、");
  const npcInfo = npcs.length > 0
    ? `\n**${isPVE ? 'NPC嫌疑人' : 'NPC目击者/关系人'}（由DM扮演）**：${npcNames}\n${isPVE
      ? '这些NPC是案件的重要嫌疑人，他们不会主动发言，但DM会在适当时机提供关于他们的信息。'
      : '这些NPC是案件的目击者或相关人，掌握特定的时间点信息，审问他们可以获得线索（但他们不是凶手）。'}`
    : "";
  const phaseDescriptions = {
    reading: `玩家们正在阅读各自的角色剧本。请生成一段简短的开场白，欢迎玩家进入游戏。${npcInfo}`,

    round1: `第一轮【搜证与讨论】开始。请生成一段叙事，描述案发现场的基本情况。
${npcInfo}${npcs.length > 0 ? `同时提醒玩家：可以向DM询问${isPVE ? 'NPC嫌疑人' : 'NPC目击者/关系人'}的相关信息。` : ''}
列出3-4个可以调查的具体地点；并提示玩家在搜证的同时可以分享交流各自的发现（本阶段可同时搜证与讨论）。
剧本设定：${script.setting?.location || '未知地点'}，时代：${script.setting?.era || '未知'}，死者：${script.victim?.name || '未知'}。`,

    round2: `第二轮【搜证与讨论】开始。请生成一段叙事，描述深入调查的过程。
${npcInfo}引导玩家调查：${[...players.slice(0, 3).map(c => c.name), ...(npcs.length > 0 ? npcs.map(c => c.name) : [])].join('、')}等人的活动轨迹。
列出新的可调查方向。${npcs.length > 0 ? (isPVE ? `提示：经过深入调查，NPC嫌疑人` + npcNames + '的可疑之处逐渐浮现，请玩家结合线索互相讨论。' : `提示：NPC目击者/关系人` + npcNames + '提供的线索逐渐拼合出真相轮廓，请玩家结合线索互相讨论。') : ''}`,

    voting: `投票阶段。请生成一段紧张、严肃的叙事。
${npcs.length > 0 && isPVE ? `提醒玩家：NPC嫌疑人` + npcNames + '也在投票范围内。请根据所有已知线索，投出你最怀疑的人。' : (npcs.length > 0 ? `提醒玩家：${npcNames}是目击者/关系人，不在投票指认范围内；请在玩家之间指认真凶。` : '')}
要求每位玩家投出自己的一票。营造倒计时的紧迫感。`,

    truth_reveal: "真相即将揭晓。请根据DM手册中的真相复盘，用戏剧化的方式揭示真正的凶手和作案过程。",
  };

  const desc = phaseDescriptions[phase] || "请生成适合当前阶段的引导内容。";
  const userPrompt = `${desc}\n\n剧本标题：《${script.title || '未命名'}》\n时代背景：${script.setting?.era || ''}\n地点：${script.setting?.location || ''}\n死者：${script.victim?.name || ''}，死因：${script.victim?.causeOfDeath || ''}\n角色：${getCharacterNames(script).join('、')}${npcInfo}\n\n请输出100-300字的叙事内容：`;

  // 15s 超时保护 + 默认叙事 fallback
  const result = await Promise.race([
    generate(DM_SYSTEM_PROMPT, userPrompt, { maxTokens: 1024, temperature: 0.8 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("narrative_timeout")), 15000)),
  ]).catch(err => {
    console.warn(`[dm-agent] 叙事生成失败 (${phase}):`, err.message);
    return null;
  });

  if (!result) {
    const fallbacks = {
      reading: "欢迎各位来到这场谋杀之谜。请仔细阅读你的角色剧本，了解自己的身份、秘密和动机。",
      round1: "案件已经发生，现场留下了许多痕迹。请各位开始搜证调查，并可以随时分享你的发现——本阶段搜证与讨论同时进行。",
    };
    return fallbacks[phase] || `游戏进入 ${phase} 阶段。请根据DM指导继续游戏。`;
  }

  // 缓存结果（1小时 TTL）—— 与读取端共用同一 cacheKey 计算函数，避免"读用指纹、写用标题"导致永不命中
  try {
    const r = getRedis();
    await r.setex(cacheKey, 3600, result.content);
  } catch (e) { /* ignore */ }

  return result.content;
}

/** 叙事缓存 key：剧本指纹 + 阶段（读写单点，避免 key 不一致导致缓存永不命中） */
function narrativeCacheKey(script, phase) {
  const fingerprint = String(script.title || "untitled").substring(0, 40)
    + "|" + ((script.characters || []).map(c => c.name).join(",") || "").substring(0, 60)
    + "|" + (script.setting?.gameMode || "");
  return `narrative:${fingerprint}:${phase}`;
}

/**
 * 生成完整的真相复盘（带超时保护 + DM 手册 fallback，真相揭示不能被 LLM 卡死）
 */
/**
 * **同步可得**的兜底真相叙述：结局概要 + DM 手册真相节选，不调 LLM。
 *
 * 为什么必须单独抽出来（2026-10-17）：阶段推进要求"先翻阶段、立刻广播"，
 * 那一刻**不能等 LLM**；但广播的 payload 里需要有可用文本。于是这里提供一份
 * 不依赖网络的版本给 `autoAdvancePhase` 立即使用，`generateTruthReveal` 超时/失败时
 * 也复用同一份 —— 同一个兜底只写一遍（本项目已经吃过"同一份事实两处各实现一次"的亏）。
 */
function fallbackTruthReveal(script, outcome) {
  const outcomeText = {
    true_accusation: "玩家成功指认真凶",
    wrong_accusation: "玩家指认错误，真凶逍遥法外",
    tie: "票数平局，凶手趁乱逃脱",
    no_votes: "无人投票",
  }[outcome?.outcome] || "游戏结束";
  const manual = (script?.dmGuide?.truthReveal || "").trim();
  return `【真相复盘】${outcomeText}。\n\n${manual ? "根据DM手册记录：\n" + manual.substring(0, 1200) : "（DM手册暂无真相记录）"}`;
}

async function generateTruthReveal(script, votes, outcome) {
  const npcs = (script.characters || []).filter(c => c.roleType === "npc");
  const isPVE = (script.setting?.gameMode || "").toUpperCase() === "PVE";
  const npcContext = npcs.length > 0
    ? `\n${isPVE ? 'NPC嫌疑人' : 'NPC目击者/关系人'}：${npcs.map(c => c.name + '(' + (c.occupation || '') + ')').join('、')}`
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

  // 20s 超时保护 + fallback 文本（DM 手册真相 + 结果概要），绝不让真相环节卡死
  const result = await Promise.race([
    generate(sysPrompt, userPrompt, { maxTokens: 1536, temperature: 0.8 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("truth_reveal_timeout")), 20000)),
  ]).catch(err => {
    console.warn("[dm-agent] 真相复盘生成失败:", err.message);
    return null;
  });
  if (result) return result.content;

  // 超时/失败一律退回**同步兜底**（与 autoAdvancePhase 立即广播用的是同一份）
  return fallbackTruthReveal(script, outcome);
}

function getCharacterNames(script) {
  if (!script.characters) return ["未知角色"];
  return script.characters.map(c => c.name).filter(Boolean);
}

module.exports = { generatePhaseNarrative, generateTruthReveal, fallbackTruthReveal };
