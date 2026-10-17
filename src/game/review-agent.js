// 复盘 Agent — 为**单个玩家**生成个性化复盘报告
//
// 与 /api/player/review/:code 的区别：那个给的是全局复盘（凶手是谁、投票分布），
// 这里回答的是玩家真正在意的那个问题 —— "**我**当时为什么想错了？我错过了什么？"
//
// 设计要点：
//   - 提示词构造（buildReviewUserPrompt）是纯函数，可独立测试，不碰网络
//   - 玩家发言是不可信输入，统一走 prompt-safety 隔离（和 NPC/AI 玩家同一套）
//   - LLM 不可用时不报错，回退到基于数据确定性拼装的基础复盘
const agnes = require("../llm/agnes-client");
const { generate, textOf } = require("../llm/generator");
const safety = require("../llm/prompt-safety");
const { HARDENING_RULES } = safety;

/** 复盘生成超时（ms）：页面加载触发，不宜让玩家干等 */
const REVIEW_TIMEOUT = 25000;

/** 报告固定小节 —— 前端按标题渲染，测试也据此断言 */
const SECTIONS = [
  "你的推理轨迹",
  "转折点",
  "你错过的线索",
  "你的秘密",
  "你的个人目标",
  "一句话点评",
];

function buildReviewSystemPrompt() {
  return `你是剧本杀复盘分析师。游戏已经结束，真相已公开，你要为**某一位玩家**写一份只给他看的复盘。

## 写作要求
- 只依据下面提供的材料。**不要编造**剧本里没有的情节、线索或对话。
- 具体优先于笼统：说"你第二轮的发言把它当成不在场证明"，而不是"你的推理有偏差"。
- 语气像一位懂行的朋友在局后跟你聊，客观但不刻薄；该指出问题时直说，不要为了安慰而含糊。
- 如果他判断对了，说清楚是**哪一步**让他抓住了关键，而不是简单夸一句"推理很棒"。
- 如果他判断错了，指出**最能改变结论的那一条信息**是什么。
- 用第二人称"你"。

## 输出格式（markdown，严格用这六个二级标题，顺序不变）
## ${SECTIONS[0]}
（2-4 句：你当时的怀疑对象与主要依据）

## ${SECTIONS[1]}
（1-3 句：整局里最关键的那次判断，以及它是对是错）

## ${SECTIONS[2]}
（列 1-3 条，每条写清楚：线索内容 → 它真正指向什么 → 你当时怎么误读了）

## ${SECTIONS[3]}
（1-2 句：你隐藏的秘密有没有被看穿，依据是什么；若你本就是凶手，写你的伪装是否成功）

## ${SECTIONS[4]}
（先给结论：**做到** / **部分做到** / **没做到**，然后 1-3 句说明依据 ——
必须引用本局实际发生过的发言、搜证或投票作为证据。没做到时要点出是哪一步暴露或放弃了它。
如果材料里没有给出个人目标，就写"本局未设置个人目标"。）

## ${SECTIONS[5]}
（一句话总评，30 字以内）

总共 450-800 字。直接输出 markdown，不要开场白、不要结语、不要代码块围栏。

${HARDENING_RULES}`;
}

/**
 * 构造复盘的用户提示（纯函数，可测）。
 * 玩家发言/角色名等不可信输入统一走 safety 隔离。
 * @param {object} ctx 见 routes/player.js 的组装
 */
function buildReviewUserPrompt(ctx) {
  const c = ctx || {};
  const murderer = c.murderer || {};

  const myClues = (c.myClues || []).length
    ? c.myClues.map(x => "- " + safety.neutralize(x, 200)).join("\n")
    : "（你一条线索都没找到）";

  const publicClues = (c.publicClues || []).length
    ? c.publicClues.map(x => "- " + safety.neutralize(x, 200)).join("\n")
    : "（本局没有线索被公开）";

  const myStatements = (c.myStatements || []).filter(Boolean);
  const transcript = (c.transcript || []).filter(Boolean);

  return `## 本局基本信息
剧本：《${safety.safeLabel(c.title || "未知", 40)}》
你的角色：${safety.safeLabel(c.characterName || "未知")}${c.isMurderer ? "（你就是凶手）" : ""}
真相：凶手是 ${safety.safeLabel(murderer.name || "未知")}
作案手法：${safety.neutralize(murderer.method, 600) || "（未记录）"}
作案动机：${safety.neutralize(murderer.motive, 600) || "（未记录）"}

## 官方真相复盘（权威，你的分析必须与它一致）
${safety.wrapUntrusted(c.truthReveal, { label: "dm-truth", maxLen: 2500 }) || "（未记录）"}

## 你的角色秘密
${safety.wrapUntrusted(c.secret, { label: "own-secret", maxLen: 800 }) || "（无）"}

## 你的说话方式（角色设定）
${safety.neutralize(c.personality, 200) || "（未设置）"}

## 你的个人目标（要判定你是否做到）
${safety.wrapUntrusted(c.goal, { label: "own-goal", maxLen: 400 }) || "（本局未设置个人目标）"}

## 你自己找到的线索
${myClues}

## 全场公开的线索
${publicClues}

## 你说过的原话（用于判断你的推理轨迹）
${myStatements.length ? safety.wrapUntrusted(myStatements.map(x => "- " + safety.neutralize(x, 200)).join("\n"), { label: "own-statements", maxLen: 2500 }) : "（你整局没怎么发言）"}

## 公开讨论记录
${transcript.length ? safety.wrapUntrusted(transcript.map(x => safety.neutralize(x, 200)).join("\n"), { label: "transcript", maxLen: 3500 }) : "（无）"}

## 结果
你的投票：${c.myVote ? "投给了 " + safety.safeLabel(c.myVote) : "没有投票"}
判定：${outcomeText(c.outcome)}

请按格式为这位玩家写复盘。`;
}

/** 把投票结果翻译成人话（也用于无 LLM 时的基础复盘） */
function outcomeText(outcome) {
  switch (outcome) {
    case "true_accusation": return "成功指认真凶";
    case "wrong_accusation": return "指认了无辜者，真凶逃脱";
    case "tie": return "票数平局，真凶趁乱逃脱";
    case "no_votes": return "无人投票";
    default: return "未判定";
  }
}

/**
 * LLM 不可用时的确定性复盘 —— 至少把事实说清楚，而不是给玩家一个错误页。
 * @param {object} ctx
 */
function buildFallbackReview(ctx) {
  const c = ctx || {};
  const murderer = c.murderer || {};
  const lines = [
    `## ${SECTIONS[0]}`,
    c.myVote
      ? `你最终投给了 ${c.myVote}，${outcomeText(c.outcome)}。`
      : `你这一局没有投票，${outcomeText(c.outcome)}。`,
    "",
    `## ${SECTIONS[1]}`,
    `真相是：凶手 ${murderer.name || "未知"}${murderer.method ? "，" + String(murderer.method).slice(0, 120) : ""}`,
    "",
    `## ${SECTIONS[2]}`,
    `你一共找到 ${(c.myClues || []).length} 条线索，全场共公开 ${(c.publicClues || []).length} 条。`,
    "",
    `## ${SECTIONS[3]}`,
    c.isMurderer ? "你本局就是凶手。" : "你的秘密是否被看穿，可以回看投票结果。",
    "",
    `## ${SECTIONS[4]}`,
    c.goal ? `你的个人目标是：「${c.goal}」——详细判定需要模型服务，当前不可用。` : "本局未设置个人目标。",
    "",
    `## ${SECTIONS[5]}`,
    "详细点评暂时无法生成（模型服务不可用），以上为本局事实摘要。",
  ];
  return lines.join("\n");
}

/**
 * 生成个性化复盘。
 * @param {object} ctx
 * @returns {Promise<{ text: string, source: "llm"|"fallback" }>}
 */
async function generatePersonalReview(ctx) {
  const c = ctx || {};
  const system = buildReviewSystemPrompt();
  const user = buildReviewUserPrompt(c);

  const CHANNELS = [
    () => agnes.chat(system, user, {
      maxTokens: 2000, temperature: 0.7,
      priority: "background", timeoutMs: REVIEW_TIMEOUT, label: "review.personal",
      sessionId: c.roomCode ? String(c.roomCode) + ":review" : undefined,
    }),
    () => generate(system, user, { maxTokens: 1400, temperature: 0.7 }),
  ];

  for (const call of CHANNELS) {
    let timer = null;
    try {
      const answer = await Promise.race([
        call(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("review_timeout")), REVIEW_TIMEOUT);
        }),
      ]);
      // 两条通道返回形状不同（字符串 vs {content}），统一用 textOf 取值
      const text = textOf(answer).trim();
      // 太短的多半是模型敷衍或截断，不值得当作复盘展示
      if (text && text !== "null" && text.length >= 80) {
        return { text, source: "llm" };
      }
    } catch (err) {
      console.warn("[review-agent] 复盘通道失败:", err.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { text: buildFallbackReview(c), source: "fallback" };
}

module.exports = {
  SECTIONS,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  buildFallbackReview,
  outcomeText,
  generatePersonalReview,
};
