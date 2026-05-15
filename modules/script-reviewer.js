// 剧本评测 Agent — v2 增强：per-dimension理由+建议+suggestedPatches
const { getSession, addMessage, createSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
const { buildMurderMystery, LIMITS } = require("./murder-mystery-builder");
const { splitScript } = require("./script-splitter");

const MAX_RETRIES = 3;
const PASS_SCORE = 60;

const MAX_PLAYERS = LIMITS.maxPlayers;
const MAX_NPC = LIMITS.maxNpc;
const MAX_TOTAL = LIMITS.maxTotal;

const REVIEW_SYSTEM_PROMPT = `你是一位资深剧本杀评测专家。你需要从多个维度审查一份剧本杀剧本的质量，并给出具体、可操作的建议。

## 硬性约束（不合格直接低分，无法通过）

1. **角色数量合规**：玩家角色：1-6人，NPC嫌疑人：0-3人，总角色数：≤9人
   必须明确区分【玩家】和【NPC嫌疑人】角色类型
   单人侦探本（玩家=1）：NPC必须恰好3人，凶手必须是NPC

2. **凶手唯一性**：有且仅有一个凶手

## 评分维度（每项0-100分）

1. **故事完整性 (25%)**：故事是否有清晰开端/发展/高潮/结局？世界观是否自洽？人物关系完整合理？
2. **凶手设计 (25%)**：凶手动机是否充分深刻？作案手法新颖且符合世界观？作案过程详细？
3. **线索系统 (20%)**：线索分层清晰（表面→深入→关键）？物证标注发现地点？证据链完整可推理？
4. **角色设计 (15%)**：每个角色有完整故事/秘密/时间线？纯叙事不含"你应该"等策略建议？
5. **可玩性 (15%)**：玩家能通过线索+审讯推理出凶手？难度合适？NPC嫌疑均衡？

## 输出格式（JSON — 必须严格遵守此结构）

{
  "totalScore": 85,
  "passed": true,
  "dimensions": {
    "storyCompleteness": {
      "score": 90,
      "reason": "故事从案发到真相揭露有清晰的时间推进，世界观设定自洽。但最后的动机反转稍显突兀，缺乏前期铺垫。",
      "suggestion": "建议在角色B的背景中加入与死者长期积怨的内容，让动机反转有更充分的铺垫。"
    },
    "murdererDesign": {
      "score": 85,
      "reason": "...",
      "suggestion": "..."
    },
    "clueSystem": {
      "score": 80,
      "reason": "...",
      "suggestion": "..."
    },
    "characterDesign": {
      "score": 85,
      "reason": "...",
      "suggestion": "..."
    },
    "playability": {
      "score": 85,
      "reason": "...",
      "suggestion": "..."
    }
  },
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["问题1", "问题2"],
  "revisionAdvice": "总体修改建议",
  "suggestedPatches": [
    {"type": "clue", "target": "线索4", "operation": "split", "description": "将线索4拆成两条，降低单条线索的信息密度"},
    {"type": "character", "target": "NPC李四", "operation": "append", "description": "给李四添加一个秘密：他曾受死者勒索"}
  ]
}

字段说明：
- dimensions：每个维度必须包含 score(number)、reason(string)、suggestion(string，null表示无需改进)
- suggestedPatches：可选数组，为空时传 []。每个patch含 type(clue/character/player_script)、target(目标名)、operation(split/append/move/remove)、description(说明)
- reason 要具体指出问题所在，不可泛泛而谈
- suggestion 要给出可执行的具体修改方案`;

function parseScores(review) {
  // 从 dimensions 提取平铺 scores（兼容旧格式）
  const dims = review.dimensions || {};
  return {
    storyCompleteness: dims.storyCompleteness?.score ?? review.scores?.storyCompleteness ?? 0,
    murdererDesign: dims.murdererDesign?.score ?? review.scores?.murdererDesign ?? 0,
    clueSystem: dims.clueSystem?.score ?? review.scores?.clueSystem ?? 0,
    characterDesign: dims.characterDesign?.score ?? review.scores?.characterDesign ?? 0,
    playability: dims.playability?.score ?? review.scores?.playability ?? 0,
  };
}

async function reviewScript(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return { ok: false, error: "剧本不存在" };

  const messages = session.messages || [];
  const markdown = messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
  if (!markdown || markdown.length < 500) return { ok: false, error: "剧本内容为空或过短" };

  const parsed = parseScript(markdown);

  const chars = parsed.characters || [];
  const playerCount = chars.filter(c => c.roleType !== "npc").length;
  const npcCount = chars.filter(c => c.roleType === "npc").length;
  const totalCount = chars.length;

  // 硬性约束检查
  const constraintErrors = [];
  if (totalCount > MAX_TOTAL) constraintErrors.push(`总角色数超限(${totalCount}/${MAX_TOTAL})`);
  if (playerCount > MAX_PLAYERS) constraintErrors.push(`玩家角色数超限(${playerCount}/${MAX_PLAYERS})`);
  if (playerCount < LIMITS.minPlayers) constraintErrors.push(`玩家角色数不足(${playerCount}，需要至少${LIMITS.minPlayers}人)`);
  if (npcCount > MAX_NPC) constraintErrors.push(`NPC数超限(${npcCount}/${MAX_NPC})`);

  const isSolo = playerCount === 1;
  if (isSolo && npcCount !== 3) constraintErrors.push(`单人本需要恰好3个NPC嫌疑人(当前${npcCount}个)`);

  const hasClearMurderer = !!(parsed.murderer?.name && parsed.murderer.name.length >= 2);
  if (!hasClearMurderer) constraintErrors.push("未明确标注凶手");

  if (isSolo && hasClearMurderer) {
    const murdererChar = chars.find(c => c.name === parsed.murderer.name);
    if (murdererChar && murdererChar.roleType !== "npc") {
      constraintErrors.push("单人本凶手必须是NPC嫌疑人");
    }
  }

  if (constraintErrors.length > 0) {
    return {
      ok: true,
      review: {
        sessionId, parsed,
        totalScore: 20, passed: false,
        scores: { storyCompleteness: 20, murdererDesign: 20, clueSystem: 20, characterDesign: 20, playability: 20 },
        dimensions: {},
        strengths: [], weaknesses: constraintErrors, suggestedPatches: [],
        revisionAdvice: `角色数量/结构违反硬性约束：${constraintErrors.join("；")}。玩家≤${MAX_PLAYERS}、NPC≤${MAX_NPC}、总计≤${MAX_TOTAL}，且有且仅有一个凶手。`,
      }
    };
  }

  const gameMode = isSolo ? "【单人侦探本】玩家扮演侦探，需从3个NPC中找出凶手" : (npcCount > 0 ? "【PVE】玩家+NPC嫌疑人" : "【PVP】纯玩家互疑");
  const context = `## 剧本基本信息
- 游戏模式：${gameMode}
- 标题：《${parsed.title || "未知"}》
- 时代背景：${parsed.setting?.era || "未知"}
- 地点：${parsed.setting?.location || "未知"}
- 玩家角色：${playerCount}人 / NPC嫌疑人：${npcCount}人 / 总计：${totalCount}人
- 玩家角色列表：${chars.filter(c => c.roleType !== "npc").map(c => c.name).join("、") || "未知"}
- NPC嫌疑人：${chars.filter(c => c.roleType === "npc").map(c => c.name).join("、") || "无"}
- 凶手：${parsed.murderer?.name || "未知"}
- 动机：${(parsed.murderer?.motive || "").substring(0, 500)}
- 手法：${(parsed.murderer?.method || "").substring(0, 500)}
- 第一轮线索数：${parsed.clues?.round1?.length || 0}
- 第二轮线索数：${parsed.clues?.round2?.length || 0}
- 第三轮线索数：${parsed.clues?.round3?.length || 0}

## 完整剧本（前8000字）
${markdown.substring(0, 8000)}`;

  try {
    const result = await generate(REVIEW_SYSTEM_PROMPT, context, { maxTokens: 3072, temperature: 0.3 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const review = JSON.parse(cleaned);
    review.sessionId = sessionId;
    review.parsed = parsed;
    // 从 dimensions 提取平铺 scores（兼容 admin.js 旧展示）
    review.scores = parseScores(review);
    review.passed = review.totalScore >= PASS_SCORE;
    review.dimensions = review.dimensions || {};
    review.suggestedPatches = review.suggestedPatches || [];
    return { ok: true, review };
  } catch (e) {
    console.warn("[review] LLM返回解析失败，使用默认评分：", e.message);
    const fallbackScore = 70;
    return {
      ok: true,
      review: {
        sessionId, parsed,
        totalScore: fallbackScore, passed: fallbackScore >= PASS_SCORE,
        scores: { storyCompleteness: 70, murdererDesign: 70, clueSystem: 70, characterDesign: 70, playability: 70 },
        dimensions: {},
        strengths: ["（评测解析异常，使用默认评分）"],
        weaknesses: ["评测结果解析失败，建议人工审查"],
        suggestedPatches: [],
        revisionAdvice: "评测Agent解析异常，请人工审查剧本质量。",
      },
    };
  }
}

async function reviewAndRevise(sessionId, onProgress) {
  const rounds = [];
  let currentSessionId = sessionId;

  for (let round = 1; round <= MAX_RETRIES; round++) {
    onProgress(`round${round}`, `第 ${round} 轮评测中...`);

    const result = await reviewScript(currentSessionId);
    if (!result.ok) return { ok: false, error: result.error, rounds };

    const review = result.review;
    rounds.push({
      round, sessionId: currentSessionId,
      totalScore: review.totalScore, passed: review.passed,
      scores: review.scores, dimensions: review.dimensions,
      strengths: review.strengths, weaknesses: review.weaknesses,
      suggestedPatches: review.suggestedPatches || [],
      advice: review.revisionAdvice,
    });

    if (review.passed) {
      onProgress("passed", `评测通过！总分 ${review.totalScore} 分，正在自动切分...`);
      const splitResult = await splitScript(currentSessionId, (stage, msg) => {
        onProgress("split_" + stage, msg);
      });
      if (splitResult.ok) {
        await deleteSession(currentSessionId);
        try { const { getRedis } = require("./game-manager"); await (await getRedis()).del(`script_meta:${currentSessionId}`); } catch (e) { /* skip */ }
      }
      return {
        ok: true, passed: true, sessionId: currentSessionId,
        finalScore: review.totalScore, totalRounds: round, rounds,
        splitted: splitResult.ok,
      };
    }

    if (round < MAX_RETRIES) {
      onProgress(`revise${round}`, `评测未通过（${review.totalScore}分），正在根据修改意见重新生成...`);
      try {
        const session = await getSession(currentSessionId);
        const originalInput = session?.metadata?.topic || (session?.messages?.find(m => m.role === "user")?.content) || "生成剧本";
        const meta = session?.metadata || {};
        const genConfig = {
          playerCount: parseInt(meta.playerCount) || LIMITS.maxPlayers,
          npcCount: parseInt(meta.npcCount) || 0,
          isPVE: meta.isPVE === "true",
        };

        // 将 suggestedPatches 也拼入修改要求
        const patchesText = (review.suggestedPatches || []).length
          ? `\n\n## 建议的具体修改项\n${review.suggestedPatches.map(p => `- [${p.type}] ${p.target}: ${p.operation} — ${p.description}`).join("\n")}`
          : "";

        const revisionInput = `## 修改要求（第${round}轮，基于评测反馈）
${review.revisionAdvice}${patchesText}

## 角色数量约束（必须遵守）
- 玩家角色：恰好${genConfig.playerCount}人
- NPC嫌疑人：${genConfig.npcCount > 0 ? '恰好' + genConfig.npcCount + '人' : '0人（PVP模式，无NPC）'}
- 总人数：${genConfig.playerCount + genConfig.npcCount}人

## 原有需求
${originalInput}`;

        const newResult = await buildMurderMystery(revisionInput, (stage, msg) => {
          onProgress(`gen_${stage}`, msg);
        }, genConfig);

        const newSession = await createSession({
          textType: "murder-mystery", topic: originalInput.slice(0, 100),
          templateName: "剧本杀",
          playerCount: String(genConfig.playerCount),
          npcCount: String(genConfig.npcCount),
          isPVE: String(genConfig.isPVE),
        });
        await addMessage(newSession.sessionId, "user", revisionInput);
        await addMessage(newSession.sessionId, "assistant", newResult.fullScript.substring(0, 50000));
        await deleteSession(currentSessionId);
        currentSessionId = newSession.sessionId;
      } catch (e) {
        return { ok: false, error: `第${round}轮重新生成失败: ${e.message}`, rounds };
      }
    }
  }

  onProgress("failed", `已进行 ${MAX_RETRIES} 轮评测和修改，仍未达到通过标准`);
  return {
    ok: true, passed: false, sessionId: currentSessionId,
    finalScore: rounds[rounds.length - 1]?.totalScore || 0,
    totalRounds: MAX_RETRIES, rounds,
  };
}

module.exports = { reviewScript, reviewAndRevise };
