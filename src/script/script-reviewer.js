// 剧本评测 Agent — 精简版：扮演挑剔玩家找时间线/线索链逻辑漏洞 + 自检清单（天眼/边缘/咬合/抗推位）
const { getSession } = require("../core/history-manager");
const { parseScript } = require("./script-parser");
const { generate } = require("../llm/generator");

const MAX_CONTEXT_CHARS = 12000; // 注入评测上下文的总字符上限（控成本）

const REVIEW_SYSTEM_PROMPT = `你是一位极度挑剔的硬核剧本杀玩家，同时兼任资深剧本杀编辑。请审读下面提供的剧本信息，先做"逻辑漏洞检查"，再做"成品自检清单"，两部分都必须输出。

## 第一部分：逻辑漏洞检查
找出时间线与线索链中所有逻辑漏洞，重点检查：
1. 作案时间是否冲突：各角色时间线之间、角色时间线与死亡/发现尸体时间之间是否自相矛盾
2. 线索是否指向唯一凶手：证据链能否收敛到唯一真凶，是否有关键线索把玩家引向错误且无法合理解释的方向
3. 有无多余线索误导到无法解释的方向：误导（红鲱鱼）线索是否都预留了"可排除"的解释路径
4. 角色动机是否充足：真凶动机是否足够强烈到杀人；各嫌疑人的"嫌疑动机"是否都成立

## 第二部分：成品自检清单
对照下面四项逐条给出结论，防止开本翻车：
1. **无天眼玩家**：是否存在某个角色掌握信息过多，导致只要他自曝，游戏直接结束？若有，指出是谁、暴露哪些信息会"天眼"。
2. **无边缘角色**：每个角色是否都有"唯一性"的信息或与他人不可替代的纠葛？是否存在与案件几乎无关、全程没戏份的边缘角色？若有，指出是谁。
3. **时间线咬合**：凶手/嫌疑人的证词是否都有其他人可通过"声响/灯光/目击"佐证或推翻的锚点？若有无法被佐证或推翻、完全孤立的说法，指出哪条。
4. **抗推位合理**：除真凶外，是否至少有 1-2 个玩家因"动机强烈"或"行踪可疑"而容易被冤枉？若完全没有人会顶锅（所有人一上来就锁定真凶），指出该问题。

## 输出要求
- 用纯文本分条输出。先输出「【逻辑漏洞】」段落，再输出「【自检清单】」段落。
- 每条尽量指出涉及的角色名、时间点或线索编号。
- 某方面没有问题就略过，不要为了凑数编造问题。
- 若整个逻辑漏洞检查没有任何发现，在【逻辑漏洞】段末明确写一行："未发现明显漏洞。"
- 【自检清单】中每项若达标写"通过"，不达标写"未通过：<原因>"。`;

/**
 * 组装评测上下文：基本设定 + 各角色时间线片段 + DM完整时间线 + 线索内容
 * （针对性喂给漏洞检查，比整本 markdown 首段更贴合时间线/线索链审查）
 */
function buildReviewContext(markdown, parsed) {
  const L = [];
  const playerChars = (parsed.characters || []).filter(c => c.roleType !== "npc");
  const npcChars = (parsed.characters || []).filter(c => c.roleType === "npc");

  L.push(`## 剧本基本信息
- 标题：《${parsed.title || "未知"}》
- 游戏模式：${parsed.setting?.gameMode || ""}（玩家${playerChars.length}人 / NPC${npcChars.length}人 / 共${(parsed.characters || []).length}人）
- 时代：${parsed.setting?.era || "未知"} | 地点：${parsed.setting?.location || "未知"}
- 凶手：${parsed.murderer?.name || "未知"} | 动机：${(parsed.murderer?.motive || "").substring(0, 300)}
- 手法：${(parsed.murderer?.method || "").substring(0, 300)}`);

  // 各角色（玩家+NPC）：关系/秘密/已知信息，供逻辑检查与自检清单共用
  if ((parsed.characters || []).length) {
    L.push("\n## 各角色信息");
    for (const c of parsed.characters) {
      const s = c.script || {};
      const isMurderer = c.isMurderer ? "【凶手】" : "";
      L.push(`### ${c.name}（${c.roleType === "npc" ? "NPC" : "玩家"}）${isMurderer} 职业：${c.occupation || ""}`);
      // 故事开头片段：含身份与死者/他人纠葛，判断边缘角色与抗推位用
      const storyHead = String(s.story || s.fullScript || "").substring(0, 350);
      if (storyHead) L.push(`- 人物与纠葛（节选）：${storyHead.replace(/\n+/g, " ")}`);
      const tl = (s.personalTimeline || "").substring(0, 300);
      if (tl) L.push(`- 时间线：${tl.replace(/\n+/g, " ")}`);
      // 秘密与已知信息：判断"天眼/边缘/动机"的关键
      if (s.secret) L.push(`- 秘密：${String(s.secret).substring(0, 160).replace(/\n+/g, " ")}`);
      if (s.knownInfo) L.push(`- 已知：${String(s.knownInfo).substring(0, 160).replace(/\n+/g, " ")}`);
      if (s.goals) L.push(`- 目标/想查明：${String(s.goals).substring(0, 100).replace(/\n+/g, " ")}`);
    }
  }

  // DM 完整时间线（权威基准） + 真相复盘
  const dmTimeline = (parsed.dmGuide?.fullTimeline || "").substring(0, 1500);
  if (dmTimeline) L.push(`\n## DM完整时间线（权威基准）\n${dmTimeline}`);
  const truth = (parsed.dmGuide?.truthReveal || "").substring(0, 1200);
  if (truth) L.push(`\n## DM真相复盘（片段）\n${truth}`);

  // 线索内容（首段截断，展示证据链指向）
  const clueParts = [];
  const rounds = [
    { key: "round1", label: "第一轮" },
    { key: "round2", label: "第二轮" },
    { key: "round3", label: "第三轮" },
  ];
  for (const r of rounds) {
    const list = parsed.clues?.[r.key] || [];
    if (!list.length) continue;
    clueParts.push(`【${r.label}】`);
    for (const c of list) {
      clueParts.push(`- ${c.id || ""}${c.location ? "（" + c.location + "）" : ""}：${(c.content || "").substring(0, 80)}`);
    }
  }
  if (clueParts.length) L.push("\n## 线索内容\n" + clueParts.join("\n"));

  let ctx = L.join("\n");
  if (ctx.length > MAX_CONTEXT_CHARS) ctx = ctx.substring(0, MAX_CONTEXT_CHARS) + "\n...（上下文截断）";
  return ctx;
}

/**
 * 评测剧本：扮演挑剔玩家找时间线/线索链逻辑漏洞，输出纯文本报告
 * @returns {Promise<{ok:boolean, review?:object, error?:string}>}
 *   review = { sessionId, parsed, report }
 */
async function reviewScript(sessionId, onProgress) {
  const session = await getSession(sessionId);
  if (!session) return { ok: false, error: "剧本不存在" };

  const messages = session.messages || [];
  const markdown = messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
  if (!markdown || markdown.length < 500) return { ok: false, error: "剧本内容为空或过短" };

  const parsed = parseScript(markdown);
  const context = buildReviewContext(markdown, parsed);

  if (onProgress) onProgress("context", "已提取剧本信息，正在寻找逻辑漏洞...");

  try {
    const result = await generate(REVIEW_SYSTEM_PROMPT, context, { maxTokens: 3072, temperature: 0.3 });
    const report = String(result.content || "").trim();
    if (!report) return { ok: false, error: "评测结果为空" };

    return {
      ok: true,
      review: {
        sessionId,
        parsed,
        report: report.length > 20000 ? report.substring(0, 20000) : report,
      },
    };
  } catch (e) {
    console.warn("[review] 评测调用失败:", e.message);
    return {
      ok: false,
      error: `评测失败：${e?.message || "未知错误"}`,
    };
  }
}

module.exports = { reviewScript };
