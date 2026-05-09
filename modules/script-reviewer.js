// 剧本评测 Agent — 审查剧本质量，不合格则提出修改意见并触发重新生成

const { getSession, addMessage, createSession, deleteSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("./generator");
const { buildMurderMystery } = require("./murder-mystery-builder");
const { splitScript } = require("./script-splitter");

const MAX_RETRIES = 3;
const PASS_SCORE = 75; // 满分100，75分通过

const REVIEW_SYSTEM_PROMPT = `你是一位资深剧本杀评测专家。你需要从多个维度审查一份剧本杀剧本的质量。

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
   - 是否每个角色都有作案动机（增加推理难度）？

5. **可玩性 (15%)**：
   - 玩家能否通过线索推理出凶手？
   - 推理难度是否合适？（不能太简单也不能不可能）
   - 剧本流程设计是否合理？

## 输出格式（必须严格遵循JSON格式）

{
  "totalScore": 85,
  "passed": true,
  "scores": {
    "storyCompleteness": 90,
    "murdererDesign": 85,
    "clueSystem": 80,
    "characterDesign": 85,
    "playability": 85
  },
  "strengths": ["故事背景设定很有沉浸感", "凶手动机层次丰富"],
  "weaknesses": ["第三轮线索数量不足", "角色C的秘密与其他角色关联较弱"],
  "revisionAdvice": "请重点改进以下方面：\n1. 补充第三轮关键线索，确保至少有8-10条\n2. 加强角色C与其他角色的秘密关联\n3. ..."
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

  // 构建评测上下文
  const context = `## 剧本基本信息
- 标题：《${parsed.title || "未知"}》
- 时代背景：${parsed.setting?.era || "未知"}
- 地点：${parsed.setting?.location || "未知"}
- 角色数量：${parsed.characters?.length || 0}
- 角色：${parsed.characters?.map(c => c.name).join("、") || "未知"}
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
