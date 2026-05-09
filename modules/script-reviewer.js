// 剧本评测 Agent — 审查剧本质量，不合格则提出修改意见并触发重新生成

const { getSession, addMessage, createSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
const { buildMurderMystery } = require("./murder-mystery-builder");
const { splitScript } = require("./script-splitter");

const MAX_RETRIES = 3;
const PASS_SCORE = 75; // 满分100，75分通过

const REVIEW_SYSTEM_PROMPT = `你是一位资深剧本杀评测专家。你需要从多个维度审查一份剧本杀剧本的质量。

## 硬性约束（不合格直接扣分到不通过）

1. **角色数量合规 (一票否决)**：
   - 玩家角色：≤6人
   - NPC嫌疑人：≤3人
   - 总角色数：≤9人
   - 必须区分【玩家】和【NPC】角色类型
   - 违反任何一条直接判定为不合格

## 评分维度（每项0-100分）

1. **故事完整性 (25%)**：
   - 故事是否有清晰的开端、发展、高潮、结局？
   - 世界观设定是否自洽？
   - 人物关系是否完整且合理？

2. **凶手设计 (25%)**：
   - 凶手的动机是否充分且深刻？（不能是简单的仇杀或财杀）
   - 作案手法是否新颖且符合世界观？
   - 手法在故事背景下是否真实可行？

3. **线索系统 (20%)**：
   - 线索是否分层清晰？（表面→深入→关键）
   - 证据链是否完整可推理？
   - 是否存在无效或冗余线索？

4. **角色设计 (15%)**：
   - 每个角色是否都有独立的故事和秘密？
   - 角色之间是否有复杂的利益纠葛？

5. **可玩性 (15%)**：
   - 玩家能否通过线索推理出凶手？
   - 推理难度是否合适？

## 输出格式（JSON）
{
  "totalScore": 85,
  "passed": true,
  "scores": {"storyCompleteness":90,"murdererDesign":85,"clueSystem":80,"characterDesign":85,"playability":85},
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["问题1", "问题2"],
  "revisionAdvice": "具体的修改建议"
}`;

/**
 * 评测剧本
 */
async function reviewScript(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return { ok: false, error: "剧本不存在" };

  const messages = session.messages || [];
  const markdown = messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
  if (!markdown || markdown.length < 500) return { ok: false, error: "剧本内容为空或过短" };

  const parsed = parseScript(markdown);

  // 统计角色类型
  const chars = parsed.characters || [];
  const playerCount = chars.filter(c => c.roleType !== "npc").length;
  const npcCount = chars.filter(c => c.roleType === "npc").length;
  const totalCount = chars.length;

  // 硬性约束检查
  const constraintErrors = [];
  if (totalCount > 9) constraintErrors.push(`总角色数超限(${totalCount}/9)`);
  if (playerCount > 6) constraintErrors.push(`玩家角色数超限(${playerCount}/6)`);
  if (npcCount > 3) constraintErrors.push(`NPC数超限(${npcCount}/3)`);

  if (constraintErrors.length > 0) {
    return {
      ok: true,
      review: {
        sessionId, parsed,
        totalScore: 20,
        passed: false,
        scores: { storyCompleteness: 20, murdererDesign: 20, clueSystem: 20, characterDesign: 20, playability: 20 },
        strengths: [],
        weaknesses: [],
        revisionAdvice: `角色数量违反硬性约束：${constraintErrors.join("；")}。玩家≤6、NPC≤3、总计≤9。请重新生成。`,
      }
    };
  }

  // 构建评测上下文
  const context = `## 剧本基本信息
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
    const result = await generate(REVIEW_SYSTEM_PROMPT, context, { maxTokens: 2048, temperature: 0.3 });
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "")
      .replace(/^[^{]*\{/, "{").replace(/\}[^}]*$/, "}");

    const review = JSON.parse(cleaned);
    review.sessionId = sessionId;
    review.parsed = parsed;
    review.passed = review.totalScore >= PASS_SCORE;
    return { ok: true, review };
  } catch (e) {
    // JSON解析失败，尝试宽松评分
    console.error("评测解析失败：", e.message);
    return {
      ok: true,
      review: {
        sessionId,
        parsed,
        totalScore: 70,
        passed: false,
        scores: { storyCompleteness: 70, murdererDesign: 70, clueSystem: 70, characterDesign: 70, playability: 70 },
        strengths: ["（评测解析异常，使用默认评分）"],
        weaknesses: ["评测结果解析失败，建议人工审查"],
        revisionAdvice: "评测Agent解析异常，请人工审查剧本质量。如需重新生成，请提供具体的修改方向。",
      },
    };
  }
}

/**
 * 评测+重新生成流程（最多3轮）
 */
async function reviewAndRevise(sessionId, onProgress) {
  const rounds = [];
  let currentSessionId = sessionId;

  for (let round = 1; round <= MAX_RETRIES; round++) {
    onProgress(`round${round}`, `第 ${round} 轮评测中...`);

    // 1. 评测
    const result = await reviewScript(currentSessionId);
    if (!result.ok) return { ok: false, error: result.error, rounds };

    const review = result.review;
    rounds.push({
      round,
      sessionId: currentSessionId,
      totalScore: review.totalScore,
      passed: review.passed,
      scores: review.scores,
      strengths: review.strengths,
      weaknesses: review.weaknesses,
      advice: review.revisionAdvice,
    });

    // 2. 通过则自动切分
    if (review.passed) {
      onProgress("passed", `评测通过！总分 ${review.totalScore} 分，正在自动切分...`);
      const splitResult = await splitScript(currentSessionId, (stage, msg) => {
        onProgress("split_" + stage, msg);
      });
      if (splitResult.ok) {
        // 清理原始数据
        await deleteSession(currentSessionId);
        try { const { getRedis } = require("./game-manager"); await (await getRedis()).del(`script_meta:${currentSessionId}`); } catch (e) { /* skip */ }
      }
      return {
        ok: true,
        passed: true,
        sessionId: currentSessionId,
        finalScore: review.totalScore,
        totalRounds: round,
        rounds,
        splitted: splitResult.ok,
      };
    }

    // 3. 未通过且不是最后一轮，则重新生成
    if (round < MAX_RETRIES) {
      onProgress(`revise${round}`, `评测未通过（${review.totalScore}分），正在根据修改意见重新生成...`);

      try {
        const session = await getSession(currentSessionId);
        const originalInput = session?.metadata?.topic || (session?.messages?.find(m => m.role === "user")?.content) || "生成剧本";

        // 构建带修改意见的输入
        const revisionInput = `【修改要求 — 基于评测反馈（第${round}轮）】\n${review.revisionAdvice}\n\n【原有需求】\n${originalInput}`;

        const newResult = await buildMurderMystery(revisionInput, (stage, msg) => {
          onProgress(`gen_${stage}`, msg);
        });

        // 创建新会话保存修改后的剧本
        const newSession = await createSession({
          textType: "murder-mystery",
          topic: originalInput.slice(0, 100),
          templateName: "剧本杀",
        });
        await addMessage(newSession.sessionId, "user", revisionInput);
        await addMessage(newSession.sessionId, "assistant", newResult.fullScript.substring(0, 50000));
        // 清理旧会话
        await deleteSession(currentSessionId);
        currentSessionId = newSession.sessionId;
      } catch (e) {
        return { ok: false, error: `第${round}轮重新生成失败: ${e.message}`, rounds };
      }
    }
  }

  // 3轮后仍未通过
  onProgress("failed", `已进行 ${MAX_RETRIES} 轮评测和修改，仍未达到通过标准`);
  return {
    ok: true,
    passed: false,
    sessionId: currentSessionId,
    finalScore: rounds[rounds.length - 1]?.totalScore || 0,
    totalRounds: MAX_RETRIES,
    rounds,
  };
}

module.exports = { reviewScript, reviewAndRevise, PASS_SCORE, MAX_RETRIES };
