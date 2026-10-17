// 时间线一致性后处理 — 生成流水线末端自动校准
// 原理：从框架/DM 章节提取"权威基准时间线"，用 LLM 逐角色审查冲突，
// 只重写存在冲突的角色时间线章节（保留故事/秘密等其它内容）。
// LLM 失败/未配置时静默返回原文，绝不阻塞生成主流程。

const { generate } = require("../llm/generator");

// ==================== 纯函数（可单测） ====================

/** 提取标题（headingRe）之后的 markdown 表格为 {time, event} 列表 */
function extractTableAfter(text, headingRe) {
  const m = text.match(new RegExp(headingRe.source + "[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s|\\n---|\\n## |$)"));
  if (!m) return [];
  const entries = [];
  for (const line of m[1].split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // 表头/分隔行跳过（"时间/地点/事件"或无具体时刻的 --- 行）
    if (/^(时间|地点|事件|相关人员)$/.test(cells[0])) continue;
    if (/-{2,}/.test(cells[0])) continue;
    entries.push({ time: cells[0], event: cells.slice(1).join(" ").substring(0, 150) });
  }
  return entries.slice(0, 60);
}

/**
 * 提取权威基准时间线：合并 DM"真实时间线"（优先）与框架"故事时间线"（补缺公共锚点，
 * 如全员抵达时刻/呼救/发现尸体）。返回 [{time, event}]
 */
function extractBaseline(fullText) {
  if (!fullText) return [];
  const real = extractTableAfter(fullText, /真实时间线/);
  const frame = extractTableAfter(fullText, /故事时间线/);
  if (!real.length && !frame.length) return [];
  const merged = [...real];
  const times = new Set(real.map(b => b.time));
  for (const f of frame) {
    if (!times.has(f.time)) { merged.push({ ...f, time: f.time }); times.add(f.time); }
  }
  return merged.slice(0, 60);
}

/**
 * 提取所有"角色时间线"章节（排除基准类：故事时间线/表面时间线/真实时间线/DM总时间线，
 * 这些是权威依据而非待审对象）。返回 [{anchor, content, owner, ordinal}]
 * - owner：所属角色区块（最近的上层 ### 玩家角色 N / NPC N 标题），用于区分"同名时间线章节"
 * - ordinal：该 anchor 在全文中的第几次出现（1-based），替换时精确定位，避免多个角色
 *   共用同一标题（如"### 二、你的时间线…"）时修订全部写进第一个角色。
 */
function extractTimelineSections(fullText) {
  if (!fullText) return [];
  const EXCLUDE = /(故事时间线|表面时间线|真实时间线|^##\s*[一二三四五六七八九十]+、\s*完整时间线)/;
  const sections = [];
  const lines = fullText.split("\n");
  const anchorCount = new Map();
  let owner = "";
  let i = 0;
  while (i < lines.length) {
    // 记录当前所属角色区块（玩家角色 N：xxx / NPC N：xxx）
    const ownerMatch = lines[i].match(/^#{2,4}\s*((?:玩家角色|NPC)\s*\d+\s*[:：].*)$/);
    if (ownerMatch) owner = ownerMatch[1].trim();
    const hl = lines[i].match(/^(#{1,4})\s+(.*时间线[^\n]*)$/);
    if (hl) {
      const anchor = lines[i];
      if (!EXCLUDE.test(anchor)) {
        const body = [];
        i++;
        while (i < lines.length) {
          if (/^#{1,4}\s+/.test(lines[i])) break;
          body.push(lines[i]);
          i++;
        }
        const ord = (anchorCount.get(anchor) || 0) + 1;
        anchorCount.set(anchor, ord);
        sections.push({ anchor, content: body.join("\n").trim(), owner, ordinal: ord });
        continue;
      }
    }
    i++;
  }
  return sections;
}

/**
 * 用锚标题替换原文中对应章节的正文（标题行保留，替换到下一个标题为止）
 * @param {string} fullText
 * @param {string} anchorTitle 锚标题（如 "### 二、你的时间线（…）"）
 * @param {string} newContent 新正文
 * @param {number} [ordinal=1] 该标题在全文中的第几次出现（1-based）——
 *   多个角色共用同一时间线标题时必须指定，否则修订会全部落到第一个角色
 * @returns {string|null} 替换后的全文；锚点不存在返回 null
 */
function replaceSection(fullText, anchorTitle, newContent, ordinal = 1) {
  if (!anchorTitle) return null;
  let idx = -1;
  let from = 0;
  for (let n = 0; n < Math.max(1, ordinal); n++) {
    idx = fullText.indexOf(anchorTitle, from);
    if (idx < 0) return null;
    from = idx + anchorTitle.length;
  }
  const start = fullText.indexOf("\n", idx);
  if (start < 0) return null;
  const rest = fullText.slice(start + 1);
  const next = rest.match(/\n#{1,6}\s+/);
  const end = next ? start + 1 + next.index : fullText.length;
  return fullText.slice(0, start + 1) + String(newContent || "").trim() + "\n" + fullText.slice(end);
}

/** LLM 输出容错 JSON 解析 */
function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* continue */ }
  let cand = text;
  const fenced = cand.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) cand = fenced[1];
  try { return JSON.parse(cand); } catch (e) { /* continue */ }
  const start = cand.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < cand.length; i++) {
      if (cand[i] === "{") depth++;
      else if (cand[i] === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cand.slice(start, i + 1)); } catch (e) { break; }
        }
      }
    }
  }
  return null;
}

// ==================== 主流程 ====================

const SYSTEM = `你是剧本杀创作总监，负责剧本时间线一致性校验。对每个提供的角色时间线章节，逐项做硬检查判定（这是判断题，不是创作题：不满足任何一项即为冲突）。

硬检查项（每项输出 true=一致 / false=冲突）：
1. arrival：该角色的到场/在场时刻表述，与基准"全员同一时刻抵达并在场"一致（若基准或他章显示某时刻全员在场，本章不得写成案发后才到/次日才到）
2. deathDiscovery：毒发、呼救、发现尸体时刻与基准一致
3. noAfterDeathTalk：不得出现"死者死亡或密室形成之后，仍与其交谈/听到其交谈"的表述
4. noTwoPlaces：不得出现同一时刻身处两处的描述
5. order：事件顺序与基准一致（无"先发现后勘察"之类的倒置）

输出 JSON（两个字段）：
{
  "audit": [{"index":章节编号,"checks":{"arrival":true,"deathDiscovery":true,"noAfterDeathTalk":true,"noTwoPlaces":true,"order":true},"reason":"一句话依据"}],
  "revisions": [{"index":有冲突的章节编号,"newContent":"重写后的完整章节正文（不含标题行，保留原格式，时间与基准严格对齐；角色秘密/行为只做时间对齐，不丢失不新增）"}]
}
要求：
- audit 必须覆盖每一个章节（一个都不能少），每项的 true/false 必须基于全文实际内容判断，禁止一律 true
- 任一检查项为 false 的章节，必须同时出现在 revisions 中并提供修正
- 只输出 JSON，不要任何解释文字`;

/**
 * 已知矛盾示例：二轮复查时附加，诱导模型以同型眼光复查
 */
const EXAMPLE_CONFLICT = `【真实案例（用于二轮复查时的诊断带）】
基准：19:30 两名侦探同时抵达宅邸，当晚共同经历谋杀全过程（22:40 发现尸体）。
角色章节A："18:00 抵达，19:00 与死者喝茶交谈，20:00 争吵" → arrival=false（到场 18:00 vs 基准 19:30）
角色章节B："中午抵达，管家告知死者昨晚已去世，尸首还在书房" → arrival=false（致命：同局玩家一个当晚在场、一个案发后抵达，必须重写为当日同时抵达并在场）
请对照上述模式，逐章检查 arrival/deathDiscovery 等项是否也存在 false。`;

/**
 * 校准用 LLM 调用：优先 agnes（独立线路、通常更稳），失败回退 generator(deepseek 通道)
 * @returns {Promise<{content: string}>}
 */
async function callForCalibration(systemMsg, userMsg, maxTokens, temperature) {
  try {
    const { chatMessages } = require("../llm/agnes-client");
    const content = await chatMessages(
      [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }],
      { maxTokens, temperature },
    );
    if (content) return { content };
  } catch (e) { console.warn("[timeline] agnes 校准调用失败，切 deepseek:", e.message); }
  return generate(systemMsg, userMsg, { maxTokens, temperature });
}

/**
 * 主入口：对完整剧本做时间线一致性校准（audit 强制逐章；空修订时二轮复查）
 * @param {string} fullText 完整剧本 markdown
 * @param {function} [onProgress] 进度回调
 * @returns {Promise<string>} 校准后的全文（失败则原样返回）
 */
async function fixTimeline(fullText, onProgress) {
  if (!fullText || fullText.length < 2000) return fullText;
  const baseline = extractBaseline(fullText);
  if (baseline.length < 2) return fullText;

  if (onProgress) onProgress("正在提取基准时间线并审查各角色时间线...");
  const sections = extractTimelineSections(fullText);
  if (!sections.length) return fullText;
  const anchors = sections.map(s => s.anchor);

  const baselineText = baseline.map(b => `${b.time} | ${b.event}`).join("\n");
  const sectionsText = sections.map((s, i) =>
    `【章节 ${i + 1}】${s.owner ? "（角色：" + s.owner + "）" : ""}${s.anchor}\n${s.content.substring(0, 1800)}`
  ).join("\n\n");

  /** 应用 revisions：兼容多种字段命名（index/id/no/chapter、newContent/content/text）、0/1-based、anchor 标题 */
  function applyRevisions(out, revisions) {
    let applied = 0, skipped = 0;
    for (const rev of (Array.isArray(revisions) ? revisions : [])) {
      if (!rev || typeof rev !== "object") { skipped++; continue; }
      const content = rev.newContent || rev.content || rev.text || rev.new_text;
      if (typeof content !== "string" || !content.trim()) {
        console.warn("[timeline] 修订内容缺失:", JSON.stringify(rev).slice(0, 220));
        skipped++;
        continue;
      }
      let exact = null;
      let ordinal = 1;
      let origin = null; // 命中的原章节，供下方长度护栏使用
      const idx = Number(rev.index ?? rev.id ?? rev.no ?? rev.chapter);
      if (Number.isFinite(idx)) {
        // 兼容 1-based / 0-based / 略偏一位
        const cand = sections[idx - 1] || sections[idx] || sections[idx + 1];
        if (cand) { exact = cand.anchor; ordinal = cand.ordinal; origin = cand; }
      }
      if (!exact) {
        exact = matchAnchor(rev.anchor || rev.title || rev.section, anchors);
        if (exact) {
          // 匹配到标题后，用 owner（角色区块）或出现序号确定是哪一章
          const cand = sections.find(s => s.anchor === exact && s.ordinal === 1);
          const byOwner = rev.owner ? sections.find(s => s.anchor === exact && s.owner && s.owner.includes(String(rev.owner))) : null;
          origin = byOwner || cand || null;
          ordinal = (origin || { ordinal: 1 }).ordinal;
        }
      }
      if (!exact) {
        console.warn("[timeline] 章节定位失败:", JSON.stringify(rev).slice(0, 220));
        skipped++;
        continue;
      }
      // 长度护栏：修订正文若显著短于原章节，判为 LLM 偷懒/截断，拒绝替换。
      // 历史缺陷：此处原本无任何校验，任何非空字符串都会整段覆盖原章节，
      // 导致完整时间线被一句话静默销毁且不留痕迹（实测出现 82 字/1 条的时间线）。
      const origLen = origin ? origin.content.length : 0;
      const newLen = content.trim().length;
      if (origLen >= 400 && newLen < origLen * 0.5) {
        console.warn(`[timeline] 拒绝过短修订（${exact.slice(0, 30)}）：原 ${origLen} 字 → 新 ${newLen} 字，疑似截断`);
        skipped++;
        continue;
      }
      const replaced = replaceSection(out, exact, content, ordinal);
      if (replaced && replaced !== out) { out = replaced; applied++; } else { skipped++; }
    }
    return { out, applied, skipped };
  }

  try {
    let result = await callForCalibration(SYSTEM,
      `【基准时间线】\n${baselineText}\n\n【各角色时间线章节】\n${sectionsText}\n\n请逐章审查并输出 JSON：`,
      9000, 0.3);

    let parsed = tryParseJson(result.content);
    let revisions = Array.isArray(parsed?.revisions) ? parsed.revisions : [];

    // 空修订 → 二轮复查（注入同型矛盾示例，防 LLM 偷懒整体判 OK）
    if (!revisions.length) {
      if (onProgress) onProgress("首轮未发现冲突，进行二轮复查...");
      result = await callForCalibration(SYSTEM,
        `${EXAMPLE_CONFLICT}\n\n【基准时间线】\n${baselineText}\n\n【各角色时间线章节】\n${sectionsText}\n\n请参照示例中的矛盾模式逐章复查，输出 JSON（audit 必须全覆盖，有冲突必须给 revisions）：`,
        9000, 0.5);
      parsed = tryParseJson(result.content);
      revisions = Array.isArray(parsed?.revisions) ? parsed.revisions : [];
    }

    if (!revisions.length) {
      if (onProgress) onProgress("时间线检查通过（两轮审查均无冲突）");
      return fullText;
    }
    const { out: finalOut, applied } = applyRevisions(fullText, revisions);
    if (onProgress) onProgress(`时间线一致性校准完成：修订 ${applied}/${revisions.length} 处冲突`);
    return finalOut;
  } catch (e) {
    console.warn("[timeline] 一致性校准失败，保留原文:", e.message);
    return fullText;
  }
}

/**
 * 容错锚匹配：LLM 输出的 anchor 可能与原文标题有细微差异（半角全角括号/空格），
 * 用代码侧提取的精确章节标题（anchors）做模糊匹配，返回精确标题或 null
 */
function matchAnchor(revAnchor, anchors) {
  if (!revAnchor) return null;
  const a = revAnchor.trim();
  if (anchors.includes(a)) return a;
  // 包含关系
  const byContains = anchors.find(x => x.includes(a) || a.includes(x));
  if (byContains) return byContains;
  // 归一化（去空白）后再试
  const norm = s => s.replace(/\s+/g, "").replace(/[（）()]/g, "()").trim();
  const na = norm(a);
  return anchors.find(x => norm(x) === na) || null;
}

module.exports = { fixTimeline, extractBaseline, extractTimelineSections, replaceSection, extractTableAfter, matchAnchor };