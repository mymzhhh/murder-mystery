// 权威表落地（story-bible 的执行层）：补齐 / 逐人对账 / 跨角色裁定。
//
// 为什么单独成文件而不是塞进 murder-mystery-builder：
//   builder 已经 3900+ 行；把"查与改"的闭环放在独立模块里，既能被单测直接覆盖，
//   也避免在巨型文件里做高风险的大段插入（本项目在这一点上吃过亏）。
// 依赖（generate / runStage / applyLineRewrites / outlineToText …）由调用方注入，
// 所以本模块**不 require builder**，不会形成循环依赖。

/**
 * 大纲定稿后的「权威表补齐」：victimLine / knowledgeMap / cluePlan 缺了就定向补一次。
 * 形状与 ensureObjectStates 一致：只补缺的、不动已合格的；失败不阻塞出本。
 */
async function ensureBibleExtras(deps, outline, onProgress) {
  const { generate, runStage, sb, outlineToText, extractJsonStrict, repairTruncatedJson, TOKENS_PER_STAGE } = deps;
  if (!outline) return outline;
  const bible0 = sb.buildBible(outline);
  const need = [];
  if (!bible0.victim.deathTime) need.push("victimLine：死者的【身亡时刻】（HH:MM，真实时间轴）、身亡地点、案发夜最后一次被见到的情形与目击者");
  if (!bible0.knowledge.length) need.push("knowledgeMap：谁在何时知道什么（每人 1-3 条关键秘密，含 since 与来源）");
  if (!bible0.cluePlan.length) need.push("cluePlan：每条线索的 发现者/时刻/地点/指向（clueId 用 A1/A2… 第一轮、B1/B2… 第二轮）");
  if (!need.length) return outline;

  if (onProgress) onProgress("outline", `权威表缺项，正在定向补齐：${need.map(n => n.split("：")[0]).join("、")}`);
  try {
    const system = "你是剧本杀设定编辑。只输出一个 JSON 对象，不要任何解释与多余文字。";
    const user = `## 本剧本设定（节选）
${outlineToText(outline).substring(0, 3500)}

## 需要你补齐的部分
${need.join("\n")}

只输出缺失的字段，已有的不要重复。格式：
{"victimLine":{"deathTime":"HH:MM","deathPlace":"地点","lastSeen":"…","confirmedBy":["角色名"]},"knowledgeMap":[{"who":"角色名","knows":"…","since":"HH:MM","source":"…"}],"cluePlan":[{"clueId":"A1","discoverer":"角色名","time":"HH:MM","place":"地点","about":"指向什么"}]}`;
    const r = await runStage("权威表补齐", () => generate(system, user, { maxTokens: Math.min(TOKENS_PER_STAGE, 7000), temperature: 0.3 }), onProgress);
    const parsed = extractJsonStrict(repairTruncatedJson(r.content)) || extractJsonStrict(r.content) || {};
    if (parsed.victimLine && !bible0.victim.deathTime) outline.victimLine = parsed.victimLine;
    if (Array.isArray(parsed.knowledgeMap) && parsed.knowledgeMap.length && !bible0.knowledge.length) outline.knowledgeMap = parsed.knowledgeMap;
    if (Array.isArray(parsed.cluePlan) && parsed.cluePlan.length && !bible0.cluePlan.length) outline.cluePlan = parsed.cluePlan;
    const after = sb.checkBibleSelfConsistency(sb.buildBible(outline));
    const hard = after.issues.filter(i => i.level === "error").length;
    if (onProgress) onProgress("outline", hard === 0 ? "权威表补齐完成（自洽校验通过）" : `⚠ 权威表补齐后仍有 ${hard} 处硬缺口（已记录，继续出本）`);
  } catch (e) {
    console.warn("[builder] 权威表补齐失败（不阻塞出本）:", e.message);
  }
  return outline;
}

/**
 * 逐人「权威事实对账」闭环：对账 → 定向改写（只改冲突行）→ 复审；
 * **只接受"问题数下降"的结果**（与 ensureDeathConsistent 同一收敛判据）。
 *
 * 为什么放在"角色剧本写完、线索生成之前"：这是跨角色矛盾的源头治理 ——
 * 实测那 7 个 crosscheck 问题全是【跨角色】或【角色 vs 权威】，
 * "每人自己审自己"抓不到，但"拿权威表逐条对账"能抓到
 * （如：权威说 20:00 你在起居室，你写 20:00 回房了）。
 *
 * @returns {Promise<{content:string, issues:number, rounds:number}>}
 */
/** 问题类型的中文名：日志里直接写清是哪一类，避免"6 处硬冲突"让人以为有 6 个真缺陷 */
const KIND_CN = { place_mismatch: "地点不符", place_unspecified_elsewhere: "地点含糊", victim_after_death: "死者死后活动", knowledge_leak: "知识越界", timeline_duplicate: "同节重复", timeline_duplicate_cross: "跨节复述", timeline_same_time: "同刻相近", timeline_out_of_order: "时序可疑", shichen_mismatch: "时辰换算", placeholder_residue: "模板占位词残留", self_name_prefix: "自我名字前缀" };

async function ensureBibleAligned(deps, name, content, bible, onProgress) {
  const { generate, runStage, sb, applyLineRewrites, extractJsonStrict, repairTruncatedJson } = deps;
  // ⓪ 先做**无损清理**：模板占位词残留（`**日期12月5日 23:05**` / `**：地点 一楼大厅`）。
  //    位置必须在 factsText 提前返回**之前**——没有权威条目的角色同样要清。
  //    为什么不交给 LLM 改写：这是纯字符串替换（删掉"日期/地点"两个字段名），语义完全不变；
  //    交给模型反而可能顺手改坏别处，而它本来就擅长"顺手改坏"。
  const pr = sb.repairPlaceholderResidues(name, content);
  if (pr.fixed) {
    content = pr.script;
    console.log(`[builder] ${name} 占位词残留：无损清理 ${pr.fixed} 处${pr.left.length ? `，剩 ${pr.left.length} 处需改写` : ""}`);
  }
  const facts = sb.bibleFactsFor(bible, name);
  const factsText = sb.bibleFactsToText(facts);
  if (!factsText) return { content, issues: 0, rounds: 0 };   // 该角色没有权威条目 → 无需对账

  let current = content;
  let best = content;
  let bestCount = Infinity;
  let rounds = 0;
  for (let round = 0; round < 2; round++) {
    const rec = sb.reconcileCharacterScript(name, current, bible);
    const kn = sb.checkKnowledgeBounds(name, current, bible);
    const th = sb.checkTimelineHealth(name, current);
    const issues = [
      ...rec.conflicts,
      ...kn.leaks.map(l => ({ kind: "knowledge_leak", level: "warn", time: l.time, expected: `在 ${l.since} 之后才该知道「${l.knows}」`, evidence: l.evidence })),
      ...th.issues,   // 时间线体检：条目重复 / 日期倒序（上一轮 crosscheck 剩下的全是这一类）
      ...sb.checkShichenConsistency(current).issues.map(i => ({
        // 时辰↔24 小时换算错：实测《听雪山庄》全文 57 处时辰词、8 处与时刻差 1.5~3.5 小时
        kind: "shichen_mismatch", level: "error", time: `${String(Math.floor(i.claimedMins / 60)).padStart(2, "0")}:${String(i.claimedMins % 60).padStart(2, "0")}`,
        expected: `「${i.said}」指的是 ${String(Math.floor(i.meansMins / 60)).padStart(2, "0")}:${String(i.meansMins % 60).padStart(2, "0")}，与原文标注的时刻相差 ${Math.round(i.diffMin)} 分钟`,
        evidence: i.line,
      })),
    ];
    if (!issues.length) { bestCount = 0; best = current; break; }
    if (issues.length < bestCount) { bestCount = issues.length; best = current; }

    // 只对**硬冲突**动手；提示级只在"数量很少"时才一起处理。
    // 实测教训：日期倒序这类提示在一本戏里能出 27 条（其中大量是合法的倒叙段），
    // 全送去改写既费钱又可能把好内容改坏 —— 数量本身就是"判据是否过宽"的信号。
    const hardIssues = issues.filter(i => i.level === "error");
    const actionable = hardIssues.length ? issues : (issues.length <= 3 ? issues : []);
    if (!actionable.length) {
      // ⚠️ 这里以前只打一句"只有 N 处提示级问题，仅记录"就结束 —— 于是**提示级问题从来没被列出来过**
      // （实测一本戏 11 条：跨节复述 9 / 同刻相近 1 / 时序可疑 1，没人知道具体是哪几条）。
      // "仅记录"必须真的是记录：把每一条连证据一起打出来，人才判断得了判据是不是过宽。
      console.warn(`[builder] ${name} 只有 ${issues.length} 处提示级问题（无硬冲突），不自动改写，逐条列出：`);
      for (const it of issues.slice(0, 20)) {
        const ev = (Array.isArray(it.evidence) ? it.evidence.join(" ／ ") : it.evidence || "").replace(/\s+/g, " ").slice(0, 110);
        console.warn(`[builder]   · [${KIND_CN[it.kind || it.code] || it.kind || it.code}] ${it.time || ""} ${String(it.text || it.expected || "").slice(0, 95)}`);
        if (ev) console.warn(`[builder]       证据：${ev}`);
      }
      if (issues.length > 20) console.warn(`[builder]   …另有 ${issues.length - 20} 条未列出`);
      if (onProgress) onProgress("revise", `${name} 提示级 ${issues.length} 条（不改写）：${issues.slice(0, 5).map(i => String(i.text || "").slice(0, 36)).join("；")}`);
      break;
    }

    const hard = issues.filter(i => i.level === "error").length;
    const byKind = issues.reduce((m, i) => { const k = i.kind || i.code || "其他"; m[k] = (m[k] || 0) + 1; return m; }, {});
    const kindText = Object.entries(byKind).map(([k, v]) => `${KIND_CN[k] || k} ${v}`).join(" / ");
    if (onProgress) onProgress("player_script", `${name} 与权威表对账：${hard} 处硬冲突 / ${issues.length - hard} 处提示（${kindText}），正在定向改写...`);
    const listed = issues.slice(0, 8).map(i => {
      const ev = Array.isArray(i.evidence) ? i.evidence.join(" ／ ") : i.evidence;
      return `- [${i.kind || i.code}] ${i.time || ""}｜期望：「${i.expected || i.text}」｜他写的：「${ev}」`;
    }).join("\n");
    // 送给 LLM 的清单同时也打进日志：以前只打"3 处硬冲突 / 2 处提示"，事后无法复盘"到底改了什么"
    console.warn(`[builder] ${name} 待改写清单：\n${listed.split("\n").map(l => "[builder]   " + l).join("\n")}`);
    try {
      const system = "你是剧本杀时间线校对。只输出 JSON，不要解释。";
      const user = `## 权威事实（不可改动，必须以它为准）
${factsText}

## 角色「${name}」剧本里与权威不符之处
${listed}

请给出**最小改动**：把有问题的那几行**原样**摘录，再给出改写后的同一行。
只输出 JSON：{"oldLines":["原样的一整行"],"newLines":["改写后的同一行"]}
要求：
- 只改与权威冲突的时刻/地点/随身物，其余文字尽量逐字保留；摘录的行必须能在原文中精确找到。
- 若是"同一时刻同一件事被写成两条"，把**重复的那一条**的 newLines 写成空字符串 ""（表示删掉该行）。
- 时辰换算：子时23:00–01:00｜丑时01:00–03:00｜寅时03:00–05:00｜卯时05:00–07:00｜辰时07:00–09:00｜巳时09:00–11:00｜午时11:00–13:00｜未时13:00–15:00｜申时15:00–17:00｜酉时17:00–19:00｜戌时19:00–21:00｜亥时21:00–23:00。一个时辰 8 刻、每刻 15 分钟，从时辰起始算（午时三刻=11:45、酉时四刻=18:00、戌时三刻=19:45、亥时三刻=21:45）。**以 24 小时时刻为权威去改时辰词**，改不准就删掉时辰词只留时刻。
- 若是"时间顺序错乱"，只调整行的先后：把该行摘录出来，newLines 里放它应该在的位置所需的同一行文字（或直接删掉重复项）。`;
      const r = await runStage(`权威对账(${name})`, () => generate(system, user, { maxTokens: 4500, temperature: 0.2 }), onProgress);
      const p = extractJsonStrict(repairTruncatedJson(r.content)) || extractJsonStrict(r.content) || {};
      rounds++;
      const oldL = Array.isArray(p.oldLines) ? p.oldLines : [];
      const newL = Array.isArray(p.newLines) ? p.newLines : [];
      // 删除上限：一次改写最多删 1 行。
      // 为什么要设上限：允许删行之后，模型完全可能靠"删掉整段"把问题数刷到 0 ——
      // 那不是修好，是把内容删没了。重复条目一次只需删一条；要删更多说明判据或模型有问题，宁可不动。
      const deletes = newL.filter(x => !String(x || "").trim()).length;
      if (deletes > 1) {
        console.warn(`[builder] ${name} 对账改写要求删 ${deletes} 行，超过上限（1 行），保留原稿`);
        break;
      }
      const fixed = applyLineRewrites(current, oldL, newL, { allowDelete: true });
      if (!fixed) { console.warn(`[builder] ${name} 对账改写未命中原文，保留原稿`); break; }
      const afterCount = sb.reconcileCharacterScript(name, fixed, bible).conflicts.length
        + sb.checkKnowledgeBounds(name, fixed, bible).leaks.length
        + sb.checkTimelineHealth(name, fixed).issues.length;
      if (afterCount < issues.length) {
        console.log(`[builder] ${name} 对账改写：问题 ${issues.length} → ${afterCount}`);
        current = fixed;
      } else {
        console.warn(`[builder] ${name} 对账改写未减少问题（${afterCount}），保留原稿`);
        break;
      }
    } catch (e) {
      console.warn(`[builder] ${name} 对账改写失败，保留原稿:`, e.message);
      break;
    }
  }
  if (bestCount !== 0 && bestCount !== Infinity) {
    console.warn(`[builder] ${name} 对账未收敛，仍有 ${bestCount} 处（已记录供人工复核）`);
  }
  return { content: best, issues: bestCount === Infinity ? 0 : bestCount, rounds };
}

/**
 * 跨角色一致性：确定性层先找**候选**（同一主体同刻两地 / 物件状态矛盾），
 * 再由带权威表的审查器裁定哪些是真矛盾并给出最小改动。
 *
 * 为什么必须"先候选、再裁定"：候选里混着"从门口看见别人进出"这类可解释情形
 * （实测在一批已通过校验的真实剧本上出现过），纯词法分不开 ——
 * 与其硬判（会误改好内容），不如把两行原样交给审查器。
 *
 * @returns {Promise<{candidateTotal:number, fixed:number, remaining:Array}>}
 */
/**
 * 模糊定位替换：模型回抄的"原行"常与原文差在空白/标点/强调符上，逐字 indexOf 必然失手
 *（实测"采纳 5 条、改动 0 个角色"）。这里先按归一化文本找到那一行，再整行替换。
 * @returns {{text:string|null, misses:string[]}}
 */
function applyLineRewritesFuzzy(text, oldLines, newLines) {
  const norm = (s) => String(s || "").replace(/[*_`【】\[\]（）()「」“”"'\s]/g, "").trim();
  let out = String(text || "");
  const misses = [];
  let changed = 0;
  for (let i = 0; i < (oldLines || []).length; i++) {
    const from = String(oldLines[i] || "").trim();
    const to = String((newLines || [])[i] || "").trim();
    if (!from || from === to) continue;
    const lines = out.split("\n");
    // 模型回抄时经常加"角色名："前缀、并把行截断（实测："陈峰：5. **对外说辞**：10月13日01:00-01:…"）→
    // 先剥掉前缀，再用**行首片段**匹配，否则归一化后仍然不是原文的子串。
    let nf = norm(from).replace(/^[一-龥A-Za-z0-9·]{2,6}[:：]/, "");
    if (nf.length > 24) nf = nf.slice(0, 24);
    let idx = lines.findIndex((l) => norm(l) === nf);
    if (idx < 0) idx = lines.findIndex((l) => nf && norm(l).includes(nf));
    if (idx < 0) idx = lines.findIndex((l) => nf.length > 8 && nf.includes(norm(l)) && norm(l).length > 8);
    if (idx < 0 && nf.length >= 6) { const head = nf.slice(0, 6); idx = lines.findIndex((l) => norm(l).startsWith(head)); }
    if (idx < 0) { misses.push(from.slice(0, 40)); continue; }
    if (to) lines[idx] = to; else lines.splice(idx, 1);   // 空串 = 删行（重复条目用）
    out = lines.join("\n");
    changed++;
  }
  return { text: changed ? out : null, misses };
}

async function ensureCrossCharacterConsistent(deps, characterResults, bible, onProgress) {
  const { generate, runStage, sb, applyLineRewrites, extractJsonStrict, repairTruncatedJson } = deps;
  const c1 = sb.findCrossCharacterConflicts(characterResults, bible);
  const c2 = sb.findObjectStateConflicts(characterResults, bible);
  const all = [...c1.conflicts, ...c2.conflicts];
  const out = { candidateTotal: c1.candidateTotal || all.length, fixed: 0, remaining: all, resolvedByLlm: 0 };
  if (!all.length) return out;
  if (onProgress) {
    onProgress("crosscheck", `跨角色候选冲突 ${all.length} 处${c1.capped ? `（另有 ${Math.max(0, (c1.candidateTotal || 0) - c1.conflicts.length)} 处未列出）` : ""}，正在让审查器裁定...`);
  }
  const listed = all.map((c, i) => `### 候选${i + 1}　[${c.kind}]${c.subject ? " 主体=" + c.subject : ""}${c.object ? " 物件=" + c.object : ""} 时刻=${c.time}\n` + (c.found || []).map(f => "  " + f).join("\n")).join("\n");
  try {
    const system = "你是剧本杀逻辑校对。只输出 JSON，不要解释。";
    const user = `## 权威事实
${sb.bibleFactsToText({ timeline: bible.timeline, publicEvents: bible.publicEvents, objectStates: bible.objectStates, knowledge: [] }).substring(0, 3500)}

## 待裁定候选（可能只是"从远处看见"，不一定是矛盾）
${listed}

只挑出**确实是矛盾**的候选，并给出**最小改动**（改那一方与权威不符的行）。
只输出 JSON：{"resolved":[{"index":1,"isConflict":true,"reason":"…","character":"要改的角色名","oldLines":["原行"],"newLines":["新行"]}]}`;
    const r = await runStage("跨角色裁定", () => generate(system, user, { maxTokens: 5000, temperature: 0.2 }), onProgress);
    const p = extractJsonStrict(repairTruncatedJson(r.content)) || extractJsonStrict(r.content) || {};
    for (const item of (Array.isArray(p.resolved) ? p.resolved : [])) {
      if (!item || item.isConflict === false) continue;
      out.resolvedByLlm++;
      const who = String(item.character || "").trim();
      if (!who || !characterResults[who]) continue;
      const fx = applyLineRewritesFuzzy(characterResults[who], item.oldLines, item.newLines);
      if (fx.text) { characterResults[who] = fx.text; out.fixed++; }
      else if (fx.misses && fx.misses.length) { console.warn(`[builder] 跨角色裁定：${who} 的改动未能定位到原文行（${fx.misses[0].slice(0, 30)}…）`); out.missed = (out.missed || 0) + 1; }
    }
    out.remaining = [...sb.findCrossCharacterConflicts(characterResults, bible).conflicts, ...sb.findObjectStateConflicts(characterResults, bible).conflicts];
    if (onProgress) onProgress("crosscheck", `跨角色裁定：采纳 ${out.resolvedByLlm} 条、改动 ${out.fixed} 个角色，剩余候选 ${out.remaining.length} 处`);
  } catch (e) {
    console.warn("[builder] 跨角色裁定失败（不阻塞出本）:", e.message);
  }
  return out;
}

/**
 * 只补"线索的发现时间"这一项：把缺时间的线索原文 + 权威时间表交给模型，
 * 让它给出**线索文本里已经隐含的时刻**（不是新编一个）。
 *
 * 为什么单独做这一步、且只做这一步：对齐后三要素里 discoverer/place 都能从线索本身确定性推出，
 * 只有 time 埋在证词的自然语言里（"五点三刻巡到库房外巷"），确定性解析不可靠；
 * 而时间恰恰是"线索在何时可被发现"的关键（DM 排轮次要用）。
 * 失败或解析不出就保留空值 —— 宁可空着，也不编一个时刻。
 *
 * @returns {Promise<Array>} 对齐后的 plan（含补上的 time）
 */
async function ensureCluePlanTimes(deps, outline, clues, bible, onProgress) {
  const { generate, runStage, sb, extractJsonStrict, repairTruncatedJson } = deps;
  const blocksById = new Map((clues || []).map(c => [String(c.id), c]));
  const plan = (outline.cluePlan || []);
  // 只问**证词线索**：证词本身就是对某时刻的陈述；物品线索不需要故事内时刻（它是搜证阶段找到的物证）
  const need = plan.filter(p => !p.time && p.type === "testimony");
  if (!need.length) return plan;

  if (onProgress) onProgress("clues", `${need.length} 条线索缺发现时间，正在从线索文本里提取（不新编时刻）...`);
  try {
    const listing = need.slice(0, 40).map(p => {
      const body = String((blocksById.get(String(p.id)) || {}).body || "").slice(0, 160).replace(/\s+/g, " ");
      return `- ${p.id}｜已知：发现者=${p.discoverer || "?"} 地点=${p.place || "?"}｜线索原文：${body}`;
    }).join("\n");
    const system = "你是剧本杀线索校对。只输出 JSON，不要解释。";
    const user = `## 案发夜时间基准（只用于对齐，不要新编时刻）
${(bible.timeline || []).map(t => `- ${t.time}　${t.doing}`).join("\n").substring(0, 1500)}

## 缺"发现时间"的线索
${listing}

请从每条线索的原文里找出它**已经隐含的**那个时刻（如"五点三刻"→05:45、"二十点十五分"→20:15）。
线索原文里没有明确时刻的，time 留空字符串 —— **不要编造**。
只输出 JSON：{"times":[{"clueId":"A1","time":"HH:MM"}]}`;
    const r = await runStage("线索发现时间", () => generate(system, user, { maxTokens: 3000, temperature: 0.1 }), onProgress);
    const p = extractJsonStrict(repairTruncatedJson(r.content)) || extractJsonStrict(r.content) || {};
    const map = new Map((Array.isArray(p.times) ? p.times : []).map(x => [String(x.clueId || ""), String(x.time || "")]));
    let filled = 0;
    const out = plan.map(item => {
      if (item.time) return item;
      const t = map.get(String(item.id)) || "";
      const hm = t ? sb.buildBible({ timeline: [{ time: t }] }).timeline[0] : null;   // 复用同一套时刻规范化
      if (hm && hm.time) { filled++; return { ...item, time: hm.time }; }
      return item;
    });
    const after = out.filter(x => !x.time).length;
    if (onProgress) onProgress("clues", `线索发现时间：补上 ${filled} 条，仍有 ${after} 条线索文本里没有明确时刻（保持空值，不编造）`);
    return out;
  } catch (e) {
    console.warn("[builder] 线索发现时间补全失败（保留空值）:", e.message);
    return plan;
  }
}

module.exports = { ensureBibleExtras, ensureBibleAligned, ensureCrossCharacterConsistent, ensureCluePlanTimes, applyLineRewritesFuzzy };
