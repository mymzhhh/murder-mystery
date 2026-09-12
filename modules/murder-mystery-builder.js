// 剧本杀多阶段生成流水线（v3：动态玩家数2-6、NPC 0-3）

const { generate } = require("./generator");
const path = require("path");

const tplPath = path.join(__dirname, "..", "templates", "murder-mystery.js");
const MURDER_TPL = require(tplPath);
const stages = MURDER_TPL.stages;
// 兼容：模块化拆分后，角色指令模板在模板顶层导出（playerInstruction 等）。
// 历史代码以 stages.xxx 访问，这里并入 stages，避免 undefined.replace 崩溃。
for (const key of ["playerInstruction", "playerSleuthInstruction", "soloDetectiveInstruction", "npcWitnessInstruction", "npcInstruction", "characterScript"]) {
  if (!stages[key] && MURDER_TPL[key] !== undefined) stages[key] = MURDER_TPL[key];
}
const LIMITS = MURDER_TPL.limits || { minPlayers: 2, maxPlayers: 6, maxNpc: 3, maxTotal: 9 };
const TOKENS_PER_STAGE = 16384;  // 每阶段输出上限（deepseek 主通道足够；Agnes fallback 仍兼容）
const TOKENS_LIGHT = 12288;      // 线索/DM手册等中型输出（8192 常不够：40-50 条线索 + 完整DM手册会截断）

/**
 * 阶段级生成：网络故障（DNS/连接/超时等瞬时错误）时只重试当前阶段，
 * 不抛给上层——避免 writeScript 把整个剧本（已完成 framework/大纲/部分角色）从头再来。
 * 连续 STAGE_NET_RETRIES 次仍失败才抛出（此时再让上层整篇重试）。
 */
const STAGE_NET_RETRIES = 2;
const isNetErr = (e) => {
  const m = String((e && (e.message || e.code)) || "").toLowerCase();
  return /getaddrinfo|enotfound|econn|etimedout|socket hang up|socket|refused|timeout|network|dns|fetch failed|undici|aborted/i.test(m);
};
async function runStage(stageName, fn, onProgress) {
  let lastErr = null;
  for (let a = 0; a <= STAGE_NET_RETRIES; a++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (a < STAGE_NET_RETRIES && isNetErr(e)) {
        const wait = 1500 * (a + 1);
        console.warn(`[builder] ${stageName} 网络故障(${e.message})，${wait / 1000}s后重试当前阶段（不重跑已完成阶段）...`);
        if (onProgress) onProgress("retry_stage", `${stageName}网络抖动，正在重试当前阶段...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ==================== 生成后校验：角色剧本时间线完整性 ====================

/** 时间线最少时间点数（与 templates/murder-mystery/character.js 玩家模板的"至少 8 个时间点"一致） */
const MIN_TIMELINE_POINTS = 8;

/** 统计时间线正文的时间点数（HH:MM、中文时辰/时段都算，去重） */
function countTimelinePoints(body) {
  // 注意：古代设定剧本用"戌时二刻"这类时辰表述，必须一并识别，
  // 否则会被误判为"时间线不完整"而触发无谓的补写。
  const re = /(\d{1,2}\s*[:：]\s*\d{2})|([一二三四五六七八九十百]+点(半|整)?)|([子丑寅卯辰巳午未申酉戌亥]时([初正]|[一二三四]刻)?)|((凌晨|清晨|拂晓|上午|中午|午后|下午|傍晚|黄昏|晚上|夜里|深夜)\s*\d{1,2}\s*[点时刻])/g;
  const set = new Set();
  let m;
  while ((m = re.exec(String(body || "")))) set.add(m[0].replace(/\s+/g, "").replace(/：/g, ":"));
  return set.size;
}

/** 抽取角色剧本中「时间线」章节正文；无该章节返回 null（排除基准类章节） */
function extractCharacterTimeline(text) {
  const lines = String(text || "").split("\n");
  const EXCLUDE = /(故事时间线|表面时间线|真实时间线|完整时间线)/;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,4}\s+.*时间线/.test(lines[i])) continue;
    if (EXCLUDE.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,4}\s+/.test(lines[j])) break;
      body.push(lines[j]);
    }
    return body.join("\n").trim();
  }
  return null;
}

/**
 * 生成后校验：角色剧本必须含「时间线」章节且时间点不少于 MIN_TIMELINE_POINTS。
 * 实测缺陷：模型会把时间线压成一两条（出现 82 字/1 条、74 字/1 条），
 * 或把完整行动轨迹塞进「凶手确认」而让时间线只剩抵达一条。
 * 不达标时带明确纠正指令补写一次；补写仍不达标则保留时间点更多的一份。
 */
async function ensureTimelineComplete(charName, content, retryFn, onProgress) {
  const body = extractCharacterTimeline(content);
  const points = body === null ? 0 : countTimelinePoints(body);
  if (body !== null && points >= MIN_TIMELINE_POINTS) return content;

  const problem = body === null
    ? "完全没有「二、你的时间线」章节"
    : `「二、你的时间线」只有 ${points} 个时间点（要求至少 ${MIN_TIMELINE_POINTS} 个）`;
  const note = `\n\n## ⚠️ 上一次输出不合格，必须重写\n上一次的问题：${problem}。\n请重新输出**完整**角色剧本（保留上一版背景故事与任务的要点，不要压缩它们），并严格遵守格式约束：\n- 必须包含 "### 一、你的背景故事" / "### 二、你的时间线" / "### 三、你的任务" 三个三级标题，顺序不可变。\n- 「二、你的时间线」必须独立成章、**至少 ${MIN_TIMELINE_POINTS} 个时间点**，覆盖案发前一日晚间到案发后，格式 "- **日期 时间**：地点 — 事件"。\n- 不得把行动轨迹写进背景故事或其它章节。`;

  if (onProgress) onProgress("player_script", `${charName} 时间线不达标（${problem}），正在补写...`);
  console.warn(`[builder] ${charName} 时间线不达标：${problem}，触发补写`);

  try {
    const retried = await retryFn(note);
    const rBody = extractCharacterTimeline(retried);
    const rPoints = rBody === null ? 0 : countTimelinePoints(rBody);
    if (rBody !== null && rPoints > points) {
      console.warn(`[builder] ${charName} 补写后时间点：${rPoints} 个`);
      return retried;
    }
    console.warn(`[builder] ${charName} 补写仍未达标（${rPoints} 个时间点），保留原稿`);
  } catch (e) {
    console.warn(`[builder] ${charName} 时间线补写失败，保留原稿:`, e.message);
  }
  return content;
}

/**
 * 布局兜底：framework/大纲都没有布局时，
 * ① 从线索"发现地点"归纳核心场所清单（剥子位置/人名/尸体）
 * ② 让 LLM 生成一段含方位关系的布局描述（"柳的房间在苏房间的左边"）
 * 返回布局文本；生成失败返回 null（assemble 再走纯清单兜底）。
 */
/** LLM 生成布局方位描述（场所清单 → 连贯的方位关系段落） */
async function genLayoutText(placeSet, deathPlace, onProgress) {
  onProgress && onProgress("layout", "正在生成场景布局方位描述...");
  const system = `你是剧本杀场景布局设计师。根据提供的场所清单，用200-350字写一段连贯的布局描述，包含明确的方位关系（如"柳惊鸿的房间在苏婉房间的左侧，走廊尽头是厨房"）。要求：
1. 每个场所都提到，说明它与相邻场所的相对位置（左边/右边/对面/上楼后/走廊尽头/穿过大厅等）
2. 案发现场（若有）重点描述其位置与通往它的路径
3. 只讲空间关系，不讲案情；
4. 用平实客观的文字，禁止排比堆砌`;
  const user = `场所清单：${placeSet.join("、")}
案发现场：${deathPlace || ""}

请写出这段布局描述（200-350字）：`;
  const result = await runStage("布局描述", () => generate(system, user, { maxTokens: 800, temperature: 0.6 }));
  const text = String(result.content || "").trim();
  if (text.length < 50) return null;
  return "本局主要场所及相互关系：\n" + text;
}

/**
 * ensureLayoutText：大纲 layout 非空时，立即为它生成方位描述（供后续角色剧本空间视角 + 组装）。
 * 大纲 layout 为空则跳过（由 buildLayoutIfMissing 在 clues 后用线索兜底）。
 */
async function ensureLayoutText(report, onProgress) {
  if (report.layoutText) return report.layoutText;
  const ol = report.outline || {};
  const places = (ol.layout || []).filter(Boolean);
  const deathPlace = (ol.victim && ol.victim.deathPlace) || "";
  if (places.length < 2) return null; // 大纲无布局，交给线索版兜底
  const text = await genLayoutText(places, deathPlace, onProgress);
  if (text) report.layoutText = text;
  return report.layoutText || null;
}

/** buildLayoutIfMissing：线索版兜底（大纲无 layout 时，clues 生成后根据发现地点归纳场所并生成方位描述） */
async function buildLayoutIfMissing(report, onProgress) {
  // 已有布局（方位描述已生成，或 framework 有布局段，或大纲 layout 非空）则不需要
  if (report.layoutText) return null;
  const fw = report.framework || "";
  const fwLayout = fwSection(fw, "场景布局") || fwSection(fw, "布局") || "";
  if (fwLayout && fwLayout.replace(/^#{1,4}\s*\S[^\n]*/, "").trim().length >= 4) return null;
  if (report.outline && report.outline.layout && report.outline.layout.length) return null;

  // ① 归纳核心场所（从线索"发现地点"）
  const placeSet = [];
  const clueLocRe = /发现地点[：:]\s*([^\n]+)/g;
  const clueText = report.clues || "";
  let cm;
  while ((cm = clueLocRe.exec(clueText)) !== null) {
    let loc = cm[1].trim();
    if (!loc || loc.length > 20) continue;
    loc = loc.replace(/[（(][^）)]*[）)]/g, "").trim();
    if (/尸体|证词|陈述|口供|随身|衣|鞋|手|怀表|戒指|发簪|身上|口袋|入住/.test(loc)) continue;
    if (!/房间|书房|大厅|走廊|厨房|仓库|工坊|居所|庭院|花园|帐房|闺房|卧室|正堂|药铺|库房|院子|阁楼|厢房|值房|寝殿|书房|亭|地下室|浴室|账房|前堂|后院|主楼|厢|堂/.test(loc)) continue;
    if (!placeSet.includes(loc)) placeSet.push(loc);
  }
  if (placeSet.length < 2) return null;

  // ② LLM 生成方位布局描述
  const deathPlace = (report.outline && report.outline.victim && report.outline.victim.deathPlace) || "";
  const text = await genLayoutText(placeSet, deathPlace, onProgress);
  if (!text) return null;
  report.layoutText = text;
  return text;
}

/**
 * 健壮 JSON 提取：从 LLM 返回全文（可能混有大段中文推理 reasoning_content、前后缀、代码块）
 * 中提取"最后一个完整可解析的 JSON 对象/数组"。
 * 策略（按优先级）：
 *   1) 剥离 ```json 代码块围栏后直接 parse
 *   2) 若 parse 失败，扫描最外层花括号/方括号对，逐个尝试，取最后一个能解析成功的对象
 *      （推理型模型常把最终 JSON 写在回答末尾，最外层对象通常就是答案）
 */
function extractJsonStrict(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim().replace(/^\uFEFF/, ""); // 去掉 BOM
  // 剥离代码块围栏（兼容开头 ```json 但结尾可能不闭合）
  const fenceOpen = t.match(/^```(?:json)?[\s]*\n?/i);
  if (fenceOpen) {
    t = t.slice(fenceOpen[0].length);
    // 去掉结尾可能残留的 ```
    t = t.replace(/```[\s]*$/m, "").replace(/\n```$/, "");
  } else {
    // 未以围栏开头，也可能中间有围栏
    const fenced2 = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenced2) t = fenced2[1].trim();
  }
  t = t.trim();

  // 直接 parse
  try { return JSON.parse(t); } catch (e) { /* fallthrough */ }

  // 从前往后扫描，记录每个最外层括号对的子串，取最后一个能解析的
  const candidates = [];
  let depth = 0, start = -1, inStr = false, escaped = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(t.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]); } catch (e) { /* try next */ }
  }
  // 最后兜底：从第一个 { 到最后一个 }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { /* ignore */ }
  }
  return null;
}

/**
 * 进阶风格档位 → 各阶段的额外写作指令
 * advancedMode: standard(标准) / hardcore(硬核-线索多重指向+抗推均衡) / emotional(情感-反转+沉浸)
 * 每个档位在「角色/线索/DM」阶段注入不同的硬约束。
 */
function stageDirective(mode, stage) {
  const m = mode || "standard";
  if (m === "standard") return "";
  if (stage === "character") {
    return m === "hardcore"
      ? `\n\n## 硬核进阶要求（本局 hardcore 档）
- 你的个人剧本需与「线索多重指向性」配合：你时间线中的关键行为，最好有可被他人合理误读/栽赃的细节，但不能自相矛盾。
- 保持自洽：若设定集中你的某句证词可被佐证或推翻，剧本里要自然埋下能被对上的事实细节（时间、位置、声响等）。`
      : `\n\n## 情感沉浸要求（本局 emotional 档）
- 深化你与死者的情感羁绊与内心矛盾：不止写"恨"或"杀机"，更要写出亏欠、不舍、挣扎或误解。
- 结尾前不得自曝身份反转；若你隐瞒了与死者的深层关系（如亲缘/旧情），要在剧本中自然流露可疑的异常反应供复盘反转使用。`;
  }
  if (stage === "npc") {
    return m === "hardcore"
      ? `\n\n## 硬核进阶要求（本局 hardcore 档）
- NPC 的证词/秘密需为玩家提供"可佐证或可推翻"的信息锚点（确切时间、方位、声响），而不是泛泛而谈。
- 无辜 NPC 也要有 1-2 处看似可疑但能讲通的自洽解释，承担抗推位。`
      : `\n\n## 情感沉浸要求（本局 emotional 档）
- 每个 NPC 与死者之间都要有一段有温度的真实关系（亲情/旧恩/愧疚），使审讯时能流露情感层次。`;
  }
  if (stage === "clues") {
    return m === "hardcore"
      ? `\n\n## 硬核进阶要求（本局 hardcore 档 —— 线索多重指向性）
- **多重指向线索**：至少 3 条线索不是"一眼锁凶"，而是包含可被推翻的伪证细节。例："凶器上有甲的指纹，但刀柄朝向与受力方向不符（若甲为左撇子则洗清嫌疑）"——线索本身客观，指向性由细节推理决定，而非直接定罪。
- **伪证细节的排除路径必须存在**：任何可能误导玩家的线索，都要在剧本/时间线中留有能证明其无关的解释（人物惯用手、真实行踪、替身等）。
- 保持"客观描述、禁止结论"，多重指向靠细节而非定性句实现。`
      : "";
  }
  if (stage === "dm") {
    return m === "hardcore"
      ? `\n\n## 硬核进阶要求（本局 hardcore 档）
- 真相复盘需点明每条"多重指向线索"的真实含义：它为何看似指向某人、实际如何洗清/坐实。
- QA 需覆盖抗推位玩家最可能被冤枉的问题，给出澄清口径。`
      : `\n\n## 情感沉浸要求（本局 emotional 档）
- 真相复盘需设计"情感反转时刻"：在投票与真相之间，用时间差/身世揭露制造情感暴击（例：玩家以为来寻仇，实则是失散至亲；死者最后一刻护住了某人）。
- 结局要有完整的情绪收束（遗书/心愿/告别），但避免空泛煽情，情感需由具体事件与物品承载。`;
  }
  return "";
}

/**
 * 生成完整剧本杀剧本
 * @param {string} userInput - 用户的需求描述
 * @param {function} onProgress - 进度回调 (stage, message)
 * @param {object} [config] - 可选：{playerCount, npcCount, isPVE}
 * @returns {Promise<{fullScript: string, stages: object, characters: Array}>}
 */
async function buildMurderMystery(userInput, onProgress, config) {
  const report = {};
  const cfg = {
    playerCount: config?.playerCount || LIMITS.maxPlayers,
    npcCount: config?.npcCount ?? (config?.isPVE ? 2 : 0),
    isPVE: config?.isPVE ?? (config?.npcCount > 0),
    advancedMode: ["hardcore", "emotional"].includes(config?.advancedMode) ? config.advancedMode : "standard",
  };
  // 约束到合法范围
  cfg.playerCount = Math.max(LIMITS.minPlayers, Math.min(LIMITS.maxPlayers, cfg.playerCount));
  cfg.npcCount = Math.max(0, Math.min(LIMITS.maxNpc, cfg.npcCount));

  // ========== 阶段 1：故事框架 ==========
  onProgress("framework", `正在设计故事框架（${cfg.playerCount}玩家${cfg.npcCount > 0 ? ' + ' + cfg.npcCount + 'NPC' : ''}）...`);
  const frameworkPrompt = buildFrameworkPrompt(userInput, cfg);
  let frameworkResult;
  try {
    frameworkResult = await runStage("framework", () => generate(frameworkPrompt.system, frameworkPrompt.user, { maxTokens: TOKENS_PER_STAGE, temperature: 0.75 }), onProgress);
  } catch (e) {
    console.error("[framework] 生成失败:", e.message, e.name, e.status, e.code);
    throw new Error("故事框架生成失败: " + (e.message || "网络超时，请重试"));
  }
  report.framework = frameworkResult.content;

  // ========== 阶段 1.3：剧本大纲（锁死人数/人物/手法/时间线，所有后续阶段的共同蓝图） ==========
  // 大纲是"人数锁定"的唯一权威：解析失败或人数不符都要重试，绝不回退到 framework 提取
  // （framework 自解历史上会出现超限 NPC，导致无谓重写）。
  onProgress("outline", "正在设计剧本大纲（锁定角色人数与核心设定）...");
  let outline = null;
  let outlineText = "";
  let outlineError = null;
  for (let oa = 0; oa < 3; oa++) {
    try {
      const cand = await buildOutline(userInput, cfg);
      const op = (cand.players || []).length;
      const on_ = (cand.npcs || []).length;
      if (cand && op === cfg.playerCount && on_ === cfg.npcCount) {
        outline = cand;
        outlineText = outlineToText(outline);
        report.outline = outline;
        break;
      }
      outlineError = new Error(`大纲人物数不符（${op}玩家+${on_}NPC，期望${cfg.playerCount}+${cfg.npcCount}）`);
      console.warn(`[builder] 大纲第${oa + 1}次人数不符：${outlineError.message}，重试...`);
    } catch (e) {
      outlineError = e;
      console.warn(`[builder] 大纲第${oa + 1}次生成失败：${e.message}，重试...`);
    }
  }
  if (!outline) {
    // 大纲无效直接抛错——由上层（script-writer / script-reviewer）整体重试，
    // 而不是回退到 framework 提取产生超限角色。
    throw new Error(`剧本大纲生成失败（3次尝试）：${outlineError?.message || "未知原因"}`);
  }

  // ========== 阶段 1.4：向流水线上报结构化大纲（供前端可视化"剧本大纲"步骤） ==========
  // 通过 onProgress 的 "outline_done" 事件传递大纲 JSON，由上层（routes/admin.js）解析为 SSE outline 事件
  try {
    onProgress("outline_done", JSON.stringify({
      title: outline.title || "",
      genre: outline.genre || "",
      coreTrick: outline.coreTrick || "",
      trickSpec: outline.trickSpec || null,
      duration: outline.duration || "",
      storyBackground: outline.storyBackground || "",
      layout: outline.layout || [],
      victim: outline.victim || {},
      relations: outline.relations || [],
      players: outline.players || [],
      npcs: outline.npcs || [],
      murderer: outline.murderer || null,
      timeline: outline.timeline || [],
      isPVE: cfg.isPVE,
      playerCount: cfg.playerCount,
      npcCount: cfg.npcCount,
    }));
  } catch (e) { console.warn("[builder] outline 可视化上报失败（不影响主流程）:", e.message); }

  // ========== 阶段 1.45：布局方位描述（大纲 layout 非空时立即生成，供后续角色剧本空间视角 + 组装） ==========
  try {
    await ensureLayoutText(report, onProgress);
  } catch (e) {
    console.warn("[builder] 布局方位描述生成跳过（不影响主流程）:", e.message);
  }

  // ========== 阶段 1.5：结构化提取角色列表 ==========
  onProgress("extract", "正在解析角色列表（区分玩家/NPC/凶手）...");
  const characters = outline && outline.players && outline.npcs
    ? extractCharactersFromOutline(outline, cfg)
    : await extractCharactersStructured(report.framework, cfg);
  let playerChars = characters.filter(c => c.type === "player");
  let npcChars = characters.filter(c => c.type === "npc");

  // 强制按配置校验角色数量（LLM可能生成过多）：
  // 不静默截断——截断会让框架文本残留被删角色、成稿自相矛盾。
  // 交由调用方（script-writer / script-reviewer）按角色数校验结果重试。
  if (playerChars.length > cfg.playerCount) {
    throw new Error(`框架中玩家角色超限（${playerChars.length}/${cfg.playerCount}），请重新生成`);
  }
  if (npcChars.length > cfg.npcCount) {
    throw new Error(`框架中NPC超限（${npcChars.length}/${cfg.npcCount}），请重新生成`);
  }
  // npcCount=0（纯PVP）时框架不应出现NPC
  if (cfg.npcCount === 0 && npcChars.length > 0) {
    throw new Error(`配置为无NPC（纯PVP），但框架中出现了${npcChars.length}个NPC，请重新生成`);
  }
  // 少于期望人数：提前报错（否则要写完全部角色剧本才在 script-writer 判失败，整条流水线白跑）
  if (playerChars.length < cfg.playerCount) {
    throw new Error(`玩家角色数不足（${playerChars.length}/${cfg.playerCount}），请重新生成`);
  }
  if (npcChars.length < cfg.npcCount) {
    throw new Error(`NPC角色数不足（${npcChars.length}/${cfg.npcCount}），请重新生成`);
  }
  // 凶手唯一性校验：有且仅有一个，且必须在角色名单内
  const murderers = characters.filter(c => c.isMurderer);
  if (murderers.length === 0) {
    throw new Error("未标注凶手（isMurderer 全为 false），请重新生成");
  }
  if (murderers.length > 1) {
    throw new Error(`出现多个凶手（${murderers.map(c => c.name).join("、")}），必须唯一，请重新生成`);
  }
  if (cfg.playerCount === 1 && npcChars.length === 0) {
    // 单人侦探本必须有NPC嫌疑人，脚本端已做校验；此处仅提示
    console.warn("[builder] 单人侦探本无NPC，玩家将无可审问对象");
  }

  report.characters = [...playerChars, ...npcChars];
  report.isPVE = cfg.isPVE;
  report.gameMode = cfg.isPVE ? "PVE" : "PVP";

  onProgress("characters", `角色解析完成：${playerChars.length}名玩家 + ${npcChars.length}名NPC（凶手：${characters.find(c => c.isMurderer)?.name || "未知"}）`);

  // ========== 阶段 2：角色内容 ==========
  const characterResults = {};
  const isSolo = cfg.playerCount === 1;

  // 从框架中提取时代背景和死者姓名
  const eraMatch = report.framework.match(/时代背景[：:]\s*(.+?)(?:\n|$)/);
  const locMatch = report.framework.match(/地点场景[：:]\s*(.+?)(?:\n|$)/);
  const victimMatch = report.framework.match(/死者信息[\s\S]*?姓名与身份[：:]\s*(.+?)(?:\n|$)/);
  cfg.era = eraMatch ? eraMatch[1].trim() : "";
  cfg.location = locMatch ? locMatch[1].trim() : "";
  cfg.victim = victimMatch ? victimMatch[1].trim() : "死者";

  // 大纲注入：后续所有阶段共享同一蓝图（决策依据 = 大纲设定集 + 权威摘要，**不含 framework 原文**）。
  // framework 初稿的角色名/凶手/时间体系可能与大纲锁定后的最终设定不一致（历史发生了
  // "柳寒山vs陈风""素心vs小翠"污染）；因此 framework 只用于组装成稿，绝不再注入生成 prompt，
  // 彻底杜绝旧设定污染下游剧本。
  let blueprintCtx = report.outline
    ? outlineToText(report.outline) + "\n\n" + buildStructuredSummary(report)
    : report.framework;
  // 布局方位描述（若已生成）注入所有角色剧本——让角色时间线带空间视角
  // （"我站在苏婉房间门口，能看见柳惊鸿从他房间出来"），与场景布局互相印证
  if (report.layoutText) {
    blueprintCtx += "\n\n## 场景布局（空间关系蓝本，所有角色的时间线必须与之吻合）\n" + report.layoutText;
  }

  for (let i = 0; i < playerChars.length; i++) {
    const ch = playerChars[i];
    const label = isSolo ? "侦探" : "玩家";
    onProgress("player_script", `撰写${label}角色剧本 (${i + 1}/${playerChars.length}): ${ch.name}`);
    if (isSolo) {
      // 单人侦探模式：用专用模板
      const instructions = stages.soloDetectiveInstruction.replace("{characterName}", ch.name);
      const prompt = `请为【侦探角色】撰写调查者剧本。\n\n## 角色基本信息\n- 姓名：${ch.name}\n- 身份：调查者/侦探\n\n## 完整故事框架（供参考）\n${blueprintCtx.substring(0, 6000)}\n\n## 要求\n${instructions}\n\n请直接输出剧本内容。`;
      const systemPrompt = `你是剧本杀写作专家。现在为【调查者】"${ch.name}"撰写侦探剧本。使用第一人称，重点是调查视角和初步线索。`;
      const result = await runStage(`玩家剧本(${ch.name})`, () => generate(systemPrompt, prompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
      characterResults[ch.name] = result.content;
    } else {
      const prompt = buildCharacterPrompt(ch, blueprintCtx, i + 1, playerChars.length, cfg.isPVE, report.outline)
        + stageDirective(cfg.advancedMode, "character");
      const systemPrompt = buildCharacterSystemPrompt(ch, cfg.isPVE);
      const result = await runStage(`玩家剧本(${ch.name})`, () => generate(systemPrompt, prompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
      // PVP 玩家剧本必须有完整时间线；PVE（玩家是侦探）按模板不写时间线，跳过校验
      characterResults[ch.name] = cfg.isPVE
        ? result.content
        : await ensureTimelineComplete(ch.name, result.content, async (note) => {
            const r = await runStage(`玩家剧本补写(${ch.name})`, () => generate(systemPrompt, prompt + note, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
            return r.content;
          }, onProgress);
    }
  }

  for (let i = 0; i < npcChars.length; i++) {
    const ch = npcChars[i];
    onProgress("npc_script", `撰写NPC信息 (${i + 1}/${npcChars.length}): ${ch.name}`);
    const prompt = buildNpcPrompt(ch, blueprintCtx, i + 1, npcChars.length, cfg.isPVE, cfg.npcCount, report.outline)
      + stageDirective(cfg.advancedMode, "npc");
    const isWitness = !cfg.isPVE;
    const systemPrompt = buildNpcSystemPrompt(ch, { era: cfg?.era, location: cfg?.location, victim: cfg?.victim }, isWitness);
    // 单人本NPC需要更丰富内容，token适度加量（封顶）
    const npcTokens = isSolo ? Math.min(TOKENS_PER_STAGE * 1.25, 16384) : TOKENS_PER_STAGE;
    const result = await runStage(`NPC信息(${ch.name})`, () => generate(systemPrompt, prompt, { maxTokens: Math.floor(npcTokens), temperature: 0.7 }), onProgress);
    characterResults[ch.name] = result.content;
  }
  report.characterScripts = characterResults;

  const frameworkSummary = buildStructuredSummary(report);

  // ========== 阶段 3：线索系统 ==========
  onProgress("clues", "正在设计线索系统和证据链...");
  try {
    // 布局真实地点清单 → 注入模板的 {layoutPlaces}，约束"发现地点"必须真实存在
    // 权威来源优先：大纲 layout（锁定后的最终布局）→ framework 提取（初稿，可能为空或与大纲不一致）
    const outlinePlaces = (report.outline && Array.isArray(report.outline.layout) ? report.outline.layout : [])
      .map(p => String(p).replace(/[（(][^）)]*[）)]/g, "").trim())
      .filter(Boolean);
    const fwPlaces = extractLayoutPlaces(report.framework)
      // 兜底清洗：过滤模板残留的噪音词（标题/字段/带星号）
      .filter(p => p && !p.includes("*") && !p.includes("#")
        && !/描述|布局|平面|地图|章节|列表|设定|信息|概要|参与人数|游戏时长|难度等级|姓名|沿革|角色结构/.test(p));
    // 合并去重（大纲在前，作为权威顺序）
    const layoutPlaces = [...new Set([...outlinePlaces, ...fwPlaces])];
    const layoutLine = layoutPlaces.length > 0
      ? layoutPlaces.join("、")
      : "（未提取到明确布局，请依据上方框架的「地点场景」自行判断真实房间，禁止编造布局外地点）";
    let cluesPrompt = stages.clues.replace("{frameworkSummary}", frameworkSummary.substring(0, 6000));
    cluesPrompt = cluesPrompt.replace("{layoutPlaces}", layoutLine);
    cluesPrompt += stageDirective(cfg.advancedMode, "clues");
    const cluesResult = await runStage("clues", () => generate(getCluesSystemPrompt(), cluesPrompt, { maxTokens: TOKENS_LIGHT }), onProgress);
    // 校验：物理线索发现地点归一化到布局真实地点
    const norm = normalizeClueLocations(cluesResult.content, layoutPlaces);
    if (norm.fixed > 0 || norm.skipped > 0) {
      console.warn(`[builder] 线索地点校验：归一 ${norm.fixed} 条 / 豁免 ${norm.skipped} 条`);
    }
    report.clues = norm.text;
  } catch (e) {
    console.error("[clues] 生成失败:", e.message, e.name, e.status);
    throw new Error("线索系统生成失败: " + (e.message || "未知错误"));
  }

  // ========== 阶段 4：DM 手册 ==========
  onProgress("dmGuide", "正在撰写DM完整手册（时间线、真相复盘、结局）...");
  try {
    // DM 手册只用"最终权威"信息源（设定集大纲 + 角色结构摘要），
    // 不再注入 framework 原文——framework 初稿的角色名可能与大纲锁定后的最终角色名不一致
    // （历史 bug：DM 开场白用了 framework 的旧角色名，与玩家剧本对不上）。
    const dmSummary = (report.outline ? outlineToText(report.outline) : "")
      + "\n\n## 角色结构（最终名单，DM 必须严格使用以下姓名，禁止使用其他名字）\n"
      + buildStructuredSummary(report).split("## 框架关键信息")[0];
    let dmPrompt = stages.dmGuide.replace("{frameworkSummary}", dmSummary.substring(0, 6000))
      .replace("{murdererName}", (report.outline && report.outline.murderer && report.outline.murderer.name) || (report.characters || []).find(c => c.isMurderer)?.name || "见设定集")
      + stageDirective(cfg.advancedMode, "dm");
    const dmResult = await runStage("dmGuide", () => generate(getDMSystemPrompt(), dmPrompt, { maxTokens: TOKENS_LIGHT }), onProgress);
    report.dmGuide = dmResult.content;
  } catch (e) {
    console.error("[dmGuide] 生成失败:", e.message, e.name, e.status);
    throw new Error("DM手册生成失败: " + (e.message || "未知错误"));
  }

  // ========== 阶段 4.6：布局描述兜底（generateOnly 布局时，用 LLM 生成含方位关系的布局） ==========
  try {
    const layoutFallback = await buildLayoutIfMissing(report, onProgress);
    if (layoutFallback) report.layoutText = layoutFallback;
  } catch (e) {
    console.warn("[builder] 布局描述生成跳过:", e.message);
  }

  // ========== 组装 ==========
  onProgress("assemble", "正在组装完整剧本...");
  let fullScript = assembleScript(report, userInput);

  // ========== 阶段 4.5：模块交叉校验（对照设定集，检查各模块间的逻辑一致性） ==========
  onProgress("crosscheck", "正在交叉校验各模块（人物/时间线/线索/DM手册）...");
  try {
    const xcheck = await runModuleCrossCheck(report, frameworkSummary, fullScript, onProgress);
    report.crossCheck = xcheck;
    if (xcheck && xcheck.issues && xcheck.issues.length) {
      console.warn(`[builder] 交叉校验发现 ${xcheck.issues.length} 个问题：`, xcheck.issues.slice(0, 3).join("；"));
    }
  } catch (e) {
    console.warn("[builder] 交叉校验跳过:", e.message);
  }

  // ========== 时间线一致性后处理（长期校准；失败静默保留原文） ==========
  try {
    const { fixTimeline } = require("./timeline-consistency");
    fullScript = await fixTimeline(fullScript, (m) => onProgress("timeline", m));
  } catch (e) {
    console.warn("[builder] 时间线一致性校准跳过:", e.message);
  }

  onProgress("done", `剧本生成完毕：${playerChars.length}名玩家 + ${npcChars.length}名NPC`);
  return { fullScript, stages: report, characters };
}

// ==================== 框架 Prompt 构建 ====================

function buildFrameworkPrompt(userInput, cfg) {
  const { playerCount, npcCount, isPVE } = cfg;

  const npcLabel = isPVE ? "NPC嫌疑人" : (npcCount > 0 ? "NPC目击者/关系人" : "");
  const npcline = npcCount > 0 ? `+ ${npcCount}名${npcLabel}` : "";
  const npcConstraint = npcCount > 0
    ? `NPC角色恰好${npcCount}人（${npcLabel}），编号NPC1-NPC${npcCount}`
    : "无NPC（纯PVP玩家互疑）";

  // NPC章节（简洁列表，详细剧本在后续阶段单独生成）
  const npcSection = npcCount > 0
    ? `（${npcCount}人，${npcLabel}）\n用表格列出每个NPC的：编号、姓名、性别、年龄、职业/身份、与死者的关系、角色定位（${npcLabel}）、掌握的信息类型（目击什么/知道什么）。不需要展开详写，后续阶段会为每个NPC单独生成完整剧本。`
    : "（本次无NPC）";

  const murdererSection = "\n\n## ";
  const timelineSection = npcCount > 0 ? "六" : "五";

  const totalChars = playerCount + npcCount + 1; // 玩家+NPC+死者（1人）
  const minRooms = totalChars + 2; // 至少2个公共区域
  const maxRooms = Math.min(totalChars + 5, 14);

  // 关键：模板 stages.framework 含占位符（{playerCount}/{npcline}/{npcSection}/{npcConstraint}/{timelineSection}），
  // 必须替换后再作为 system 消息，否则 LLM 看到的是字面量"{{playerCount}}"、章节标题变成
  // "## {timelineSection}、故事时间线"，导致下游正则（如 extractLayoutPlaces / extractNpcRelevantSection）大面积失配。
  const system = String(stages.framework)
    .replace(/\{playerCount\}/g, String(playerCount))
    .replace(/\{npcline\}/g, npcline)
    .replace(/\{npcSection\}/g, npcSection)
    .replace(/\{npcConstraint\}/g, npcConstraint)
    .replace(/\{timelineSection\}/g, timelineSection);

  const user = `【角色数量约束 — 必须严格遵守】
玩家角色：恰好${playerCount}人
${npcConstraint}
游戏模式：${isPVE ? 'PVE侦探对抗' : 'PVP玩家互疑'}
总人数：${playerCount + npcCount}人（不超过${LIMITS.maxTotal}人）

【房间数量约束】
专属房间：${totalChars}个（${playerCount}玩家 + ${npcCount}NPC + 1死者）
公共区域：2-3个（如大厅、厨房、前院等，不包括走廊/过道/楼梯间）
总房间数：${minRooms}-${maxRooms}个

【用户需求】
${userInput}`;

  return { system, user };
}

// ==================== 结构化角色提取 ====================

/**
 * 阶段 1.5：剧本大纲生成
 * 一次性产出锁死"人数/人物卡/手法/时间线骨架/布局"的结构化大纲（JSON），
 * 后续所有阶段（角色剧本/线索/DM手册）都基于大纲创作，避免各自发散导致人数/设定冲突。
 */
async function buildOutline(userInput, cfg) {
  const { playerCount, npcCount, isPVE } = cfg;
  const npcLabel = isPVE ? "嫌疑人" : (npcCount > 0 ? "目击者/关系人" : "无NPC");
  const roleHint = isPVE
    ? `凶手可以是玩家或NPC（建议NPC更有挑战性）；NPC都是嫌疑人，各怀动机`
    : (npcCount > 0 ? `凶手在玩家之间；NPC是目击者/关系人，掌握特定时间点信息，不是凶手` : `凶手在玩家之间，纯玩家互疑`);

  const system = `你是剧本杀大纲设计师。根据需求与人数约束，直接输出一份完整剧本大纲（JSON），作为后续所有创作阶段（角色剧本、线索、DM手册）的共同蓝图。大纲必须严格锁定角色人数，后续阶段不得增减。

## 输出铁律（必须遵守）
- **不要输出任何思考过程、推理草稿、分析说明**——直接给出最终 JSON。
- 一次性在正文完整输出 JSON，且只输出一个 JSON 代码块。不要分两次、不要先给草稿再给终稿。
- 若你的推理层（如果有）已想好，正文只放 JSON，不要复述。`;

  const user = `## 用户需求
${userInput}

## 硬性人数约束（必须严格遵守，大纲中一个不多一个不少）
- 玩家角色：恰好 ${playerCount} 人
- NPC：恰好 ${npcCount} 人
- 总角色数（不含死者）：${playerCount + npcCount} 人
- 凶手：有且仅有一个
- 模式：${isPVE ? "PVE（NPC为" + npcLabel + "）" : "PVP（" + roleHint + "）"}

## 输出格式（严格 JSON，不要其他内容）
> 输出纪律：先简短思考，然后把**最终大纲**作为正文直接输出，并且**只输出一个 JSON 代码块**，代码块内就是完整 JSON，不要有任何解释文字、不要复述格式、不要把思考过程写进正文。若你的思考过程中已经设计好了，直接在正文给出 JSON 代码块（\`\`\`json 开始，\`\`\` 结束）。

{
  "title": "剧本名",
  "genre": "本格/变格/社会派/新本格（选一，默认本格）",
  "coreTrick": "核心诡计类型（密室/身份错位/时间诡计/不在场证明/叙述性诡计/多重解答等，30字内）",
  "trickSpec": {
    "trick": "诡计名称（与 coreTrick 一致）",
    "type": "密室 / 身份错位(A假装B) / 时间诡计(时差/双胞胎/钟表调慢) / 叙述性诡计 / 不在场证明 / 多重解答",
    "mechanism": "诡计具体运作原理（手法如何实现，物理/时空上必须可行，100字内）",
    "conceal": "诡计如何被隐藏（凶手如何伪装身份/制造假时间线/伪造现场）",
    "breakPoint": "会被哪 2-3 条线索/证词逐步暴露的破绽方向"
  },
  "duration": "预计游玩时长（如：3.5小时）",
  "murdererCanLie": true,
  "storyBackground": "故事背景（时代/场景/核心矛盾，150字内）",
  "layout": ["公共地点1", "公共地点2", "专属房间...（每个角色一个）", "案发地点"],
  "victim": {"name": "死者", "identity": "身份", "gender": "性别", "causeOfDeath": "死因", "deathPlace": "死亡地点"},
  "relations": [
    {"a": "角色A", "b": "角色B", "link": "两人表面关系一句话", "tension": "利益/情感纠葛一句话（可为恩怨/债务/情债/把柄/旧谊）"}
  ],
  "players": [
    {"name": "玩家1姓名", "gender": "性别", "identity": "身份/职业", "background": "简单背景1-2句", "connection": "与死者或案件的关系", "isMurderer": false}
  ],
  "npcs": [
    {"name": "NPC1姓名", "gender": "性别", "identity": "身份", "background": "简单背景1-2句", "connection": "与死者或案件的关系", "role": "嫌疑人或目击者/关系人", "isMurderer": false}
  ],
  "murderer": {
    "name": "凶手姓名", "motive": "动机简述", "method": "真实杀人手法（具体过程，60字内，物理上可行）",
    "misdeedClues": "留下的破绽方向（2-3个）",
    "realLine": "凶手真实行凶时间线（案发前24h关键节点，精确到分钟）",
    "fakeLine": "凶手对外宣称的伪装时间线/不在场证明（与 realLine 明显区分，可被证伪）"
  },
  "timeline": [
    {"time": "20:55", "desc": "核心事件（如：凶手进入书房）"}
  ]
}
要求：
- players 恰为 ${playerCount} 项、npcs 恰为 ${npcCount} 项；凶手只能出现在 players 或 npcs 中之一（isMurderer: true），且 murderer.name 必须与之对应。
- **relations 保证无边缘角色**：每名角色至少与 2 名其他角色有明确 link+tension，整体关系网必须连通（任一角都能通过关系链牵扯到案件）；凶手、死者身边人、容易被冤枉的抗推位角色之间的纠葛务必列出。请列出尽可能多的关键角色对（覆盖 5-8 对核心纠葛即可，不必穷举全部 36 对）。
- **凶手必须双时间线**：murderer.realLine（真）与 murderer.fakeLine（对外谎称）同时给出，fakeLine 要有能被 1-2 条线索/证词戳破的破绽。`;

  // 大纲是结构化 JSON：deepseek-v4-flash 等推理型模型会先用大量预算"思考"再输出正文，
  // 预算太小（8k）会被思考占满导致正文空。这里一次给足 24000（含思考+正文），
  // 同时关闭预算倍增升级（noEscalate）——升级会造成 24000→32768 的浪费且未必出文，
  // 改为"正文空则从推理内容提取 JSON"兜底（推理里已含完整设计）。
  const result = await runStage("大纲生成", () => generate(system, user, { maxTokens: 24000, temperature: 0.2, noEscalate: true }));
  let parsed = extractJsonStrict(result.content);
  // 兜底：正文为空但推理过程（reasoning_content）里已有完整 JSON 时，从推理中提取
  // （大纲是纯 JSON 任务，推理与正文内容等价；此兜底只发生在正文空=失败时，零额外 token）
  if ((parsed === null || parsed === undefined) && result.reasoningContent) {
    parsed = extractJsonStrict(result.reasoningContent);
    if (parsed) console.warn("[builder] outline 正文为空，已从推理过程提取 JSON");
  }
  if (parsed === null || parsed === undefined) {
    // 调试：把完整返回落盘（服务容器内 /tmp/outline-fail-*.md），便于定位解析失败根因
    try {
      const fs = require("fs");
      const p = "/tmp/outline-fail-" + Date.now() + ".md";
      fs.writeFileSync(p, String(result.content || "") + "\n\n---REASONING---\n\n" + String(result.reasoningContent || ""));
      console.error("[builder] outline 解析失败，完整返回已保存:", p, "len=", String(result.content || "").length);
    } catch (e) { /* ignore */ }
    throw new Error(`大纲 JSON 解析失败：${String(result.content || "").substring(0, 200)}`);
  }
  return normalizeOutline(parsed);
}

/**
 * 大纲字段归一化：LLM 可能把数组字段输出成字符串/对象（如 layout 写成字符串、
 * misdeedClues 写成 "A、B"），导致下游 .map/.join 崩溃。这里强制归一为安全类型。
 */
function normalizeOutline(o) {
  if (!o || typeof o !== "object") return o;
  const asArr = (v) => {
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === "string") return v.split(/[、，,；;|\n]/).map(s => s.trim()).filter(Boolean);
    if (v && typeof v === "object" && Array.isArray(v.items)) return v.items.filter(Boolean);
    return [];
  };
  o.players = asArr(o.players);
  o.npcs = asArr(o.npcs);
  o.layout = asArr(o.layout);
  o.timeline = asArr(o.timeline);
  if (o.relations !== undefined) o.relations = Array.isArray(o.relations) ? o.relations.filter(Boolean) : [];
  if (o.murderer && o.murderer.misdeedClues !== undefined) {
    o.murderer.misdeedClues = Array.isArray(o.murderer.misdeedClues)
      ? o.murderer.misdeedClues.filter(Boolean)
      : String(o.murderer.misdeedClues || "").split(/[、，,；;|\n]/).map(s => s.trim()).filter(Boolean);
  }
  return o;
}

/** 把大纲转成给后续阶段的提示注入文本 */
function outlineToText(outline) {
  if (!outline) return "";
  const L = [];
  L.push(`## 设定集（剧本大纲 — 所有阶段必须遵循，不得更改角色人数/姓名/身份/手法）`);
  if (outline.genre) L.push(`### 类型\n${outline.genre}${outline.coreTrick ? "｜核心诡计：" + outline.coreTrick : ""}${outline.duration ? "｜时长：" + outline.duration : ""}${outline.murdererCanLie !== undefined ? "｜凶手是否允许说谎：" + (outline.murdererCanLie ? "是" : "否") : ""}`);
  L.push(`### 故事背景\n${outline.storyBackground || ""}`);
  L.push(`### 场景布局\n${(outline.layout || []).join("、")}`);
  L.push(`### 死者\n${outline.victim?.name || ""}（${outline.victim?.identity || ""}${outline.victim?.gender ? "，" + outline.victim.gender : ""}）死于 ${outline.victim?.causeOfDeath || ""}，地点：${outline.victim?.deathPlace || ""}`);

  // 核心诡计说明书（灵魂，先行）
  const ts = outline.trickSpec || {};
  L.push(`### 核心诡计说明书（灵魂 — 所有角色剧本/线索/DM手册必须围绕并服务于它）
- 诡计：${ts.trick || outline.coreTrick || ""}
- 类型：${ts.type || ""}
- 运作原理：${ts.mechanism || ""}
- 隐藏方式：${ts.conceal || ""}
- 暴露破绽方向：${ts.breakPoint || ""}`);

  L.push(`### 人物\n玩家：${(outline.players || []).map(p => `${p.name}（${p.gender || ''}${p.identity ? "，" + p.identity : ''}）${p.isMurderer ? "【凶手】" : ""}`).join("、")}`);
  if ((outline.npcs || []).length) L.push(`NPC：${(outline.npcs || []).map(n => `${n.name}（${n.gender || ''}${n.identity ? "，" + n.identity : ''}）${n.isMurderer ? "【凶手】" : ""}`).join("、")}`);

  // 人物关系网（每对都有纠葛，保证无边缘角色）
  if ((outline.relations || []).length) {
    L.push(`### 人物关系网（所有角色对已锁定 — 各角色剧本/线索必须体现这些纠葛）
${outline.relations.map(r => `- ${r.a} ↔ ${r.b}：表面 ${r.link || ""}；纠葛 ${r.tension || ""}`).join("\n")}`);
  }

  L.push(`### 凶手\n${outline.murderer?.name || ""}，动机：${outline.murderer?.motive || ""}，手法：${outline.murderer?.method || ""}`);
  // 凶手双时间线：真实 / 伪装
  if (outline.murderer?.realLine) L.push(`### 凶手真实时间线（DM掌握真相）\n${outline.murderer.realLine}`);
  if (outline.murderer?.fakeLine) L.push(`### 凶手伪装时间线（对外谎言，需能被1-2条线索戳破）\n${outline.murderer.fakeLine}`);
  L.push(`### 时间线骨架\n${(outline.timeline || []).map(t => `${t.time} ${t.desc}`).join("；") || ""}`);
  return L.join("\n");
}

/**
 * 交叉校验送检内容：原实现只送 fullScript 前 14000 字（完整剧本约 43000 字），
 * 后 2/3 角色的时间线从未被检查。改为"全部角色时间线章节 + 基准时间线"的结构化送检，
 * 在同样的 token 预算内让每一节都被核对到。
 */
function buildCrossCheckDigest(fullScript, maxChars = 16000) {
  const text = String(fullScript || "");
  const lines = text.split("\n");
  const EXCLUDE = /(故事时间线|表面时间线|真实时间线|完整时间线)/;
  const targets = [], bases = [];
  let owner = "";
  for (let i = 0; i < lines.length; i++) {
    const om = lines[i].match(/^#{2,4}\s*((?:玩家角色|NPC)\s*\d+\s*[:：].*)$/);
    if (om) owner = om[1].trim();
    if (!/^#{1,4}\s+.*时间线/.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,4}\s+/.test(lines[j])) break;
      body.push(lines[j]);
    }
    const content = body.join("\n").trim();
    if (!content) continue;
    const item = { owner: owner || "未知", anchor: lines[i].trim(), content };
    (EXCLUDE.test(lines[i]) ? bases : targets).push(item);
  }
  if (!targets.length) {
    return `${text.substring(0, maxChars)}\n\n（注：未能提取角色时间线章节，以上为剧本开头片段）`;
  }
  const per = Math.max(600, Math.floor((maxChars - 2500) / targets.length));
  const L = ["## 各角色时间线（逐节送检，必须逐节与基准核对）"];
  for (const s of targets) L.push(`\n### ${s.owner} ｜ ${s.anchor}\n${s.content.substring(0, per)}`);
  if (bases.length) {
    L.push("\n## 基准时间线（DM 权威，用于比对）");
    for (const s of bases) L.push(`\n### ${s.anchor}\n${s.content.substring(0, 2500)}`);
  }
  return L.join("\n");
}

/**
 * 阶段 4.5：模块交叉校验
 * 生成完成后，让 LLM 以"挑剔硬核玩家"身份对照设定集，交叉检查各模块（人物剧本/时间线/线索/DM手册）
 * 之间的逻辑一致性，输出 issue 列表。只报告，不自动改写——具体修正交给 reviewer/人工。
 */
async function runModuleCrossCheck(report, frameworkSummary, fullScript, onProgress) {
  const system = `你是一位极度挑剔的硬核剧本杀玩家。给你一份已生成的剧本和它的设定集（蓝图），
请你找出各模块之间所有的逻辑漏洞。重点核对：
1. 人物剧本中的时间线 vs 设定集时间线骨架 vs DM手册时间线 是否互相矛盾（同一时刻不同角色说法是否冲突）
2. 凶手手法 vs 线索（物理证据能否支撑手法、谜面与谜底是否对得上）
3. 角色姓名/身份/人数 vs 设定集是否一致（有没有擅自增减或改名）
4. 地点 vs 设定集布局（剧本里出现的地点是否都在布局中）
5. 关键破绽/动机 vs 设定集凶手设定是否吻合
只输出 JSON：{"ok": true, "issues": ["问题1（引用具体时间/人名/段落）", "问题2", ...]}，issues 为空数组表示无问题。`;

  const digest = buildCrossCheckDigest(fullScript, 16000);
  const user = `## 设定集（权威蓝图）
${report.outline ? outlineToText(report.outline) : frameworkSummary.substring(0, 3000)}

## 待检剧本内容（已含全部角色时间线，仅逐节截断；请对每一节都做核对）
${digest}

请逐项交叉核对，找出所有逻辑漏洞并输出 JSON：`;

  const result = await runStage("交叉校验", () => generate(system, user, { maxTokens: TOKENS_LIGHT, temperature: 0.2 }));
  const data = extractJsonStrict(result.content) || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  // 让结论可见：原实现仅 console.warn，issues 无任何消费方，管理员在界面上完全看不到
  if (onProgress) {
    onProgress("crosscheck", issues.length
      ? `交叉校验发现 ${issues.length} 个问题：${issues.slice(0, 3).join("；")}`
      : "交叉校验未发现问题");
  }
  return { issues, ok: data.ok !== false };
}

/** 从大纲直接取角色列表（人数已被大纲锁定，不再让 LLM 自创） */
function extractCharactersFromOutline(outline, cfg) {
  const chars = [];
  const murdererName = outline.murderer?.name || "";
  for (const p of (outline.players || [])) {
    if (!p.name || String(p.name).trim().length < 2) continue;
    chars.push({
      name: String(p.name).trim(),
      type: "player",
      isMurderer: Boolean(p.isMurderer) || p.name === murdererName,
      occupation: String(p.identity || "").trim(),
    });
  }
  for (const n of (outline.npcs || [])) {
    if (!n.name || String(n.name).trim().length < 2) continue;
    chars.push({
      name: String(n.name).trim(),
      type: "npc",
      isMurderer: Boolean(n.isMurderer) || n.name === murdererName,
      occupation: String(n.identity || "").trim(),
    });
  }
  return chars;
}

async function extractCharactersStructured(framework, cfg) {
  const minExpected = cfg.playerCount || LIMITS.minPlayers;

  const prompt = `请从以下剧本杀故事框架中提取所有角色的结构化信息。以 JSON 格式返回，不要其他内容。

格式要求：
[
  {
    "name": "角色姓名",
    "type": "player 或 npc",
    "isMurderer": true或false,
    "occupation": "职业/身份"
  }
]

规则：
1. 必须提取框架中出现的**每一个**角色（包括玩家和NPC），一个都不能漏
2. 【玩家】角色 type = "player"，位于"玩家角色设定"章节
3. 【NPC嫌疑人】角色 type = "npc"，位于"NPC角色列表"章节（无此章节则全部为player）
4. 凶手有且仅有一个，isMurderer = true
5. 按玩家先、NPC后的顺序排列

故事框架：
${framework.substring(0, 8000)}

请提取所有角色，只输出 JSON 数组：`;

  try {
    const result = await generate(
      "你是一个数据提取工具。从剧本框架中提取角色信息，只输出 JSON 数组。",
      prompt,
      { maxTokens: 1024, temperature: 0.1 }
    );
    const cleaned = result.content.trim()
      .replace(/```json\n?/g, "").replace(/```\n?/g, "");

    const chars = extractJsonStrict(cleaned);
    if (Array.isArray(chars) && chars.length >= 2) {
      return chars.map(c => ({
        name: String(c.name || "").trim(),
        type: c.type === "npc" ? "npc" : "player",
        isMurderer: Boolean(c.isMurderer),
        occupation: String(c.occupation || "").trim(),
      })).filter(c => c.name.length >= 2 && c.name.length <= 8);
    }
  } catch (e) {
    console.error("结构化角色提取失败，回退到传统方法：", e.message);
  }

  return extractCharactersFallback(framework, minExpected);
}

function extractCharactersFallback(framework, minExpected) {
  minExpected = minExpected || LIMITS.minPlayers;
  const chars = [];

  const playerPattern = /(?:玩家\d|玩家[一二三四五六])[：:]\s*(.{2,6})/g;
  let m;
  while ((m = playerPattern.exec(framework)) !== null) {
    const name = m[1].trim().replace(/[【\[].*$/, "");
    if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "player", isMurderer: false, occupation: "" });
    }
  }

  const npcPattern = /(?:NPC\d|NPC嫌疑人|NPC\s*\d)[：:\s]+(.{2,6})/g;
  while ((m = npcPattern.exec(framework)) !== null) {
    const name = m[1].trim().replace(/[【\[].*$/g, "").replace(/\s*\[.*$/, "");
    if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
    }
  }

  // 补充：从NPC嫌疑人章节提取 - **姓名**：xxx 格式
  const npcSection = (framework.match(/NPC嫌疑人设定[\s\S]*?(?=凶手设定|##\s*[五六七八九]、|重要约束)/) || [])[0] || "";
  if (npcSection && chars.filter(c => c.type === "npc").length === 0) {
    const namePattern = /\*\*姓名\*\*[：:]\s*(.{2,6})/g;
    let nm;
    while ((nm = namePattern.exec(npcSection)) !== null) {
      const name = nm[1].trim();
      if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
        chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
      }
    }
  }

  if (chars.length < minExpected) {
    const genericPattern = /(?:###\s+)?角色[一二三四五六七八\d]+[：:]\s*(.{2,6})/g;
    while ((m = genericPattern.exec(framework)) !== null) {
      const name = m[1].trim().replace(/[【\[].*$/, "");
      if (name.length >= 2 && name.length <= 6 && !chars.find(c => c.name === name)) {
        const isNpc = /NPC/.test(framework.substring(Math.max(0, m.index - 100), m.index + 200));
        chars.push({ name, type: isNpc ? "npc" : "player", isMurderer: false, occupation: "" });
      }
    }
  }

  // 不够 minExpected 时补齐占位
  while (chars.length < minExpected) {
    chars.push({ name: `角色${chars.length + 1}`, type: "player", isMurderer: false, occupation: "" });
  }

  const murdererRegex = /凶手[姓名]*[：:]\s*(.{2,6})/;
  const murMatch = framework.match(murdererRegex);
  if (murMatch) {
    const murName = murMatch[1].trim();
    const found = chars.find(c => c.name === murName || murName.includes(c.name) || c.name.includes(murName));
    if (found) found.isMurderer = true;
  }

  return chars.slice(0, LIMITS.maxTotal);
}

// ==================== Prompt 构建 ====================

function buildCharacterPrompt(ch, framework, index, total, isPVE, outline) {
  // PVE：玩家是调查者/侦探，NPC是嫌疑人——用简版模板；PVP：玩家互疑——用详版模板
  const tpl = isPVE ? stages.playerSleuthInstruction : stages.playerInstruction;
  let instructions = tpl
    .replace("{characterName}", ch.name);

  if (!isPVE) {
    // PVP：填充"调查目标" + 凶手注入（凶手可能在玩家中）
    const victimName = (framework.match(/死者信息[\s\S]*?姓名与身份[：:]\s*《?(.+?)》?/) || [])[1] || "死者";
    instructions = instructions
      .replace("{investigateTask}", `你想查明${victimName}之死的真相——结合线索与时间线推理，找出真凶`)
      .replace("{isMurdererExtra}", ch.isMurderer
        ? `\n4. **你是凶手**：请尽可能隐藏自己的凶手身份，误导他人，直到投票结束。\n\n### 四、凶手确认（仅你可见）\n⚠️ 你就是凶手。用 150-300 字陈述你的**真实**作案经过（手法、真实时间、地点、凶器去向）与你的对外口径。这段内容融入上方"背景故事"与"时间线"，让玩家靠线索推理而非直接读出。\n\n    **重要澄清（覆盖上一句）**：上一句只要求"真相别写成大白话"，**不是**让你把时间线写空。「二、你的时间线」必须写**对外口径（伪装时间线）**：同样完整、至少 8 个时间点，覆盖从到场到案发后的全部时段；把你离厅行凶那段时间写成对外声称的去处（例如"一直在客厅与某人争吵"），并刻意留出可被其他角色证词推翻的细节破绽。真实经过只放在「四、凶手确认」供 DM 核对，**绝不要写进时间线**。`
        : "");
  } else {
    // PVE：玩家不是凶手（凶手在NPC中），无需凶手注入，移除占位符
    instructions = instructions.replace("{investigateTask}", "").replace("{isMurdererExtra}", "");
  }

  // 设定集硬约束：最终角色名单 + 死者（防 framework 初稿的旧名/旧设定污染剧本）
  let constr = "";
  if (outline) {
    const allNames = [...(outline.players || []).map(p => p.name), ...(outline.npcs || []).map(n => n.name)]
      .filter(Boolean).join("、");
    constr = `\n\n## ⚠️ 设定集硬约束（最高优先级）
- 本剧本唯一有效角色名单：${allNames}（死者：${outline.victim?.name || ""}）。严禁出现名单之外的角色名（framework 初稿中不在名单内的旧角色一律作废）。
- 你的名字：「${ch.name}」，身份「${ch.occupation || outline.players?.find(p => p.name === ch.name)?.identity || ""}」。
- 若你是侦探（PVE），本案真凶在其中一名NPC中（${outline.murderer?.name || "见设定集"}）；你掌握的信息见你的剧本，不要直接读出真凶名字。`;
  }

  return `请为【玩家${index}/${total}】角色撰写完整个人剧本。

## 角色基本信息
- 姓名：${ch.name}
- 身份：${ch.occupation || "详见框架"}
- 角色类型：${isPVE ? "调查者/侦探（非嫌疑人）" : (ch.isMurderer ? "玩家（凶手）" : "玩家")}

## 设定集（最终权威）
${outline ? outlineToText(outline).substring(0, 3000) : "（无设定集）"}
${constr}

## 完整故事框架（供参考，仅用于背景一致；与设定集冲突时以设定集为准）
${framework.substring(0, 6000)}

## 要求
${instructions}

请直接输出角色剧本内容，不需要 JSON 包装。`;
}

function extractNpcRelevantSection(framework, npcName, isPVE, isMurderer) {
  const parts = [];
  // 死者信息单独提取（每个NPC必须围绕同一死者）
  const victimSection = framework.match(/##\s*二、\s*死者信息[\s\S]*?(?=##\s*[三四五六七八九]、|$)/);
  if (victimSection) {
    parts.push('## 【核心】死者信息（所有NPC必须与此死者相关）\n' + victimSection[0].substring(0, 1500));
  }
  // 基本设定+时代背景（前2000字）
  parts.push('## 时代背景与场景\n' + framework.substring(0, 2000));

  // NPC设定章节（嫌疑人 / 目击者 两种命名兼容）
  const npcChapterTitle = isPVE ? "NPC嫌疑人设定" : "NPC目击者/关系人设定";
  const npcChapter = framework.match(new RegExp(`##\\s*[四五六七八]、\\s*(?:NPC嫌疑人设定|NPC目击者\\/关系人设定|NPC角色设定)[\\s\\S]*?(?=##\\s*[五六七八九]、|\\n## 重要约束|$)`));
  if (npcChapter) {
    parts.push(`## ${npcChapterTitle}章节\n` + npcChapter[0].substring(0, 2500));
  } else if (isPVE) {
    // 兼容旧版"NPC嫌疑人设定"字样
    const legacy = framework.match(/NPC嫌疑人设定[\s\S]*?(?=\n## |$)/);
    if (legacy) parts.push('## NPC嫌疑人章节\n' + legacy[0].substring(0, 2500));
  }

  // 凶手设定章节：只注入给凶手 NPC（非凶手 NPC 若看到凶手的作案细节，会被引导写成凶手的行动）
  // ——通过参数传递"是否为凶手"，在此过滤。
  if (isMurderer) {
    const murdererChapter = framework.match(/##\s*[五六]、\s*凶手设定[\s\S]*?(?=##\s*[六七八]、|\n## 重要约束|$)/);
    if (murdererChapter) parts.push(murdererChapter[0].substring(0, 2000));
  }

  // 时间线中提及该NPC的段落（只提取与该NPC本人相关的行，绝不给"完整时间线"兜底
  // ——完整时间线全是其他角色的活动，若塞给本NPC，LLM 会以他人为主语写错剧本）
  const timelineChapter = framework.match(/##\s*[六七八]、\s*故事时间线[\s\S]*?(?=##\s*[七八九]、|\n## 重要约束|$)/);
  if (timelineChapter) {
    const lines = timelineChapter[0].split('\n');
    const relevantLines = lines.filter(l => l.includes(npcName));
    if (relevantLines.length > 0) {
      parts.push('## 时间线（' + npcName + '相关行，仅供对齐——你最终写出的时间线必须以你自己为主语）\n' + relevantLines.join('\n'));
    }
    // 找不到该NPC的行 → 不注入任何时间线内容；由设定集+本NPC信息自行生成自己的时间线
  }

  // 角色关系图
  const relationChapter = framework.match(/##\s*[七八九]、\s*角色关系图[\s\S]*?(?=##\s*[八九十]、|\n## 重要约束|$)/);
  if (relationChapter) parts.push(relationChapter[0].substring(0, 2000));

  return parts.join('\n\n').substring(0, 8000);
}

function buildNpcPrompt(ch, framework, index, total, isPVE, npcCount, outline) {
  // 权威信息源：大纲（设定集，最终角色名/凶手/关系）优先，framework 初稿仅作补充
  const outlineText = outline ? outlineToText(outline) : "";
  // 从大纲（若存在）提取与该NPC相关的段落
  const outlinePart = outline ? extractOutlineNpcPart(outline, ch.name, outlineText) : "";
  // 从 framework 提取（作为背景补充，但大纲存在时其权重降低；凶手设定/时间线按角色过滤）
  const npcSection = extractNpcRelevantSection(framework, ch.name, isPVE, ch.isMurderer);
  // PVP模式下NPC用目击者模板，PVE用嫌疑人模板
  const npcTemplate = (!isPVE && npcCount > 0) ? stages.npcWitnessInstruction : stages.npcInstruction;
  const isWitness = !isPVE;
  const label = isPVE ? "NPC嫌疑人" : "NPC目击者/关系人";
  // 最终名单硬约束（防框架旧名污染：素心/柳寒山等初稿名字必须禁用）
  const allNames = (outline ? [...(outline.players || []).map(p => p.name), ...(outline.npcs || []).map(n => n.name)] : [])
    .filter(Boolean).join("、");
  const murdererName = outline?.murderer?.name || "";
  const instructions = npcTemplate
    .replace("{characterName}", ch.name)
    .replace("{isMurdererExtra}", ch.isMurderer
      ? `### 五、凶手确认（该NPC是凶手，仅供DM掌握）
⚠️ 该NPC就是凶手（全局唯一真凶）。务必写明（300字以上）：
- 作案经过：**以该NPC本人为主语**，完整还原他/她在何时何地、用什么手法、如何完成下毒/制造密室/取走密文的全过程（与设定集 murderer.method 一致，参照其 realLine）；
- 对外口径：该NPC对外宣称的行踪/不在场证明；
- 破绽：能戳破其伪装的具体线索一两条；
- 关键：本剧本的时间线与"凶手确认"必须自洽——时间线里要体现其作案的关键动作（如取药、送茶、潜入书房），不能与"我不是凶手"矛盾。
此节仅供DM掌握真相，不会被玩家直接看到。`
      : "");

  const hardConstraint = outline
    ? `\n\n## ⚠️ 最终名单硬约束（最高优先级，必须严格遵守）
- 本剧本的唯一有效角色名单为：${allNames}（死者：${outline.victim?.name || ""}）。**严禁出现名单外的名字**（framework 初稿中的角色名如与名单不符一律作废，不得使用）。
- 你的名字是「${ch.name}」。全剧本（人物关系/时间线/秘密）**只能以你自己的视角和行动为主语**撰写，不要写其他角色的详细时间线。
- 真凶是「${murdererName || "见设定集"}」，与设定集一致。若你不是真凶，请在"时间线/秘密"中体现你的可疑与清白并存；若你是真凶（见第五节），时间线必须还原你的作案过程。`
    : "";

  return `请为【${label}${index}/${total}】撰写详尽角色信息。

## NPC基本信息
- 姓名：${ch.name}
- 身份：${ch.occupation || "详见框架"}
- 角色定位：${label}
- 是否是凶手：${ch.isMurderer ? "是（凶手是NPC！）" : "否"}

## 设定集（最终权威，最高优先级）
${outlinePart || (outlineText ? outlineText.substring(0, 3000) : "（无设定集）")}

## 与该NPC相关的故事段落（framework 背景补充，若与设定集冲突以设定集为准）
${npcSection}
${hardConstraint}

## 要求
${instructions}

严格约束：最终名单以设定集为准；生成内容必须与设定集一致，禁止使用设定集之外的旧角色名。

请直接输出NPC信息内容，不需要 JSON 包装。`;
}

/** 从大纲中提取与该NPC相关的段落（权威信息：凶手手法realLine、关系、时间线骨架中的相关行） */
function extractOutlineNpcPart(outline, npcName, outlineText) {
  const parts = [];
  const m = outline.murderer || {};
  // 凶手设定（含作案手法）**只注入给凶手本人**——非凶手 NPC 若看到凶手手法，
  // 会被引导把凶手的行动写进自己的剧本（历史事故：王氏时间线全写赵高）。
  if (m.name && npcName === m.name) {
    const brief = outlineText.split("### 凶手")[1] || "";
    if (brief) parts.push("### 凶手设定（全局真相，仅你可见）\n### 凶手" + brief.substring(0, 800));
  }
  // 该NPC在人物列表中的信息
  const allChars = [...(outline.players || []), ...(outline.npcs || [])];
  const me = allChars.find(c => c.name === npcName) || allChars.find(c => c.name && npcName.includes(c.name));
  if (me && (me.background || me.connection)) {
    parts.push(`### 你的背景\n${me.background || ""}${me.connection ? "\n与案件关系：" + me.connection : ""}`);
  }
  // 时间线骨架中含该NPC的行
  const tl = (outline.timeline || []).filter(t => (t.desc || "").includes(npcName));
  if (tl.length) parts.push("### 时间线骨架（与你相关）\n" + tl.map(t => `- ${t.time} ${t.desc}`).join("\n"));
  // 真实双时间线（若是凶手）
  if (m.realLine && npcName === m.name) parts.push(`### 你的真实作案时间线\n${m.realLine}`);
  if (m.fakeLine && npcName === m.name) parts.push(`### 你的对外宣称时间线\n${m.fakeLine}`);
  return parts.join("\n\n");
}

function buildCharacterSystemPrompt(ch, isPVE) {
  if (isPVE) {
    // PVE：玩家是调查者/侦探，剧本简洁——背景+来此目的
    return `你是剧本杀角色剧本作家。为【调查者/侦探】"${ch.name}"撰写一份简洁的玩家剧本（600-1200字）。该角色的任务是调查死者之死、找出真凶（真凶在NPC中）。第一人称简述案发背景与来此目的即可，不需要长篇个人经历、杀机或私人时间线。`;
  }
  return ch.isMurderer
    ? `你是剧本杀角色剧本作家。为【PVP玩家 — 凶手】"${ch.name}"撰写2500-4000字的深度个人剧本。使用第一人称叙事：写清身份、与其他玩家及死者的关系（部分隐藏以便交流推断）、可被推断的杀机、精确时间线、任务。凶手部分需包含真实的作案经过陈述（融入剧本，让凶手玩家知晓自己所为），但不直接教玩家如何掩饰。`
    : `你是剧本杀角色剧本作家。为【PVP玩家】"${ch.name}"撰写2500-4000字的深度个人剧本。使用第一人称叙事：写清身份、与其他玩家及死者的关系（部分隐藏以便其他玩家靠交流推断）、可被推断的杀机、精确时间线、任务。不包含"你应该怎么玩"的策略指导，由玩家自行判断。`;
}

function buildNpcSystemPrompt(ch, setting, isWitness) {
  const era = setting?.era || "";
  const location = setting?.location || "";
  const victimName = setting?.victim || "死者";
  const settingContext = `故事发生在${era}的${location}。死者是${victimName}。`;

  if (isWitness) {
    return `你是剧本杀角色剧本作家。${settingContext}为【NPC目击者/关系人】"${ch.name}"撰写一份1500-2500字的角色档案。该NPC不是凶手，但他的目击信息和个人秘密让他显得可疑。重点写他看到了什么、听到了什么，以及有什么个人秘密使他表现紧张。**所有内容必须围绕死者${victimName}展开。** 时代背景${era}。`;
  }

  return ch.isMurderer
    ? `你是剧本杀角色剧本作家。${settingContext}为【NPC嫌疑人 — 凶手】"${ch.name}"撰写一份3000-4000字的详尽角色档案（第三人称纯叙事）。必须严格遵循下方模板中的结构（一至六），逐一详细填写。作案过程必须写明具体手法、时间、地点和留下的破绽。**所有内容必须围绕死者${victimName}展开。** 内容必须与${era}的时代背景一致。`
    : `你是剧本杀角色剧本作家。${settingContext}为【NPC嫌疑人】"${ch.name}"撰写一份3000-4000字的详尽角色档案（第三人称纯叙事）。必须严格遵循下方模板中的结构（一至五），逐一详细填写。包含充分的作案动机、完整时间线和秘密，使其成为有说服力的嫌疑人。**所有内容必须围绕死者${victimName}展开。** 内容必须与${era}的时代背景一致。`;
}

/**
 * 从框架中提取布局真实地点清单（供线索发现地点约束使用）
 * 解析"地点场景/场景布局"章节中的房间/地点名，返回去重后的列表
 */
function extractLayoutPlaces(framework) {
  if (!framework) return [];
  const places = new Set();
  const push = (name) => {
    const n = String(name || "").trim()
      .replace(/^[-*\s]+/, "")
      .replace(/\*\*+$/, "")          // 尾部加粗标记
      .replace(/[：:].*$/, "").trim();
    if (n && n.length >= 2 && n.length <= 14
      && !/^(一|二|三|四|五|六|七|八|九|十)$/.test(n)
      && !n.includes("**")
      && !/描述|布局|平面|地图|章节|列表|设定|信息|概要|#/.test(n)) places.add(n);
  };

  // 1) "地点场景"字段的整体描述（可能含列表项；兼容 **加粗** 与普通标签）
  const sceneMatch = framework.match(/(?:\*\*)?地点场景(?:\*\*)?[：:]\s*([\s\S]*?)(?=\n(?:#{1,3}\s|[-*]\s*姓名|-?\s*\*\*沿革|[-*]\s*\*\*布局|\n\*\*|\n##\s*[一二三四五六七八九]、))/);
  let sceneText = sceneMatch ? sceneMatch[1] : "";
  // 截断到"参与人数/游戏时长/难度等级"之前（这些是基本设定字段，不是布局）
  const fieldCut = sceneText.search(/[-*]\s*(?:参与人数|游戏时长|难度等级|角色概要|故事氛围)/);
  if (fieldCut > 0) sceneText = sceneText.substring(0, fieldCut);
  // 场景描述中提取"X位于/朝向/连接"提到的房间名
  const roomWords = ['书房', '大厅', '厨房', '餐厅', '卧室', '闺房', '起居室', '走廊', '楼梯', '花园', '前院', '后院', '杂物间', '仆人房', '客厅', '客房', '药房', '诊室', '浴室', '卫生间', '储藏室', '车库', '阁楼', '地下室', '阳台', '庭院', '正厅', '门厅'];
  // 场景文本内的房间词
  for (const w of roomWords) {
    if (sceneText.includes(w)) places.add(w);
  }
  // 列表项形式的条目（"厅堂："/"书房：位于…"）
  const listItems = sceneText.match(/[-*]\s*([^：:\n]{2,12})[：:]/g);
  if (listItems) listItems.forEach(l => push(l.replace(/^[-*]\s*/, "").replace(/[：:]/g, "")));

  // 2) 布局清单条目：`- **某地点**：位于...`（地点章节/布局描述），兼容加粗或普通
  const layoutEntryRe = /[-*]\s*(?:(?:\*\*)([^：:\n]{2,14})(?:\*\*)|([^：:\n*]{2,14}))[：:]\s*(?:位于|在|坐落|设有|包含|包括|为|是)/g;
  let le;
  while ((le = layoutEntryRe.exec(framework)) !== null) {
    push(le[1] || le[2]);
  }

  // 3) 独立"场景布局/平面布局"章节（如果有），只提取"地名：位于..."条目
  const layoutHeads = framework.match(/##\s*[一二三四五六七八九十]、\s*(?:场景布局|平面布局|房间布局|地点分布)[^\n]*\n([\s\S]*?)(?=\n##\s*[一二三四五六七八九十]、|$)/);
  if (layoutHeads) {
    const entryRe = /[-*]\s*(?:(?:\*\*)([^：:\n]{2,14})(?:\*\*)|([^：:\n*]{2,14}))[：:]\s*(?:位于|在|坐落|设有|包含|包括|为|是)/g;
    let me;
    while ((me = entryRe.exec(layoutHeads[1])) !== null) {
      push(me[1] || me[2]);
    }
    // 兼容无"位于"的纯列表（如 "大厅：正厅…"），但排除 ### 标题与纯描述段
    const plainItems = layoutHeads[1].match(/^[-*]\s*(?!###)(?:\*\*)?([^：:\n]{2,12})(?:\*\*)?[：:]/gm);
    if (plainItems) plainItems.forEach(l => push(l.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").replace(/[：:]/g, "")));
  }

  // 3) 兜底：死者信息/角色设定里的房间词也纳入
  if (framework.includes("案发现场") && !places.has("书房")) {
    // 不强制，交由显式提取
  }

  return [...places];
}

/**
 * 校验并把线索发现地点统一到布局真实地点
 * 仅对 物证/痕迹/文件/知识型线索 生效；搜身/证词（人物名）豁免。
 * 若地点不在布局清单中：能匹配到布局房间词 → 归一为该房间；完全未知 → 保留并告警。
 */
function normalizeClueLocations(cluesText, layoutPlaces) {
  if (!cluesText || !layoutPlaces || layoutPlaces.length === 0) return { text: cluesText, fixed: 0, skipped: 0 };
  // 布局地点的主词（如"沈曼青闺房"→"闺房"）
  const placeWords = [];
  for (const p of layoutPlaces) {
    placeWords.push(p);
    // 复合名（"沈曼青闺房"）拆出核心词
    const core = p.replace(/^[^一二三四五六七八九十]{1,4}(房间|闺房|卧室|书房|客厅|起居室|走廊|厨房|餐厅|花园|庭院|药房|诊室|正厅|门厅)/, '$1');
    if (core !== p && core.length >= 2) placeWords.push(core);
  }
  // 子位置词 → 其主地点（"走廊地毯"→走廊；"书房桌面"→书房），仅用于归一目标，不作独立合法地点
  const subToMain = {
    '走廊地毯': '走廊', '走廊窗台': '走廊', '走廊尽头': '走廊',
    '门框上沿': '书房', '门闩底部': '书房', '门内侧': '书房',
    '茶盏内壁': '茶盏',
    '梳妆台': '闺房', '衣柜深处': '闺房', '床底': '卧室',
    '床头柜': '卧室', '床头': '卧室',
    '灶台': '厨房', '水井': '厨房', '水井旁': '厨房',
  };
  for (const k in subToMain) if (!placeWords.includes(k)) placeWords.push(k);
  if (!placeWords.includes('走廊')) placeWords.push('走廊');
  if (!placeWords.includes('茶盏')) placeWords.push('茶盏');
  // 人物名（豁免：搜身/证词）
  const personNames = ['周管家', '沈曼青', '林医生', '管家', '医生', '仆人', '仆役', '女佣', '车夫', '账房', '丫鬟', '下人'];
  // 随身物件/部位词（"人名+随身物" = 搜身，豁免布局约束）
  const bodyItemWords = ['药箱', '书柜', '抽屉', '茶盘', '暗格', '衣柜', '梳妆台', '床底', '床铺', '床头柜', '枕头', '钱包', '衣袋', '口袋', '扣子', '袖', '手', '伤', '疤痕', '指甲'];

  const blockRe = /(###\s+[A-CM]\d+[：:][\s\S]*?)(?=###\s+[A-CM]\d+[：:]|$)/g;
  let fixed = 0, skipped = 0;
  const replaced = cluesText.replace(blockRe, (block) => {
    const typeMatch = block.match(/线索类型[：:]\s*(.+)/);
    const locMatch = block.match(/发现地点[：:]\s*(.+)/);
    if (!locMatch || !typeMatch) return block;
    const type = typeMatch[1].trim();
    const loc = locMatch[1].trim();
    // ① 证词/人证 → 豁免
    if (/人证|证词|口供|陈述/.test(type)) { skipped++; return block; }
    // ② 搜身：地点含人物名 + 随身物词 → 豁免（"周管家右手""林医生药箱""沈曼青梳妆台"）
    const hasPerson = personNames.some(n => loc.includes(n));
    const hasBodyItem = bodyItemWords.some(w => loc.includes(w));
    if (hasPerson && hasBodyItem) { skipped++; return block; }
    // ③ 知识型文件（含文档词，如处方/清单/账本/记录）→ 视为随身文件，豁免
    const hasDocWord = /记录|清单|存根|处方|发货单|笔[记]|手册|图谱|账本|收据|日志|信|遗书|字条|纸条|合影|照片/.test(loc) || /知识型/.test(type);
    if (hasDocWord && !locationIsInLayout(loc, placeWords)) { skipped++; return block; }
    // ④ 地点已在布局中（含子位置形态，如"书房桌面""沈曼青闺房窗台"）→ 保留
    if (locationIsInLayout(loc, placeWords)) return block;
    // ⑤ 尝试归一：地点包含布局房间词 → 归为该房间（去子位置，如"走廊地毯"→走廊）
    const hit = placeWords.find(w => loc.includes(w));
    if (hit) {
      fixed++;
      return block.replace(/发现地点[：:]\s*.+/, `发现地点：${hit}`);
    }
    // ⑥ 完全未知地点 → 保持原样（提示由 reviewer/人工处理）
    skipped++;
    return block;
  });

  return { text: replaced, fixed, skipped };
}

function locationIsInLayout(loc, placeWords) {
  return placeWords.some(w => loc.includes(w));
}

function getCluesSystemPrompt() {
  return `你是剧本杀线索设计专家。确保每条线索都是"客观事实描述"而非结论：禁止使用"证明X是凶手/嫌疑最大/证实其说谎"等判定句；线索需能与角色剧本的秘密/时间线交叉验证；涉及毒药/药物/机关时必须包含知识型线索（性状/发作时间/获取途径）供玩家结合剧本推理；整体形成 2-3 条推理链且有烟雾弹。输出40-50条线索，分为**两轮**（第一轮=人物关系与杀机，第二轮=尸体与重推理），并用 "## 第一轮线索" / "## 第二轮线索" 标题分隔轮次；两轮内均可适当放几条误导线索。`;
}

function getDMSystemPrompt() {
  return `你是剧本杀DM手册撰写专家。请输出完整的主持人手册，包括游戏流程、开场白、完整时间线、真相复盘、多种结局和注意事项。需详细严谨，DM能直接使用。`;
}

// ==================== 摘要与组装 ====================

function buildStructuredSummary(report) {
  const chars = report.characters || [];
  const players = chars.filter(c => c.type === "player");
  const npcs = chars.filter(c => c.type === "npc");
  const murderer = chars.find(c => c.isMurderer);

  let summary = "## 角色结构摘要\n\n";
  // 若存在大纲（阶段1.3产出），大纲作为权威蓝图最先给出，后续所有阶段必须遵循
  if (report.outline) {
    summary += outlineToText(report.outline) + "\n\n";
  }
  summary += `### 玩家角色（${players.length}人）\n`;
  players.forEach((c, i) => {
    summary += `- 玩家${i + 1}：${c.name}（${c.occupation || "待定"}）${c.isMurderer ? "【凶手】" : ""}\n`;
  });

  if (npcs.length > 0) {
    summary += `\n### ${report.isPVE ? 'NPC嫌疑人' : 'NPC目击者/关系人'}（${npcs.length}人）\n`;
    npcs.forEach((c, i) => {
      summary += `- NPC${i + 1}：${c.name}（${c.occupation || "待定"}）${c.isMurderer ? "【凶手】" : ""}\n`;
    });
  } else {
    summary += `\n### NPC\n（无 — 纯PVP模式）\n`;
  }

  summary += `\n### 凶手\n- 凶手：${murderer?.name || "未知"}（${murderer?.type === "npc" ? (report.isPVE ? "NPC嫌疑人" : "NPC关系人") : "玩家"}）\n\n`;

  // ===== 关键信息区：以大纲（设定集）为唯一权威，绝不注入 framework 原文 =====
  // 历史上 framework 初稿的角色名/凶手/时间体系与大纲锁定后的最终设定不一致
  // （如：素心vs小翠、柳寒山vs陈风、下午vs晚上时间系），若把 framework 原文传给下游，
  // LLM 会被旧设定带偏，产出"两版凶手/两版时间线"的灾难性剧本。
  if (report.outline) {
    const o = report.outline;
    const extraParts = [];
    if (o.trickSpec) {
      extraParts.push(`### 核心诡计（最终版）\n${o.trickSpec.trick || ""}｜${o.trickSpec.type || ""}\n${o.trickSpec.mechanism || ""}`);
    }
    if (o.timeline && o.timeline.length) {
      extraParts.push(`### 时间线骨架（最终版，唯一时间体系）\n${o.timeline.map(t => `- ${t.time} ${t.desc}`).join("\n")}`);
    }
    if (o.murderer && o.murderer.method) {
      extraParts.push(`### 凶手手法（最终版，唯一真相）\n${o.murderer.method || ""}${o.murderer.misdeedClues ? "\n破绽方向：" + (Array.isArray(o.murderer.misdeedClues) ? o.murderer.misdeedClues.join("、") : String(o.murderer.misdeedClues)) : ""}`);
    }
    if (o.layout && o.layout.length) {
      extraParts.push(`### 场景布局（最终版）\n${o.layout.join("、")}`);
    }
    extraParts.push(`### 死者（最终版）\n${o.victim?.name || ""}（${o.victim?.identity || ""}）死于${o.victim?.causeOfDeath || ""}，地点${o.victim?.deathPlace || ""}`);
    return summary + "\n## 设定集关键信息（唯一权威，禁止使用本文档之外的角色名/时间/手法）\n\n" + extraParts.join("\n\n");
  }

  const fw = report.framework || "";
  const importantSections = [];
  const sectionPatterns = [
    /(?:##\s*[一二三四五六七八九十]、[^\n]+)[\s\S]*?(?=##\s*[一二三四五六七八九十]、|$)/g,
  ];

  for (const pattern of sectionPatterns) {
    let match;
    while ((match = pattern.exec(fw)) !== null) {
      const section = match[0];
      if (/(?:死者|凶手|时间线|关系)/.test(section.substring(0, 30))) {
        importantSections.push(section.substring(0, 1500));
      }
    }
  }

  const extra = importantSections.length > 0
    ? importantSections.join("\n\n")
    : fw.substring(0, 3000);

  return summary + "\n## 框架关键信息\n\n" + extra;
}

// ==================== 组装 ====================

/** 从 framework 文本中提取形如 "**时代背景**：xxx" 或 "时代背景：xxx" 的字段值 */
function fwField(fw, label) {
  if (!fw) return "";
  const re = new RegExp("(?:\\*\\*)?\\s*" + label + "(?:\\*\\*)?[：:]\\s*([^\\n]+)");
  const m = fw.match(re);
  return m ? m[1].trim() : "";
}

/** 从 framework 文本中按标题关键字切出一整段（含标题行），切到下一个 # 标题为止 */
function fwSection(fw, kw) {
  if (!fw) return "";
  const lines = fw.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i]) && lines[i].includes(kw)) { start = i; break; }
  }
  if (start < 0) return "";
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (i < lines.length && /^#{1,4}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

/**
 * 删除文本中标题匹配 keyword 的整段（含其下正文，直到下一个同级/更高级标题）。
 * 用于消除成稿中的重复章节（如 DM 手册内重复的"完整时间线"）。
 */
function stripSectionByKeyword(text, keywordRe) {
  if (!text) return text;
  const lines = String(text).split("\n");
  const out = [];
  let skipLevel = 0;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level > skipLevel) continue;      // 被删章节的子标题一并跳过
      if (skipLevel && level <= skipLevel) skipLevel = 0; // 遇到同级/更高级标题，结束跳过
      if (!skipLevel && keywordRe.test(h[2])) { skipLevel = level; continue; }
    } else if (skipLevel) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function assembleScript(report, userInput) {
  const parts = [];
  const chars = report.characters || [];
  const players = chars.filter(c => c.type === "player");
  const npcs = chars.filter(c => c.type === "npc");
  const fw = report.framework || "";
  const outline = report.outline || {};
  const victim = outline.victim || {};
  const murderer = outline.murderer || {};
  const title = outline.title || fwField(fw, "剧本名称") || "未命名剧本";
  const era = outline.era || fwField(fw, "时代背景");
  const location = outline.location || fwField(fw, "地点场景");
  const gameMode = report.isPVE ? "PVE" : "PVP";
  const playerCountStr = outline.playerCount || playerCharsCount(players) || fwField(fw, "参与人数");
  const duration = outline.duration || fwField(fw, "游戏时长") || "3-5小时";
  const difficulty = fwField(fw, "难度等级") || "中等";
  const npcCount = npcs.length;

  parts.push(`# 《${title}》\n`);
  parts.push(`> 生成时间：${new Date().toISOString()}\n`);
  parts.push(`> 角色结构：${players.length}名玩家 + ${npcCount}名NPC\n`);
  parts.push(`---\n`);

  // ========== 第一部分：故事背景与案发现场 ==========
  parts.push(`# 第一部分：故事背景与案发现场\n`);

  // 基本设定（保留 parser/splitter 依赖的字段标记：时代背景/地点场景/参与人数/游戏时长/难度等级）
  parts.push(`## 一、基本设定\n`);
  parts.push(`- **剧本名称**：《${title}》\n`);
  parts.push(`- **游戏模式**：${gameMode}\n`);
  parts.push(`- **时代背景**：${era}\n`);
  parts.push(`- **地点场景**：${location}\n`);
  parts.push(`- **参与人数**：${playerCountStr}${npcCount > 0 ? "（含 " + npcCount + " 名NPC）" : ""}\n`);
  parts.push(`- **游戏时长**：${duration}\n`);
  parts.push(`- **难度等级**：${difficulty}\n`);

  // 故事背景（优先 outline.storyBackground，其次 framework 的氛围/背景段）
  const bg = outline.storyBackground || fwSection(fw, "故事氛围") || fwSection(fw, "故事背景");
  if (bg) {
    parts.push(`\n## 二、故事背景\n`);
    parts.push(bg.replace(/^#{1,4}\s*\S[^\n]*\n/, "") + "\n");
  }

  // 死者信息
  parts.push(`\n## 三、死者信息\n`);
  parts.push(`- **姓名与身份**：${victim.name || ""}${victim.identity ? "（" + victim.identity + "）" : ""}\n`);
  parts.push(`- **死亡时间**：${victim.deathTime || ""}\n`);
  parts.push(`- **死亡地点**：${victim.deathPlace || ""}\n`);
  parts.push(`- **直接死因**：${victim.causeOfDeath || ""}\n`);
  const bodyDesc = fwSection(fw, "尸体状态") || fwSection(fw, "现场");
  if (bodyDesc) parts.push(`- **尸体状态**：\n${bodyDesc.replace(/^#{1,4}\s*\S[^\n]*\n/, "")}\n`);
  parts.push(`\n`);

  // 案发现场与场景布局图
  // 优先级：① buildLayoutIfMissing 生成的方位描述（report.layoutText）
  //         ② framework 布局段 / 大纲 layout
  //         ③ 纯清单兜底（见下）
  let layoutText = report.layoutText
    || fwSection(fw, "场景布局")
    || (outline.layout && outline.layout.length ? outline.layout.join("、") : "");
  // fwSection 可能只抓到标题行（framework 布局段为空时）——此时视为无布局
  if (layoutText && layoutText.replace(/^#{1,4}\s*\S[^\n]*/, "").trim().length < 4) layoutText = "";
  // 纯清单兜底：以上都没有时，从线索归纳出核心场所列表（只列场所，不列子位置/人名）
  if (!layoutText) {
    const placeSet = [];
    const clueLocRe = /发现地点[：:]\s*([^\n]+)/g;
    const clueText = report.clues || "";
    let cm;
    while ((cm = clueLocRe.exec(clueText)) !== null) {
      let loc = cm[1].trim();
      if (!loc || loc.length > 20) continue;
      // 剥掉人名前缀（如"王福""赵四""陈画影""李琴心""随行医师"——发现地点写成人名的是搜身/证词类，不是场所）
      // 剥掉括号子位置（如"柳惊鸿房间（书桌抽屉）"→"柳惊鸿房间"）
      loc = loc.replace(/[（(][^）)]*[）)]/g, "").trim();
      // 过滤明确不是场所的（尸体/人名/随身物）
      if (/尸体|尸体旁|证词|陈述|口供|随身|衣|鞋|手|怀表|戒指|发簪|身上|口袋/.test(loc)) continue;
      // 过滤纯人名（两个字的像人名；保险起见：含"房间/书房/大厅"等场所词才保留，否则跳过）
      if (!/房间|书房|大厅|走廊|厨房|仓库|工坊|居所|庭院|花园|帐房|闺房|卧室|正堂|药铺|库房|院子|阁楼|厢房|值房|书房|寝殿|宫|亭|门|窗|地下室|浴室|账房/.test(loc)) continue;
      if (!placeSet.includes(loc)) placeSet.push(loc);
    }
    if (placeSet.length) {
      // 以案发现场为锚点，描述场所与相互关系
      const anchor = outline.victim?.deathPlace || placeSet[0];
      const others = placeSet.filter(p => p !== anchor);
      let lines = [];
      lines.push(`- **案发现场**：${anchor}`);
      others.forEach((p, i) => {
        lines.push(`- **${p}**：案发现场附近的日常活动场所${i === 0 ? "（与案发现场相邻）" : ""}`);
      });
      layoutText = "本局主要场所及相互关系：\n" + lines.join("\n") + "\n（各场所的具体位置关系以线索和角色剧本为准）";
    } else if (outline.victim?.deathPlace) {
      layoutText = "主要场所：案发现场位于「" + outline.victim.deathPlace + "」，另有各角色日常活动区域（详见各角色剧本与线索发现地点）。";
    }
  }
  if (layoutText) {
    parts.push(`## 四、案发现场与场景布局图\n`);
    // 剥掉 fwSection 自带的原始标题行（如"## 八、场景布局图"），避免重复标题
    parts.push(layoutText.replace(/^#{1,4}\s*\S[^\n]*\n/, "") + "\n");
  }
  parts.push(`---\n`);

  // ========== 第二部分：人物角色 ==========
  parts.push(`# 第二部分：人物角色\n`);
  parts.push(`## 玩家角色剧本\n\n`);
  for (let i = 0; i < players.length; i++) {
    const name = players[i].name;
    const tag = players[i].isMurderer ? " [凶手]" : "";
    // 告知凶手：明确直陈"你就是凶手"
    parts.push(`### 玩家角色 ${i + 1}：${name}${tag}\n`);
    if (players[i].isMurderer) {
      parts.push(`> ⚠️ 你就是凶手！你的处境与真实过程见下方剧本。\n\n`);
    }
    parts.push(report.characterScripts[name] || "(内容缺失)");
    parts.push(`\n`);
  }

  if (npcs.length > 0) {
    const npcTitle = report.isPVE ? "NPC嫌疑人信息" : "NPC目击者/关系人信息";
    parts.push(`---\n`);
    parts.push(`## ${npcTitle}\n\n`);
    for (let i = 0; i < npcs.length; i++) {
      const name = npcs[i].name;
      const tag = npcs[i].isMurderer ? " [凶手]" : "";
      parts.push(`### NPC ${i + 1}：${name}${tag}\n`);
      if (npcs[i].isMurderer) {
        parts.push(`> ⚠️ 他是凶手！此信息仅供 DM 掌握。\n\n`);
      }
      parts.push(report.characterScripts[name] || "(内容缺失)");
      parts.push(`\n`);
    }
  }

  parts.push(`---\n`);

  // ========== 第三部分：线索系统 ==========
  parts.push(`# 第三部分：线索系统\n`);
  parts.push(report.clues || "");
  parts.push(`\n---\n`);

  // ========== 第四部分：DM 手册 ==========
  parts.push(`# 第四部分：DM 手册\n`);
  // 凶手设定（保留 parser 依赖的"凶手设定/凶手姓名/作案动机/作案手法"标记）
  parts.push(`## 一、凶手设定\n`);
  parts.push(`- **凶手姓名**：${murderer.name || ""}\n`);
  parts.push(`- **作案动机**：${murderer.motive || ""}\n`);
  parts.push(`- **作案手法**：${murderer.method || ""}\n`);
  if (murderer.misdeedClues) parts.push(`- **破绽与线索**：${murderer.misdeedClues}\n`);
  if (murderer.realLine) parts.push(`- **真实时间线**：${murderer.realLine}\n`);
  if (murderer.fakeLine) parts.push(`- **伪装时间线（对外谎言）**：${murderer.fakeLine}\n`);
  parts.push(`\n`);

  // 人物关系总览
  // 有大纲时只用大纲的 relations（权威）；framework 初稿的关系图含旧角色名，绝不拼回成稿
  const relSection = outline.relations && outline.relations.length ? "" : fwSection(fw, "角色关系图");
  if (relSection || (outline.relations && outline.relations.length)) {
    parts.push(`## 二、人物关系总览\n`);
    if (outline.relations && outline.relations.length) {
      parts.push(outline.relations.map(r => `- ${r.a} ↔ ${r.b}：表面 ${r.link || ""}；纠葛 ${r.tension || ""}`).join("\n") + "\n");
    }
    if (relSection) parts.push("\n" + relSection.replace(/^#{1,4}\s*\S[^\n]*\n/, "") + "\n");
    parts.push(`\n`);
  }

  // 上帝时间线
  // 同理：有大纲时间线时不再拼 framework 初稿时间线（否则成品出现两套时间体系）
  const hasOutlineTimeline = outline.timeline && outline.timeline.length;
  const timelineSection = hasOutlineTimeline ? "" : fwSection(fw, "故事时间线");
  const dmTimeline = (report.dmGuide || "").includes("完整时间线") ? fwSection(report.dmGuide, "完整时间线") : "";
  if (timelineSection || dmTimeline || hasOutlineTimeline) {
    // 标题同时保留"完整时间线"（parser dmGuide 提取）与"故事时间线"（timeline-consistency 基准）关键字
    parts.push(`## 三、完整时间线（故事时间线 · 上帝视角）\n`);
    if (outline.timeline && outline.timeline.length) {
      parts.push((outline.timeline || []).map(t => `- ${t.time} ${t.desc}`).join("\n") + "\n");
    }
    if (timelineSection) parts.push("\n" + timelineSection.replace(/^#{1,4}\s*\S[^\n]*\n/, "") + "\n");
    if (dmTimeline) parts.push("\n" + dmTimeline.replace(/^#{1,4}\s*\S[^\n]*\n/, "") + "\n");
    parts.push(`\n`);
  }

  // DM 手册正文
  // ① 剥掉模型自带的顶级标题（如 "# 《书名》DM主持人手册"）——否则会与上方的
  //    "# 第四部分：DM 手册" 形成"两个 DM 手册标题"的视觉混淆。
  // ② 剥掉 DM 手册内的"完整时间线"章节——它已作为 dmTimeline 合并到上方
  //    "## 三、完整时间线"，否则同一份时间线会出现两次。
  let dmBody = String(report.dmGuide || "").trim();
  dmBody = dmBody.replace(/^#\s+[^\n]*(DM|主持人|手册)[^\n]*\n+/, "");
  dmBody = stripSectionByKeyword(dmBody, /完整时间线/);
  parts.push(`## 四、主持流程与复盘\n`);
  parts.push(dmBody || report.dmGuide || "");
  parts.push(`\n---\n`);

  parts.push(`\n# 剧本统计\n`);
  const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
  parts.push(`- 总字数：约 ${Math.round(totalChars * 0.7).toLocaleString()} 字\n`);
  parts.push(`- 玩家角色：${players.length} 人\n`);
  parts.push(`- NPC${report.isPVE ? '嫌疑人' : '目击者/关系人'}：${npcs.length} 人\n`);
  parts.push(`- 线索总数：约 40-50 条\n`);

  return parts.join("\n");
}

function playerCharsCount(players) {
  return players && players.length ? String(players.length) : "";
}

module.exports = { buildMurderMystery, LIMITS, extractLayoutPlaces, normalizeClueLocations, buildOutline, outlineToText, extractCharactersFromOutline, runModuleCrossCheck, assembleScript, fwSection, fwField, MIN_TIMELINE_POINTS, countTimelinePoints, extractCharacterTimeline, ensureTimelineComplete, buildCrossCheckDigest };
