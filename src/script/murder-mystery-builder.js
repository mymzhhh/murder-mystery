// 剧本杀多阶段生成流水线（v3：动态玩家数2-6、NPC 0-3）

const { generate } = require("../llm/generator");
const { extractJsonStrict, repairTruncatedJson } = require("./json-extract");
const { cutCharacterName, isValidCharacterName } = require("./script-parser");
// 时间/时间线文本工具：与 story-bible（权威表对账）共用同一份实现，
// 避免"两个模块对同一个时刻解读不同"——这类问题最难查（见 timeline-utils 的注释）。
const { hmOf, minutesOf, extractCharacterTimeline, escapeRe } = require("./timeline-utils");
// 权威表（剧本圣经）：把大纲事实变成可逐条对账的结构 + 确定性检查
const sb = require("./story-bible");
// 权威表的执行层（补齐/逐人对账/跨角色裁定）；依赖由这里注入，避免循环依赖
const bibleEnforce = require("./bible-enforce");

// 时间写法纪律（注入所有写作阶段）：全剧以 **24 小时制为唯一权威**。
// 为什么必须在源头写进提示词：实测《听雪山庄》全文 57 处时辰词、8 处与时刻差 1.5~3.5 小时
//（"酉时四刻（座钟20:30）"——酉时四刻是 18:00），玩家按角色本陈述会与所有目击者的时间线全对不上，
// DM 复盘"戌时了断与作案时刻吻合"这类断言也自相矛盾。事后可查（checkShichenConsistency），但最好的修法是**第一次就不写错**。
/** 线索时刻纪律：证词必须自带时刻（否则玩家无法把它钉在时间线上） */
const CLUE_TIME_RULE = `

## ⏰ 线索时刻纪律（违反会被程序判为不合格）
- **证词类线索必须自带时刻**：一律写成「某人说：**HH:MM** 我（看到/听到/做了什么）……」，把时刻写在证词正文里。
  为什么：证词的价值就在于"某人**何时**看到/听到"；没有时刻，玩家无法把它钉到时间线上，这条线索等于废掉。
- **物品/物证类线索不需要故事内时刻**（它是搜证阶段在现场被找到的），但**必须写清发现地点**（用布局里的真实地点名）。
- 时刻必须与设定集的时间线一致，不要另编一个时刻。`;

const TIME_SYSTEM_RULE = `

## ⏰ 时间写法纪律（违反会被程序判错并要求改回）
- 本剧**以 24 小时制为唯一权威**（如 21:35）。时间线、证词、验尸记录一律写 24 小时制。
- 若要写古风时辰词，必须与 24 小时制严格对应：子23:00–01:00｜丑01:00–03:00｜寅03:00–05:00｜卯05:00–07:00｜辰07:00–09:00｜巳09:00–11:00｜午11:00–13:00｜未13:00–15:00｜申15:00–17:00｜酉17:00–19:00｜戌19:00–21:00｜亥21:00–23:00。
- 一个时辰 8 刻、每刻 15 分钟，从**时辰起始**起算：午时三刻=11:45、酉时四刻=18:00、戌时三刻=19:45、亥时三刻=21:45。
- **不要在括号里做换算**（"酉时四刻（20:30）"这种写法一旦算错就前后矛盾）；拿不准就只写 24 小时制，不要写时辰。`;
const { designTrick, trickDesignToText, nextClueId, insertCluesIntoRound2, normalizeClueBlocks } = require("./trick-design");
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
/**
 * 单个阶段的**硬超时**（默认 10 分钟，可用 STAGE_TIMEOUT_MS 调整）。
 *
 * 为什么必须有（实测，2026-10-17）：整本生成在 `npc_script (1/2)` 处**挂死 23 分钟**，
 * 日志一行不出、进程还活着。根因是 runStage 只对**抛错**重试 —— 挂死的调用永远不返回，
 * 那个 for 循环就永远不推进，"重试当前阶段"这条兜底完全用不上。
 * 而超时抛出的错误消息里带 "timeout"，正好命中 isNetErr ✓ → 直接走既有重试路径，
 * 不需要另写一套。最坏情况 = 3 次尝试 × 阶段超时上限（比"永远停住"好得多）。
 *
 * ⚠️ 默认值 10 → 15 分钟（2026-10-18 实测）：
 * 用火山方舟 ark-code-latest 生成时，framework 阶段连续撞满 10 分钟超时，
 * 日志时间差正好是 601s / 602s（= 每次都在同一个上限被打断），
 * 4 次重试白烧 40 分钟、整轮跑了 75 分钟还没出稿。
 * 长本（4 角色 × 4000+ 字 + 40 条线索 + 完整 DM 手册）的输出本来就重，
 * 上限卡在 10 分钟会让"慢但能成"的阶段被反复打断 —— 那比多等 5 分钟更糟。
 */
const STAGE_TIMEOUT_MS = Math.max(60000, parseInt(process.env.STAGE_TIMEOUT_MS, 10) || 15 * 60 * 1000);
function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`stage timeout: ${label} 超过 ${Math.round(ms / 1000)}s 未返回`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const isNetErr = (e) => {
  const m = String((e && (e.message || e.code)) || "").toLowerCase();
  return /getaddrinfo|enotfound|econn|etimedout|socket hang up|socket|refused|timeout|network|dns|fetch failed|undici|aborted/i.test(m);
};
async function runStage(stageName, fn, onProgress) {
  let lastErr = null;
  for (let a = 0; a <= STAGE_NET_RETRIES; a++) {
    try {
      return await withTimeout(fn(), STAGE_TIMEOUT_MS, stageName);
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

/**
 * NPC 时间线最少时间点数（与 NPC 模板的"至少 6 个时间点"一致）。
 *
 * 为什么 NPC 要单独一个更低的数（2026-10-17 实测）：NPC 的篇幅预算本就比玩家小
 *（目击者 1500-2500 / 嫌疑人 1200-2000，玩家 3400-5200），且 NPC 时间线只覆盖
 * "案发当日及前一日的行动轨迹"，不含完整背景动线。所以 8 条对 NPC 不合适，
 * 但"不设下限"更不行 —— 实测漏写时只剩 5 条。
 */
const MIN_NPC_TIMELINE_POINTS = 6;

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

// escapeRe / extractCharacterTimeline / hmOf / minutesOf 已移到 ./timeline-utils
// （与 story-bible 共用；builder 继续对外导出，调用方与测试不受影响）

/**
 * 找出死者的**死亡时刻**（真实时间轴上的权威值）。
 *
 * 为什么必须单独抽出来：实测三次复验里都出现"某角色在死者已死之后还写他活着、说话、下指示"
 * （如基准 19:20 已身亡，某角色却写 20:00 死者还在交代事情）。角色拿到的是一张
 * 「真实时间 | 座钟显示 | 事件」的大表，其中的死亡条目**没有任何特殊地位**——
 * 模型不会自动把它当成一条不可违反的禁令。把它抽成一条显式约束才拦得住。
 *
 * ⚠️ 必须排除"发现尸体/报案"那一条：它的描述里同样含"死亡/尸体"字样，
 * 但那是**发现**时刻而不是死亡时刻，混用会把禁令的时间点整体推后。
 */
/**
 * 从时间线里找死者的**死亡时刻**。
 *
 * ⚠️ 实测漏判（本轮验证抓到）：动词表原来只有 身亡/死亡/遇害/被杀/断气/气绝/毙命/死去/咽气/丧命，
 * **不含「击杀」**。当时间线写成「20:40 …在站台击杀周世奎」时，这里**静默返回 null**，
 * 于是 buildSharedFacts 里那条"死者死后不得再与死者互动"的硬约束**整条不注入**给任何角色，
 * ensureDeathConsistent 也永不启动——三轮端到端里"就地改写"从未触发，根因就在这里：
 * **不是修复路径不工作，而是检测压根没跑**。静默失效比报错难发现得多，
 * 所以这里做两件事：① 动词表覆盖常见的致死表述；② 判不出来时由调用方出声音（见角色阶段）。
 *
 * 关于"计划行"：「19:00 谭志强决定杀死周世奎」说的是打算，不是已发生的事，
 * 把它当成死亡时刻会让禁令整体提前、进而把**写对了的**内容判成违规并被改写（危害大于漏判）。
 * 所以计划行**一律不算候选**；宁可判不出来（有告警、只是少一层保护），也不能判错。
 *
 * ⚠️ 第二次漏判（补验后的下一轮真实生成又抓到）：时间线写「…用冻硬铁托盘击头**致死**」——
 * 这类**结果补语构词**（X致死 / X而死 / 失血过多而死）当时一条都不在表里。
 * 教训：这张表不能只列"死亡动词"，还要列"致死构词"；靠词表终究会有边界，
 * 所以"判不出来就告警"那条兜底必须一直留着（它正是这次能发现漏判的原因）。
 */
const DEATH_RE = /(身亡|死亡|遇害|遇刺|被杀|杀死|击杀|击毙|勒死|缢死|毒死|刺死|捅死|砍死|打死|掐死|闷死|淹死|溺死|烧死|电死|摔死|砸死|捂死|坠亡|炸死|枪杀|断气|气绝|毙命|死去|咽气|丧命|致死|而死|杀害|丧生|殒命|命丧|亡故|毙)/;
/**
 * 预谋/计划语境：这些行描述的是"打算做什么"，不是"已经死了"。
 * ⚠️ 只收**明确表示尚未发生**的词。刻意不收「计划/准备/商量」——
 * 它们会与已发生的事实同句出现（"周世奎正准备离开，被谭志强从背后击杀"），
 * 收进来会把真实的死亡行误排除掉（宁可漏判，不可误判）。
 */
const DEATH_PLAN_RE = /(决定|打算|预谋|密谋|谋划|意图|想要|扬言|威胁|伺机)/;
function findDeathMoment(outline) {
  const rows = (outline && outline.timeline) || [];
  const DISCOVERY_RE = /(发现|察觉|找到|报案|报警|见到尸体|尸体已被)/;
  const victimName = String((outline && outline.victim && outline.victim.name) || "").trim();

  const cands = rows.filter((r) => {
    const d = String((r && r.desc) || "");
    if (DISCOVERY_RE.test(d)) return false;              // 发现/报案不是死亡时刻
    if (DEATH_PLAN_RE.test(d)) return false;             // 计划行不是死亡时刻
    return DEATH_RE.test(d);
  });
  const pick = (pool) => (victimName && pool.find((r) => String(r.desc).includes(victimName))) || pool[0];
  const toTime = (row) => (row ? hmOf(row.time) : null);
  if (cands.length) {
    const t = toTime(pick(cands));
    // ⚠️ 不能在这里直接 `return toTime(...)`：候选行的 time 可能 hmOf **解析不出**
    //（如写成"案发前后"），而下面的死因兜底明明能判出这一条。
    // 原实现只要 cands 非空就直接 return，于是那个 null 被原样交出去 →
    // 整层死亡约束静默失效。改成"解析出来才返回，否则继续往下兜底"。
    if (t) return t;
  }

  // 兜底：靠**死因描述**定位，而不是靠死亡动词。
  // ⚠️ 第三次实测漏判（1993 成都·川剧团）：时间线写「21:10 贺清源推倒大戏箱压住陈慕舟口鼻」——
  // 全句**没有任何死亡动词**，它只描述了动作本身；而死因字段写的是"被推倒的大戏箱压住口鼻窒息死亡"。
  // 靠词表穷举永远会漏（前两次漏了"击杀"、漏了"致死"），所以再加一条**结构化**判据：
  // 行内**同时出现死者姓名与死因的实词片段** → 这一行就是死亡时刻。
  // 要求"死者姓名 + 死因片段同现"是刻意的：只匹配死因片段会把"某人搬动那个大戏箱"也算进来。
  const kw = causeKeywords(outline && outline.victim && outline.victim.causeOfDeath);
  if (!kw.length || !victimName) return null;
  const fallback = rows.filter((r) => {
    const d = String((r && r.desc) || "");
    if (DISCOVERY_RE.test(d)) return false;
    if (DEATH_PLAN_RE.test(d)) return false;
    if (!d.includes(victimName)) return false;           // 死者必须在场（作为受害者被提及）
    if (victimActs(d, victimName)) return false;         // 死者若是这一行的动作主体，多半是他生前在做事
    // ⚠️ 第四次实测漏判（2026-10-17）：死因短语常被**死者姓名插在中间** ——
    // 死因写「钝器击打后脑」，行文却是「用压片轮击打**邱长贵**后脑」，
    // 要求短语连续出现必然落空（4 字窗口"击打后脑"被姓名劈开）。
    // 所以把姓名从行文里摘掉后再匹配一次。这不放宽判据：上面已经要求
    // "这一行提到了死者"且"死者不是动作主体"，摘掉姓名只是把这句话还原成死因的措辞。
    const noName = d.split(victimName).join("");
    return kw.some((k) => d.includes(k) || noName.includes(k));
  });
  if (fallback.length) return toTime(pick(fallback));
  return null;
}

/**
 * 从死因描述里抽出用于"定位死亡时刻"的实词片段。
 * 例：「被推倒的大戏箱压住口鼻窒息死亡」→ 推倒 / 大戏箱压住口鼻窒息 / 大戏箱压 / 压住口鼻 …
 * 只保留 ≥3 字的片段（太短会到处命中，制造误判）。
 */
function causeKeywords(causeOfDeath) {
  const s = String(causeOfDeath || "").trim();
  if (!s) return [];
  const cleaned = s.replace(/(被|的|而|致|导致|当场|最终|死亡|身亡|致死|身死|不幸|造成|引发)/g, " ");
  const chunks = cleaned.split(/[\s，,、；;。！!？?（）()【】\[\]—–\-]+/).filter(Boolean);
  const out = new Set();
  for (const c of chunks) {
    if (c.length >= 3) out.add(c);
    for (let i = 0; i + 4 <= c.length; i++) out.add(c.slice(i, i + 4));   // 长片段切 4 字窗口提高命中
  }
  return [...out];
}

/** 公共事件表的渲染、校验与补齐 —— 见下方 buildPublicEventTable 注释 */
const MIN_PUBLIC_EVENTS = 6;

/** 角色的公开名册（players + npcs + **死者**） */
function rosterNames(outline) {
  const names = [...((outline && outline.players) || []), ...((outline && outline.npcs) || [])]
    .map((p) => String((p && p.name) || "").trim()).filter(Boolean);
  // ⚠️ 死者必须算合法当事人。第一版只取 players+npcs，把"东家独自进茶仓"这类
  // **死者的公开行踪**判成"当事人不在名单内"并丢弃——那恰恰是公共事件表最该收录的内容。
  // （实测：把死者「苏鹤年」误判为名单外的幽灵人名，差点删掉他的全部行踪条目。）
  const victim = String((outline && outline.victim && outline.victim.name) || "").trim();
  if (victim && !names.includes(victim)) names.push(victim);
  return names;
}

/** 净化公共事件条目：时刻非法 / 无当事人的条目直接丢弃（宁可少给也不给错），并按时刻排序、去重 */
function normalizePublicEvents(raw) {
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== "object") continue;
    const time = String(e.time || "").trim();
    const actor = String(e.actor || "").trim();
    if (minutesOf(time) === null || !actor) continue;
    const who = Array.isArray(e.who) ? e.who : String(e.who || "").split(/[、，,；;|]/);
    out.push({
      time,
      actor,
      place: String(e.place || "").trim(),
      doing: String(e.doing || "").trim(),
      who: who.map((s) => String(s).trim()).filter(Boolean),
    });
  }
  const seen = new Set();
  return out
    .filter((e) => { const k = `${e.actor}@${e.time}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (minutesOf(a.time) || 0) - (minutesOf(b.time) || 0));
}

/**
 * 校验角色级公共事件表是否够用。非致命——不达标走 ensurePublicEvents 定向补齐。
 * 覆盖度要求（每个角色都应在公开场合被看到）只作为**补齐的触发条件**，不做硬失败：
 * 万一某角色确实整晚没露面，最多多花一次补齐调用，不会让整条流水线失败。
 */
function validatePublicEvents(outline) {
  const events = (outline && outline.publicEvents) || [];
  const roster = rosterNames(outline);
  if (!events.length) {
    return { ok: false, errors: ["完全没有 publicEvents（角色级公共事件表）"], missingActors: roster, count: 0 };
  }
  const errors = [];
  if (events.length < MIN_PUBLIC_EVENTS) {
    errors.push(`publicEvents 只有 ${events.length} 条，覆盖不足（至少 ${MIN_PUBLIC_EVENTS} 条）`);
  }
  const badActor = events.filter((e) => !roster.includes(String(e.actor || "").trim()));
  if (badActor.length) {
    errors.push(`${badActor.length} 条的 actor 不在角色名单内（如「${String(badActor[0].actor || "").slice(0, 10)}」）`);
  }
  const missingActors = roster.filter((n) => !events.some((e) => String(e.actor || "").trim() === n));
  if (missingActors.length) {
    errors.push(`以下角色没有任何公开事件（人人都该有能被目击的行踪）：${missingActors.join("、")}`);
  }
  return { ok: errors.length === 0, errors, missingActors, count: events.length };
}

/** 跨午夜时统一的日期分界说明（事件表与公共事件表共用，避免两处措辞不一致） */
function midnightRuleText(rows, caseDate) {
  if (!crossesMidnight(rows)) return "";
  const nextDate = nextDayLabel(caseDate);
  return `- ⚠️ **本剧本跨过午夜**：表中 00:00 之后的时刻属于**案发次日**${nextDate ? `（即 ${nextDate}）` : ""}。` +
    `凡 00:00–05:59 的条目，日期必须写案发次日${caseDate ? `（${caseDate} 是案发当日，**不要**把午夜后的时刻标成它）` : ""}；` +
    `凡 17:00–23:59 的条目属于案发当日。**禁止把整段夜间事件统一标成同一天。**`;
}

/**
 * 角色级公共事件表 —— 权威来源是大纲的 `publicEvents`。
 *
 * 为什么需要它（实测）：事件表只能对齐**大纲时间线里确实存在的事件**。
 * 而"某角色某时刻上楼、手里拿着什么"这类**角色级公共事件**不在 timeline 里，
 * 于是每个角色各自编一套——交叉校验原文："苏韵秋上楼时间互相矛盾：顾行舟称18:30…；
 * 苏砚生称…约19:00；郑慕桥称18:30…；阿蘅称'宴未散便先上楼'——上楼时刻与携带物
 * （黑漆账匣/蓝布账本/青布包袱/一册账）**四种说法不一致**"。
 */
function buildPublicEventTable(outline) {
  const roster = rosterNames(outline);
  // ⚠️ 必须过滤掉"名单外的当事人/在场者"：实测模型会写出一个设定集里不存在的角色名
  // （如大纲说 苏鹤年，而名单里没有他）。这类条目一旦注入，等于把**虚构人物名**送进
  // 每个角色的提示词——正是代码其他地方严令禁止的"名单外角色名污染"。
  const events = ((outline && outline.publicEvents) || []).filter((e) => {
    const actor = String((e && e.actor) || "").trim();
    return actor && (!roster.length || roster.includes(actor));
  });
  if (!events.length) return "";
  const caseDate = parseCaseDate(outline);
  const L = [];
  L.push("## 角色级公共事件表（所有人看到的行踪必须与此一致）");
  L.push("- 下表是案发夜**公开可见**的角色行踪（谁、何时、在哪、在做什么）。凡你的时间线写到下表已有的事件（无论你是当事人还是目击者），**时刻、地点、随身物必须与下表逐字一致**；同一件事只能有一个时刻。");
  L.push("- **若你是某一条的当事人（当事人列写了你），你必须在自己的时间线里写出该时刻的这条行踪**——这是你被别人看到的样子，不能改成别的时刻或别的随身物。");
  L.push("- 表中「在场其他人」可能目击到该条；若你当时在场，你的时间线里该时刻也必须与之一致。");
  // 这一条是针对实测里最顽固的一类冲突：角色给**别人**安排了表里没有的行踪。
  // 交叉校验原文："贺掌柜20:00称在账房见秦少棠一人在拨算盘…但秦少棠时间线当晚根本不在账房"。
  // 表不可能穷举"每个人对每个人的每次目击"，但可以禁止**无依据地把某人的身份安在某个时刻某个地点上**。
  L.push("- ⚠️ **不得凭空给他人安排行踪**：凡你写到**另一个角色**在某个具体时刻出现在某地或做了某事，该条必须能在上表（或你自己的时间线）里找到依据。表里没有的，你只能写你确实看到的现象而**不指定是谁**（如「账房里亮着灯，有个人影在拨算盘」），绝不能断言「那人是某某」——实测这一类断言是交叉校验里最常被抓的硬伤。");
  const mr = midnightRuleText(events, caseDate);
  if (mr) L.push(mr);
  L.push("");
  L.push("| 时刻 | 当事人 | 地点 | 公开行为（别人能看到的） | 在场其他人 |");
  L.push("|---|---|---|---|---|");
  for (const e of events) {
    const who = (e.who || []).filter((n) => !roster.length || roster.includes(String(n).trim()));
    L.push(`| ${e.time} | ${e.actor} | ${e.place || "—"} | ${String(e.doing || "").replace(/\|/g, "/").slice(0, 60)} | ${who.join("、") || "—"} |`);
  }
  return L.join("\n");
}

/**
 * 检查：作为某条公共事件「当事人」的角色，其剧本里是否出现了该时刻。
 *
 * ⚠️ **只作为告警，绝不触发重写**——"当事人未必逐条复述自己的每次走动"，
 * 缺失不等于错误。把它当硬约束会重演 8.3.1 那种误报事故（误报会主动破坏正确内容）。
 * 时钟诡计下角色可能写【座钟】读数，所以真实时刻与换算后的钟面时刻都算命中。
 */
function checkPublicEventAnchors(charName, text, events, deltaMin) {
  const name = String(charName || "").trim();
  const body = String(text || "");
  if (!name || !body) return { needed: false, missing: [], ok: true };
  const mine = (events || []).filter((e) => String((e && e.actor) || "").trim() === name);
  if (!mine.length) return { needed: false, missing: [], ok: true };
  const missing = [];
  for (const e of mine) {
    const real = hmOf(e.time) || String(e.time).trim();
    const shifted = deltaMin ? shiftClock(real, deltaMin) : null;
    if (!body.includes(real) && !(shifted && body.includes(shifted))) {
      missing.push({ time: real, doing: String(e.doing || "").slice(0, 40) });
    }
  }
  return { needed: true, missing, ok: missing.length === 0 };
}

/**
 * 定向补齐公共事件表（缺陷分级里的"可局部补丁"一档）。
 * 只补一次、只输出 JSON 数组、失败即放弃并如实告警——绝不因此让整条流水线失败。
 */
async function ensurePublicEvents(outline, cfg, onProgress) {
  if (!outline) return outline;
  const roster = rosterNames(outline);
  const rawCount = ((outline.publicEvents) || []).length;
  // 先净化 + 丢弃"当事人不在角色名单内"的条目：这类条目一旦留存，会以虚构人名污染下游所有提示词
  outline.publicEvents = normalizePublicEvents(outline.publicEvents)
    .filter((e) => !roster.length || roster.includes(String(e.actor || "").trim()));
  if (rawCount > outline.publicEvents.length) {
    console.warn(`[builder] 公共事件表：丢弃 ${rawCount - outline.publicEvents.length} 条（当事人不在角色名单内）`);
  }
  const before = validatePublicEvents(outline);
  if (before.ok) return outline;

  if (onProgress) onProgress("outline", `公共事件表不完整，正在定向补齐：${before.errors.join("；")}`);
  console.warn(`[builder] publicEvents 不完整：${before.errors.join("；")}`);

  try {
    const roster = rosterNames(outline);
    const existing = (outline.publicEvents || []).map((e) => `- ${e.time} ${e.actor} ${e.place} ${e.doing}`).join("\n") || "（空）";
    const system = `你是剧本杀时间线编辑。只输出一个 JSON 数组，不要任何解释与多余文字。`;
    const user = `## 本剧本设定（节选）
${outlineToText(outline).substring(0, 2500)}

## 已有的公共事件表
${existing}

## 需要补齐的问题
${before.errors.map((e) => "- " + e).join("\n")}

## 要求
补齐缺失的 publicEvents 条目：
- 覆盖案发夜全过程，粒度约 15–30 分钟；**每一次角色在场景之间移动都要一条**（谁、何时、去了哪、手里拿着什么）；
- **只写公开可见的行为**（不得写秘密动作或只有本人知道的内心/私下会面）；
- actor 必须逐字来自角色名单：${roster.join("、")}；
- time 用真实时间。

## 输出格式（严格 JSON 数组，只输出数组本身）
[{"time":"18:30","actor":"姓名","place":"地点","doing":"公开行为","who":["在场角色"]}]`;
    const result = await runStage("公共事件补齐", () => generate(system, user, { maxTokens: 6000, temperature: 0.3 }), onProgress);
    let raw = extractJsonStrict(result.content);
    if (raw === null || raw === undefined) raw = extractJsonStrict(result.reasoningContent || "");
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.publicEvents) ? raw.publicEvents : null);
    if (!arr || !arr.length) {
      console.warn("[builder] 公共事件补齐：未产出可用条目，保持原表");
      return outline;
    }
    outline.publicEvents = normalizePublicEvents([...(outline.publicEvents || []), ...arr]);
    const after = validatePublicEvents(outline);
    console.warn(`[builder] 公共事件补齐：${before.count} → ${after.count} 条${after.ok ? "，已达标" : "，仍有问题：" + after.errors.join("；")}`);
    if (onProgress) {
      onProgress("outline", after.ok
        ? `公共事件表补齐完成（${after.count} 条）`
        : `⚠️ 公共事件表补齐后仍不完整：${after.errors.join("；")}`);
    }
  } catch (e) {
    console.warn("[builder] 公共事件补齐失败（不影响出本）:", e.message);
  }
  return outline;
}

/** 关键物件状态变更表的最小条目数（少于它就触发定向补齐） */
const MIN_OBJECT_STATES = 3;

/** 校验物件状态变更表是否够用；非致命——不达标走 ensureObjectStates 定向补齐 */
function validateObjectStates(outline) {
  const states = (outline && outline.objectStates) || [];
  if (!states.length) {
    return { ok: false, errors: ["完全没有 objectStates（关键物件状态变更表）"], objects: [], count: 0 };
  }
  const errors = [];
  if (states.length < MIN_OBJECT_STATES) {
    errors.push(`objectStates 只有 ${states.length} 条，覆盖不足（至少 ${MIN_OBJECT_STATES} 个物件的状态变更）`);
  }
  const objects = [...new Set(states.map((e) => String(e.object || "").trim()))];
  if (objects.length < MIN_OBJECT_STATES) {
    errors.push(`objectStates 只涉及 ${objects.length} 个物件（至少 ${MIN_OBJECT_STATES} 个：灯/门闩/锁/窗/闸板/账本位置等会被多人看到且会变的东西）`);
  }
  // 秘密动作泄漏检测：状态描述不得出现"凶手/凶手把"这类词——那属于 murderer.realLine，不是公开状态
  const leak = states.filter((e) => /凶手|凶手把|秘密|暗中|无人知晓/.test(String(e.state || "")));
  if (leak.length) {
    errors.push(`${leak.length} 条的状态描述里出现了秘密动作（如「${String(leak[0].state).slice(0, 20)}」）——状态只能写可被观察到的客观样子，凶手暗中做了什么属于真实时间线`);
  }
  return { ok: errors.length === 0, errors, objects, count: states.length };
}

/**
 * 定向补齐物件状态变更表（与 ensurePublicEvents 同构：只补一次、失败即放弃、绝不让流水线失败）。
 */
async function ensureObjectStates(outline, cfg, onProgress) {
  if (!outline) return outline;
  const before = validateObjectStates(outline);
  if (before.ok) return outline;

  if (onProgress) onProgress("outline", `物件状态表不完整，正在定向补齐：${before.errors.join("；")}`);
  console.warn(`[builder] objectStates 不完整：${before.errors.join("；")}`);

  try {
    const existing = (outline.objectStates || []).map((e) => `- ${e.at} ${e.object} ${e.state}`).join("\n") || "（空）";
    const system = `你是剧本杀场景编辑。只输出一个 JSON 数组，不要任何解释与多余文字。`;
    const user = `## 本剧本设定（节选）
${outlineToText(outline).substring(0, 2500)}

## 已有的物件状态表
${existing}

## 需要补齐的问题
${before.errors.map((e) => "- " + e).join("\n")}

## 要求
补齐缺失的 objectStates 条目：
- 列出**会被多个角色看到、且状态会变**的物件（灯、门闩、锁、窗户、闸板、账本位置等）在案发夜的状态变更；
- **状态是可被观察到的客观描述**（"灯亮着"而不是"灯被凶手调暗了"——后者是秘密动作，不属于此表）；
- 只列案发夜的状态变更，不列前情；at 用真实时间；同一个物件在状态改变的每个时刻都列一条。

## 输出格式（严格 JSON 数组，只输出数组本身）
[{"at":"20:00","object":"书房的灯","state":"亮着"}]`;
    const result = await runStage("物件状态补齐", () => generate(system, user, { maxTokens: 4000, temperature: 0.3 }), onProgress);
    let raw = extractJsonStrict(result.content);
    if (raw === null || raw === undefined) raw = extractJsonStrict(result.reasoningContent || "");
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.objectStates) ? raw.objectStates : null);
    if (!arr || !arr.length) {
      console.warn("[builder] 物件状态补齐：未产出可用条目，保持原表");
      return outline;
    }
    // 合并去重：同物件+同时刻只留一条（新的覆盖旧的）
    const seen = new Map();
    for (const e of [...(outline.objectStates || []), ...arr]) {
      if (!e || typeof e !== "object") continue;
      const k = `${String(e.object || "").trim()}@${String(e.at || "").trim()}`;
      if (minutesOf(e.at) !== null && String(e.object || "").trim() && String(e.state || "").trim()) seen.set(k, e);
    }
    outline.objectStates = [...seen.values()];
    const after = validateObjectStates(outline);
    console.warn(`[builder] 物件状态补齐：${before.count} → ${after.count} 条${after.ok ? "，已达标" : "，仍有问题：" + after.errors.join("；")}`);
    if (onProgress) {
      onProgress("outline", after.ok
        ? `物件状态表补齐完成（${after.count} 条）`
        : `⚠️ 物件状态表补齐后仍不完整：${after.errors.join("；")}`);
    }
  } catch (e) {
    console.warn("[builder] 物件状态补齐失败（不影响出本）:", e.message);
  }
  return outline;
}

/**
 * 渲染关键物件状态变更表并注入角色/NPC 提示词。
 *
 * 为什么需要它（实测）：交叉校验反复报出同一类矛盾——"书房灯未熄/虚掩"与"里头没点灯"冲突、
 * "闸板已放下三分之二"与"闸板尚全开"冲突。根因是各角色对同一物件在同一时刻的状态各写各的，
 * 没有权威来源可对齐（timeline 只有事件，不含物件状态）。
 *
 * ⚠️ 只做注入（预防），不做确定性检测：物件状态是开放的自然语言描述，
 * 用词表匹配必然误伤（本轮已有 4 次"规则比事实更绝对"的教训），检测交给既有的交叉校验。
 */
function buildObjectStateTable(outline) {
  const states = (outline && outline.objectStates) || [];
  if (!states.length) return "";
  const sorted = [...states].sort((a, b) => (minutesOf(a.at) || 0) - (minutesOf(b.at) || 0));
  const L = [];
  L.push("## 关键物件状态变更表（所有人看到的状态必须与此一致）");
  L.push("- 下表是案发夜**关键物件的状态**（灯、门闩、锁、窗户、闸板、账本位置等）在各个时刻的样子。");
  L.push("- **两次变更之间，该物件的状态恒定**——若你在表中两个时刻之间描写它，写**前一条**的状态；");
  L.push("  任何角色在同一时刻看到的同一物件状态都必须与本表一致（实测里「书房灯未熄 vs 里头没点灯」「闸板已放下 vs 闸板尚全开」这类矛盾都源于各写各的）。");
  L.push("- 本表只写**可被观察到的客观状态**；凶手暗中做了什么（如「他把灯芯调暗了」）不在此列，写你自己的时间线。");
  L.push("");
  L.push("| 时刻 | 物件 | 状态（客观描述） |");
  L.push("|---|---|---|");
  for (const e of sorted) {
    L.push(`| ${hmOf(e.at) || String(e.at).trim()} | ${String(e.object || "").trim()} | ${String(e.state || "").replace(/\|/g, "/").slice(0, 60)} |`);
  }
  return L.join("\n");
}

/** 该角色在权威时间线里被点名的条目 —— 这些时刻是他不能改动的锚点 */
function characterAnchors(outline, name) {
  const n = String(name || "").trim();
  if (!n) return [];
  return ((outline && outline.timeline) || [])
    .filter((r) => String((r && r.desc) || "").includes(n))
    .map((r) => ({ time: String(r.time || "").trim(), desc: String(r.desc || "").trim() }));
}

/**
 * 这一行是否可能落在"案发夜"——只有可能的行才判"死者死后仍在活动"。
 *
 * ⚠️ 为什么必须判日期（实测误判，本轮验证抓到）：原实现只看时刻、**完全不看日期**，
 * 于是角色剧本里「**11月7日** 21:00 周世奎在二楼朝下喊我」这种**案发前一日**的正当内容，
 * 只要时刻晚于死亡时刻（20:40）就被判成"死者死后仍在活动"，进而被就地改写**改坏**。
 * 而模板本来就要求角色时间线覆盖"案发前一日"，所以这类行必然存在。
 * （这与 checkDateLabels 规则 B、checkDateAgreement 是同一个病根：**代码分不清"案发夜"与"前情"**。）
 *
 * 判据刻意偏保守——**宁可漏判，不可误判**：改坏一段正确内容，比漏掉一处违规有害得多
 * （漏掉的违规仍会被交叉校验抓到，改坏的内容却要靠人发现）。
 *   · 明确写「前一日/前一天/昨日」        → 不是案发夜，不判
 *   · 明确写「当日/次日/当天/案发当日」    → 是案发夜（或其后），判
 *   · 写了具体日期（X月X日）：等于案发日 → 判；不等于 → 不判；**案发日未知 → 不判**
 *   · 没有任何日期标注                   → 判（沿用原行为，避免大幅削减检出）
 * @param {string} line
 * @param {string|null} caseDate 案发日（如"11月8日"）；取不到就传 null
 */
function onCaseNight(line, caseDate) {
  const s = String(line || "");
  if (/案发前一日|前一日|前一天|昨日|昨天/.test(s)) return false;
  if (/案发当日|案发次日|当日|次日|当天/.test(s)) return true;
  const dated = /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s)
    || /[〇零一二三四五六七八九十廿卅初]{1,3}月[〇零一二三四五六七八九十廿卅初\d]{1,4}日/.test(s);
  if (dated) {
    if (!caseDate) return false;                 // 案发日未知 → 不敢判（保守）
    const norm = (t) => String(t || "").replace(/\s+/g, "");
    return norm(s).includes(norm(caseDate));
  }
  return true;
}

/**
 * 死者"还在活动"的动词 —— 必须**紧跟在死者姓名之后**才算。
 *
 * ⚠️ 这条"紧随其后"的约束是踩过坑才加的：第一版只做"行内同时出现死者姓名与互动动词"，
 * 结果把**发现尸体**的情节全部误判——发现现场必然有"喊起来""我叫他""惊呼"，
 * 而死者在句中是别人动作的宾语、或被描述成"跪在供桌前、一动不动"的尸体。
 * 实测代价：4 个角色被误判并进入无谓重写（3 个重写后并未变好，保留原稿），
 * 其中 1 个"改成功了"也只是把情节改坏。误报比漏报有害得多。
 */
const VICTIM_ACT_RE_SRC = "(说|问|答|道|喊|叫|吩咐|交代|叮嘱|递给|交给|接过|点头|摇头|招手|笑|看向|盯着|拉住|扶着|起身|走进|迎出|开口|应声|叹气)";
// escapeRe 已移到 ./timeline-utils（与 story-bible 共用同一份实现）
/** 死者是否是这一行的"动作主语"（姓名后紧跟互动动词） */
function victimActs(line, name) {
  if (!name) return false;
  return new RegExp(`${escapeRe(name)}[^。！？\\n]{0,10}?${VICTIM_ACT_RE_SRC}`).test(String(line || ""));
}

/**
 * 确定性检测：角色剧本里是否出现"死亡时刻之后死者仍在活动"。
 * 逐行取第一个时刻与死亡时刻比较；**只判可能落在案发夜的行**（见 onCaseNight，
 * 前一日/其他日期一律不判——否则会把写对的前情当违规改坏）。
 * @param {string} text 角色剧本
 * @param {string} deathTime 死亡时刻 "HH:MM"
 * @param {string} victimName 死者姓名
 * @param {string|null} [caseDate] 案发日（如"11月8日"）；取不到传 null
 * @returns {{ needed:boolean, violations:Array<{time:string,line:string}>, ok:boolean }}
 */
function checkVictimAfterDeath(text, deathTime, victimName, caseDate) {
  const deathMin = minutesOf(deathTime);
  const name = String(victimName || "").trim();
  if (deathMin === null || !name) return { needed: false, violations: [], ok: true };
  const violations = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes(name)) continue;
    if (!victimActs(line, name)) continue;      // 死者必须是动作主语，否则是发现尸体/提及
    if (!onCaseNight(line, caseDate || null)) continue;   // 前一日/其他日期不判（防误伤）
    const m = line.match(/(\d{1,2})[:：](\d{2})/);
    if (!m) continue;
    const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (t > deathMin && t - deathMin <= 12 * 60) {
      // 保留**整行原文**（不是截断版）：就地改写修复要拿它做精确替换，
      // 截断过的字符串匹配不到原文，替换会静默失败。
      violations.push({ time: `${m[1].padStart(2, "0")}:${m[2]}`, line, short: line.slice(0, 120) });
    }
  }
  return { needed: true, violations, ok: violations.length === 0 };
}

/**
 * 给单个角色拼「共享事实」约束：死亡时刻禁令 + 他自己的权威时刻锚点。
 * 与时间轴一样属于最高优先级硬约束。
 */
function buildSharedFacts(outline, ch) {
  const L = [];
  // 案发日期基准。**必须放在这里**（每个角色都会拿到），不能只放在 buildTimeAxis 里——
  // ⚠️ 实测根因（1996 长沙·湘绣厂）：那条"案发日期统一为「X」"原来写在 buildTimeAxis 内，
  // 而 buildTimeAxis 开头就是 `if (!off) return ""`：**非时钟类诡计**（那轮是密室）根本拿不到这段话，
  // 于是 6 个角色各自编日期（11月19／27／13／17日…），修订要为此打 37 条补丁去统一；
  // 而同一天跑的时钟类诡计那轮（川剧团）拿到了这段话，日期一次就对。
  // **指令的作用域应当由"这条事实是否普遍成立"决定，而不是由"诡计类型"决定。**
  const caseDate = parseCaseDate(outline);
  if (caseDate) {
    L.push(`- **案发日期统一为「${caseDate}」**：你时间线里的日期必须使用它（案发前一日即它的前一天），禁止自创其它月份/日期。`);
  } else {
    L.push("- **本案未设定绝对日期**：你的时间线一律用相对日期表述（`案发前一日` / `案发当日`），**严禁自创月份与日期**（同一剧本内出现多个不同日期属于重大逻辑漏洞）。");
  }
  const victimName = String((outline && outline.victim && outline.victim.name) || "死者");
  const deathAt = findDeathMoment(outline);
  if (deathAt) {
    L.push(`- **死者「${victimName}」的死亡时刻是 ${deathAt}（真实时间）**：${deathAt} 之后，**任何人（包括你）都不得再与死者互动**——不得听见他说话、不得看见他走动、不得与他交谈或交接物品；发现尸体必须发生在 ${deathAt} 之后。若你的时间线里在 ${deathAt} 之后仍出现死者活动，属于致命逻辑漏洞，整段会被打回。`);
  }
  const anchors = characterAnchors(outline, ch && ch.name);
  if (anchors.length) {
    L.push(`- **你的【时间线】必须逐条覆盖下列 ${anchors.length} 条**（不是"参考"，是骨架）：时刻、地点、在场者照抄，行为可补细节，但**不得增删时刻、不得换地点、不得自行换算成别的时刻**。写完后自查一遍：少一条、或某条的时刻/地点与这里不同，都会在生成后被程序查出并要求你重写。`);
    for (const a of anchors) L.push(`  - ${a.time}　${a.desc}`);
  }
  return L.join("\n");
}

/**
 * 把 content 里 oldLines[i] 替换为 newLines[i]（只替换首次出现）。
 * 纯函数，供测试：就地改写的成败完全取决于这一步能否精确命中。
 *
 * opts.allowDelete：允许把 newLines[i] 写成空串，表示**删掉这一行**。
 * 为什么需要：时间线体检报出的"同一时刻同一件事被写成两条"，修法就是删掉一条 ——
 * 而只支持"替换"时这类问题根本无法修复（实测《云锦庄·卯时账》的 crosscheck 就卡在这一类，改了两轮）。
 */
function applyLineRewrites(content, oldLines, newLines, opts) {
  const allowDelete = !!(opts && opts.allowDelete);
  let text = String(content || "");
  let changed = 0;
  for (let i = 0; i < oldLines.length; i++) {
    const from = String(oldLines[i] || "").trim();
    const to = String(newLines[i] || "").trim();
    if (!from || from === to) continue;
    if (!to && !allowDelete) continue;            // 默认不允许删除，保持既有调用方行为不变
    const idx = text.indexOf(from);
    if (idx === -1) continue;
    if (!to) {
      // 删整行：连同行首缩进/项目符号与行尾换行一起删，避免留下空行或空的项目符号
      const lineStart = text.lastIndexOf("\n", idx) + 1;
      let lineEnd = text.indexOf("\n", idx + from.length);
      lineEnd = lineEnd === -1 ? text.length : lineEnd + 1;
      text = text.slice(0, lineStart) + text.slice(lineEnd);
      changed++;
      continue;
    }
    text = text.slice(0, idx) + to + text.slice(idx + from.length);
    changed++;
  }
  return changed ? text : null;
}

/**
 * 就地改写"死亡后死者仍在活动"的那几行，**不整篇重生成**。
 *
 * 为什么改：改造前的修复是"整篇重生成角色剧本"，两轮实测 5 次触发只有 1 次把违规降到 0
 * （4 次"重写后违规未减少，保留原稿"）——重生成既慢（一次整篇 ~60s），
 * 模型还常常在新稿里重现同一个错误，甚至把别处改坏。
 *
 * 与线索阶段的 repairClueTexts 同构：**只改违规的那几行**，其余一字不动。
 * 只要有一行没改好就整体放弃（返回 null），由调用方保留原稿或走旧的整篇重生成。
 *
 * @returns {Promise<string|null>} 改写后的文本；失败返回 null
 */
async function repairDeathLines(charName, content, deathAt, victimName, violations, onProgress, caseDate) {
  const targets = (violations || []).slice(0, 6);   // 封顶 6 行：太多说明整篇设定出了问题，就该整体重做而不是逐行补
  if (!targets.length) return null;

  const system = `你是剧本杀编辑。只改写给出的几行，不要输出任何解释、不要改动其他内容。`;
  const user = `## 规则
死者「${victimName}」在 **${deathAt}** 已经死亡。下面这几行让死者在死亡之后仍然活动，必须改写。
改写要求：
- 保留每行的行首格式（日期/时刻/标记/地点）与该行的语境；
- 使该行不再出现"死者在死亡之后仍然活动"：可改为与死者无关的动作、或改成死者死亡之前的转述/回忆、或改成目击尸体；
- **不要新增情节、不要改动其他行**。

## 待改写的行（共 ${targets.length} 行，逐行改写，顺序不要变）
${targets.map((v, i) => `${i + 1}. ${v.line}`).join("\n")}

## 输出格式（按同样顺序输出 ${targets.length} 条，标题固定写 "### 重写"）
### 重写
（改写后的完整一行）

只输出这 ${targets.length} 个改写块。`;

  try {
    const result = await runStage(`${charName} 死亡违规行改写`, () => generate(system, user, { maxTokens: 3000, temperature: 0.5 }), onProgress);
    let raw = String((result && result.content) || "").trim();
    if (!raw && result && result.reasoningContent) raw = String(result.reasoningContent).trim();
    if (!raw) return null;

    const newLines = raw
      .split(/\n(?=#{2,4}\s*重写)/)
      .map((s) => s.replace(/^#{2,4}\s*重写[^\n]*\n?/, "").trim())
      .filter(Boolean);
    if (!newLines.length) {
      console.warn(`[builder] ${charName} 死亡违规行改写：未产出可用改写块`);
      return null;
    }

    const patched = applyLineRewrites(content, targets.map((v) => v.line), newLines);
    if (!patched) {
      console.warn(`[builder] ${charName} 死亡违规行改写：未命中任何原行`);
      return null;
    }
    const re = checkVictimAfterDeath(patched, deathAt, victimName, caseDate || null);
    if (!re.ok) {
      console.warn(`[builder] ${charName} 死亡违规行改写后仍有 ${re.violations.length} 处，放弃改写`);
      return null;
    }
    console.warn(`[builder] ${charName} 死亡违规行就地改写：${targets.length} 处已修好`);
    return patched;
  } catch (e) {
    console.warn(`[builder] ${charName} 死亡违规行改写失败:`, e.message);
    return null;
  }
}

/**
 * 生成后校验：角色剧本不得在死者死亡之后仍描写死者活动。
 *
 * 修复分两级（缺陷分级里的"局部补丁 → 整篇重做"）：
 * ① 先**就地改写违规行**（小调用、不动其余内容）；
 * ② 改不动才回退到整篇重生成（慢且常重现同一错误，但对嵌在长段落里的违规仍可能有效）。
 * 两级都失败则保留原稿。
 */
async function ensureDeathConsistent(charName, content, deathAt, victimName, retryFn, onProgress, opts) {
  // opts.caseDate：案发日（如"11月8日"）。有它才能判定"这一行是不是案发夜"，
  // 否则带日期标注的行（多半是正当的"案发前一日"）会被误判成死亡后活动——
  // 详见 onCaseNight 的注释。
  const caseDate = (opts && opts.caseDate) || null;
  const chk = checkVictimAfterDeath(content, deathAt, victimName, caseDate);
  if (!chk.needed || chk.ok) return content;

  if (onProgress) onProgress("player_script", `${charName} 剧本在死者死亡后仍写其活动（${chk.violations.length} 处），正在就地改写...`);
  console.warn(`[builder] ${charName} 死亡时刻校验失败：${chk.violations.length} 处（死亡时刻 ${deathAt}）`);
  // 与日期标注那处同理：这一层判错会把**写对的内容改坏**（见上方 repairDeathLines 的注释），
  // 所以每条违规的时刻与原文都必须留痕，事后才能复核是"真违规"还是"误伤"。
  // ⚠️ 注意这里的违规对象形状是 `{time, line, short}`（checkVictimAfterDeath 产出），
  // **没有 reason 字段** —— 别照抄日期标注那处的 `v.reason`，否则打出一行空原因。
  for (const v of chk.violations) console.warn(`[builder]   · [死后活动] 死者在该时刻之后仍被写成活动（${v.time}）｜原文：${v.short || v.line || ""}`);

  // ① 优先就地改写
  const patched = await repairDeathLines(charName, content, deathAt, victimName, chk.violations, onProgress, caseDate);
  if (patched) return patched;

  // ② 回退：整篇重生成
  const listed = chk.violations.slice(0, 4).map((v) => `- ${v.time}：${v.short || v.line}`).join("\n");
  const note = `\n\n## ⚠️ 上一次输出有致命时间漏洞，必须重写\n问题：死者「${victimName}」在 **${deathAt}** 已经死亡，但你的剧本在此时刻之后仍描写他活动：\n${listed}\n\n请重新输出**完整**角色剧本（保留上一版的故事与任务要点），并改成：\n- ${deathAt} 之后，任何人都不得与死者交谈、听见他说话、看见他走动或从他手里接东西；\n- 若你需要"死者交代过某事"的情节，把它挪到 ${deathAt} **之前**，或改成你从别人口中/书面材料得知；\n- 发现尸体必须发生在 ${deathAt} 之后，且不得描写死者当时还活着。`;
  console.warn(`[builder] ${charName} 就地改写未成功，回退整篇重生成`);
  if (onProgress) onProgress("player_script", `${charName} 就地改写未成功，回退整篇重写...`);

  try {
    const retried = await retryFn(note);
    const r = checkVictimAfterDeath(retried, deathAt, victimName, caseDate);
    if (r.ok || r.violations.length < chk.violations.length) {
      console.warn(`[builder] ${charName} 重写后违规 ${chk.violations.length} → ${r.violations.length} 处`);
      return retried;
    }
    console.warn(`[builder] ${charName} 重写后违规未减少（${r.violations.length} 处），保留原稿`);
  } catch (e) {
    console.warn(`[builder] ${charName} 重写失败，保留原稿:`, e.message);
  }
  return content;
}

/** 中文数字（1..30 用途足够；只支持本模块需要的形态） */
const CN_DIGITS = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function parseCnNum(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t === "十") return 10;
  const m = t.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? CN_DIGITS.indexOf(m[1]) : 1;
    const ones = m[2] ? CN_DIGITS.indexOf(m[2]) : 0;
    return tens * 10 + ones;
  }
  if (t.length === 1 && CN_DIGITS.includes(t)) return CN_DIGITS.indexOf(t);
  return null;
}
/** 日期里的"日"：兼容 初八 / 廿一 / 卅 / 十九 这些写法 */
function parseCnDay(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (t.startsWith("初")) return parseCnNum(t.slice(1));
  if (t === "廿") return 20;
  if (t.startsWith("廿")) { const r = parseCnNum(t.slice(1)); return r === null ? null : 20 + r; }
  if (t === "卅") return 30;
  return parseCnNum(t);
}
const MONTH_ALIAS = { 正月: 1, 冬月: 11, 腊月: 12 };
/**
 * 解析日期标注为 {month, day}；解析不了返回 null。
 * 支持 腊月初八 / 十二月十五日 / 12月15日 / 正月初一 等形态。
 */
function parseDateLabel(label) {
  // 两个坑（都实测踩过）：
  // ① "日"的字符类必须含 初/廿/卅，否则 "腊月初八" / "腊月廿一" 匹配失败；
  // ② 结尾的"日"必须**可选**——中文日期有 "腊月初八"（无日）与 "十二月十五日"（有日）两种写法。
  const m = String(label || "").trim().match(/^(.{0,4}?月)([〇零一二三四五六七八九十廿卅初\d]{1,4})日?$/);
  if (!m) return null;
  const monthRaw = m[1];
  let month = MONTH_ALIAS[monthRaw];
  if (month === undefined) {
    const mm = monthRaw.match(/^([〇零一二三四五六七八九十\d]{1,3})月$/);
    month = mm ? parseCnNum(mm[1]) : null;
  }
  const day = parseCnDay(m[2]);
  if (month === null || month === undefined || day === null) return null;
  return { month, day };
}
/** 两个日期标注的先后比较；任一方解析不了返回 null */
function compareDateLabels(a, b) {
  const pa = parseDateLabel(a), pb = parseDateLabel(b);
  if (!pa || !pb) return null;
  return (pa.month * 100 + pa.day) - (pb.month * 100 + pb.day);
}
function cnNum(n) {
  if (n < 10) return CN_DIGITS[n];
  if (n === 10) return "十";
  if (n < 20) return "十" + CN_DIGITS[n - 10];
  const tens = Math.floor(n / 10), ones = n % 10;
  return CN_DIGITS[tens] + "十" + (ones ? CN_DIGITS[ones] : "");
}

/**
 * 「案发当日」+1 天。用于跨午夜日期规则。
 * 日期天数 ≥ 28 时返回 null：月底进位（三十→初一）依赖具体月份，宁可不给也不给错。
 */
function nextDayLabel(label) {
  const m = String(label || "").trim().match(/^(.*?)([〇零一二三四五六七八九十\d]{1,3})月([〇零一二三四五六七八九十\d]{1,4})日$/);
  if (!m) return null;
  const d = parseCnNum(m[3]);
  if (d === null || d >= 28) return null;
  const isCn = !/^\d+$/.test(m[3]);
  return `${m[1]}${m[2]}月${isCn ? cnNum(d + 1) : d + 1}日`;
}

/** 时间线是否跨过午夜（存在 00:00–05:59 的时刻，或时刻非单调递增） */
function crossesMidnight(timeline) {
  const mins = ((timeline || []).map((r) => minutesOf(r && r.time)).filter((m) => m !== null));
  if (mins.some((m) => m < 6 * 60)) return true;
  for (let i = 1; i < mins.length; i++) if (mins[i] < mins[i - 1]) return true;
  return false;
}

/**
 * 权威事件表 —— **独立于时钟**。
 *
 * 为什么必须与 buildTimeAxis 分开：`buildTimeAxis` 只在能解析出"分钟级时钟偏差"时才产出
 * （`parseTimeOffset` 返回 null 就整段为空）。而像"买通更夫漏敲三更"这类诡计**根本没有分钟偏差**，
 * 于是角色拿不到任何权威事件表，各方对同一事件的时刻各说各话——
 * 实测（1948 北平·更夫案）：一个人送参汤，三个角色给出的时刻差 35 分钟。
 * 事件表与"有没有钟被动过"无关，只要有时间线就该给。
 */
function buildEventTable(outline) {
  const rows = (outline && outline.timeline) || [];
  if (!rows.length) return "";
  const names = [...((outline && outline.players) || []), ...((outline && outline.npcs) || [])]
    .map((p) => String((p && p.name) || "").trim()).filter(Boolean);
  const L = [];
  L.push("## 权威事件表（所有角色共同遵守 — 同一事件只能有一个时刻）");
  L.push("- 下表是全案的**公共事件时刻**。凡你在自己的时间线里写到下表已有的事件（无论是你亲历、目击还是事后听说），**时刻必须与下表逐字一致**，禁止自行推算、四舍五入或改写成别的时刻。");
  L.push("- 「涉及角色」一列只列了下表描述里点名的人；**若你当时在现场而未被点名，你的时间线里也必须在该时刻出现对应条目**，不得自己另给一个时刻。");
  L.push("- 每个事件只能有一个时刻。同一件事在两个人的剧本里出现两个时刻，属于重大逻辑漏洞。");
  const caseDate = parseCaseDate(outline);
  const nextDate = nextDayLabel(caseDate);
  if (crossesMidnight(rows)) {
    L.push(`- ⚠️ **本剧本跨过午夜**：表中 00:00 之后的时刻属于**案发次日**${nextDate ? `（即 ${nextDate}）` : ""}。` +
      `凡 00:00–05:59 的条目，日期必须写案发次日${caseDate ? `（${caseDate} 是案发当日，**不要**把午夜后的时刻标成它）` : ""}；` +
      `凡 17:00–23:59 的条目属于案发当日。**禁止把整段夜间事件统一标成同一天。**`);
  }
  L.push("");
  L.push("| 时刻 | 事件（DM 权威） | 涉及角色 |");
  L.push("|---|---|---|");
  for (const r of rows) {
    const desc = String((r && r.desc) || "").replace(/\|/g, "/").slice(0, 80);
    const involved = names.filter((n) => desc.includes(n));
    L.push(`| ${String((r && r.time) || "").trim()} | ${desc} | ${involved.join("、") || "—"} |`);
  }
  return L.join("\n");
}

/**
 * 日期标注校验：跨午夜时，夜间事件的日期必须标对。
 *
 * 实测缺陷（1948 北平）：某角色把案发当日牌局（21:00、22:30）全部标成"十四日"，
 * 把 00:05/00:10 标成"十五日"——**全篇日期整体错位一天**，而设定集里案发夜是
 * "十五日夜至十六日凌晨"。规则里既有的措辞（"统一日期""禁止自创"）挡不住这种整体位移。
 *
 * ⚠️ 只保留两条**没有误伤面**的规则。第一版还加了"夜间事件的日期必须等于案发当日"，
 * 结果把"前一日 20:30 在报馆"这种**正当的前情情节**判成违规——上一日的晚间事件标上一日的日期
 * 本来就是对的，判别"这行是案发夜还是前情"需要语义理解，代码不该猜。
 * 于是：
 *   A. **午夜之后**（00:00–05:59）标成当日/案发当日 → 违规（此后必须标次日）
 *   B. **午夜之前**（17:00–23:59）标成次日/案发次日 → 违规（午夜前不可能是次日）
 * 规则 A 命中时还说明"整篇可能整体错位一天"——因为把午夜后标成案发当日，
 * 正是整体位移一天的典型症状，提示模型去检查夜前事件。
 */
// 行内日期标注的定位正则：必须与 parseDateLabel 支持的范围一致，
// 否则 "腊月十九" 这种（月份用 腊/正/冬 而非数字）根本不会被识别成日期（实测踩过）。
const DAY_MARK_RE = /((?:[〇零一二三四五六七八九十\d]{1,3}月|[正冬腊]月)[〇零一二三四五六七八九十廿卅初\d]{1,4}日?|案发当日|案发次日|案发前一日|当日|次日|前一日)/;
function checkDateLabels(text, opts) {
  const { caseDate = null, nextDate = null, midnight = false } = opts || {};
  if (!midnight) return { needed: false, violations: [], ok: true };
  const violations = [];
  const isToday = (label) => label === "案发当日" || label === "当日" || (!!caseDate && label === caseDate);
  const isNext = (label) => label === "案发次日" || label === "次日" || (!!nextDate && label === nextDate);
  const isOther = (label) => label === "案发前一日" || label === "前一日";
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const dm = line.match(DAY_MARK_RE);
    const hm = line.match(/(\d{1,2})[:：](\d{2})/);
    if (!dm || !hm) continue;
    const label = dm[1];
    if (isOther(label)) continue;                       // 明确的前情标注不判
    const min = parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
    if (min < 6 * 60) {
      // A. 午夜之后必须是次日
      if (isToday(label)) {
        violations.push({
          reason: `00:00–05:59 的时刻属于案发次日${nextDate ? `（${nextDate}）` : ""}，却标成「${label}」` +
            (caseDate ? `。把午夜后标成案发当日，通常意味着**整篇日期整体错位了一天**，请一并检查夜前事件的日期` : ""),
          line: line.slice(0, 110),
        });
      }
    } else if (min >= 17 * 60) {
      // B. 午夜之前不可能是次日
      if (isNext(label)) {
        violations.push({ reason: `17:00–23:59 的时刻属于案发当日，却标成「${label}」`, line: line.slice(0, 110) });
      }
    }
    // C. 具体日期**晚于案发当日**、又不等于案发次日 → 一定是错位
    // 为什么只判"更晚"：早于案发当日的具体日期很可能是正当的前情（"初五那天他来过"），
    // 代码分不清那是不是案发夜，判它就会误伤（第一版正是因此误报）。
    // 而"更晚"完全不同——案发夜之后没有正当情节，出现它只能是日期整体位移。
    if (caseDate && !isToday(label) && !isNext(label) && !isOther(label)) {
      const cmp = compareDateLabels(label, caseDate);
      if (cmp !== null && cmp > 0) {
        violations.push({
          reason: `日期标注「${label}」晚于案发当日（${caseDate}）且不是案发次日${nextDate ? `（${nextDate}）` : ""}——案发夜之后没有正当情节，属于整篇日期错位`,
          line: line.slice(0, 110),
        });
      }
    }
  }
  return { needed: true, violations, ok: violations.length === 0 };
}

/**
 * 生成后校验：角色剧本的夜间日期标注必须正确（跨午夜时尤其）。
 * 与 ensureDeathConsistent 同构：带明确纠正指令重写一次，只有违规数减少才采纳。
 */
async function ensureDateConsistent(charName, content, opts, retryFn, onProgress) {
  const chk = checkDateLabels(content, opts);
  if (!chk.needed || chk.ok) return content;
  const shown = chk.violations.slice(0, 4).map((v) => `- ${v.reason}\n  原文：${v.line}`).join("\n");
  const note = `\n\n## ⚠️ 上一次输出的日期标注有误，必须重写\n问题：本剧本**跨过午夜**${opts.nextDate ? `（案发当日 ${opts.caseDate}，案发次日 ${opts.nextDate}）` : ""}，而你的日期标注与之冲突：\n${shown}\n\n请重新输出**完整**角色剧本（保留上一版情节要点），并改成：\n- 17:00–23:59 的事件标 **案发当日${opts.caseDate ? `（${opts.caseDate}）` : ""}**；\n- 00:00–05:59 的事件标 **案发次日${opts.nextDate ? `（${opts.nextDate}）` : ""}**；\n- 不要把整段夜间事件统一标成同一天。`;
  if (onProgress) onProgress("player_script", `${charName} 日期标注与跨午夜规则冲突（${chk.violations.length} 处），正在重写...`);
  console.warn(`[builder] ${charName} 日期标注校验失败：${chk.violations.length} 处`);
  // ⚠️ 必须把**每一条**违规的原因与原文都打出来，不能只写"N 处"：
  // 这里每命中一次就要**整篇重写一遍角色剧本**（实测一次约 1 分钟），代价不低；
  // 只留一个数字的话，事后连"这是真缺陷还是判据误伤"都判断不了 ——
  // 实测改后那一本有 2 个角色因此各多跑了一整遍，却无从复核。
  // 与 bible-enforce 里 warn 路径的做法一致（那里也是逐条列出原因与原文）。
  for (const v of chk.violations) console.warn(`[builder]   · [日期标注] ${v.reason}｜原文：${v.line}`);
  try {
    const retried = await retryFn(note);
    const r = checkDateLabels(retried, opts);
    if (r.ok || r.violations.length < chk.violations.length) {
      console.warn(`[builder] ${charName} 重写后日期违规 ${chk.violations.length} → ${r.violations.length} 处`);
      return retried;
    }
    console.warn(`[builder] ${charName} 重写后日期违规未减少（${r.violations.length} 处），保留原稿`);
  } catch (e) {
    console.warn(`[builder] ${charName} 日期重写失败，保留原稿:`, e.message);
  }
  return content;
}

/**
 * 跨角色「案发日期」核对（确定性，众数投票制）。
 *
 * 背景（实测 1890 广州）：三份剧本三个日期——四人用"六月十四/十五"，麦安琪用"四月十四/十五"，
 * 陈九用"四月十七/十八"。此前一版实现用"行首日期"逐条比对，被单测否掉：
 * 角色时间线**本来就要求覆盖"案发前一日"**（模板要求"覆盖案发前一日晚间到案发后"），
 * 所以合法地会出现更早的日期（`- **六月初五 20:30**：报馆 — 他来过一趟`），
 * 逐条判据区分不了"案发夜"与"前情"。
 *
 * 本实现用**众数投票**：案发夜在每份角色时间线里都是最密集的一簇（10+ 条细粒度记录），
 * 前情是零散的 1-2 条——所以取"出现次数最多的日期"作为该案发日期的表达，再比对各角色的众数。
 * - 众数出现 <3 次视为不可信（剧本太薄或前情过多）→ 该角色不参与比对；
 * - 有权威案发日（parseCaseDate）时优先用它；否则用各角色众数的**过半**多数；
 *   3-3 分歧不判（无法确定谁对，交给交叉校验）；
 * - 与基准相差 >1 天 → 判为日期错位（相邻两天是案发夜跨午夜，允许）。
 * - 跨年相邻（12月31 → 1月1）按同一天处理。
 */
const TL_DATE_AT_START_RE = /^\s*[-*•]?\s*\**\s*((?:[〇零一二三四五六七八九十\d]{1,3}月|[正冬腊]月)[〇零一二三四五六七八九十廿卅初\d]{1,4}日?)\s*\**\s*[（(]?\s*\d{1,2}[:：]\d{2}/;
function dateDiffDays(a, b) {
  const pa = parseDateLabel(a), pb = parseDateLabel(b);
  if (!pa || !pb) return null;
  const ML = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const doy = (v) => ML.slice(0, v.month - 1).reduce((s, m) => s + m, 0) + v.day;
  const d = Math.abs(doy(pa) - doy(pb));
  return Math.min(d, 365 - d);   // 循环距离：12月31 与 1月1 相邻
}
function checkDateAgreement(sections, outline) {
  const MIN_VOTES = 3;
  const perScript = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    const name = String((s && s.name) || "").trim();
    // ⚠️ 只统计**傍晚（17:00–23:59）**时段的日期作为该角色"案发夜的表达"。
    // 为什么只看傍晚：案发夜必然包含傍晚时段，而跨午夜的相邻日只会出现在凌晨——
    // 实测（1960 云南）岩温把整个案发夜整体前移一天（傍晚在腊月十六，其余五人在腊月十七），
    // 总众数只差 1 天、被"跨午夜相邻"的宽容放过了；但用傍晚窗口就能精确判定：
    // 傍晚的日期就是"案发当日晚上"，跨午夜的合法相邻日（凌晨）不会混进来。
    const counts = new Map();
    for (const raw of String((s && s.text) || "").split("\n")) {
      const m = raw.match(TL_DATE_AT_START_RE);
      if (!m) continue;
      const d = m[1];
      if (parseDateLabel(d) === null) continue;
      const hm = raw.match(/(\d{1,2})[:：](\d{2})/);
      if (!hm) continue;
      const min = parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
      if (min < 17 * 60 || min >= 24 * 60) continue;   // 只算傍晚
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    let mode = null, modeCount = 0;
    for (const [d, c] of counts) if (c > modeCount) { mode = d; modeCount = c; }
    if (mode && modeCount >= MIN_VOTES) perScript.push({ name, date: mode, count: modeCount });
  }
  if (perScript.length < 2) return { needed: false, ok: true, groups: perScript, message: "" };

  let baseline = outline ? parseCaseDate(outline) : null;
  let baselineSrc = "设定集";
  if (!baseline) {
    const vote = new Map();
    for (const p of perScript) vote.set(p.date, (vote.get(p.date) || 0) + 1);
    let b = null, bc = 0;
    for (const [d, c] of vote) if (c > bc) { b = d; bc = c; }
    if (bc * 2 > perScript.length) { baseline = b; baselineSrc = "多数角色"; }
    else {
      // 无多数派（如 3-3 或 4 方各执一词）：**仍然是不一致**，只是无法确定谁对。
      // 实测（1965 长春）四套日期各 1 票、无多数，此前直接放行 → 交叉校验抓到
      // "同一案件出现四套日期"却没人拦在修订之前。改为如实报告、交修订统一。
      if (vote.size >= 2) {
        const detail = [...vote.entries()].map(([d, c]) => `${d}（${perScript.filter((p) => p.date === d).map((p) => p.name).join("、")}）`).join("，");
        return {
          needed: true,
          ok: false,
          groups: perScript,
          message: `跨角色案发日期不一致（各角色使用的傍晚日期互不相同，无多数派可循）：${detail}——` +
            `同一案件只能有一套日期，请先在修订中确定案发当日是哪一天，再把所有角色时间线的日期统一过去。`,
        };
      }
      return { needed: true, ok: true, groups: perScript, message: "" };
    }
  }

  // 傍晚窗口的日期不做 ±1 天宽容：案发夜的傍晚必然同一天（跨午夜只发生在凌晨，
  // 已被窗口排除），所以差 1 天也是整体位移，必须判。
  const off = perScript.filter((p) => p.date !== baseline);
  if (!off.length) return { needed: true, ok: true, groups: perScript, message: "" };

  const offList = off.map((p) => `${p.date}（${p.name}）`).join("，");
  return {
    needed: true,
    ok: false,
    groups: perScript,
    message: `跨角色案发日期不一致：以${baselineSrc}的「${baseline}」为基准，${offList} 与之不同——` +
      `案发夜的傍晚必然属于同一天（跨午夜只发生在凌晨），请把这些角色时间线的日期统一到基准，并同步修正其"前一日/次日"的表述。`,
  };
}

/**
 * ⚠️ 已放弃的实现（保留说明，避免以后有人再踩）：
 *
 * 曾试图加一条"跨角色日期体系核对"来抓"三份剧本三个日期"。判法是取各角色
 * 时间线条目**行首的"日期+时刻"**，比较日期是否相差超过 1 天。
 *
 * **为什么放弃**：角色的时间线**本来就要求覆盖"案发前一日"**
 * （playerInstruction 模板明确要求"覆盖案发前一日晚间到案发后"），
 * 所以行首形态里必然合法地出现比案发日更早的日期——
 * 单测里 `- **六月初五 20:30**：报馆 — 他来过一趟`（案发日为六月十四）
 * 就被误判成"体系不一致"。**行首形态区分不了"案发夜"与"前情"**，
 * 与第 8.7 节那次误伤同一个病根。
 *
 * 这一类（跨角色日期不统一）**已由既有的"交叉校验 → 定向修订"覆盖**：
 * 实测 1890 广州那一轮，交叉校验把它列为头号问题，修订阶段应用了 31 条补丁。
 * 与其再塞一条会误伤的规则，不如让已经工作的机制去修。
 *
 * 【重做说明】上面的逐条判据已撤，换成上面的**众数投票版** checkDateAgreement：
 * 不再逐条判"这个日期对不对"，而是比对各角色时间线里**最密集那一簇日期的众数**——
 * 案发夜每份剧本都有 10+ 条细粒度记录，前情只有 1-2 条，众数必然落在案发夜上；
 * 众数出现 <3 次即视为不可信、不参与比对。这样"案发前一日"的合法条目只贡献 1 票，
 * 不会改变众数，误伤面就不存在了。
 */

/**
 * 生成后校验：角色剧本必须含「时间线」章节且时间点不少于下限（玩家 8 / NPC 6）。
 * 实测缺陷：模型会把时间线压成一两条（出现 82 字/1 条、74 字/1 条），
 * 或把完整行动轨迹塞进「凶手确认」而让时间线只剩抵达一条。
 * 不达标时带明确纠正指令补写一次；补写仍不达标则保留时间点更多的一份。
 *
 * ⚠️ 为什么加第 5 个参数（NPC 校验缺失，2026-10-17 实测）：
 *   这个门以前**只接在玩家角色循环上**（NPC 循环里没人调用它）。于是 NPC 的时间线
 *   薄到只剩几条也没人拦 —— 实测改后那一本里 `阿强` 只有 **5 个时刻 / 时间线 374 字**，
 *   而 NPC 模板自己要求"至少 6 个时间点"，即**低于自己的要求却无人出声**。
 *   NPC 的目击信息是玩家推理的输入，它薄了直接削弱整局可推理度，属于结构性漏洞。
 *   但 NPC 的章节名（"三、时间线"）与标题体系（人物关系/作案动机/需要隐瞒的信息）
 *   都与玩家不同，所以把"下限/章节名/标题约束/覆盖范围/进度阶段"做成可选参数，
 *   而不是复制一份实现 —— 本项目已经吃过"同一份事实在两处各实现一次"的亏（见 timeline-utils.js 注释）。
 *   默认值即玩家侧的原行为，调用方不传参数时行为完全不变。
 */
async function ensureTimelineComplete(charName, content, retryFn, onProgress, opts) {
  const o = opts || {};
  const min = Number.isFinite(o.min) ? o.min : MIN_TIMELINE_POINTS;
  // 字数下限（2026-10-18 新增）：实测《停表的修表铺》四个角色本只有 2473–2804 字，
  // 而预算是 3400–5200、真本中位 5929 —— 时间线点数是够的，**正文本身就薄**，
  // 原来的门只看时间线条数，所以一句都没拦。传 0 表示不检查（保持旧行为）。
  const minChars = Number.isFinite(o.minChars) ? o.minChars : 0;
  const charsOf = (s) => String(s || "").replace(/\s+/g, "").length;
  const section = o.section || "二、你的时间线";
  const evaluate = (txt) => {
    const b = extractCharacterTimeline(txt);
    const p = b === null ? 0 : countTimelinePoints(b);
    const c = charsOf(txt);
    const ok = b !== null && p >= min && (minChars === 0 || c >= minChars);
    return { p, c, ok, hasSection: b !== null };
  };
  const cur = evaluate(content);
  if (cur.ok) return content;

  const problems = [];
  if (!cur.hasSection) problems.push(`完全没有「${section}」章节`);
  else if (cur.p < min) problems.push(`「${section}」只有 ${cur.p} 个时间点（要求至少 ${min} 个）`);
  if (minChars > 0 && cur.c < minChars) problems.push(`正文只有 ${cur.c} 字（要求至少 ${minChars} 字：背景、时间线、任务都要写足，不要压缩）`);
  const problem = problems.join("；");
  const headings = o.headings
    || '必须包含 "### 一、你的背景故事" / "### 二、你的时间线" / "### 三、你的任务" 三个三级标题，顺序不可变。';
  const cover = o.cover || "覆盖案发前一日晚间到案发后";
  const lenNote = minChars > 0 ? `\n- 全篇正文（去掉标题与空白）**不少于 ${minChars} 字**。` : "";
  const note = `\n\n## ⚠️ 上一次输出不合格，必须重写\n上一次的问题：${problem}。\n请重新输出**完整**角色剧本（保留上一版其它章节的要点，不要压缩它们），并严格遵守格式约束：\n- ${headings}\n- 「${section}」必须独立成章、**至少 ${min} 个时间点**，${cover}，格式 "- **月日 时刻**：房间名 — 事件"（月日/时刻/房间名都要换成真实值；**禁止把"日期""时间""地点"这三个词写进条目**）。\n- 不得把行动轨迹写进其它章节。${lenNote}`;

  if (onProgress) onProgress(o.progressStage || "player_script", `${charName} 不达标（${problem}），正在补写...`);
  console.warn(`[builder] ${charName} 不达标：${problem}，触发补写`);

  try {
    const retried = await retryFn(note);
    const got = evaluate(retried);
    if (got.ok) {
      console.warn(`[builder] ${charName} 补写后达标：${got.p} 个时间点 / ${got.c} 字`);
      return retried;
    }
    // 没完全达标，但明显更好（时间线更多 或 字数更多，且另一项不退步）就用新的
    if ((got.p > cur.p && got.c >= cur.c) || (got.c > cur.c && got.p >= cur.p)) {
      console.warn(`[builder] ${charName} 补写后仍未达标但更好（${got.p} 点 / ${got.c} 字），采用新稿`);
      return retried;
    }
    console.warn(`[builder] ${charName} 补写无改善（${got.p} 点 / ${got.c} 字），保留原稿`);
  } catch (e) {
    console.warn(`[builder] ${charName} 补写失败，保留原稿:`, e.message);
  }
  return content;
}

// ==================== 交叉校验问题定向修订 ====================

/** 按标题切段的结构化摘要（仅在剧本过长、无法整篇送检时使用） */
function buildSectionDigest(fullScript, maxChars = 24000) {
  const lines = String(fullScript || "").split("\n");
  const secs = [];
  let cur = null;
  for (const l of lines) {
    if (/^#{1,4}\s+/.test(l)) { cur = { head: l.trim(), body: [] }; secs.push(cur); }
    else if (cur) cur.body.push(l);
    else { cur = { head: "(前言)", body: [l] }; secs.push(cur); }
  }
  if (!secs.length) return String(fullScript || "").substring(0, maxChars);
  const per = Math.max(300, Math.floor(maxChars / secs.length));
  return secs.map(s => `${s.head}\n${s.body.join("\n").trim().substring(0, per)}`).join("\n\n");
}

/**
 * 应用定向修订补丁 [{oldText, newText}]。
 * 定位策略：先精确匹配；失败则按"忽略所有空白"归一化后再匹配（容忍换行/全角空格差异）。
 * 返回 { text, applied, skipped }
 */
/** 归一化并保留"归一化下标 → 原文下标"的映射，供模糊定位把替换区间映射回原文 */
function normWithMap(s) {
  const norm = [];
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) continue;
    // 引号/标点/全角半角差异不参与匹配：模型抄原文时最容易改的就是这些。
    // ⚠️ 第一版漏了全角「！？」—— 测试里 oldText 以「！」结尾，尾部锚点因此永远匹配不上，
    // 模糊定位形同虚设（正是这条 bug 让"标点差异也能量"的用例挂了）。
    const c = ch.replace(/[“”"‘’'，,。；;：:、！？!?（）()【】\[\]{}《》〈〉—–\-·…~～]/g, "");
    if (!c) continue;
    norm.push(c);
    map.push(i);
  }
  return { norm: norm.join(""), map };
}

function applyPatches(text, patches) {
  let out = String(text || "");
  let applied = 0, skipped = 0, fuzzy = 0;
  for (const p of (Array.isArray(patches) ? patches : [])) {
    if (!p || typeof p !== "object") { skipped++; continue; }
    const oldText = p.oldText || p.old || p.find || p.anchor;
    const newText = p.newText || p.new || p.replace || p.replacement;
    if (typeof oldText !== "string" || oldText.trim().length < 8 || typeof newText !== "string" || !newText.trim()) {
      skipped++;
      continue;
    }
    const idx = out.indexOf(oldText);
    if (idx >= 0) {
      out = out.slice(0, idx) + newText + out.slice(idx + oldText.length);
      applied++;
      continue;
    }
    // 归一化兜底：忽略空白差异后重新定位，再映射回原始下标
    const norm = (s) => s.replace(/\s+/g, "");
    const nOld = norm(oldText);
    if (nOld.length < 8) { skipped++; continue; }
    const pos = norm(out).indexOf(nOld);
    if (pos >= 0) {
      let oi = 0, start = -1, end = -1;
      for (let i = 0; i < out.length; i++) {
        if (/\s/.test(out[i])) continue;
        if (oi === pos && start < 0) start = i;
        if (oi === pos + nOld.length - 1) { end = i + 1; break; }
        oi++;
      }
      if (start >= 0 && end >= 0) {
        out = out.slice(0, start) + newText + out.slice(end);
        applied++;
        continue;
      }
    }

    // 策略三：**前后锚点模糊定位**（2026-10-18 实测）
    // 《停表的修表铺》那次 5 条补丁全部 skipped，矛盾原样留在成稿里 ——
    // 根因是模型抄 oldText 时把引号/逗号/破折号改了型，逐字和"只去空白"都对不上。
    // 这里改成：归一化后取前段/后段当锚点，命中即整段替换。
    // 只放宽"怎么找到这段"，替换范围仍由原文锚点界定，不会误伤别处。
    const { norm: nOut, map } = normWithMap(out);
    const nOldFull = normWithMap(oldText).norm;
    if (nOldFull.length < 8) { skipped++; continue; }
    const headLen = Math.min(14, Math.max(8, Math.floor(nOldFull.length * 0.5)));
    const tailLen = Math.min(12, Math.max(6, Math.floor(nOldFull.length * 0.3)));
    const head = nOldFull.slice(0, headLen);
    const tail = nOldFull.slice(-tailLen);
    const startPos = nOut.indexOf(head);
    if (startPos < 0) { skipped++; continue; }
    const tailPos = nOut.indexOf(tail, startPos + headLen);
    if (tailPos < 0) { skipped++; continue; }
    const startIdx = map[startPos];
    const endIdx = map[Math.min(tailPos + tailLen - 1, map.length - 1)] + 1;
    if (!(endIdx > startIdx)) { skipped++; continue; }
    out = out.slice(0, startIdx) + newText + out.slice(endIdx);
    applied++;
    fuzzy++;
  }
  return { text: out, applied, skipped, fuzzy };
}

const REVISE_SYSTEM = `你是剧本杀剧本修订编辑。你会收到一份剧本的若干逻辑漏洞清单，以及剧本原文。
请只输出 JSON（不要解释）：
{"patches":[{"oldText":"原文中要被替换的一段连续文字","newText":"替换后的文字"}]}

硬性要求：
- oldText 必须是**剧本原文的逐字片段**（长度 20-150 字，可被直接搜到，且在全文唯一），
  严禁改写、严禁加省略号、严禁跨段落拼接。
- 只修正清单中列出的漏洞；不要顺手改写其它内容；严禁改动角色姓名/人数/时代/凶手。
- 每条 patch 尽量最小（只覆盖出错的那一两句），newText 篇幅不得明显短于 oldText，禁止删减信息。
- 无法在原文中定位的问题就**不要输出 patch**，不要编造。
- 若清单中的问题无需修改，输出 {"patches":[]}。`;

/**
 * 从**成稿**里切出各角色段落（供"修订后复检"用）。
 *
 * 为什么必须从成稿切：`report.characterScripts` 是**生成期**的文本，而定向修订改的是
 * `fullScript`——修订之后两者已经不同步。要复核"改完到底怎么样"，只能从成稿本身切。
 * 标题格式由 assembleScript 决定：`### 玩家角色 N：姓名 [凶手]` / `### NPC N：姓名`。
 */
function extractCharacterSections(fullScript) {
  const out = [];
  let cur = null;
  for (const line of String(fullScript || "").split("\n")) {
    const m = line.match(/^#{2,4}\s*(?:玩家角色|NPC)\s*\d*\s*[：:]\s*(.+?)\s*$/);
    if (m) {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { name: m[1].replace(/\s*\[[^\]]*\]\s*$/, "").trim(), text: "" };
      continue;
    }
    if (cur) cur.text += line + "\n";
  }
  if (cur && cur.text.trim()) out.push(cur);
  return out.filter((s) => s.name);
}

/**
 * 对成稿做一次**确定性体检**，返回可比较的快照。
 * 供"修订后复检"用：某条从"通过"变"不通过"，就说明这轮修订改坏了东西（要回退）。
 *
 * 只用**已被信任**的既有判据（不新增判断规则），所以不会引入新的误报面：
 *   · 跨角色日期一致性（checkDateAgreement，众数投票）
 *   · 第一轮线索是否指控真凶（checkRoundUnlock + nameAccuses）
 *   · 死者死后仍在活动（checkVictimAfterDeath，已含日期维度）
 * 每项各自 try/catch：任何一项算不出来都记为 unknown，绝不因此拦住生成。
 */
function deterministicSnapshot(text, ctx) {
  const c = ctx || {};
  const sections = extractCharacterSections(text);
  const snap = {
    sectionCount: sections.length,
    dateAgreement: "unknown",
    roundUnlock: "unknown",
    deathViolations: 0,
    deathDetail: [],
  };
  try {
    const da = checkDateAgreement(sections, c.outline);
    snap.dateAgreement = da.needed ? (da.ok ? "ok" : "bad") : "na";
  } catch (e) { /* 保持 unknown */ }
  try {
    const ru = checkRoundUnlock(text, c.murdererName);
    snap.roundUnlock = ru.r1NamesMurderer ? "bad" : (ru.r2HasAnchor ? "ok" : "na");
  } catch (e) { /* 保持 unknown */ }
  if (c.deathAt) {
    for (const s of sections) {
      try {
        const v = checkVictimAfterDeath(s.text, c.deathAt, c.victimName, c.caseDate);
        if (v.violations.length) {
          snap.deathViolations += v.violations.length;
          snap.deathDetail.push(`${s.name}×${v.violations.length}`);
        }
      } catch (e) { /* 单个角色失败不影响整体 */ }
    }
  }
  return snap;
}

/**
 * 比较两次体检快照，返回**变坏了**的项目（人话描述）。
 * 只判"通过 → 不通过"与"违规变多"——这是修订不该造成的方向性变化。
 */
function snapshotRegressions(before, after) {
  const b = before || {}, a = after || {};
  const out = [];
  if (b.dateAgreement === "ok" && a.dateAgreement === "bad") out.push("跨角色日期一致性由通过变为不通过");
  if (b.roundUnlock === "ok" && a.roundUnlock === "bad") out.push("第一轮线索由「未指控真凶」变为指控真凶");
  if ((a.deathViolations || 0) > (b.deathViolations || 0)) {
    out.push(`死者死后仍在活动由 ${b.deathViolations || 0} 处增加到 ${a.deathViolations} 处`);
  }
  return out;
}

/**
 * 把交叉校验发现的问题回灌成定向修订补丁并应用到成稿。
 * 背景：交叉校验原先只报警不修复（report.crossCheck 无任何消费方），
 * 检测出的问题（虚构人物、地点/楼层矛盾、诡计参数冲突等）全部被丢弃。
 *
 * ⚠️ 为什么要把"改了什么"记下来（`record` 出参）：驱动这一阶段的是一份**由 LLM 产出的
 * 问题清单**，它是有噪声的（实测复核过其中一条：读原文后并不成立，是校验器自己误报），
 * 而这里会照着它**自动改写成稿**。改之前无从知道它会把哪一段换成什么——
 * 想核对"它对那条误报做了什么"时查不到任何痕迹。所以每轮的 patches 原文都要留档，
 * 由 buildArtifacts 落盘、在管理端剧本详情页可见（人在环路里复核）。
 *
 * ⚠️ `opts.recheck`：**修订后复检**。原实现两轮都用**同一份**清单——第一轮改完不复核，
 * 第二轮还拿旧清单继续改，既不知道改好了没有，也可能把已经对了的地方改坏。现在每轮改完回调一次：
 *   · 返回 `{revert: "原因"}` → **整轮回退**（用于"修订让确定性校验变红"的情形）；
 *   · 返回 `{issues: [...]}`  → 用**复检后的新清单**驱动下一轮（而不是拿旧清单接着改）；
 *   · 返回 `{issues: []}`    → 已无问题，直接收工（省掉后续轮次）。
 *
 * @param {Array} [record] 可选出参：每轮追加 {round, issueCount, patches, applied, skipped}
 * @param {object} [opts] 可选：{ recheck: async ({before, after, round}) => ({revert?, issues?, verdict?}) }
 * @returns {Promise<string>} 修订后的全文（任何失败都原样返回，不阻塞生成）
 */
async function reviseByCrossCheck(fullScript, issues, onProgress, maxRounds = 2, record, opts) {
  let list = (Array.isArray(issues) ? issues : []).filter(x => typeof x === "string" && x.trim());
  if (!list.length) return fullScript;
  let text = String(fullScript || "");
  let appliedTotal = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (!list.length) {
      if (Array.isArray(record)) record.push({ round, issueCount: 0, issues: [], applied: 0, skipped: 0, patches: [], note: "复检已无问题，无需再审" });
      if (onProgress) onProgress("revise", `第 ${round} 轮复检已无问题，提前结束修订`);
      break;
    }
    if (onProgress) onProgress("revise", `第 ${round} 轮定向修订：处理 ${list.length} 个交叉校验问题...`);
    // 尽量整篇送检，保证 oldText 能逐字摘录；超长时退化为按标题切段的摘要
    const body = text.length <= 60000 ? text : buildSectionDigest(text, 24000);
    const user = `## 待修订的漏洞清单\n${list.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n## 剧本原文\n${body}\n\n请输出定向修订 JSON：`;

    // 解析补丁：① 正常解析；② 输出被截断时**抢救截断前写完的完整补丁**；③ 仍拿不到再重试一次。
    // ⚠️ 为什么必须区分结局（实测踩过）：原来写成 `extractJsonStrict(r.content) || {}`——
    // 截断/解析失败一律变成"0 条补丁"，而留档只会写一句"模型未产出可用补丁"，
    // 看不出其实是"输出被截断"，于是整轮白跑且无从归因。
    // **"模型确实没产出补丁"与"补丁 JSON 解析失败"是两回事**：后者意味着这次调用白费了（重试才有意义）。
    let patches = [];
    let parsedOk = false;
    let salvagedCount = 0;
    const acquirePatches = async () => {
      const r = await runStage(`交叉校验修订(第${round}轮)`, () => generate(REVISE_SYSTEM, user, { maxTokens: 8000, temperature: 0.1 }), onProgress);
      const raw = extractJsonStrict(r.content);
      if (raw) return { list: Array.isArray(raw.patches) ? raw.patches : [], salvaged: 0 };
      const salv = repairTruncatedJson(r.content);
      if (salv && Array.isArray(salv.patches) && salv.patches.length) {
        console.warn(`[builder] 第 ${round} 轮修订输出被截断，已从截断处抢救 ${salv.patches.length} 条完整补丁`);
        return { list: salv.patches, salvaged: salv.patches.length };
      }
      return null;   // 完全不是可解析的 JSON（含"开头就截断、无从抢救"）
    };
    try {
      const first = await acquirePatches();
      if (first) { patches = first.list; parsedOk = true; salvagedCount = first.salvaged; }
      else {
        if (onProgress) onProgress("revise", `第 ${round} 轮补丁 JSON 解析失败，正在重试一次...`);
        const second = await acquirePatches();
        if (second) { patches = second.list; parsedOk = true; salvagedCount = second.salvaged; }
      }
    } catch (e) {
      console.warn(`[builder] 交叉校验修订第 ${round} 轮调用失败:`, e.message);
      break;
    }
    if (!parsedOk || !patches.length) {
      // 留档"这一轮一条补丁都没产出"，并写明**是哪一种**没有产出——审计时比数字更重要。
      const note = parsedOk
        ? "模型未产出补丁（JSON 里 patches 为空）"
        : "补丁 JSON 解析失败（抢救与重试都没成功，本轮白费）";
      if (Array.isArray(record)) {
        record.push({ round, issueCount: list.length, issues: list.slice(0, 60).map((s) => String(s)), applied: 0, skipped: 0, patches: [], note });
      }
      if (onProgress) onProgress("revise", `第 ${round} 轮未产出可用补丁：${note}`);
      break;
    }
    const res = applyPatches(text, patches);
    if (Array.isArray(record)) {
      record.push({
        round,
        issueCount: list.length,
        issues: list.slice(0, 60).map((s) => String(s)),
        applied: res.applied,
        skipped: res.skipped,
        patches: (Array.isArray(patches) ? patches : []).slice(0, 80).map((p) => ({
          oldText: String((p && (p.oldText || p.old || p.find || p.anchor)) || ""),
          newText: String((p && (p.newText || p.new || p.replace || p.replacement)) || ""),
        })),
        ...(res.applied ? {} : { note: "补丁均无法在原文定位" }),
        ...(salvagedCount ? { salvaged: salvagedCount } : {}),   // 本轮补丁是从截断输出里抢救来的
      });
    }
    if (!res.applied) {
      console.warn(`[builder] 交叉校验修订第 ${round} 轮补丁均无法定位（跳过 ${res.skipped} 条）`);
      if (onProgress) onProgress("revise", "修订补丁无法在原文定位，已跳过");
      break;
    }    const before = text;
    text = res.text;
    appliedTotal += res.applied;
    if (onProgress) onProgress("revise", `第 ${round} 轮应用修订 ${res.applied}/${patches.length} 条`);

    // ===== 修订后复检 =====
    // 两件事：① 确定性体检（护栏，判"有没有改坏"）② 拿一份**新**的问题清单给下一轮。
    if (opts && typeof opts.recheck === "function") {
      let v = null;
      try {
        v = await opts.recheck({ before, after: text, round, issues: list });
      } catch (e) {
        console.warn(`[builder] 第 ${round} 轮修订后复检失败（不改动成稿）:`, e.message);
      }
      const last = Array.isArray(record) && record.length ? record[record.length - 1] : null;
      if (v && v.verdict && last) last.verdict = v.verdict;
      if (v && v.revert) {
        // 回退这一轮：宁可少改，不可把已经对了的地方改坏。
        text = before;
        appliedTotal -= res.applied;
        if (last) { last.reverted = true; last.applied = 0; last.note = v.revert; }
        console.warn(`[builder] 第 ${round} 轮修订被复检否决并整体回退：${v.revert}`);
        if (onProgress) onProgress("revise", `第 ${round} 轮修订经复检判定会改坏已有内容，已整体撤销：${v.revert}`);
        break;
      }
      if (v && Array.isArray(v.issues)) {
        list = v.issues.filter((x) => typeof x === "string" && x.trim());
        if (!list.length && onProgress) onProgress("revise", `第 ${round} 轮修订后复检：已无剩余问题`);
      }
    }
  }
  if (appliedTotal && onProgress) onProgress("revise", `交叉校验定向修订完成：共应用 ${appliedTotal} 条`);

  // ===== 整段重写兜底 =====
  // 走到这里还有 list（复检剩下的问题）时，不再收工：补丁机制对"抄错 oldText"没辙，
  // 而实测每次都有 4–10 个问题因此被留在成稿里。改成让模型交回整段、由代码定位替换。
  if (list.length && typeof opts.finalRewrite === "function") {
    try {
      const rw = await opts.finalRewrite({ text, issues: list, onProgress });
      if (rw && rw.text) {
        text = rw.text;
        if (Array.isArray(record)) {
          record.push({
            round: "整段重写", issueCount: list.length, issues: list.slice(0, 60).map((s) => String(s)),
            applied: rw.fixed || 0, skipped: (rw.attempts || 0) - (rw.fixed || 0),
            patches: [], note: "补丁定位不到的残留问题改走整段重写", details: rw.details || [],
          });
        }
        if (rw.fixed && onProgress) onProgress("revise", `残留问题整段重写：修好 ${rw.fixed}/${rw.attempts} 段`);
      }
    } catch (e) {
      console.warn("[builder] 整段重写兜底失败（保留现状）:", e.message);
    }
  }
  if (Array.isArray(record)) record.residual = list;   // 留档：最后仍未被修掉的问题
  return text;
}

/**
 * 把成稿按 "### 玩家角色 N：某某" / "### NPC N：某某" 这类三级标题切成段。
 * 用于「整段重写兜底」：补丁定位不到时，退化成"整段交回改好的版本再按标题换回去"。
 */
function splitScriptSections(text) {
  const lines = String(text || "").split("\n");
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s*(玩家角色|NPC|角色)\s*[一二三四五六七八九十\d]+\s*[：:]\s*(.+?)\s*$/);
    if (m) {
      if (cur) { cur.end = i; sections.push(cur); }
      cur = { header: lines[i], kind: m[1], title: m[2].trim(), start: i, end: lines.length };
    }
  }
  if (cur) sections.push(cur);
  return sections.map((s) => {
    const body = lines.slice(s.start + 1, s.end).join("\n");
    return { ...s, body, name: cutCharacterName(s.title) || s.title };
  });
}

/** 用新正文替换掉某段的正文（保留标题行与段外内容） */
function replaceSectionBody(text, section, newBody) {
  const lines = String(text || "").split("\n");
  const before = lines.slice(0, section.start + 1);
  const after = lines.slice(section.end);
  return [...before, String(newBody).replace(/\s+$/, ""), ...after].join("\n");
}

/**
 * 整段重写兜底（2026-10-18 新增）。
 *
 * 为什么必须有它：实测两轮定向修订之后**仍有 4–10 个问题没修掉**，而且日志里
 * 反复出现"修订补丁无法在原文定位，已跳过" —— 补丁机制靠模型抄对 oldText，
 * 一旦抄错（改标点/漏字）就整条作废，**检测出来的问题就此留在成稿里**。
 * 这里换成另一条路：不问"改哪几句"，而是让模型**交回整段改好的正文**，
 * 再按三级标题确定性替换 —— 定位由代码负责，不再依赖模型抄写。
 *
 * 安全边界：
 *   · 只碰 issues 里点名的角色段，最多 maxSections 段；
 *   · 新正文长度不得低于原来的 50%（防"交回一小段"把剧本改瘦）；
 *   · 每段重写后跑一次确定性体检（opts.snapshot/regressions），一旦改红就回退这一段。
 */
async function finalRewriteBySection(fullScript, issues, generateFn, onProgress, opts) {
  const o = opts || {};
  const list = (Array.isArray(issues) ? issues : []).filter((s) => typeof s === "string" && s.trim());
  if (!list.length) return { text: fullScript, fixed: 0, attempts: 0, details: [] };
  const sections = splitScriptSections(fullScript);
  if (!sections.length) return { text: fullScript, fixed: 0, attempts: 0, details: [] };

  // 认领：哪些角色段被 issues 点名（按角色名出现在问题描述里）
  const targets = [];
  for (const sec of sections) {
    const mine = list.filter((s) => sec.name && s.includes(sec.name));
    if (mine.length) targets.push({ sec, issues: mine });
  }
  const maxSections = Number.isFinite(o.maxSections) ? o.maxSections : 3;
  const chosen = targets.slice(0, maxSections);
  if (!chosen.length) return { text: fullScript, fixed: 0, attempts: 0, details: [] };

  let text = fullScript;
  let fixed = 0;
  const details = [];
  for (const t of chosen) {
    // 每段都重新定位（前面的替换会改变下标）
    const cur = splitScriptSections(text).find((s) => s.name === t.sec.name);
    if (!cur) { details.push({ name: t.sec.name, ok: false, reason: "重写前找不到该段" }); continue; }
    if (onProgress) onProgress("revise", `${t.sec.name} 的剧本有 ${t.issues.length} 个问题未能靠补丁修复，正在整段重写...`);
    let newBody = "";
    try {
      const sys = `你是剧本杀剧本校对。用户给你**某个角色的完整剧本**、以及它违反设定集的具体问题。
请输出**修改后的完整剧本正文**（不要标题行、不要任何解释、不要代码块），要求：
① 只修掉列出的问题，其余内容、结构、字段格式与篇幅一律保持；
② 时间线条目必须与该角色真实经历一致（与设定集凶手/手法/时间线不冲突）；
③ 不得删减章节：原来有的「背景故事/时间线/任务」等章节都要在，篇幅不得明显变短。`;
      const user = `【角色剧本正文】\n${cur.body}\n\n【必须修掉的问题】\n${t.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n请输出修改后的完整正文：`;
      const r = await runStage(`整段重写(${t.sec.name})`, () => generateFn(sys, user, { maxTokens: TOKENS_PER_STAGE, temperature: 0.6 }), onProgress);
      newBody = String(r.content || "").trim();
    } catch (e) {
      details.push({ name: t.sec.name, ok: false, reason: "调用失败：" + e.message });
      continue;
    }
    if (!newBody || newBody.length < cur.body.length * 0.5) {
      details.push({ name: t.sec.name, ok: false, reason: `交回的正文太短（${newBody.length} < 原文一半 ${Math.round(cur.body.length * 0.5)}），已放弃` });
      continue;
    }
    const candidate = replaceSectionBody(text, cur, newBody);
    // 确定性体检：改红就回退这一段（宁可留问题，不可改坏）
    // 只要求传了 snapshot/regressions 两个函数即可 —— snapCtx 合法地可以是 undefined，
    // 第一版把它也写成必要条件，结果"体检"整段被跳过（被单测当场抓出）。
    if (o.snapshot && o.regressions) {
      try {
        const broke = o.regressions(o.snapshot(text, o.snapCtx), o.snapshot(candidate, o.snapCtx));
        if (broke && broke.length) {
          details.push({ name: t.sec.name, ok: false, reason: "整段重写会使确定性校验变红：" + broke.join("；") });
          if (onProgress) onProgress("revise", `${t.sec.name} 的整段重写被否决（会改坏已有内容），已撤销`);
          continue;
        }
      } catch (e) { /* 体检失败不阻塞，继续采用 */ }
    }
    text = candidate;
    fixed++;
    details.push({ name: t.sec.name, ok: true, issues: t.issues.length, before: cur.body.length, after: newBody.length });
    if (onProgress) onProgress("revise", `${t.sec.name} 整段重写完成（${cur.body.length} → ${newBody.length} 字）`);
  }
  return { text, fixed, attempts: chosen.length, details };
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

// extractJsonStrict 已抽到 ./json-extract（诡计设计等中间产物阶段也要解析 JSON，
// 留在本文件里被别的模块 require 会形成循环依赖）。这里保持同名，调用点无需改动。

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
    // ⚠️ 这里是**白名单重建**：函数后半段只认 cfg，因此凡是下游要用的字段都必须列进来。
    //    2026-10-20 第二次踩坑：漏了 sessionId → 配图存到空 script_id（8 张图全成孤儿）。
    //    这已是同类事故的第三次（前两次：script-writer 漏 images、getSplitData 漏类型归一）。
    //    配套有元测试 tests/unit/builder-config-whitelist.test.js 自动比对"代码里用到的 cfg.* 字段
    //    是否都在这个白名单里"，以后漏字段会直接测试失败。
    sessionId: config?.sessionId || "",
    // 配图（可选）：默认关闭 —— 本机 Qwen-Image 单张约 40s 起，不该让每次生成都默认多花几分钟。
    // 调用方显式传 { images: { enabled: true, cover: true, characters: false, clues: 0 } } 才出图。
    images: config?.images && typeof config.images === "object" ? config.images : null,
  };
  // 约束到合法范围
  cfg.playerCount = Math.max(LIMITS.minPlayers, Math.min(LIMITS.maxPlayers, cfg.playerCount));
  cfg.npcCount = Math.max(0, Math.min(LIMITS.maxNpc, cfg.npcCount));

  // ========== 阶段 1.1：核心诡计与证明链（推理链第一步：先想清楚再写） ==========
  // 为什么放在最前面：诡计是整本的承重墙。改造前它只在框架/大纲那一次调用里隐式决定一次，
  // 而"诡计在物证上不可观测"这类致命问题要等四万字写完才被 checkTrickObservability 发现，
  // 且当时只 warn 不回炉。现在把它提到最前面，用**确定性校验**把住：
  // 不通过只重做这一个几百 token 的小步骤，代价远低于整线重跑。
  //
  // 放在框架之前还有第二个作用（实测得来）：框架模板原本要求模型"先在脑中敲定核心诡计，
  // 确保逻辑自洽、物理可行"，加上它自身庞大的产出要求（动机 500 字 + 双时间线 + 关系网 + 平面布局），
  // 推理模型会把 32768 token 预算整个烧在思考上、一个字正文都不输出（3 次尝试全部失败）。
  // 诡计定稿后，框架阶段只需"围绕它铺开"，这段自我一致性推理被显式取消。
  // 全部尝试失败则降级继续（design=null），框架阶段回到改造前的行为，可用性下限不降低。
  let trickDesign = null;
  try {
    const tr = await designTrick(userInput, cfg, onProgress, { maxAttempts: 2 });
    trickDesign = tr.design;
    if (trickDesign) report.trickDesign = trickDesign;
    // ========== 向流水线上报诡计设计（供管理端可视化"推理链"） ==========
    // 与 outline_done 同一套机制：把结构化产物随进度事件送出去，由 routes/admin.js 转成
    // 独立的 SSE 事件。此前 trickDesign 只存在于内存的 report 里，管理端只看得到
    // 一行进度文字（"核心诡计已定稿并通过校验：…"），看不到三锁、证明链与最弱处——
    // 而这三样才是"这个诡计立不立得住"的全部依据。
    if (trickDesign) {
      try {
        onProgress("trick_done", JSON.stringify({
          ...trickDesign,
          // 设计阶段的真实返回字段（designTrick 返回 {design, attempts, lastErrors}）：
          // attempts>1 即"有过被打回的尝试"，lastErrors 是最后被打回的原因（空数组=一次通过）。
          attempts: tr.attempts || null,
          lastErrors: Array.isArray(tr.lastErrors) ? tr.lastErrors : [],
        }));
      } catch (e) { console.warn("[builder] trick 可视化上报失败（不影响主流程）:", e.message); }
    }
  } catch (e) {
    console.warn("[builder] 诡计设计阶段异常，降级继续:", e.message);
  }

  // ========== 阶段 1：故事框架 ==========
  onProgress("framework", `正在设计故事框架（${cfg.playerCount}玩家${cfg.npcCount > 0 ? ' + ' + cfg.npcCount + 'NPC' : ''}）...`);
  const frameworkPrompt = buildFrameworkPrompt(userInput, cfg, trickDesign);
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
  let outlineError = null;
  for (let oa = 0; oa < 3; oa++) {
    try {
      const cand = await buildOutline(userInput, cfg, trickDesign);
      const op = (cand.players || []).length;
      const on_ = (cand.npcs || []).length;
      if (cand && op === cfg.playerCount && on_ === cfg.npcCount) {
        outline = cand;
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
  // 案发日期来自大纲后立刻核一次并出声音：它是全剧唯一的时间基准，
  // 缺了它 → 每个角色都会收到"未设定绝对日期，严禁自创" → 实测挡不住 → 各角色编出多套日期
  // → 事后靠几十条补丁统一（1975 西安·俑坑案：76 条）。静默缺失的代价太大，必须可见。
  if (!parseCaseDate(outline)) {
    const warnMsg = "⚠️ 大纲没有给出案发日期（caseDate 缺失）：各角色可能各自编日期，需在修订阶段统一";
    console.warn("[builder]", warnMsg);
    onProgress("outline", warnMsg);
  }

  // 角色级公共事件表：拿到合格大纲后**补齐一次**。
  // 它是"同一事件只有一个时刻"的权威来源——timeline 只承载 DM 关键节点，
  // 而"某人何时去了哪、手里拿着什么"这类角色级公开行踪必须另有出处，
  // 否则各角色会为同一趟走动编出不同时刻与不同随身物（实测见 buildPublicEventTable 注释）。
  try {
    await ensurePublicEvents(outline, cfg, onProgress);
    // 上报规模：E2E 与线上都要能从日志判断这张表是否真的产出了（否则无从验证）
    const peCount = ((outline && outline.publicEvents) || []).length;
    onProgress("outline", `角色级公共事件表：${peCount} 条`);
  } catch (e) {
    console.warn("[builder] 公共事件表处理失败（不影响出本）:", e.message);
  }

  // 关键物件状态变更表：同样在大纲定稿后补齐一次。
  // 实测里"书房灯未熄 vs 里头没点灯""闸板已放下 vs 闸板尚全开"这类矛盾，
  // 根因是各角色对同一物件在同一时刻的状态各写各的，没有权威来源可对齐。
  try {
    await ensureObjectStates(outline, cfg, onProgress);
    const osCount = ((outline && outline.objectStates) || []).length;
    onProgress("outline", `关键物件状态表：${osCount} 条`);
  } catch (e) {
    console.warn("[builder] 物件状态表处理失败（不影响出本）:", e.message);
  }

  // ===== 权威表（剧本圣经）：补齐缺项 + 自洽闸门 =====
  // 存在的理由：这些是"全局唯一事实"，必须在源头钉死，且钉在**所有相关方都会读到**的地方
  //（outlineToText 会把它们渲染进角色/线索/DM 的提示词）。实测：缺身亡时刻会让
  // "死者死后不得再活动"整层保护静默失效；缺 publicEvents 会让同一趟走动被写成不同时刻。
  const bibleDeps = { generate, runStage, sb, applyLineRewrites, outlineToText, extractJsonStrict, repairTruncatedJson, TOKENS_PER_STAGE };
  try {
    await bibleEnforce.ensureBibleExtras(bibleDeps, outline, onProgress);
  } catch (e) { console.warn("[builder] 权威表补齐异常（不阻塞）:", e.message); }
  let bible = sb.buildBible(outline);
  // ===== 权威表矛盾的确定性修复（2026-10-20）=====
  // 为什么在自检之前：自检原本只报警不修，矛盾会原样传进 4 个角色本与 DM 手册，
  // 然后靠交叉校验 + 两轮修订去救 —— 实测救不干净（曾残留 11 处并触发 2 段整篇重写）。
  // 这里只在源头做"删冗余/取权威"两种保守动作，不编造新内容。
  let bibleRepair = { fixes: [] };
  try {
    bibleRepair = sb.repairBibleContradictions(outline, bible);
    if (bibleRepair.fixes.length) {
      bible = sb.buildBible(outline);   // 用修好的 outline 重建，下游全部读到一致版本
      console.warn(`[builder] 权威表已自动修复 ${bibleRepair.fixes.length} 处矛盾：`,
        bibleRepair.fixes.slice(0, 3).map((f) => f.text).join("；"));
      if (onProgress) {
        onProgress("outline", `权威表自动修复 ${bibleRepair.fixes.length} 处矛盾（同刻两地 / 事件归属不一致 / 死者死后活动）`);
      }
    }
  } catch (e) { console.warn("[builder] 权威表修复失败（不阻塞）:", e.message); }
  try {
    const self = sb.checkBibleSelfConsistency(bible);
    report.bibleCheck = { ok: self.ok, issues: self.issues, candidates: 0, fixed: (bibleRepair.fixes || []).length, fixes: bibleRepair.fixes || [] };
    for (const i of self.issues) {
      if (i.level !== "error") continue;
      console.warn("[builder] 权威表自检:", i.text);
      if (onProgress) onProgress("outline", `⚠ ${i.text}`);
    }
  } catch (e) { console.warn("[builder] 权威表自检失败:", e.message); }

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
  // 权威时间轴：统一所有角色的时间基准。历史缺陷：各角色各自推算且大半不标注，
  // 同一个数字在不同角色嘴里代表不同真实时刻，核心破绽因此无法被读懂。
  // ⚠️ 必须放在 blueprintCtx 的**最前面**：下游 buildCharacterPrompt 用
  // substring(0,8000)、buildNpcPrompt 用 substring(0,6000) 截断，而 blueprintCtx
  // （outlineToText + buildStructuredSummary，后者又重复包含一次 outlineToText）
  // 远超该上限——追加在末尾会被整段截掉。
  const timeAxis = buildTimeAxis(report.outline);
  // 两套上下文：**无谜底**（给侦探/所有玩家角色/NPC）与**含谜底**（只给凶手本人）。
  // 此前所有角色共用同一份含谜底的上下文，靠"不要读出真凶名字"维持——单点隐患（见 outlineToText 注释）。
  // 凶手本人必须拿含谜底版：他要在剧本里写清自己真实的作案经过与对外说辞。
  const mkBlueprint = (includeTruth) => {
    const base = report.outline
      ? (timeAxis ? timeAxis + "\n\n" : "") + outlineToText(report.outline, { includeTruth }) + "\n\n" + buildStructuredSummary(report, { includeTruth })
      : report.framework;
    // 布局方位描述（若已生成）注入所有角色剧本——让角色时间线带空间视角
    // （"我站在苏婉房间门口，能看见柳惊鸿从他房间出来"），与场景布局互相印证
    return report.layoutText
      ? base + "\n\n## 场景布局（空间关系蓝本，所有角色的时间线必须与之吻合）\n" + report.layoutText
      : base;
  };
  const blueprintCtx = mkBlueprint(false);         // 角色/NPC 默认：不含谜底
  const blueprintCtxTruth = mkBlueprint(true);     // 仅凶手本人：含谜底

  // 跨午夜日期校验的选项（算一次，循环内复用）
  const caseDate = parseCaseDate(report.outline);
  const dateOpts = {
    caseDate,
    nextDate: nextDayLabel(caseDate),
    midnight: crossesMidnight((report.outline && report.outline.timeline) || []),
  };
  // 死亡时刻（算一次，循环内复用）。算不出来时**必须出声音**：它撑着的是一整层保护
  // （角色提示词里的"死者死后不得再互动"硬约束 + 生成后的死后一致性校验），
  // 静默返回 null 会让这层保护整轮消失而无人察觉——实测踩过（见 findDeathMoment 注释）。
  const deathMoment = findDeathMoment(report.outline);
  if (!deathMoment && ((report.outline && report.outline.timeline) || []).length) {
    const warnMsg = "⚠️ 时间线里识别不出死者身亡的时刻——本轮「死者死后不得再活动」约束与死后一致性校验都不会生效";
    console.warn("[builder]", warnMsg);
    onProgress("player_script", warnMsg);
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
      // 凶手本人拿含谜底版（他要写清自己的真实经过与对外说辞）；其余角色只拿公共事实
      const ctx = ch.isMurderer ? blueprintCtxTruth : blueprintCtx;
      const prompt = buildCharacterPrompt(ch, ctx, i + 1, playerChars.length, cfg.isPVE, report.outline) + TIME_SYSTEM_RULE
        + stageDirective(cfg.advancedMode, "character");
      const systemPrompt = buildCharacterSystemPrompt(ch, cfg.isPVE);
      const result = await runStage(`玩家剧本(${ch.name})`, () => generate(systemPrompt, prompt, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
      // PVP 玩家剧本必须有完整时间线；PVE（玩家是侦探）按模板不写时间线，跳过校验
      if (cfg.isPVE) {
        characterResults[ch.name] = result.content;
      } else {
        const withTimeline = await ensureTimelineComplete(ch.name, result.content, async (note) => {
          const r = await runStage(`玩家剧本补写(${ch.name})`, () => generate(systemPrompt, prompt + note, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
          return r.content;
        }, onProgress, {
          // 玩家角色本的正文下限：实测 2473–2804 字的稿子"时间线够、正文太薄"，
          // 而真本中位 5929 字。4200 是"明显厚实但仍可在一次重写内完成"的门槛。
          minChars: 4200,
        });
        // 生成后校验：死者死亡之后不得再被描写成活动（实测复验里反复出现的致命漏洞）
        const deathAt = deathMoment;   // 循环外算好（含"算不出来就告警"）
        const afterDeath = await ensureDeathConsistent(
          ch.name, withTimeline, deathAt,
          report.outline && report.outline.victim && report.outline.victim.name,
          async (note) => {
            const r = await runStage(`玩家剧本重写(${ch.name})`, () => generate(systemPrompt, prompt + note, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
            return r.content;
          },
          onProgress,
          { caseDate: dateOpts.caseDate }   // 传递案发日：避免把"案发前一日"的正当内容当违规改坏
        );
        // 生成后校验：跨午夜时夜间事件的日期标注必须正确（实测出现过整篇错位一天）
        const withDates = await ensureDateConsistent(
          ch.name, afterDeath, dateOpts,
          async (note) => {
            const r = await runStage(`玩家剧本日期重写(${ch.name})`, () => generate(systemPrompt, prompt + note, { maxTokens: TOKENS_PER_STAGE, temperature: 0.7 }), onProgress);
            return r.content;
          },
          onProgress
        );
        characterResults[ch.name] = withDates;
        // 公共事件锚点核对：只告警、不改写（"当事人未必逐条复述自己的每次走动"，缺失不等于错）
        try {
          const off = parseTimeOffset(report.outline);
          const deltaMin = off ? (off.slow ? -off.offsetMin : off.offsetMin) : 0;
          const anc = checkPublicEventAnchors(ch.name, withDates, report.outline && report.outline.publicEvents, deltaMin);
          if (anc.needed && !anc.ok) {
            console.warn(`[builder] ${ch.name} 未复述自己的 ${anc.missing.length} 条公共事件（告警，不重写）：${anc.missing.map((m) => m.time).join(" ")}`);
            onProgress("player_script", `⚠️ ${ch.name} 的剧本未出现其 ${anc.missing.length} 条权威公开行踪（已记录，未改动）`);
          }
        } catch (e) { /* 纯告警，失败不影响主流程 */ }
      }
    }
  }

  for (let i = 0; i < npcChars.length; i++) {
    const ch = npcChars[i];
    onProgress("npc_script", `撰写NPC信息 (${i + 1}/${npcChars.length}): ${ch.name}`);
    // NPC 同理：凶手 NPC（PVE 常见）拿含谜底版，其余见证人/关系人只拿公共事实
    const npcCtx = ch.isMurderer ? blueprintCtxTruth : blueprintCtx;
    const prompt = buildNpcPrompt(ch, npcCtx, i + 1, npcChars.length, cfg.isPVE, cfg.npcCount, report.outline) + TIME_SYSTEM_RULE
      + stageDirective(cfg.advancedMode, "npc");
    const isWitness = !cfg.isPVE;
    const systemPrompt = buildNpcSystemPrompt(ch, { era: cfg?.era, location: cfg?.location, victim: cfg?.victim }, isWitness);
    // 单人本NPC需要更丰富内容，token适度加量（封顶）
    const npcTokens = isSolo ? Math.min(TOKENS_PER_STAGE * 1.25, 16384) : TOKENS_PER_STAGE;
    const result = await runStage(`NPC信息(${ch.name})`, () => generate(systemPrompt, prompt, { maxTokens: Math.floor(npcTokens), temperature: 0.7 }), onProgress);
    // 生成后校验：NPC 的时间线同样有下限（模板要求"至少 6 个时间点"）。
    // ⚠️ 这一步以前**不存在** —— 门只接在玩家角色循环上，于是 NPC 时间线薄到 5 条也没人出声
    //（实测改后那一本的 `阿强`：5 个时刻 / 时间线 374 字）。NPC 的目击信息是玩家推理的输入，
    // 它薄了直接削弱整局可推理度，属于结构性漏洞而不是文风问题。
    // 章节名与标题体系用 NPC 自己那套（"三、时间线" / 人物关系 / 目击信息…），不能沿用玩家的。
    const npcHeadings = isWitness
      ? '使用 "### 一、人物关系" / "### 二、目击信息与需要隐瞒的事" / "### 三、时间线" 三个三级标题，顺序不可变。'
      : '使用 "### 一、人物关系" / "### 二、作案动机" / "### 三、时间线" / "### 四、需要隐瞒或可供审讯透露的信息" 四个三级标题，顺序不可变。';
    const npcTimeline = await ensureTimelineComplete(
      ch.name,
      result.content,
      async (note) => {
        const r = await runStage(`NPC信息补写(${ch.name})`, () => generate(systemPrompt, prompt + note, { maxTokens: Math.floor(npcTokens), temperature: 0.7 }), onProgress);
        return r.content;
      },
      onProgress,
      {
        min: MIN_NPC_TIMELINE_POINTS,
        section: "三、时间线",
        progressStage: "npc_script",
        headings: npcHeadings,
        cover: "覆盖案发当日及前一日的完整行动轨迹",
        // NPC 的目击信息是玩家推理的输入，太薄同样削弱可推理度（实测出现过 374 字）
        minChars: 1200,
      },
    );
    characterResults[ch.name] = npcTimeline;
  }
  report.characterScripts = characterResults;

  // ===== 逐人权威对账 + 跨角色一致性（角色写完、线索生成之前）=====
  // 为什么插在这里：这是跨角色矛盾的源头治理。实测 crosscheck 报出的问题全是
  // 【跨角色】或【角色 vs 权威】，逐人自审抓不到，逐条对账能抓到；
  // 而放在线索之前，是因为线索要以"定稿的角色行踪"为准（否则线索链会跟着角色一起断）。
  try {
    let unresolved = 0;
    let shichenFixed = 0;
    for (const nm of Object.keys(characterResults)) {
      // ① 时辰↔时刻换算：确定性就地改对（24 小时制是权威；只改时辰词，不动时刻）
      const shFx = sb.fixShichenByClock(characterResults[nm], { unsafeApply: true });
      if (shFx.fixed) {
        characterResults[nm] = shFx.text;
        shichenFixed += shFx.fixed;
        console.log(`[builder] ${nm} 时辰换算修正 ${shFx.fixed} 处: ` + shFx.changes.map(c => `${c.said}→${c.to}`).join("、"));
      }
      // ② 再与权威表对账（时刻/地点/知识/时间线体检）
      const r = await bibleEnforce.ensureBibleAligned(bibleDeps, nm, characterResults[nm], bible, onProgress);
      if (r && r.content) characterResults[nm] = r.content;
      unresolved += (r && r.issues) || 0;
    }
    const cross = await bibleEnforce.ensureCrossCharacterConsistent(bibleDeps, characterResults, bible, onProgress);
    report.bibleCheck = {
      ...(report.bibleCheck || {}),
      unresolved,
      shichenFixed,
      candidates: cross.candidateTotal || 0,
      fixed: cross.fixed || 0,
      remaining: (cross.remaining || []).slice(0, 8),
    };
    report.characterScripts = characterResults;
  } catch (e) {
    console.warn("[builder] 权威对账阶段异常（不阻塞出本）:", e.message);
  }

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
    cluesPrompt += stageDirective(cfg.advancedMode, "clues") + TIME_SYSTEM_RULE + CLUE_TIME_RULE;
    // 时间类诡计：强制要求"可被玩家实际获取"的锚点线索。
    // 实测反例《钟楼诡影》：全案只有一口被拨快的座钟，花园那口是停摆的（停摆钟不能作基准），
    // 唯一能测出时差的怀表没有任何线索卡 → 核心诡计在物证上不可观测。
    if (buildTimeAxis(report.outline)) {
      cluesPrompt += `\n\n## ⚠️ 时间类诡计的硬性线索要求（本剧本核心诡计涉及公共时钟，**必须满足**）\n- 必须设计 **至少 1 条能独立锚定"真实时间"的线索**（如：某人的怀表/手表读数、有客观时间戳的记录、法医对死亡时间的判定），并给出**具体读数或区间**。\n- **禁止用"停摆的钟"单独充当时间基准**——停摆的钟只能说明它停在哪一刻，不能证明公共时钟快/慢。\n- 必须设计 **至少 1 条直接描述公共时钟本身异常的线索**（如：机芯有近期拨动痕迹、钟面与可靠时间源对不上、有人提及"钟好像不太准"）。\n- 以上线索一律客观描述读数与痕迹，禁止出现"这证明座钟被拨快"这类结论句。`;
    }
    const cluesResult = await runStage("clues", () => generate(getCluesSystemPrompt(), cluesPrompt, { maxTokens: TOKENS_LIGHT }), onProgress);
    // 校验：物理线索发现地点归一化到布局真实地点
    const norm = normalizeClueLocations(cluesResult.content, layoutPlaces);
    if (norm.fixed > 0 || norm.skipped > 0) {
      console.warn(`[builder] 线索地点校验：归一 ${norm.fixed} 条 / 豁免 ${norm.skipped} 条`);
    }
    report.clues = norm.text;
    // 诡计可观测性校验：**任何**诡计都必须留下可被玩家实际获取的锚点。
    // 改造前这里只 warn 不回炉——用户会拿到一个"诡计无法被任何线索证明"的废本，而流程显示成功；
    // 且只对时间诡计检查，密室/身份诡计的"手法可行但物证上不可观测"没人管。
    // 现在按"修复成本分级"处理：缺个别线索属于**可局部补丁**（补 1-2 条线索即可），
    // 所以定向补写并复检，而不是重跑整个线索阶段（那是 40-50 条的重新生成）。
    let obs = checkTrickObservability(report, report.outline);
    if (obs.needed && !obs.ok) {
      const missText = [
        !obs.hasAnchor && "缺少任何物证/记录/证词类锚点线索（玩家将无法证伪手法）",
        obs.clockNeeded && !obs.hasIndependent && "缺少独立时间源（怀表/手表读数、尸检对死亡时间的判定、带时间戳的记录）",
        obs.clockNeeded && !obs.hasClockAnomaly && "缺少公共时钟本身的异常线索（机芯拨动痕迹、与可靠时间源对不上）",
      ].filter(Boolean);
      console.warn(`[builder] 诡计可观测性不足：${missText.join("；")}——尝试定向补写线索`);
      onProgress("clues", `诡计可观测性不足，正在定向补写线索：${missText.join("；")}`);
      try {
        const repaired = await repairCluesObservability(report, missText, layoutPlaces, onProgress);
        if (repaired) {
          report.clues = repaired;
          const obs2 = checkTrickObservability(report, report.outline);
          if (obs2.ok) {
            onProgress("clues", "定向补写完成：诡计可观测性校验已通过");
            console.log("[builder] 诡计可观测性补写成功");
          } else {
            // 补写后仍不达标：如实告知，不假装通过
            console.warn("[builder] 诡计可观测性补写后仍未达标");
            onProgress("clues", "⚠️ 定向补写后仍未完全达标，玩家可能无法证伪核心手法");
          }
        }
      } catch (e) {
        console.warn("[builder] 诡计可观测性补写失败（不影响出本）:", e.message);
        onProgress("clues", `⚠️ 诡计可观测性不足且补写失败：${missText.join("；")}`);
      }
    } else if (obs.needed) {
      onProgress("clues", "诡计可观测性校验通过");
    }

    // 时代载体校验：防"民国本子写出联网日志"这类穿越（确定性词表，误伤成本低）。
    // 违规的是**几条线索的措辞** → 就地改写成时代相符的等价物（局部补丁，不动总数与轮次）。
    const eraLabel = detectEra(cfg.era || (report.outline && report.outline.storyBackground) || report.framework || "");
    const eraCheck = checkEraCarriers(eraLabel, report.clues);
    if (eraCheck.needed && eraCheck.offenders.length) {
      onProgress("clues", `时代载体校验：发现 ${eraCheck.offenders.length} 个不属于「${eraCheck.era}」时代的载体词（${eraCheck.offenders.join("、")}），正在就地改写`);
      try {
        const blocks = extractClueBlocks(report.clues).filter((b) =>
          eraCheck.offenders.some((w) => b.body.includes(w))
        );
        const rewritten = await repairClueTexts(report, blocks,
          `本剧本时代为「${eraCheck.era}」，以下线索里出现了该时代不存在的载体/物件/信息方式：${eraCheck.offenders.join("、")}。` +
          `把这些违规说法改写成该时代真实存在的等价物（例如"联网日志"→"门房登记簿"、"监控"→"巡夜更夫的证词"、"微信"→"口信/字条"），` +
          `其余内容（发现地点、客观描述风格）保持不变。`, onProgress, "时代载体改写");
        if (rewritten) {
          report.clues = rewritten;
          const re = checkEraCarriers(eraLabel, report.clues);
          if (!re.offenders.length) onProgress("clues", "时代载体改写完成，已无穿越词");
          else onProgress("clues", `⚠️ 时代载体改写后仍有 ${re.offenders.length} 个穿越词（${re.offenders.join("、")}）`);
        }
      } catch (e) {
        console.warn("[builder] 时代载体改写失败（不影响出本）:", e.message);
      }
    }

    // 轮次解锁校验（借鉴"最低解锁=可指控 / 完整解锁=无法抵赖"）：
    // 第一轮不得直接点出真凶姓名——否则第一轮就能锁定凶手，两轮制形同虚设。
    // 注意只取**第一轮区间内**的违规块：第二轮本来就该能点名定案，
    // 一并改写会白白削掉定案证据（实测踩过）。
    const murdererName = report.outline && report.outline.murderer && report.outline.murderer.name;
    const unlock = checkRoundUnlock(report.clues, murdererName);
    if (unlock.r1NamesMurderer) {
      onProgress("clues", `轮次解锁校验：第一轮线索里有 ${unlock.r1Blocks.length} 条在**指控**真凶「${unlock.r1NamesMurderer}」，正在就地改写`);
      try {
        // 只改写"结论性指控"（"凶手是X""X杀害了死者"），纯提及（证词/文档/目击）不判——
        // PVP 剧本里所有人互为嫌疑人，"目击某某出现在某处"本来就是核心玩法材料（见 nameAccuses 注释）。
        const rewritten = await repairClueTexts(report, unlock.r1Blocks,
          `第一轮线索不得出现**结论性指控**——如「凶手是${unlock.r1NamesMurderer}」「${unlock.r1NamesMurderer}杀害了死者」` +
          `这类直接把身份说破的写法。请把这些线索改写成**客观事实**（物证、目击到的行为、他人的原话），` +
          `让玩家只能通过推理锁定，而不是被线索直接指控。注意：证词、签到簿/登记簿这类客观文档里出现「${unlock.r1NamesMurderer}」的名字**不算指控**，可以保留。`,
          onProgress, "第一轮指控性线索改写");
        if (rewritten) {
          report.clues = rewritten;
          const u2 = checkRoundUnlock(report.clues, murdererName);
          if (!u2.r1NamesMurderer) onProgress("clues", "第一轮指控性线索改写完成");
          else onProgress("clues", `⚠️ 改写后第一轮仍有 ${u2.r1Blocks.length} 条在指控真凶`);
        }
      } catch (e) {
        console.warn("[builder] 第一轮指控性线索改写失败（不影响出本）:", e.message);
      }
    } else if (unlock.r2HasAnchor) {
      onProgress("clues", "轮次解锁校验通过（第一轮未点名真凶 + 第二轮含定案锚点）");
    } else {
      onProgress("clues", "⚠️ 轮次解锁校验：第二轮未检出定案锚点（玩家可能缺少「无法抵赖」的证据）");
    }

    // ===== 线索三要素与权威一致性（story-bible）=====
    // 线索只有 location+round 时，"线索链断裂"根本查不出原因。
    // 这里做两件事：① 把 cluePlan 对齐到**已落地的线索**（冲突时以线索为准，因为计划是大纲阶段猜的）；
    // ② 只对"缺发现时间"的线索做一次定向补全（时间是最难从线索文本里确定性推出的字段）。
    try {
      const blocks = extractClueBlocks(report.clues || "");
      const clueObjs = blocks.map(b => {
        const loc = (b.body.match(/发现地点[：:]\s*(.+)/) || [])[1];
        return { id: b.id, location: loc ? loc.trim().replace(/[（(].*$/, "").trim() : "", body: b.body || "" };
      });
      const shClue = sb.checkShichenConsistency(report.clues || "");
      if (shClue.issues.length) {
        console.warn(`[builder] 线索时辰换算错 ${shClue.issues.length} 处`);
        onProgress("clues", `⚠ 线索里有 ${shClue.issues.length} 处时辰↔时刻换算错（已记录，交叉校验阶段会据此改写）`);
      }
      const aligned = sb.alignCluePlan(clueObjs, bible);
      outline.cluePlan = aligned.plan;                 // 写回大纲 → 随 artifacts 落盘，管理端可复核
      console.log(`[builder] cluePlan 对齐：推导 ${aligned.derived} 项 / 纠正 ${aligned.mismatched} 项 / 缺时间 ${aligned.missingTime} / 仍不完整 ${aligned.incomplete}`);
      let plan = aligned.plan;
      if (aligned.missingTime > 0) {
        try {
          plan = await bibleEnforce.ensureCluePlanTimes(bibleDeps, outline, clueObjs, bible, onProgress);
          outline.cluePlan = plan;
        } catch (e) { console.warn("[builder] 线索发现时间补全失败（不阻塞）:", e.message); }
      }
      const finalBible = sb.buildBible(outline);
      const cp = sb.checkCluePlan(clueObjs, finalBible);
      const filled = plan.filter(p => p.discoverer && p.time && (p.kind === "person" || p.place)).length;
      report.bibleCheck = {
        ...(report.bibleCheck || {}),
        clueTotal: clueObjs.length,
        clueShichen: shClue.issues.length,
        clueShichenIssues: shClue.issues.slice(0, 5),
        cluePlanFilled: filled,
        cluePlanDerived: aligned.derived,
        cluePlanMismatched: aligned.mismatched,
        clueHard: cp.issues.filter(i => i.level === "error").length,
        clueWarn: cp.issues.filter(i => i.level === "warn").length,
        clueIssues: cp.issues.slice(0, 8),
      };
      const bt = aligned.byType || {};
      const fmtT = (k, label) => (bt[k] ? `${label} ${bt[k].complete}/${bt[k].total}` : null);
      const doneAll = aligned.plan.filter(p => p.complete).length;
      onProgress("clues", `线索计划：齐备 ${doneAll}/${clueObjs.length}（${[fmtT("testimony", "证词[需发现者+时刻]"), fmtT("physical", "物品[需地点]"), fmtT("unknown", "未分类")].filter(Boolean).join("｜")}；由线索推导 ${aligned.derived}、纠正 ${aligned.mismatched}）`);
    } catch (e) { console.warn("[builder] 线索三要素核对失败（不阻塞）:", e.message); }
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
    // 把**真实线索编号**交给 DM：实测模型会自己造「线索1…线索22」这套编号，
    // 与库里的 A1..A20/B1..B20 对不上，玩家复盘时无法回查；而且它只解析了 22/40 条却自称"无遗漏"。
    {
      const ids = [...String(report.clues || "").matchAll(/^###\s*([AB]\d{1,3})/gm)].map((m) => m[1]);
      if (ids.length) {
        dmPrompt += `\n\n## 必须逐条解析的线索编号（共 ${ids.length} 条，一条都不能漏）\n`
          + ids.join("、")
          + `\n\n硬性要求：「真相复盘」里的线索解析**必须按上面这些编号逐条写**（如「A3：… —— 在推理中的作用」），`
          + `不得自造「线索1、线索2」这类序号；漏一条即不合格；不得声称"共N条"以外的数量。`;
      }
    }
    let dmResult = await runStage("dmGuide", () => generate(getDMSystemPrompt(), dmPrompt, { maxTokens: TOKENS_LIGHT }), onProgress);
    report.dmGuide = dmResult.content;
    // ===== 真相复盘字数下限 =====
    // 实测（2026-10-18，《停表的修表铺》）：不设下限时模型交过来的真相复盘只有 **587 字**，
    // 而真本《吉普赛女郎之死》是 **11242 字**（5%）。真相复盘是这类本的价值核心，
    // 短了整本就没有"回扣线索"的可读性。这里给下限 + 补写一次，仍然太短就保留较长的那个。
    const truthLenOf = (s) => {
      const t = String(s || "");
      const i = t.search(/真相复盘/);
      if (i < 0) return 0;
      const rest = t.slice(i);
      const end = rest.search(/\n#{2,4}\s*(?=[^\n]*(QA|问答|结局|注意事项|注意事项))/);
      return (end > 0 ? rest.slice(0, end) : rest).replace(/\s+/g, "").length;
    };
    const MIN_TRUTH_CHARS = 4000;
    if (truthLenOf(report.dmGuide) < MIN_TRUTH_CHARS) {
      const shortLen = truthLenOf(report.dmGuide);
      if (onProgress) onProgress("dmGuide", `真相复盘仅 ${shortLen} 字（要求 ≥${MIN_TRUTH_CHARS}），正在补写...`);
      try {
        const retryPrompt = dmPrompt + `\n\n## ⚠️ 上一次的「真相复盘」写得太短（只有 ${shortLen} 字）
必须重写整份手册，并且「真相复盘」**不少于 ${MIN_TRUTH_CHARS} 字**，必须包含：
1. 凶手完整作案过程（分钟级，与设定集一致）
2. **逐条列出全部线索的编号与意义**（含误导/红鲱鱼线索的真实作用）——一条都不要漏
3. 推理逻辑链：每条结论写明"由哪几条线索推出"
4. 可能的多种结局`;
        const retry = await runStage("dmGuide", () => generate(getDMSystemPrompt(), retryPrompt, { maxTokens: TOKENS_PER_STAGE }), onProgress);
        if (truthLenOf(retry.content) > shortLen) {
          report.dmGuide = retry.content;
          if (onProgress) onProgress("dmGuide", `真相复盘已补写到 ${truthLenOf(report.dmGuide)} 字`);
        } else {
          console.warn(`[dmGuide] 真相复盘补写无效（${truthLenOf(retry.content)} 字），保留原稿`);
        }
      } catch (e) {
        console.warn("[dmGuide] 真相复盘补写失败，保留原稿:", e.message);
      }
    }
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

  // 非法时刻的确定性修复（2026-10-18）：实测生成稿的真相里出现「手表显示22:60」——
  // 分钟位 ≥60 不是合法时刻，玩家一眼就看出错。这类可以纯字符串修好，不必回炉让模型改。
  try {
    const { fixIllegalClockTimes } = require("./logic-checks");
    const fix1 = fixIllegalClockTimes(fullScript);
    if (fix1.fixed) {
      fullScript = fix1.text;
      console.log(`[builder] 非法时刻修正 ${fix1.fixed} 处（如 22:60 → 23:00）`);
      if (onProgress) onProgress("assemble", `非法时刻修正 ${fix1.fixed} 处`);
    }
    if (report.dmGuide) {
      const fix2 = fixIllegalClockTimes(report.dmGuide);
      if (fix2.fixed) report.dmGuide = fix2.text;
    }
  } catch (e) { console.warn("[builder] 非法时刻修正跳过:", e.message); }

  // 组装后是**交付文本**（DM 手册 + 线索 + 各角色本都在里面），时辰换算在这里再查一次：
  // 线索与 DM 复盘是角色本之外最容易写错的地方（实测 4 处真问题里有 2 处在线索正文）。
  try {
    // 先确定性修正，再复检：交付文本里 DM 复盘与线索正文都在，实测 4 处真问题里有 2 处在线索正文
    const shFix = sb.fixShichenByClock(fullScript, { unsafeApply: true });
    if (shFix.fixed) {
      fullScript = shFix.text;
      console.log(`[builder] 交付文本时辰换算修正 ${shFix.fixed} 处: ` + shFix.changes.map(c => `${c.said}→${c.to}`).join("、"));
      onProgress("assemble", `时辰换算：就地修正 ${shFix.fixed} 处`);
    }
    const shFinal = sb.checkShichenConsistency(fullScript);
    report.bibleCheck = { ...(report.bibleCheck || {}), finalShichen: shFinal.issues.length, finalShichenIssues: shFinal.issues.slice(0, 5) };
    if (shFinal.issues.length) {
      console.warn(`[builder] 交付文本时辰换算错 ${shFinal.issues.length} 处`);
      onProgress("assemble", `⚠ 交付文本里仍有 ${shFinal.issues.length} 处时辰↔时刻换算错，已并入交叉校验待修`);
    }
  } catch (e) { console.warn("[builder] 交付文本时辰检查失败（不阻塞）:", e.message); }

  // ========== 阶段 4.5：模块交叉校验（对照设定集，检查各模块间的逻辑一致性） ==========
  onProgress("crosscheck", "正在交叉校验各模块（人物/时间线/线索/DM手册）...");
  try {
    const xcheck = await runModuleCrossCheck(report, frameworkSummary, fullScript, onProgress);
    report.crossCheck = xcheck;
    if (xcheck && xcheck.issues && xcheck.issues.length) {
      console.warn(`[builder] 交叉校验发现 ${xcheck.issues.length} 个问题：`, xcheck.issues.slice(0, 3).join("；"));
    }
    // 跨角色日期体系核对（众数投票，确定性）：结论并入 issues，走既有定向修订。
    // 日期问题改不好单个角色，只能全局统一——所以必须让修订阶段看到它。
    // 确定性检查的结论是**补充**，不是替代交叉校验（交叉校验是抽样读且能发现别的类）。
    try {
      const sections = Object.entries(report.characterScripts || {}).map(([name, text]) => ({ name, text: String(text || "") }));
      const da = checkDateAgreement(sections, report.outline);
      if (da.needed && !da.ok) {
        report.crossCheck = report.crossCheck || { issues: [] };
        report.crossCheck.issues = [...(report.crossCheck.issues || []), da.message];
        console.warn(`[builder] 日期体系核对：${da.message}`);
        onProgress("crosscheck", `日期体系核对：跨角色案发日期不一致，已并入待修订问题`);
      } else if (!da.needed) {
        // ⚠️ "判不了"必须出声音。MIN_VOTES=3（每角色需≥3条傍晚带日期条目）是为了不在证据太薄时乱判，
        // 但代价是**恰好在出问题的时候失明**——实测（1996 长沙）交叉校验第一条就是"六个角色五套日期"，
        // 而确定性体检只能给 na。沉默会让人以为这一项把过关了。
        console.warn("[builder] 跨角色日期核对：证据不足（每角色需≥3条傍晚带日期条目），本次无法判定——这一项本次没有把关");
        if (onProgress) onProgress("crosscheck", "跨角色日期核对：证据不足，本次无法判定（这一项没有把关）");
      }
    } catch (e) {
      console.warn("[builder] 日期体系核对跳过:", e.message);
    }
    // ===== 逻辑层确定性校验（2026-10-18 新增）=====
    // 补上管道此前完全查不出的四类问题（实测《停摆的时针》四类全中）：
    //   ① 凶手「凶手确认」写了手法，但自己的时间线里没落地 → 凶手玩家以为自己是目击者
    //   ② 「座钟」在凶手剧本里是被调过的钟、在其他人剧本里当真实时间用
    //   ③ 真相算术不自洽（同一只钟两个偏差、22:60 这种不存在的时刻）
    //   ④ 真相只解析了 22/40 条线索，还自称"无遗漏"
    // 并入 issues 后走既有的定向修订；结论同时留档 report.logicChecks 供审计。
    try {
      const { runLogicChecks } = require("./logic-checks");
      const sections = Object.entries(report.characterScripts || {}).map(([name, text]) => ({ name, text: String(text || "") }));
      const clueIds = [...String(report.clues || "").matchAll(/^###\s*([AB]\d{1,3})/gm)].map((m) => m[1]);
      const lc = runLogicChecks({
        sections,
        murdererName: (report.outline && report.outline.murderer && report.outline.murderer.name) || "",
        dmText: String(report.dmGuide || ""),
        clueIds,
      });
      report.logicChecks = { issues: lc.issues, details: lc.details, clueIdCount: clueIds.length };
      if (lc.issues.length) {
        report.crossCheck = report.crossCheck || { issues: [] };
        report.crossCheck.issues = [...(report.crossCheck.issues || []), ...lc.issues];
        console.warn(`[builder] 逻辑校验发现 ${lc.issues.length} 个问题：`, lc.issues.slice(0, 3).join("；"));
        if (onProgress) onProgress("crosscheck", `逻辑校验：发现 ${lc.issues.length} 个逻辑问题（凶手手法/时间基准/真相算术/线索覆盖），已并入待修订问题`);
      } else if (onProgress) {
        onProgress("crosscheck", "逻辑校验：凶手手法落地、时间基准、真相算术、线索覆盖 四项均通过");
      }
    } catch (e) {
      console.warn("[builder] 逻辑校验跳过:", e.message);
    }
    // ===== 难度校验：不能一眼看穿凶手（2026-10-20 用户需求）=====
    // 语义评审 rubric 里「唯一锁定」三本都只有 2/3 分：删掉一两条关键线索仍能推出凶手，
    // 说明证据过度集中在凶手身上。这里用三条确定性判据兜底，问题并入待修订队列。
    try {
      const { checkEvidenceBalance } = require("./difficulty-checks");
      const parts = String(report.clues || "").split(/^###\s*/m);
      const clueObjs = parts.slice(1).map((p) => {
        const m = p.match(/^([AB]\d{1,3})\s*[：:]?/);
        return m ? { id: m[1], content: p.slice(m[0].length) } : null;
      }).filter(Boolean);
      const chars = Object.keys(report.characterScripts || {});
      const murdererName = (report.outline && report.outline.murderer && report.outline.murderer.name) || "";
      const dc = checkEvidenceBalance({ clues: clueObjs, characters: chars, murderer: murdererName });
      // 两轮分工：第一轮只揭杀机、第二轮才指凶，且单条不得同时含"凶手名 + 手法"
      let rp = { ok: true, issues: [], stats: {} };
      try {
        const { checkRoundPurpose } = require("./difficulty-checks");
        rp = checkRoundPurpose({ clues: clueObjs, characters: chars, murderer: murdererName });
      } catch (e) { console.warn("[builder] 轮次分工校验异常:", e.message); }
      const allIssues = [...dc.issues, ...rp.issues];
      report.difficulty = { issues: allIssues, stats: dc.stats, roundStats: rp.stats };
      if (allIssues.length) {
        report.crossCheck = report.crossCheck || { issues: [] };
        report.crossCheck.issues = [...(report.crossCheck.issues || []), ...allIssues];
        console.warn(`[builder] 难度校验发现 ${allIssues.length} 个问题（证据平衡 ${dc.issues.length} / 轮次分工 ${rp.issues.length}）`,
          allIssues.slice(0, 2).join("；"));
        if (onProgress) {
          const s = dc.stats || {};
          const rs = rp.stats || {};
          onProgress("crosscheck",
            `难度校验：${allIssues.length} 个问题（证据平衡 ${dc.issues.length}、轮次分工 ${rp.issues.length}）｜` +
            `凶手 ${s.killer || 0} 条 / 其他人最多 ${s.maxOther || 0} 条｜` +
            `第一轮 ${rs.round1 || 0} 条（含凶器类 ${(rs.round1Killing || []).length} 条）、第二轮 ${rs.round2 || 0} 条`);
        }
      } else if (onProgress) {
        const s = dc.stats || {};
        const rs = rp.stats || {};
        onProgress("crosscheck",
          `难度校验通过：凶手 ${s.killer || 0} 条 / 其他人最多 ${s.maxOther || 0} 条，隐藏线索 ${s.hiddenKillerClues || 0} 条｜` +
          `第一轮 ${rs.round1 || 0} 条只揭杀机、第二轮 ${rs.round2 || 0} 条指凶`);
      }
    } catch (e) {
      console.warn("[builder] 难度校验跳过:", e.message);
    }
    // ===== 配图（可选，2026-10-18 新增）=====
    // 真本《吉普赛女郎之死》带 24 张图（角色立绘/线索文档/真相时间线），生成稿是 0 张 ——
    // 这是"看起来不像真本"最直观的一块。用本机 ComfyUI（Qwen-Image 2.1 + 8step LoRA）出图。
    // 约束：本机单张约 40s–数分钟，所以**默认只出封面一张**（别人的机器可以开 characters/clues）；
    // ComfyUI 没起来时**直接跳过**，绝不因为配图失败而拖垮整篇生成。
    try {
      const imgCfg = (cfg && cfg.images) || {};
      if (imgCfg.enabled) {
        const { attachScriptImages } = require("./script-images");
        const { saveScriptImage } = require("../core/db");
        if (onProgress) onProgress("images", "正在生成封面配图（本机 ComfyUI）...");
        // ⚠️ 必须拿到 scriptId，否则图片会存到空 id 上（2026-10-20 实测：8 张图全成孤儿）。
        // 优先级：cfg.sessionId（script-writer 传入）→ report 上的 → 明确报错而不是静默存空。
        const imgScriptId = (cfg && cfg.sessionId) || report.sessionId || report.scriptId || "";
        if (!imgScriptId) {
          console.warn("[builder] 配图缺少 scriptId，跳过（否则图片会存到空 id 上，切分后取不到）");
          throw new Error("missing scriptId for images");
        }
        const imgRes = await attachScriptImages({
          scriptId: imgScriptId,
          outline: report.outline,
          meta: { location: (report.outline && report.outline.setting && report.outline.setting.location) || "", era: (report.outline && report.outline.setting && report.outline.setting.era) || "" },
          characters: (report.characters || []).map((c) => ({ name: c.name, occupation: c.occupation })),
          // ⚠️ 必须把成稿交给配图：正文里 `![线索·图片N](img:cluedoc-N)` 的引用要**按引用出图**，
          //    否则引用指向不存在的图（碎图），或者图与线索内容无关。见 script-images.planImageJobs。
          scriptText: fullScript,
          options: {
            cover: imgCfg.cover !== false,
            characters: !!imgCfg.characters,
            clues: Number(imgCfg.clues) || 0,
            clueRefs: imgCfg.clueRefs !== false,
            maxClueRefs: Number(imgCfg.maxClueRefs) || 6,
            width: Number(imgCfg.width) || 768,
            height: Number(imgCfg.height) || 768,
          },
          save: saveScriptImage,
          onProgress: (m) => { if (onProgress) onProgress("images", m); },
        });
        report.images = imgRes;
        if (imgRes.generated.length) {
          console.log(`[builder] 配图完成 ${imgRes.generated.length} 张：` + imgRes.generated.map((g) => g.key).join("、"));
        }
        if (imgRes.skipped.length) {
          console.warn("[builder] 配图跳过/失败：" + imgRes.skipped.map((s) => `${s.key}(${s.reason})`).join("；"));
        }
      }
    } catch (e) {
      console.warn("[builder] 配图跳过:", e.message);
    }
  } catch (e) {
    console.warn("[builder] 交叉校验跳过:", e.message);
  }

  // ========== 阶段 4.6：交叉校验问题定向修订（含"修订后复检"） ==========
  // 交叉校验此前只报警不修复（report.crossCheck 无任何消费方），检测出的
  // 虚构人物/地点矛盾/诡计参数冲突等问题全部被丢弃。这里回灌成补丁作用到成稿。
  // revisionLog 留档"照着哪些问题、把哪几段换成了什么"——这份清单是 LLM 产的、有噪声，
  // 而这里会照着它自动改写；不留档就没法事后核对它到底改对了没有。
  try {
    const revisionLog = [];
    const snapCtx = {
      outline: report.outline,
      murdererName: (report.outline && report.outline.murderer && report.outline.murderer.name) || "",
      victimName: (report.outline && report.outline.victim && report.outline.victim.name) || "",
      deathAt: deathMoment,
      caseDate: dateOpts.caseDate,
    };
    fullScript = await reviseByCrossCheck(
      fullScript, report.crossCheck && report.crossCheck.issues, onProgress, 2, revisionLog,
      {
        // 补丁定位不到的残留问题 → 整段重写兜底（定位交给代码，不再依赖模型抄对原文）
        finalRewrite: async ({ text, issues, onProgress: op }) => finalRewriteBySection(
          text, issues, generate, op,
          {
            maxSections: 3,
            snapshot: deterministicSnapshot,
            regressions: snapshotRegressions,
            snapCtx,
          },
        ),
        recheck: async ({ before, after, round }) => {
          // ① 确定性护栏：用**既有、已被信任**的判据体检，避免"修订把已经对了的地方改坏"。
          //    任何一项从"通过"变"不通过" → 整轮回退（宁可少改，不可改坏）。
          const b = deterministicSnapshot(before, snapCtx);
          const a = deterministicSnapshot(after, snapCtx);
          const broke = snapshotRegressions(b, a);
          const verdict = {
            dateAgreement: a.dateAgreement, roundUnlock: a.roundUnlock,
            deathViolations: a.deathViolations, sectionCount: a.sectionCount,
          };
          if (broke.length) return { revert: `修订使确定性校验变红：${broke.join("；")}`, verdict };
          if (onProgress) onProgress("revise", `第 ${round} 轮修订后体检：日期一致性=${a.dateAgreement}、轮次解锁=${a.roundUnlock}、死亡后活动=${a.deathViolations} 处`);
          // ② 复检：重新做一次交叉校验，拿**新**清单驱动下一轮（旧清单在改写后已经过期）。
          //    本轮是最后一轮时也做——它的结论就是"改完到底还剩多少问题"，正是审计要看的东西。
          try {
            const x2 = await runModuleCrossCheck(report, frameworkSummary, after, onProgress);
            if (!x2 || !x2.parsed) {
              // ⚠️ 复检**没有结论** ≠ 没有问题：绝不能拿空清单去停掉后续修订
              // （那会把"校验失败"变成"提前收工"，是本改动最危险的失败模式）。
              if (onProgress) onProgress("revise", `第 ${round} 轮复检没有结论（输出无法解析），沿用本轮清单继续`);
              report.revisionRecheck = { count: null, issues: [], failed: true };
              const last2 = Array.isArray(record) && record.length ? record[record.length - 1] : null;
              if (last2) last2.recheckFailed = true;
              return { verdict, recheckFailed: true };
            }
            const rest = Array.isArray(x2.issues) ? x2.issues : [];
            report.revisionRecheck = rest;
            if (onProgress) onProgress("revise", `第 ${round} 轮修订后复检：剩余 ${rest.length} 个问题`);
            return { issues: rest, verdict };
          } catch (e) {
            console.warn(`[builder] 第 ${round} 轮修订后复检失败（沿用原清单）:`, e.message);
            return { verdict };
          }
        },
      },
    );
    if (revisionLog.length) report.revision = revisionLog;
  } catch (e) {
    console.warn("[builder] 交叉校验定向修订跳过:", e.message);
  }

  // ===== 角色标题完整性兜底（2026-10-19，实测事故）=====
  // 修订/整段重写会把「### 玩家角色 3：林小满」这一行吃掉，正文变成无主的孤儿段，
  // 切分时该角色**彻底消失**（实测：生成报 4 人，落库只有 3 人，玩家选角选不到）。
  // 标题是切分的唯一锚点，必须在保存前保证"每个角色都有且只有一个标题"。
  try {
    const rep = repairMissingCharacterHeadings(fullScript, report.characters || []);
    if (rep.fixed.length) {
      fullScript = rep.text;
      const names = rep.fixed.map((f) => f.name).join("、");
      console.warn(`[builder] 角色标题缺失已补回 ${rep.fixed.length} 个：${names}`);
      if (onProgress) onProgress("revise", `角色标题缺失已修复：${names}（否则这个角色会在切分后消失）`);
      if (!report.structureRepairs) report.structureRepairs = [];
      report.structureRepairs.push({ kind: "missing-character-heading", names: rep.fixed.map((f) => f.name) });
    }
  } catch (e) {
    console.warn("[builder] 角色标题完整性检查跳过:", e.message);
  }

  // ===== 角色段落丢失的最后防线（正文也没了就从 characterScripts 整段重建）=====
  // 实测：2026-10-20《山坳雪夜烛影》5 人本只剩 1 人 —— 修订整段重写把另外 4 段吞了。
  try {
    const re = restoreMissingCharacterSections(fullScript, report.characters || [], report.characterScripts || {});
    if (re.restored.length) {
      fullScript = re.text;
      const names = re.restored.map((r) => `${r.name}(${r.chars}字)`).join("、");
      console.warn(`[builder] ⚠️ 角色段落丢失，已从原文重建 ${re.restored.length} 个：${names}`);
      if (onProgress) onProgress("revise", `⚠️ 修订误删了 ${re.restored.length} 个角色段落，已从原文重建：${names}`);
      if (!report.structureRepairs) report.structureRepairs = [];
      report.structureRepairs.push({ kind: "missing-character-section", names: re.restored.map((r) => r.name) });
    }
  } catch (e) {
    console.warn("[builder] 角色段落恢复跳过:", e.message);
  }

  // ========== 阶段 4.7：时间线一致性后处理（长期校准；失败静默保留原文） ==========
  // 放在定向修订之后，让时间线校准对时间线有最终话语权
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

/**
 * @param {object|null} trickDesign - 阶段 1.2 定稿的诡计设计。
 *   非空时做两件事：① 把设计注入用户消息作为硬约束；
 *   ② **改写模板里的「创作顺序纪律」**，明确告诉模型"核心诡计已定稿，不要重新设计、不要自行验算可行性"。
 *
 *   为什么 ② 是必要的（实测）：框架模板原本要求模型"先在脑中敲定核心诡计，确保逻辑自洽、物理可行"，
 *   而框架本身又要求产出作案动机 500 字以上 + 双时间线表格 + 关系网连通 + 一二层平面布局。
 *   推理模型为了这套自我一致性校验，会把 32768 token 的预算整个烧在思考上、**一个字正文都不输出**
 *   （实测 3 次尝试全部失败：`模型仅在推理后未输出正文（reasoning 占满 32768 tokens 预算）`）。
 *   诡计已由上游定稿并通过确定性校验后，这段推理就是纯浪费——必须显式取消掉。
 */
function buildFrameworkPrompt(userInput, cfg, trickDesign) {
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
  let system = String(stages.framework)
    .replace(/\{playerCount\}/g, String(playerCount))
    .replace(/\{npcline\}/g, npcline)
    .replace(/\{npcSection\}/g, npcSection)
    .replace(/\{npcConstraint\}/g, npcConstraint)
    .replace(/\{timelineSection\}/g, timelineSection);

  if (trickDesign) {
    // 取消"自己设计诡计"的指令（见本函数头注释：这是 32k 思考预算被烧光的主因）
    system = system.replace(
      /## 创作顺序纪律[\s\S]*?内在一致性。/,
      `## 创作顺序纪律（核心诡计已定稿，禁止重新设计）
1. **本局核心诡计已经确定并通过校验**（见用户消息中的「核心诡计设计」一节的完整内容）。
   **不要重新构思诡计、不要自行推演或验算它的可行性、不要改动它的机制**——那些工作已经做完了。
2. **直接围绕它构思人物**：为每个角色设计公开身份、隐藏身份与作案动机，让人物服务于这个诡计。
3. **最后填时间线**：保证行凶窗口、在场证明与该诡计的机制严丝合缝。
下方所有章节都是按此顺序组织的结果，写作时应保持这种"诡计→人物→时间线"的内在一致性。`
    );
  }

  const user = `【角色数量约束 — 必须严格遵守】
玩家角色：恰好${playerCount}人
${npcConstraint}
游戏模式：${isPVE ? 'PVE侦探对抗' : 'PVP玩家互疑'}
总人数：${playerCount + npcCount}人（不超过${LIMITS.maxTotal}人）

【房间数量约束】
专属房间：${totalChars}个（${playerCount}玩家 + ${npcCount}NPC + 1死者）
公共区域：2-3个（如大厅、厨房、前院等，不包括走廊/过道/楼梯间）
总房间数：${minRooms}-${maxRooms}个

${trickDesign ? trickDesignToText(trickDesign) + "\n\n" : ""}【用户需求】
${userInput}`;

  return { system, user };
}

// ==================== 结构化角色提取 ====================

/**
 * 阶段 1.5：剧本大纲生成
 * 一次性产出锁死"人数/人物卡/手法/时间线骨架/布局"的结构化大纲（JSON），
 * 后续所有阶段（角色剧本/线索/DM手册）都基于大纲创作，避免各自发散导致人数/设定冲突。
 */
/**
 * @param {object|null} trickDesign - 阶段 1.2 定稿并通过校验的诡计设计。
 *   非空时作为**最高优先级硬约束**注入：大纲的 coreTrick/trickSpec/murderer 必须与它一致。
 *   为 null（诡计阶段降级）时行为与改造前完全一致——不注入任何诡计约束。
 */
async function buildOutline(userInput, cfg, trickDesign) {
  const { playerCount, npcCount, isPVE } = cfg;
  const npcLabel = isPVE ? "嫌疑人" : (npcCount > 0 ? "目击者/关系人" : "无NPC");
  const roleHint = isPVE
    ? `凶手可以是玩家或NPC（建议NPC更有挑战性）；NPC都是嫌疑人，各怀动机`
    : (npcCount > 0 ? `凶手在玩家之间；NPC是目击者/关系人，掌握特定时间点信息，不是凶手` : `凶手在玩家之间，纯玩家互疑`);

  const system = `你是剧本杀大纲设计师。根据需求与人数约束，直接输出一份完整剧本大纲（JSON），作为后续所有创作阶段（角色剧本、线索、DM手册）的共同蓝图。大纲必须严格锁定角色人数，后续阶段不得增减。

## 输出铁律（必须遵守）
- **不要输出任何思考过程、推理草稿、分析说明**——直接给出最终 JSON。
- 一次性在正文完整输出 JSON，且只输出一个 JSON 代码块。不要分两次、不要先给草稿再给终稿。
- 若你的推理层（如果有）已想好，正文只放 JSON，不要复述。
${trickDesign ? "\n## 关于核心诡计\n本次的核心诡计**已经单独设计并通过校验**，随用户消息一并给出。你的职责是把人物、关系、时间线、动机围绕它铺开，**不要另立诡计、不要改动机制**；trickSpec 必须与给定的设计一致。" : ""}`;

  const trickBlock = trickDesign ? trickDesignToText(trickDesign) + "\n\n" : "";

  const user = `## 用户需求
${userInput}

${trickBlock}## 硬性人数约束（必须严格遵守，大纲中一个不多一个不少）
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
  "caseDate": "案发当日的具体日期（如 6月14日）",
  "storyBackground": "故事背景（时代/场景/核心矛盾，150字内）",
  "layout": ["公共地点1", "公共地点2", "专属房间...（每个角色一个）", "案发地点"],
  "victim": {"name": "死者", "identity": "身份", "gender": "性别", "causeOfDeath": "死因", "deathPlace": "死亡地点"},
  "relations": [
    {"a": "角色A", "b": "角色B", "link": "两人表面关系一句话", "tension": "利益/情感纠葛一句话（可为恩怨/债务/情债/把柄/旧谊）"}
  ],
  "players": [
    {"name": "玩家1姓名", "gender": "性别", "identity": "身份/职业", "personality": "性格与说话方式（20字内，要具体到语速/用词/口头禅，不要写'善良''聪明'这类空词）", "goal": "个人支线任务（30字内，必须是一件**可判定是否做到**的具体事，例如'隐瞒你当晚去过药房''找出谁偷了账本'）", "background": "简单背景1-2句", "connection": "与死者或案件的关系", "isMurderer": false}
  ],
  "npcs": [
    {"name": "NPC1姓名", "gender": "性别", "identity": "身份", "personality": "性格与说话方式（20字内，同上）", "goal": "个人支线任务（30字内，可判定）", "background": "简单背景1-2句", "connection": "与死者或案件的关系", "role": "嫌疑人或目击者/关系人", "isMurderer": false}
  ],
  "murderer": {
    "name": "凶手姓名", "motive": "动机简述", "method": "真实杀人手法（具体过程，60字内，物理上可行）",
    "misdeedClues": "留下的破绽方向（2-3个）",
    "realLine": "凶手真实行凶时间线（案发前24h关键节点，精确到分钟）",
    "fakeLine": "凶手对外宣称的伪装时间线/不在场证明（与 realLine 明显区分，可被证伪）"
  },
  "timeline": [
    {"id": "T1", "time": "20:55", "actor": "角色姓名（**凡是一个角色做的动作都必须写在这里**；只有纯环境节点才留空）", "place": "地点", "kind": "public", "desc": "核心事件（如：凶手进入书房）"}
  ],
  "victimLine": {
    "deathTime": "22:35",
    "deathPlace": "西侧书房",
    "lastSeen": "22:20 在书房与某人说话（案发夜最后一次被见到）",
    "confirmedBy": ["目击或发现该节点的角色名"]
  },
  "publicEvents": [
    {"time": "18:30", "actor": "角色姓名", "place": "公开可见的地点", "doing": "别人能看到的公开行为（不带秘密）", "who": ["当时在场、可能目击到的其他角色名"]}
  ],
  "objectStates": [
    {"at": "20:00", "object": "书房的灯", "state": "亮着（灯罩上有一层薄灰，可见光晕）", "witnesses": ["看到该状态的角色名"]}
  ],
  "knowledgeMap": [
    {"who": "角色姓名", "knows": "他/她知道的某件事（如：密道日记的存在）", "since": "21:00", "source": "怎么知道的（亲眼所见/他人转述/推理得出）"}
  ],
  "cluePlan": [
    {"clueId": "A1", "discoverer": "角色姓名", "time": "20:30", "place": "东侧起居室", "about": "这条线索指向什么（破绽方向）"}
  ]
}
要求：
- **victimLine 必须给**：死者**身亡时刻**是全剧的硬锚点 —— 缺了它，"死者死后不得再活动"这层约束
  与事后校验**会整层静默失效**（实测多次：角色剧本里让已经死掉的人在 20:00 继续交代事情）。
  deathTime 必须是真实时间轴上的 HH:MM（不是钟面读数）。
- **timeline 每条都要带 id / kind，且凡是角色动作必须写明 actor**：只写动作不写人（"20:30 借添酒之名在温酒壶中下巴豆"）会让 DM 分不清是谁做的 —— 实测外部评审就把这种条目误读成"写错了角色"。
- **timeline 每条都要带 id / kind**：id 让后续"逐条对账"能指名道姓；
  kind=secret 表示只有凶手或极少数人知道，kind=public 表示公开可见。
- **knowledgeMap 是"谁在何时知道什么"**：推理本最典型的漏洞是"角色知道了不该知道的事"，
  没有这张表就无法判定。只列**关键秘密**（每个角色 1-3 条），since 用真实时间。
- **cluePlan 是线索的"谁 / 何时 / 何地发现"三要素**：线索链断裂时，没有这三要素根本查不出原因；
  clueId 必须与最终线索编号一致（A1/A2… 第一轮，B1/B2… 第二轮）。
- **caseDate 必须给出一个具体日期（"X月X日"）**，它是全剧**唯一的时间基准**：
  - 跨午夜（夜里发案、凌晨发现）可写成 **"X月X日夜至X月X日晨"**，此时**第一段就是案发当日**；
  - 所有角色时间线的日期都必须用它（跨午夜的凌晨用它的次日）；
  - **禁止**写"某日/一日/不详/未设定"这类空值，也**禁止**在别处另立日期；
  - 为什么必须给：实测（1975 西安·俑坑案等两轮）大纲不给日期时，6 个角色**各自编出了 4 套不同的月份日期**
    （4月16日／6月14日／十月十六日…），而提示词里"严禁自创日期"的禁令挡不住——
    只能靠事后 76 条补丁去统一，代价极大。**日期这种"全局唯一事实"必须在源头钉死，不能靠禁令。**
- players 恰为 ${playerCount} 项、npcs 恰为 ${npcCount} 项；凶手只能出现在 players 或 npcs 中之一（isMurderer: true），且 murderer.name 必须与之对应。
- **objectStates 是"关键物件状态变更表"**：列出**会被多个角色看到、且状态会变**的物件（灯、门闩、锁、窗户、闸板、挂钟、账本位置等）。要求：
  - 每个物件在其状态改变的**每个时刻**都列一条（状态未变期间不重复列）；
  - **状态是可被观察到的客观描述**（"灯亮着"而不是"灯被凶手调暗了"——后者是秘密动作，不属于此表）；
  - 只列**案发夜**的状态变更，不列前情；at 用真实时间；
  - 至少覆盖 3 个物件（凡诡计涉及或场景中显眼的物件都要有）——实测里"书房灯未熄 vs 里头没点灯"、"闸板已放下 vs 闸板尚全开"这类矛盾都源于各角色对同一物件在同一时刻的状态各写各的。
- **publicEvents 是"角色级公共事件表"**（与 timeline 分工不同：timeline 是 DM 的关键节点，publicEvents 是**在场所有人都能看到的公开行踪**）。要求：
  - 覆盖案发夜从入席到案发的全过程，粒度约 15–30 分钟；
  - **每一次角色在场景之间移动都必须列一条**：谁（actor）、何时、去了哪个地点、手里拿着什么/在做什么——实测里"同一个人的同一趟走动"最容易被各角色写成不同时刻与不同携带物，所以这类必须逐条钉死；
  - **只写公开可见的行为**：不得写凶手的秘密动作、不得写只有本人知道的内心或私下会面。可以写"某人离席上楼"，但不必写他上楼后秘密做了什么（那是 timeline 与 murderer.realLine 的事）；
  - actor 必须与 players/npcs 的姓名**逐字一致**；who 只列当时在场、可能目击到的其他角色；
  - time 用**真实时间**（若涉及时钟诡计，真实时间与钟面读数的换算由后续阶段统一处理）。
- **relations 保证无边缘角色**：每名角色至少与 2 名其他角色有明确 link+tension，整体关系网必须连通（任一角都能通过关系链牵扯到案件）；凶手、死者身边人、容易被冤枉的抗推位角色之间的纠葛务必列出。请列出尽可能多的关键角色对（覆盖 5-8 对核心纠葛即可，不必穷举全部 36 对）。
- **personality 必须互不相同且具体**：这是 AI 扮演该角色时的唯一语气抓手，写"温和""精明"没用；要写得出声，如"语速很快，爱抢话，常带'我跟你说'"。六个人读起来必须是六个不同的人在说话。
- **goal 必须是可判定的支线任务**：不要写"查明真相"这种人人都一样、也无从判定完成与否的空话（那是公共目标，另有字段承载）。要写一件只属于这个角色、局后能明确说出"做到/没做到"的事，例如"隐瞒你当晚去过药房""不让任何人知道你和死者的旧情""找出谁拿走了账本"。凶手的目标通常就是"不被投出去"。
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
  // publicEvents：逐条净化——时刻非法 / actor 缺失的条目直接丢弃（宁可少给也不给错）
  if (o.publicEvents !== undefined) {
    o.publicEvents = asArr(o.publicEvents).filter((e) => e && typeof e === "object"
      && minutesOf(e.time) !== null && String(e.actor || "").trim());
  }
  // objectStates：同上——at 非法 / 无物件名 / 无状态的条目丢弃
  if (o.objectStates !== undefined) {
    o.objectStates = asArr(o.objectStates).filter((e) => e && typeof e === "object"
      && minutesOf(e.at) !== null && String(e.object || "").trim() && String(e.state || "").trim());
  }
  if (o.relations !== undefined) o.relations = Array.isArray(o.relations) ? o.relations.filter(Boolean) : [];
  if (o.murderer && o.murderer.misdeedClues !== undefined) {
    o.murderer.misdeedClues = Array.isArray(o.murderer.misdeedClues)
      ? o.murderer.misdeedClues.filter(Boolean)
      : String(o.murderer.misdeedClues || "").split(/[、，,；;|\n]/).map(s => s.trim()).filter(Boolean);
  }
  return o;
}

/** 把大纲转成给后续阶段的提示注入文本 */
/**
 * 渲染设定集文本。
 *
 * @param {object} outline
 * @param {{includeTruth?: boolean}} [opts]
 *   `includeTruth: false` —— **抹掉谜底**再交给角色：凶手是谁/动机/手法、核心诡计说明书
 *   （运作原理·隐藏方式·破绽方向）、凶手双时间线、人物表里的【凶手】标记、类型行里的"核心诡计："。
 *
 * 为什么需要这个开关（实测隐患）：角色/NPC 提示词此前把**整份含谜底的设定集**塞给每一个角色，
 * 靠一句"不要直接读出真凶名字"维持——这是单点隐患：模型一旦漏嘴，扮演该角色的 AI 玩家
 * 就直接拿到答案，整局游戏作废；而且"知道答案却要装作不知道"本身就会污染角色的行为
 * （不敢自由怀疑、下意识避开真凶）。DM 手册与最终成稿仍用完整版（它们本来就该掌握真相）。
 */
function outlineToText(outline, opts) {
  if (!outline) return "";
  const includeTruth = !opts || opts.includeTruth !== false;
  const L = [];
  L.push(`## 设定集（剧本大纲 — 所有阶段必须遵循，不得更改角色人数/姓名/身份/手法）`);
  if (outline.genre) {
    const bits = [outline.genre];
    // "核心诡计：..." 正是谜底本身（一句话说破手法），角色版不给
    if (includeTruth && outline.coreTrick) bits.push("核心诡计：" + outline.coreTrick);
    if (outline.duration) bits.push("时长：" + outline.duration);
    if (outline.murdererCanLie !== undefined) bits.push("凶手是否允许说谎：" + (outline.murdererCanLie ? "是" : "否"));
    L.push(`### 类型\n${bits.join("｜")}`);
  }
  L.push(`### 故事背景\n${outline.storyBackground || ""}`);
  L.push(`### 场景布局\n${(outline.layout || []).join("、")}`);
  L.push(`### 死者\n${outline.victim?.name || ""}（${outline.victim?.identity || ""}${outline.victim?.gender ? "，" + outline.victim.gender : ""}）死于 ${outline.victim?.causeOfDeath || ""}，地点：${outline.victim?.deathPlace || ""}`);

  // 核心诡计说明书（灵魂，先行）
  const ts = outline.trickSpec || {};
  if (includeTruth) {
    L.push(`### 核心诡计说明书（灵魂 — 所有角色剧本/线索/DM手册必须围绕并服务于它）
- 诡计：${ts.trick || outline.coreTrick || ""}
- 类型：${ts.type || ""}
- 运作原理：${ts.mechanism || ""}
- 隐藏方式：${ts.conceal || ""}
- 暴露破绽方向：${ts.breakPoint || ""}`);
  } else {
    L.push(`### 核心诡计\n本剧本含一个核心诡计，其**运作原理、隐藏方式与破绽方向由 DM 掌握**。你的角色不知道真相，只需按自己的视角如实书写所见所闻——不要试图猜测或写出诡计原理。`);
  }

  // 人物：逐人一行并带上"性格语气/个人任务"。
  // 为什么在这里渲染：assembleScript 会把设定集整段写进最终剧本，
  // script-parser 再从剧本里把这两个字段解析回结构化数据 ——
  // 这是 personality/goal 从大纲走到运行时的唯一通路（否则它们会像以前一样丢失）。
  const personLine = (p) => {
    const bits = [`**${p.name}**`];
    const who = [p.gender, p.identity].filter(Boolean).join("，");
    if (who) bits.push(who);
    if (p.personality) bits.push(`性格语气：${p.personality}`);
    if (p.goal) bits.push(`个人任务：${p.goal}`);
    if (includeTruth && p.isMurderer) bits.push("【凶手】");   // 角色版不得标出谁是凶手
    return `- ${bits.join(" ｜ ")}`;
  };
  L.push(`### 人物\n玩家：\n${(outline.players || []).map(personLine).join("\n")}`);
  if ((outline.npcs || []).length) L.push(`NPC：\n${(outline.npcs || []).map(personLine).join("\n")}`);

  // 人物关系网（每对都有纠葛，保证无边缘角色）
  if ((outline.relations || []).length) {
    L.push(`### 人物关系网（所有角色对已锁定 — 各角色剧本/线索必须体现这些纠葛）
${outline.relations.map(r => `- ${r.a} ↔ ${r.b}：表面 ${r.link || ""}；纠葛 ${r.tension || ""}`).join("\n")}`);
  }

  if (includeTruth) {
    L.push(`### 凶手\n${outline.murderer?.name || ""}，动机：${outline.murderer?.motive || ""}，手法：${outline.murderer?.method || ""}`);
    // 凶手双时间线：真实 / 伪装
    if (outline.murderer?.realLine) L.push(`### 凶手真实时间线（DM掌握真相）\n${outline.murderer.realLine}`);
    if (outline.murderer?.fakeLine) L.push(`### 凶手伪装时间线（对外谎言，需能被1-2条线索戳破）\n${outline.murderer.fakeLine}`);
  } else {
    L.push(`### 凶手\n（本节由 DM 掌握，不向角色公开。）真凶就在上面的玩家/NPC 名单之中，但**具体是谁、动机为何、如何下手，你的角色并不知道**——不要猜测、不要写出真相，只需如实书写你自己的所见所为。`);
  }
  // ===== 权威事实（story-bible）：公开的给所有角色，含秘密的只给 DM/审查 =====
  // 为什么要渲染进设定集：这些是"所有相关方都必须读到"的全局唯一事实。
  // 以前 publicEvents/objectStates 只以"锚点"形式零散注入，各角色看不到全貌，
  // 于是同一个人的同一趟走动被写成不同时刻（实测多次）。
  const vl = outline.victimLine || {};
  if (vl.deathTime || vl.lastSeen) {
    L.push(`### 死者最后行踪与身亡时刻（硬锚点 — 此后死者不得再有任何活动）
- 身亡时刻：${vl.deathTime || "（大纲未给，必须以线索中的法医/记录判定为准）"}
- 身亡地点：${vl.deathPlace || outline.victim?.deathPlace || ""}
- 最后一次被见到：${vl.lastSeen || ""}${(vl.confirmedBy || []).length ? `（${vl.confirmedBy.join("、")}）` : ""}`);
  }
  if ((outline.objectStates || []).length) {
    L.push(`### 关键物件状态（公共可观察事实 — 同一时刻只有一种状态，所有角色必须一致）
${outline.objectStates.map(o => `- ${o.at}　${o.object}：${o.state}${(o.witnesses || []).length ? `（${o.witnesses.join("、")}可见）` : ""}`).join("\n")}`);
  }
  if ((outline.publicEvents || []).length) {
    L.push(`### 角色级公开行踪（谁都能看到的公共事实 — 各角色剧本必须与之逐条一致）
${outline.publicEvents.map(e => `- ${e.time}　${e.actor} 在「${e.place}」：${e.doing}${(e.who || []).length ? `（在场：${e.who.join("、")}）` : ""}`).join("\n")}`);
  }
  if (includeTruth) {
    if ((outline.knowledgeMap || []).length) {
      L.push(`### 谁知道什么、何时知道（审查用 — 角色不得提前知道）
${outline.knowledgeMap.map(k => `- ${k.who} 自 ${k.since} 起知道：${k.knows}${k.source ? `（来源：${k.source}）` : ""}`).join("\n")}`);
    }
    if ((outline.cluePlan || []).length) {
      // ⚠️ 空字段绝不能渲染成字面 undefined（实测 DM 手册里出现"undefined： 于  在「门卫室」发现"，
      // 被交叉校验当成"悬空线索"报了出来）。缺失就写"待定"，且整条至少要有发现者或地点才有意义。
      const planLines = (outline.cluePlan || []).map((c) => {
        const who = String(c.discoverer || "").trim() || "待定";
        const at = String(c.time || "").trim() || "待定";
        const where = String(c.place || "").trim() || "待定";
        // ⚠️ clueId 也要兜底：alignCluePlan 产出的是 id，渲染读 clueId → 曾渲染出字面 undefined（被交叉校验抓出）\n        const cid = String(c.clueId || c.id || "").trim() || "线索";\n        return `- ${cid}：${who} 于 ${at} 在「${where}」发现${c.about ? `（指向：${c.about}）` : ""}`;
      });
      L.push(`### 线索发现计划（谁/何时/何地发现 — 线索表必须与之一致）\n${planLines.join("\n")}`);
    }
  }

  L.push(`### 时间线骨架\n${(outline.timeline || []).map(t => `${t.time} ${t.desc}`).join("；") || ""}`);
  return L.join("\n");
}

// ==================== 权威时间轴（时间基准统一） ====================

/**
 * 从核心诡计说明书解析公共时钟相对真实时间的偏移（分钟）。
 * @returns {{offsetMin:number, slow:boolean}|null}
 */
function parseTimeOffset(outline) {
  const ts = (outline && outline.trickSpec) || {};
  const text = [ts.trick, ts.type, ts.mechanism, ts.conceal, outline && outline.coreTrick].filter(Boolean).join(" ");
  if (!text) return null;
  const m = text.match(/(拨快|调快|拨慢|调慢|提前|延后|快|慢)[^。；，,\n]{0,12}?(\d{1,3})\s*分钟/)
    || text.match(/(\d{1,3})\s*分钟[^。；，,\n]{0,12}?(拨快|调快|拨慢|调慢|提前|延后|快|慢)/);
  if (m) {
    // 方向必须取自"紧邻数字的那个词"，不能扫全文——
    // 实测大纲里 type 写"钟表调慢"而 mechanism 写"调快约15分钟"，扫全文会把方向判反。
    const kw = m[1] || m[2] || "";
    const slow = /(慢|延后)/.test(kw);
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n > 0 && n <= 12 * 60) return { offsetMin: n, slow };
  }
  const m2 = text.match(/(\d{1,3})\s*分钟(?:的)?(?:时差|时间差)/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    // 仅有"时差"未指明方向时：无"快"且有"慢"才判为慢，否则默认快
    if (Number.isFinite(n) && n > 0 && n <= 12 * 60) return { offsetMin: n, slow: !/快/.test(text) && /慢/.test(text) };
  }
  return null;
}

/** 把 "HH:MM" 或 "HH:MM-HH:MM" 按偏移量平移；无法解析返回 null */
function shiftClock(timeStr, deltaMin) {
  const one = (s) => {
    const m = String(s).trim().match(/^(\d{1,2})\s*[:：]\s*(\d{2})$/);
    if (!m) return null;
    let total = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + deltaMin) % (24 * 60);
    if (total < 0) total += 24 * 60;
    return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
  };
  const parts = String(timeStr).split(/\s*[-–—~至]\s*/);
  if (parts.length === 2) {
    const a = one(parts[0]), b = one(parts[1]);
    if (a && b) return `${a}-${b}`;
  }
  return one(String(timeStr)) || null;
}

/** 从大纲中提取唯一的案发日期（如"4月12日"）；无、或有多个不一致时返回 null */
function parseCaseDate(outline) {
  if (!outline) return null;
  // ① 优先读大纲的**显式字段** caseDate —— 这是权威且唯一的来源。
  //    为什么加这一条（实测根因）：此前只能从故事背景/时间线描述里"扫"日期，扫不到就返回 null；
  //    而 null 会让每个角色收到"本案未设定绝对日期，严禁自创月份与日期"——该禁令**挡不住自创**：
  //    1975 西安·俑坑案那轮 6 个角色编出 4 套日期（4月16日／6月14日／十月十六日…），
  //    最后靠 76 条 LLM 补丁才统一。**日期是"全局唯一事实"，必须钉在源头，不能靠事后禁令。**
  const explicit = String(outline.caseDate || "").trim().replace(/\s+/g, "");
  if (explicit) {
    if (parseDateLabel(explicit)) return explicit;
    // 实测（1988 武汉·棉纺厂）：模型给的是**跨午夜区间**「5月17日夜至5月18日晨」——
    // 对"夜里发案、凌晨发现"的案件这比单日更准确，不该被判非法。取**第一段**作为案发当日
    // （夜从当日傍晚开始，次日凌晨由 nextDayLabel 负责，与既有跨午夜机制一致）。
    const first = explicit.match(/\d{1,2}月\d{1,2}日/)
      || explicit.match(/[〇零一二三四五六七八九十廿卅初]{1,3}月[〇零一二三四五六七八九十廿卅初]{1,4}日?/);
    if (first && parseDateLabel(first[0])) return first[0];
  }
  // ② 兜底：仍支持从大纲文本里扫出唯一日期（旧产物/模型漏给字段时）
  const text = [
    outline.storyBackground,
    outline.coreTrick,
    ...(outline.timeline || []).map(t => t && t.desc),
  ].filter(Boolean).join(" ");
  const hits = [...new Set(text.match(/\d{1,2}月\d{1,2}日/g) || [])];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 权威时间轴：把大纲的时间线骨架（真实时间）按诡计偏移展开成「真实 ↔ 座钟」对照表。
 * 历史缺陷：各角色各自推算、且大半不标注基准，同一个数字在不同角色嘴里代表不同真实时刻，
 * 导致核心破绽（某人以真实时间为准的目击 vs 凶手以座钟时间为准的说辞）无法被读懂。
 * 该文本注入所有角色 prompt，保证所有角色取同一张表的值。
 */
// hmOf / minutesOf 已移到 ./timeline-utils（与 story-bible 共用同一份实现）

/**
 * 找出「时钟被动动手脚」的时刻，也就是时间轴上的**状态转折点**。
 *
 * 为什么必须有它：改造前的权威时间轴把偏差描述成**恒定状态**
 * （"座钟比真实时间快 45 分钟：座钟时间 = 真实时间 + 45 分钟"），
 * 却从不说座钟是几时被动的手脚。角色写 18:30 的场景时照着这条规则写出
 * "18:30，座钟显示七点一刻（快45分钟）"——**完全符合时间轴，却与诡计直接冲突**
 * （拨钟在 20:10）。实测三次端到端的交叉校验里，"座钟拨快时刻矛盾"每一轮都出现。
 *
 * 判定顺序：① 诡计文本里**紧邻**动手动词的那个时刻；② 大纲时间线里描述拨钟的那一条。
 * 都找不到就返回 null，时间轴退回改造前的行为（宁可不说，不可说错）。
 */
function findTamperMoment(outline) {
  const ts = (outline && outline.trickSpec) || {};
  const texts = [ts.mechanism, ts.trick, ts.conceal, outline && outline.coreTrick]
    .map((t) => String(t || "")).filter(Boolean);

  // 为什么用模式而不是"离动词最近的时刻"：距离分不清**动作发生的时刻**与**被引用的读数**。
  // 实测大纲写"凶手提前将大厅的落地座钟调快约15分钟。当座钟显示21:30（晚餐结束）时，
  // 真实时间仅21:15。"——离"调快"最近的时刻是 21:30，但那是"座钟显示"的**读数**，
  // 不是拨钟时刻（真值是时间线里的 19:45）。只按距离取最近会稳定取错。
  const TIME = "(\\d{1,2})[:：](\\d{2})";
  const VERB = "(?:拨快|拨慢|回调|调快|调慢|上弦|拨钟|动钟|拨动)";
  // 读数的标志词：紧跟其后的时刻是"表盘显示"，不是"某人动手"
  const READING = "(?:显示|指着|指向|读到|读数|停在|指向)";

  const pick = (re, s) => {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (!m) return null;
    const hh = String(parseInt(m[1], 10)).padStart(2, "0");
    return `${hh}:${m[2]}`;
  };

  // 模式 A：时刻紧邻动词 —— "在20:10拨快"、"20:10拨快"、"20:10 左右拨慢"
  const reA = new RegExp(`${TIME}\\s*(?:时|左右|前后)?\\s*[^。；\\n]{0,4}?${VERB}`, "g");
  // 模式 B：动词在前，动作发生的时刻在后 —— "拨快大厅座钟的动作发生在20:10"
  const reB = new RegExp(`${VERB}[^。；\\n]{0,24}?(?:发生在|是在|发生于|在)\\s*(?:当日|当晚|案发当日)?\\s*${TIME}`, "g");
  // 反向排除：显式的"表盘读数"句式
  const reReading = new RegExp(`${READING}\\s*(?:着|为|是)?\\s*${TIME}`, "g");

  const readings = new Set();
  for (const s of texts) {
    reReading.lastIndex = 0;
    let m;
    while ((m = reReading.exec(s))) readings.add(`${String(parseInt(m[1], 10)).padStart(2, "0")}:${m[2]}`);
  }

  for (const re of [reA, reB]) {
    for (const s of texts) {
      const hit = pick(re, s);
      if (hit && !readings.has(hit)) return hit;
    }
  }

  // 回退：大纲时间线里描述拨钟的那一条
  for (const r of (outline && outline.timeline) || []) {
    const d = String((r && r.desc) || "");
    if (/(拨快|拨慢|回调|调快|调慢|撬开|动过|改过|上弦|拨钟)/.test(d)) {
      const hm = hmOf(r.time); if (hm) return hm;
    }
  }
  return null;
}

function buildTimeAxis(outline) {
  const off = parseTimeOffset(outline);
  if (!off) return "";
  const delta = off.slow ? -off.offsetMin : off.offsetMin;
  const L = [];
  L.push("## 权威时间轴（最高优先级 — 所有角色的时间线必须严格以此为准，禁止自行推算或改动）");
  // ⚠️ 措辞要点（实测教训）：分段模型必须是**头条第一条**，不能写成"对恒定偏差的补充例外"。
  // 第一版把恒定公式放第一条并加粗、分段说明放后面当例外，结果角色仍然锚定恒定公式：
  // 复验里真凶写"17:40 时钟已慢一刻钟"、两名角色从 20:00 起按"慢35分钟"记录，
  // 全都早于 20:50 的拨钟时刻——权威声明是对的，却被后排的例外句式压过去了。
  const tamperAt = findTamperMoment(outline);
  if (tamperAt) {
    L.push(`- ⚠️ **关键：大厅座钟是在 ${tamperAt} 才被人动过，偏差不是全天都存在的。必须分两段理解：**`);
    L.push(`  - **${tamperAt} 之前（含此前的一切时段）**：座钟走时正常，**座钟时间 = 真实时间，没有任何偏差**。写这个时段的场景时，**绝对不得**写"座钟快了/慢了 N 分钟"、不得让角色"发现座钟不准"，也不得出现拨动/撬动的痕迹、新划痕、工具痕迹——**那些痕迹在动手之前还不存在**。`);
    L.push(`  - **${tamperAt} 及之后**：座钟比真实时间${off.slow ? "慢" : "快"} ${off.offsetMin} 分钟：**座钟时间 = 真实时间${delta > 0 ? " + " : " − "}${off.offsetMin} 分钟**。`);
    // 给一张"照抄即可"的读数示例：光有规则没有样例时，模型仍会按恒定偏差自行推算。
    const tMin = minutesOf(tamperAt);
    if (tMin !== null) {
      const fmt = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      const demo = [[Math.max(0, tMin - 150), "拨钟前"], [Math.max(0, tMin - 20), "拨钟前"], [tMin + 15, "拨钟后"], [tMin + 90, "拨钟后"]];
      L.push("");
      L.push("- 读数示例（照此口径写，不要自行换算）：");
      L.push("");
      L.push("  | 真实时间 | 座钟显示 | 所处时段 |");
      L.push("  |---|---|---|");
      for (const [min, seg] of demo) {
        const realHm = fmt(min);
        const shown = seg === "拨钟前" ? realHm : (shiftClock(realHm, delta) || "—");
        L.push(`  | ${realHm} | ${shown} | ${seg} |`);
      }
    }
  } else {
    L.push(`- 案发当日，公共时钟（大厅座钟）比真实时间${off.slow ? "慢" : "快"} ${off.offsetMin} 分钟：**座钟时间 = 真实时间${delta > 0 ? " + " : " − "}${off.offsetMin} 分钟**。`);
  }
  L.push("- **每条时间线条目都必须标注时间来源**，格式：`【座钟】21:30` 或 `【真实】21:15`；两者都清楚时写 `【真实】21:15（座钟21:30）`。禁止写不带来源的裸时间。");
  L.push("- 角色只能引用自己**当时实际可能看到的时间源**：普通人只看到座钟（写【座钟】）；持有怀表/手表者可看到真实时间（写【真实】）；凶手两者都知道。");
  L.push("- 下方对照表为 DM 权威，角色剧本中的同一事件必须与之吻合；若你扮演的角色当时不可能知道该换算，就只写自己看到的那一侧。");
  // 日期基准：实测不约束时，各角色会各自编出互相冲突的日期
  // （出现过 4月12日／10月18日／6月18日／11月4日 四个日期并存），而逐句补丁式修订修不了这类全局问题。
  const caseDate = parseCaseDate(outline);
  if (caseDate) {
    L.push(`- **案发日期统一为「${caseDate}」**：所有角色的时间线必须使用该日期，禁止自创其它月份/日期。`);
  } else {
    L.push("- **本案未设定绝对日期**：所有角色的时间线一律使用相对日期表述（`案发前一日` / `案发当日`），**严禁自创月份与日期**（同一剧本内出现多个不同日期属于重大逻辑漏洞）。");
  }
  const tamperMin = minutesOf(tamperAt);
  const rows = (outline.timeline || []).map(t => {
    const tMin = minutesOf(t.time);
    // 拨动之前：座钟读数与真实时间一致（**不是** +offset）。
    // 改造前这里一律套用偏差，等于用一张权威表教角色把拨钟前的场景写错。
    let isBefore = false;
    if (tamperMin !== null && tMin !== null) {
      const diff = tamperMin - tMin;
      isBefore = diff > 0 && diff <= 12 * 60;  // 只按同一天算；跨过午夜的不算"拨动前"
    }
    const clock = isBefore
      ? `${hmOf(t.time) || String(t.time).trim()}（与真实一致）`
      : (shiftClock(t.time, delta) || "—");
    return `| ${t.time} | ${clock} | ${String(t.desc || "").replace(/\|/g, "/").slice(0, 60)} |`;
  });
  if (rows.length) {
    L.push("");
    L.push("| 真实时间 | 座钟显示 | 事件（DM 权威） |");
    L.push("|---|---|---|");
    L.push(...rows);
  }
  return L.join("\n");
}

/**
 * 诡计可观测性校验：任何诡计都必须留下「可被玩家实际获取」的锚点，否则玩家只能靠猜人。
 *
 * 改造前只对时间类诡计检查（实测《钟楼诡影》：全案只有一口被拨快的座钟，花园那口是停摆的，
 * 唯一能测出时差的怀表没有线索卡 → 核心诡计在物证上不可观测）。
 * 现在推广到全部诡计：密室/身份诡计同样可能"手法物理可行、物证上却不可观测"。
 * 时钟特有两项要求保留（涉及时钟时才查）。
 */
function checkTrickObservability(report, outline, fullScript) {
  const clues = String((report && report.clues) || "");
  const text = clues + "\n" + String(fullScript || "");
  const hasTrick = !!(outline && (outline.murderer?.method || outline.trickSpec?.mechanism || outline.coreTrick));
  if (!hasTrick) return { needed: false, ok: true };

  // 通用锚点：玩家伸手能拿到的物证/记录/证词。只要线索体系里有任意一条像样的物证痕迹，
  // 手法就是可被逐步证伪的（具体"手法的哪个动作被证伪"由诡计阶段的 proofChain 事前把关）。
  const hasAnchor =
    /痕迹|印记|压痕|划痕|抓痕|擦痕|指印|指纹|脚印|血迹|残留|污渍|油渍|水渍|裂口|磨损|字迹|笔迹|签名|印章|账本|账簿|单据|回执|登记|名册|日记|信件|便签|字条|手帕|衣物|工具|钥匙|锁孔|插销|茶杯|药瓶|毒物|残渣|证词|证言|口供|供述|陈述|目击|听见|看见/.test(text);

  // 时钟特有两项（仅涉及时钟时要求）
  const clockNeeded = !!buildTimeAxis(outline);
  // 独立时间源：某人的怀表/手表读数，或对死亡时间的客观判定
  const hasIndependent = /怀表|手表|腕表|秒表|挂表|死亡时间|尸温|尸僵|时间戳|报时|标准时间|对表/.test(text);
  // 公共时钟本身的异常 / 被动手脚的证据。
  // ⚠️ 钟的名词必须宽松匹配：实测剧本通篇用"落地钟"，而早期实现只列了
  // 座钟|时钟|挂钟|铜钟，导致明明有撬痕/钥匙线索却报"缺少时钟异常线索"（假阴性）。
  // 用 (?<!分) 排除"分钟"，避免把任意"分钟…慢"当成时钟异常。
  const hasClockAnomaly =
    /(?<!分)钟[^。\n]{0,40}(拨|调|不准|走时|机芯|痕迹|齿轮|撬|后盖|底座|对不上|不一致|动过|快|慢)/.test(text) ||
    /(拨|调|撬|动过|改过)[^。\n]{0,20}(?<!分)钟/.test(text);

  const ok = hasAnchor && (!clockNeeded || (hasIndependent && hasClockAnomaly));
  return { needed: true, clockNeeded, hasAnchor, hasIndependent, hasClockAnomaly, ok };
}

/** 时代→载体黑名单（防"民国本子写出联网日志"这类穿越）。
 *  只对明确的前现代时代检查；架空/现代/未来不设限（误伤成本 > 收益）。
 *
 *  ⚠️ 刻意只收**二十世纪后期才可能出现**的载体，两档用同一张表。
 *  早期版本让「古代」档额外禁止 电报/报纸/火车/轮船/电话/汽车/指纹，这是错的：
 *  清末（光绪/宣统）已被 detectEra 归入「古代」，而这些东西在晚清**真实存在**
 *  （电报局、申报、淞沪铁路、轮船招商局），照那条规则会把正确内容改坏。
 *  要区分"唐宋"还是"晚清"需要更细的时代判定，在拿到可靠依据之前，宁可漏报不可误伤。 */
const MODERN_CARRIER_RE = /摄像头|监控(?:录像|探头|画面|中)?|联网日志|微信|短信|二维码|GPS|DNA|身份证|行程码|人脸识别|WiFi|WIFI|蓝牙|服务器日志|云端|小程序|手机号码|手机信号/;
const ERA_CARRIERS = {
  民国: MODERN_CARRIER_RE,
  古代: MODERN_CARRIER_RE,
};

/** 从时代文本推断时代档位（民国/古代/其他） */
function detectEra(text) {
  const t = String(text || "");
  if (/民国|191\d|192\d|193\d|194\d|宣统|民国初|民初/.test(t)) return "民国";
  if (/唐代|宋代|明代|清代|元代|秦|汉代|三国|晋朝|先秦|古代|光绪|宣统年间|宣统二年|道光|乾隆|嘉庆|雍正|康熙|同治/.test(t)) return "古代";
  return null;
}

/** 时代载体检查：列出线索文本里不属于该时代的载体词。纯函数，供测试。 */
function checkEraCarriers(eraLabel, cluesText) {
  const era = String(eraLabel || "").trim();
  if (!ERA_CARRIERS[era]) return { era, needed: false, offenders: [] };
  const text = String(cluesText || "");
  const offenders = [];
  const seen = new Set();
  let m;
  const re = new RegExp(ERA_CARRIERS[era].source, "g");
  while ((m = re.exec(text))) {
    if (!seen.has(m[0])) { seen.add(m[0]); offenders.push(m[0]); }
  }
  return { era, needed: true, offenders };
}

/**
 * 第一轮线索是否**在指控**真凶（而非仅仅提到他）。
 *
 * ⚠️ 这是第五次"规则比事实更绝对"的教训（详见 8.3.1 / 8.7 / 8.11.1）：
 * 原来的判据是"第一轮线索里出现真凶姓名即违规"，每一轮端到端都触发匿名化改写，
 * 但把产物抽出来逐条看，被点名的其实是**正当的 PVP 内容**：
 *   - 「赵铁成证词（公开陈述）」——凶手自己的公开说辞，人人都知道；
 *   - 「签到簿：…赵铁成19:40（事由栏写巡检）」——客观文档列了所有人的名字；
 *   - 「登记簿显示…借阅人签名栏签有"赵铁成"三字」——同上。
 * PVP 剧本里所有人互为嫌疑人，"目击某某出现在某处""某人的档案"本来就是核心玩法材料。
 * 真正破坏两轮制的是**结论性指控**（"凶手是X""X杀害了死者"），不是提及。
 *
 * 所以判据改为：**结论性指控才算违规**——
 *   "凶手/真凶…是X"、"X…就是凶手"、"X…杀害/勒死/毒死…"、"这说明凶手是X"。
 * 纯提及（证词、文档、目击）不判。
 */
function nameAccuses(text, name) {
  if (!name) return false;
  const n = escapeRe(name);
  const t = String(text || "");
  // "凶手是X / 真凶即X / 凶手就是X"
  if (new RegExp(`(凶手|真凶|凶犯|杀人者|行凶者|害人者)[^。；\\n]{0,10}(是|即|就是|乃是|便)\\s*${n}`).test(t)) return true;
  // "X就是凶手 / X乃真凶 / X是真正的凶手"
  if (new RegExp(`${n}[^。；\\n]{0,10}(就是|乃是|乃|即|是真正的|是\\s*(?:真正的)?)\\s*(凶手|真凶|凶犯)`).test(t)) return true;
  // "X杀害了死者 / X勒死了他"
  if (new RegExp(`${n}[^。；\\n]{0,8}(杀害|害死|勒死|毒死|刺死|打死|淹死|捂死|掐死)`).test(t)) return true;
  // "这说明/这证明/由此可见…凶手是X"
  if (new RegExp(`(这说明|这证明|由此可见|显然|不难看出)[^。；\\n]{0,14}${n}`).test(t) && /(凶手|真凶|凶犯)/.test(t)) return true;
  return false;
}

/**
 * 轮次解锁检查（借鉴"最低解锁=可指控 / 完整解锁=无法抵赖"）：
 * ① 第一轮线索不得**指控**真凶（纯提及不算——见 nameAccuses 注释）；
 * ② 第二轮必须有可定案的锚点（独立时间源/物证类）。
 * ① 的修复走 repairClueTexts 就地改写。
 *
 * ⚠️ 只检查**第一轮区间内**的线索块：第二轮本来就该能定案点名，
 * 把第二轮也算作违规会白白削掉定案证据（实测踩过：改写混进了 B 打头的第二轮线索）。
 */
function checkRoundUnlock(cluesText, murdererName) {
  const text = String(cluesText || "");
  const r1m = /^##\s*第[一二12]轮[^\n]*$/m.exec(text);
  const r2m = /^##\s*第[二三23]轮[^\n]*$/m.exec(text);
  const r1 = r1m ? text.slice(0, r2m ? r2m.index : text.length) : text;
  const r2 = r2m ? text.slice(r2m.index) : "";
  const name = String(murdererName || "").trim();
  // 第一轮里**指控**真凶的线索块（id + 正文），供就地匿名化使用；纯提及不判
  const r1Blocks = name ? extractClueBlocks(r1).filter((b) => nameAccuses(b.body, name)) : [];
  const r1NamesMurderer = r1Blocks.length ? name : "";
  // 第二轮的定案锚点（与可观测性同源的独立时间源词表 + 决定性物证词）
  const r2HasAnchor = /怀表|手表|腕表|秒表|挂表|死亡时间|尸温|尸僵|时间戳|验尸|尸检|毒理|化验|检验|血迹|指纹|脚印|钥匙|锁|撬|残留/.test(r2);
  return { r1NamesMurderer, r1Blocks, r2HasAnchor, ok: !r1NamesMurderer && r2HasAnchor };
}

/**
 * 原地替换某条线索块（保留 ### Bn：编号），供"就地改写违规线索"使用。
 * 返回替换后的全文；找不到该线索或新正文为空时返回 null（调用方保持原文）。
 */
function replaceClueBlock(cluesText, id, newBody) {
  const text = String(cluesText || "");
  const startRe = new RegExp(`^###\\s+${String(id || "").replace(/[^\w]/g, "")}[：:]`, "m");
  const m = startRe.exec(text);
  if (!m) return null;
  const start = m.index;
  const nextRe = /^###\s+[A-CM]\d+[：:]/gm;
  nextRe.lastIndex = start + 1;
  const next = nextRe.exec(text);
  const end = next ? next.index : text.length;
  const body = String(newBody || "").replace(/^#{2,4}\s*[^\n]*\n?/, "").trim();
  if (!body) return null;
  return text.slice(0, start) + `### ${id}：\n${body}\n` + text.slice(end);
}

/** 从线索全文里提取全部线索块：[{ id, body }]（供改写类修复定位目标） */
function extractClueBlocks(cluesText) {
  const text = String(cluesText || "");
  // ⚠️ 结尾断言要用 (?![\s\S])（"后面没有任何字符"），不是 Python 的 \Z——
  // JS 里 \Z 只是字面量 'Z'，会让最后一条块永远匹配不上（实测踩过）。
  const re = /^###\s+([A-CM]\d+)[：:][^\n]*\n([\s\S]*?)(?=^###\s+[A-CM]\d+[：:]|(?![\s\S]))/gm;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], body: m[2].trim() });
  return out;
}

/**
 * 定向补写缺失的可观测性线索（缺陷分级里的"可局部补丁"一档）。
 *
 * 为什么不是重跑线索阶段：缺的只是 1-2 条锚点线索，而线索阶段一次产出 40-50 条，
 * 重跑等于把已经合格的内容全部作废重建，既贵又可能引入新的不一致。
 *
 * 插入位置很关键：必须落进「第二轮线索」区间（核心推理线索本属第二轮），
 * 否则 script-parser 分配不到轮次，这条线索在游戏里根本不会发出来。
 *
 * @returns {Promise<string|null>} 补写后的完整线索文本；补写失败返回 null（调用方保持原文）
 */
async function repairCluesObservability(report, missing, layoutPlaces, onProgress) {
  const cluesText = String((report && report.clues) || "");
  if (!missing || !missing.length) return null;

  const startId = nextClueId(cluesText, "B");
  const places = Array.isArray(layoutPlaces) && layoutPlaces.length
    ? layoutPlaces.join("、")
    : "（无明确布局清单，请用剧情中已出现的场所，禁止编造新地点）";
  const trick = report && report.trickDesign ? report.trickDesign : null;
  const trickHint = trick
    ? `\n## 本剧核心诡计（补写的线索必须直接服务于它，不得另立设定）\n- 类型：${trick.type || ""}\n- 核心：${trick.coreTrick || ""}\n- 机制：${trick.mechanism || ""}`
    : "";

  const system = `你是剧本杀线索设计专家。现在只补写**缺失的少数几条线索**，用于让核心诡计在物证上可被玩家证明。
不要重写、不要复述已有线索，不要输出任何解释或总结。`;

  const user = `现有线索系统缺少以下要素：
${missing.map((m) => "- " + m).join("\n")}

请针对每一条缺失要素补写 1 条线索，共 ${missing.length} 条。
${trickHint}

## 输出格式（严格遵守，标题固定写 "### 新线索"，不要自己编号）
### 新线索
- 线索类型：物证
- 发现地点：（从下方地点清单中选，或写人物名/证词）
- 线索内容：（客观描述，必须写清具体读数、痕迹或原话）

## 允许的发现地点
${places}

## 硬性要求
- 线索内容**只写客观事实**：读数（如"怀表指针停在21:15"）、痕迹（如"机芯调速螺母有新鲜扳手压痕"）、别人的原话。
- **禁止结论句**：不得出现"这证明了…""说明钟被拨快""凶手就是…"。推断必须留给玩家。
- **禁止用停摆的钟充当时间基准**：停摆的钟只能说明它停在哪一刻，不能证明公共时钟快/慢。
- 每条都要能被玩家实际搜到。

只输出线索块，不要其他内容。`;

  const result = await runStage("诡计可观测性补写", () => generate(system, user, { maxTokens: 3000, temperature: 0.5 }), onProgress);
  let raw = String((result && result.content) || "").trim();
  if (!raw && result && result.reasoningContent) raw = String(result.reasoningContent).trim();

  const blocks = normalizeClueBlocks(raw, startId, "B");
  if (!blocks.length) {
    console.warn("[builder] 可观测性补写未产出可用线索块");
    return null;
  }
  const merged = insertCluesIntoRound2(cluesText, blocks);
  if (merged === cluesText) {
    console.warn("[builder] 可观测性补写：插入未改变文本，已放弃");
    return null;
  }
  console.log(`[builder] 可观测性补写：新增 ${blocks.length} 条线索（${blocks.map(b => b.split("\n")[0]).join(" ")}）`);
  return merged;
}

/**
 * 就地改写若干条违规线索（保留编号与轮次），"局部补丁"级修复。
 *
 * 与 repairCluesObservability 的区别：那个是**新增**线索（锚点缺失），这个是**改写**既有线索
 * （措辞违规：时代穿越词、第一轮点名真凶）。就地改写不会改变线索总数与轮次分配，
 * 也不会让 split/review 读到编号断裂的线索。
 *
 * @param {object} report - 含 report.clues
 * @param {Array<{id: string, body: string}>} targets - extractClueBlocks 的结果
 * @param {string} ruleText - 说清违反了什么规则、该怎么改
 * @returns {Promise<string|null>} 改写后的全文；失败返回 null（调用方保持原文）
 */
async function repairClueTexts(report, targets, ruleText, onProgress, label) {
  const cluesText = String((report && report.clues) || "");
  if (!targets || !targets.length) return null;

  const system = `你是剧本杀线索编辑。只改写给定的几条线索，不要新增、不要复述、不要输出任何解释。保持线索的客观描述风格（只写读数/痕迹/原话，禁止结论句）。`;

  const user = `## 必须遵守的修改规则
${ruleText}

## 待改写线索（共 ${targets.length} 条，逐条改写）
${targets.map((t, i) => `### 待改写${i + 1}\n${t.body}`).join("\n\n")}

## 输出格式（按同样顺序输出 ${targets.length} 条，标题固定写 "### 重写"）
### 重写
- 线索类型：（保持原类型）
- 发现地点：（保持原地点）
- 线索内容：（改写后的内容）

只输出这 ${targets.length} 个线索块。`;

  const result = await runStage(label || "线索改写", () => generate(system, user, { maxTokens: 3000, temperature: 0.5 }), onProgress);
  let raw = String((result && result.content) || "").trim();
  if (!raw && result && result.reasoningContent) raw = String(result.reasoningContent).trim();
  if (!raw) return null;

  const bodies = raw
    .split(/\n(?=#{2,4}\s*重写)/)
    .map((s) => s.replace(/^#{2,4}\s*重写[^\n]*\n?/, "").trim())
    .filter((s) => /线索内容/.test(s));
  if (!bodies.length) {
    console.warn(`[builder] ${label || "线索改写"}：未产出可用的改写块`);
    return null;
  }

  let merged = cluesText;
  const used = Math.min(bodies.length, targets.length);
  for (let i = 0; i < used; i++) {
    const next = replaceClueBlock(merged, targets[i].id, bodies[i]);
    if (next) merged = next;
  }
  if (merged === cluesText) {
    console.warn(`[builder] ${label || "线索改写"}：替换未改变文本，已放弃`);
    return null;
  }
  console.log(`[builder] ${label || "线索改写"}：就地改写 ${used}/${targets.length} 条（${targets.slice(0, used).map((t) => t.id).join(" ")}）`);
  return merged;
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
另外必须逐条检查下面四类问题（有则报出，并给出具体改法）：
1) **时辰↔24小时换算**：子23-01｜丑01-03｜寅03-05｜卯05-07｜辰07-09｜巳09-11｜午11-13｜未13-15｜申15-17｜酉17-19｜戌19-21｜亥21-23；一个时辰 8 刻、每刻 15 分钟，从时辰起始算（午时三刻=11:45、酉时四刻=18:00、戌时三刻=19:45、亥时三刻=21:45）。凡"时辰词（约HH:MM）"对不上的一律报出。
2) **检验与结论不匹配**：不得用只对某类毒有效的检验（如银针只对硫化物/砒霜显色）去"排除"其它类毒物，也不得把它当作"无毒"的充分证据 —— 排除必须靠药性/剂量/验尸结论等真正对症的依据。
3) **上帝时间线条目缺主语**：只写动作、不写是谁做的（"20:30 借添酒之名在温酒壶中下巴豆"）必须补上角色名。
4) **悬空线索**：线索指向的人/影/物在全剧中从未被解释（如"亥时初见一条黑影走向寝居"却无人认领、无交代）必须补解释或改写。

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
  // ⚠️ 解析失败**必须与"没有问题"区分开**（实测踩过）：原来写成 `extractJsonStrict(...) || {}`，
  // 解析失败就得到一个空对象 → issues=[] → 对外表现为"校验通过、零问题"，
  // 而实际上**这次校验根本没结论**。后果是双向的：调用方会以为剧本干净、
  // 复检拿到空清单还会**静默跳过后续修订**。
  // 现在的顺序是：正常解析 → **输出被截断时抢救截断前写完的部分**（比重试更便宜，
  // 而截断多半会复现）→ 仍拿不到再重试一次。
  const parseCrossCheck = (content) => {
    const raw = extractJsonStrict(content);
    if (raw && typeof raw === "object") return { data: raw, salvaged: false };
    const salv = repairTruncatedJson(content);
    if (salv && typeof salv === "object") {
      console.warn(`[builder] 交叉校验输出被截断，已从截断处抢救部分结论（${Array.isArray(salv.issues) ? salv.issues.length : 0} 条）`);
      return { data: salv, salvaged: true };
    }
    return null;
  };
  let got = parseCrossCheck(result.content);
  if (!got) {
    console.warn("[builder] 交叉校验输出无法解析为 JSON，重试一次（本次结果不能当作通过）");
    if (onProgress) onProgress("crosscheck", "交叉校验输出无法解析，正在重试...");
    try {
      const retry = await runStage("交叉校验(重试)", () => generate(system, user, { maxTokens: TOKENS_LIGHT, temperature: 0.2 }));
      got = parseCrossCheck(retry.content);
    } catch (e) {
      console.warn("[builder] 交叉校验重试失败:", e.message);
    }
  }
  const data = got ? got.data : null;
  const parsed = !!got;
  const salvaged = got ? got.salvaged : false;
  const issues = parsed && Array.isArray(data.issues) ? data.issues : [];
  if (!parsed) {
    console.warn("[builder] 交叉校验两次都没能解析——本次校验**没有结论**（不等于通过）");
    if (onProgress) onProgress("crosscheck", "交叉校验没有结论（不等于通过），本轮不据此改写");
  }
  // 让结论可见：原实现仅 console.warn，issues 无任何消费方，管理员在界面上完全看不到
  if (onProgress && parsed) {
    // 抢救回来的是**截断前写完的部分**结论：每条都可能是真的，但清单本身不全——必须说出来
    const tail = salvaged ? "（输出被截断，问题清单可能不全）" : "";
    onProgress("crosscheck", issues.length
      ? `交叉校验发现 ${issues.length} 个问题${tail}：${issues.slice(0, 3).join("；")}`
      : `交叉校验未发现问题${tail}`);
  }
  return { issues, ok: parsed ? data.ok !== false : false, parsed, salvaged };
}

/** 从大纲直接取角色列表（人数已被大纲锁定，不再让 LLM 自创） */
function extractCharactersFromOutline(outline, cfg) {
  const chars = [];
  const murdererName = outline.murderer?.name || "";
  const pick = (p) => ({
    personality: String(p.personality || "").trim(),
    goal: String(p.goal || "").trim(),
  });
  for (const p of (outline.players || [])) {
    if (!p.name || String(p.name).trim().length < 2) continue;
    chars.push({
      name: String(p.name).trim(),
      type: "player",
      isMurderer: Boolean(p.isMurderer) || p.name === murdererName,
      occupation: String(p.identity || "").trim(),
      ...pick(p),
    });
  }
  for (const n of (outline.npcs || [])) {
    if (!n.name || String(n.name).trim().length < 2) continue;
    chars.push({
      name: String(n.name).trim(),
      type: "npc",
      isMurderer: Boolean(n.isMurderer) || n.name === murdererName,
      occupation: String(n.identity || "").trim(),
      ...pick(n),
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
        // 模型给的名字可能带说明（"玛格丽特·伦诺克斯（女，28岁）"），先切再判。
        // 旧版是 `name.length <= 8` —— 9 字的真名字会被整条丢掉，
        // 于是"玩家角色数不足"触发重试，整条生成白跑一遍。
        name: cutCharacterName(c.name),
        type: c.type === "npc" ? "npc" : "player",
        isMurderer: Boolean(c.isMurderer),
        occupation: String(c.occupation || "").trim(),
      })).filter(c => isValidCharacterName(c.name));
    }
  } catch (e) {
    console.error("结构化角色提取失败，回退到传统方法：", e.message);
  }

  return extractCharactersFallback(framework, minExpected);
}

function extractCharactersFallback(framework, minExpected) {
  minExpected = minExpected || LIMITS.minPlayers;
  const chars = [];

  // ⚠️ 下面几处旧正则都是 (.{2,6})：长名字会被**截断**成 6 字
  //（"玛格丽特·伦诺克斯" → "玛格丽特·伦"），比整条丢弃更隐蔽 —— 剧本里会多出一个不存在的人。
  // 现在统一放宽捕获、交给 cutCharacterName 切说明文字、再用 isValidCharacterName 判。
  const playerPattern = /(?:玩家\d|玩家[一二三四五六])[：:]\s*(.{1,40})/g;
  let m;
  while ((m = playerPattern.exec(framework)) !== null) {
    const name = cutCharacterName(m[1]);
    if (isValidCharacterName(name) && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "player", isMurderer: false, occupation: "" });
    }
  }

  const npcPattern = /(?:NPC\d|NPC嫌疑人|NPC\s*\d)[：:\s]+(.{1,40})/g;
  while ((m = npcPattern.exec(framework)) !== null) {
    const name = cutCharacterName(m[1]);
    if (isValidCharacterName(name) && !chars.find(c => c.name === name)) {
      chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
    }
  }

  // 补充：从NPC嫌疑人章节提取 - **姓名**：xxx 格式
  const npcSection = (framework.match(/NPC嫌疑人设定[\s\S]*?(?=凶手设定|##\s*[五六七八九]、|重要约束)/) || [])[0] || "";
  if (npcSection && chars.filter(c => c.type === "npc").length === 0) {
    const namePattern = /\*\*姓名\*\*[：:]\s*(.{1,40})/g;
    let nm;
    while ((nm = namePattern.exec(npcSection)) !== null) {
      const name = cutCharacterName(nm[1]);
      if (isValidCharacterName(name) && !chars.find(c => c.name === name)) {
        chars.push({ name, type: "npc", isMurderer: false, occupation: "" });
      }
    }
  }

  if (chars.length < minExpected) {
    const genericPattern = /(?:###\s+)?角色[一二三四五六七八\d]+[：:]\s*(.{1,40})/g;
    while ((m = genericPattern.exec(framework)) !== null) {
      const name = cutCharacterName(m[1]);
      if (isValidCharacterName(name) && !chars.find(c => c.name === name)) {
        const isNpc = /NPC/.test(framework.substring(Math.max(0, m.index - 100), m.index + 200));
        chars.push({ name, type: isNpc ? "npc" : "player", isMurderer: false, occupation: "" });
      }
    }
  }

  // 不够 minExpected 时补齐占位
  while (chars.length < minExpected) {
    chars.push({ name: `角色${chars.length + 1}`, type: "player", isMurderer: false, occupation: "" });
  }

  // 凶手名同样不能卡长度：它是结局判定的分母（determineOutcome 拿它对票型），
  // 匹配不上就会永远判"指认错误"。旧版 (.{2,6}) 会在 7 字名字上直接失配。
  const murdererRegex = /凶手[姓名]*[：:]\s*(.{1,40})/;
  const murMatch = framework.match(murdererRegex);
  if (murMatch) {
    const murName = cutCharacterName(murMatch[1]);
    const found = murName && chars.find(c => c.name === murName || murName.includes(c.name) || c.name.includes(murName));
    if (found) found.isMurderer = true;
  }

  return chars.slice(0, LIMITS.maxTotal);
}

// ==================== Prompt 构建 ====================

/**
 * 时间线格式示范的取值（填充角色/NPC 模板里的 `{tlDate}` / `{tlPlace}`）。
 *
 * 为什么必须运行时注入，而不是在模板里写死：
 * 模板原来写的是 `每条格式：- **日期 时间**：地点 — 事件` —— 它把**字段名**当成了格式样板。
 * 模型分不清"标签"与"示例值"，于是照抄标签，产出
 * `**日期12月4日 20:10（真实）**：地点一层车间工具房` 这种提纲残渣
 * （实测：全库 31 处，`地点`×21 / `日期`×10，玩家会直接读到）。
 * 注入**真实案发日期 + 真实房间名**后，示范行本身就是一个合法值：
 * 即使模型照抄这个形状，也不会自相矛盾、更不会留下"日期/地点"两个字。
 */
function timelineExampleValues(outline, framework) {
  const date = String(outline && outline.caseDate || "").trim() || "案发当日";
  // 只要不是"公共地点1"这种占位名就行（真布局里是真实房间名）
  const looksReal = (p) => !!p && !/^(?:公共|专属|备用)?(?:地点|房间|场所)\d*$/.test(p);
  let place = (outline && outline.layout || []).map(p => String(p || "").trim()).find(looksReal)
    || (extractLayoutPlaces(String(framework || "")) || []).map(p => String(p || "").trim()).find(looksReal)
    || "";
  if (!place) place = "（设定集布局里的某个真实房间名）";
  return { date, place };
}

function buildCharacterPrompt(ch, framework, index, total, isPVE, outline) {
  // PVE：玩家是调查者/侦探，NPC是嫌疑人——用简版模板；PVP：玩家互疑——用详版模板
  const tpl = isPVE ? stages.playerSleuthInstruction : stages.playerInstruction;
  let instructions = tpl
    .replace("{characterName}", ch.name);

  // 个人支线任务：优先用大纲为该角色单独生成的 goal。
  // 以前这里对所有玩家填的是同一句"查明X之死的真相，找出真凶"——
  // 那是公共目标，人人都一样，局后也无从判定完成与否，等于没有个人任务。
  const personalGoal = String(ch.goal || "").trim()
    || (ch.isMurderer ? "不被任何人指认，全身而退" : "隐瞒你与此案相关的隐情，同时找出真凶");
  // 全局替换做逃生兜底：任何模板里残留的未替换占位符都必须清掉，
  // 否则它会原样出现在生成的剧本正文里（玩家会直接看到 "{personalGoal}"）。
  instructions = instructions.replace(/\{personalGoal\}/g, personalGoal);
  // 时间线格式示范：`{tlDate}` / `{tlPlace}` 必须清掉，否则会原样出现在正文里。
  // 与上面 {personalGoal} 同一套"全局替换兜底"思路（模板里任何未替换占位符都是事故）。
  const tl = timelineExampleValues(outline, framework);
  instructions = instructions.replace(/\{tlDate\}/g, tl.date).replace(/\{tlPlace\}/g, tl.place);

  if (!isPVE) {
    // PVP：填充"调查目标" + 凶手注入（凶手可能在玩家中）
    const victimName = (framework.match(/死者信息[\s\S]*?姓名与身份[：:]\s*《?(.+?)》?/) || [])[1] || "死者";
    instructions = instructions
      .replace("{investigateTask}", `你想查明${victimName}之死的真相——结合线索与时间线推理，找出真凶`)
      .replace("{isMurdererExtra}", ch.isMurderer
        ? `\n4. **你是凶手**：请尽可能隐藏自己的凶手身份，误导他人，直到投票结束。\n\n    **【核心】你的「二、你的时间线」写的是真实发生的经过**——与其他角色一样是客观流水账，但必须完整覆盖你的作案过程，让读到它的人能顺着物品与目击线索反推出你的手法：\n    - 你何时、以什么借口离席，走的哪条路线，进入了哪个房间；\n    - 你**接触了哪些具体物品**（如某人的药箱、某个容器、擦拭用的手帕），并对它做了什么；\n    - 你途中**看到谁、被谁看到、听到什么**——这是别人能反过来对质你的锚点，不可省略；\n    - 你如何返回、以及回到公共区域的确切时间。\n    作案窗口那一段必须写出**与旁人同等密度的具体观察**，禁止只写“我上楼了”“我进房了”这类空泛交代。\n\n    **你的对外说辞（统一口径）**：在「三、你的任务」里另起一条写明你在案发时段对外声称的行踪（例如“散席后头晕，径直回房休息，未再外出”）。该说辞必须与你时间线里的真实动线**存在明确冲突**——这个冲突点就是你留给玩家的破绽。被追问时按说辞应对，不要主动坦白。\n\n### 四、凶手确认（仅你可见）\n⚠️ 本节只写 150-300 字的**手法要点确认**（毒物/凶器、下药或行凶的方式与位置、关键物证的来源与去向），供 DM 与系统解析核对，必须与「二、你的时间线」完全自洽。**它不是真相的唯一存放处**——详细真实经过以时间线为准，禁止在此处马后炮式地补充时间线里没有的作案细节。`
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
    // 权威时间轴属于最高优先级硬约束（不能混在"仅供参考"的背景里）
    const axis = buildTimeAxis(outline);
    // 权威事件表：**独立于时钟**，没有钟表偏差也必须给（否则各方对同一事件各说各话）
    const eventTable = buildEventTable(outline);
    // 角色级公共事件表：公开行踪的唯一权威（"同一趟走动只有一个时刻"）
    const publicTable = buildPublicEventTable(outline);
    // 关键物件状态变更表：同一物件同一时刻只有一个客观状态
    const objTable = buildObjectStateTable(outline);
    const header = [axis, eventTable, publicTable, objTable].filter(Boolean).join("\n\n");
    // 共享事实：死亡时刻禁令 + 该角色的权威时刻锚点（改动 3 的预防面）
    const sharedFacts = buildSharedFacts(outline, ch);
    constr = `${header ? header + "\n\n" : ""}## ⚠️ 设定集硬约束（最高优先级）
- 本剧本唯一有效角色名单：${allNames}（死者：${outline.victim?.name || ""}）。严禁出现名单之外的角色名（framework 初稿中不在名单内的旧角色一律作废）。
${sharedFacts}
- 你的名字：「${ch.name}」，身份「${ch.occupation || outline.players?.find(p => p.name === ch.name)?.identity || ""}」。
- 若你是侦探（PVE），本案真凶在其中一名NPC中；**你并不知道是谁**，也不要直接读出或写出任何"真凶名字"——你掌握的信息见你的剧本，真相要靠你在游戏里查出来。`;
  }

  return `请为【玩家${index}/${total}】角色撰写完整个人剧本。

## 角色基本信息
- 姓名：${ch.name}
- 身份：${ch.occupation || "详见框架"}
- 性格与语气：${ch.personality || "（设定集未指定，请自行给一个具体的说话方式，不要写成通用书面语）"}
- 角色类型：${isPVE ? "调查者/侦探（非嫌疑人）" : (ch.isMurderer ? "玩家（凶手）" : "玩家")}

## 设定集（最终权威）
${outline ? outlineToText(outline, { includeTruth: !!ch.isMurderer }).substring(0, 3000) : "（无设定集）"}
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
  // includeTruth 按身份开关：非凶手 NPC 只拿公共事实（否则下方 outline 兜底会把凶手手法漏回去）
  const outlineText = outline ? outlineToText(outline, { includeTruth: !!ch.isMurderer }) : "";
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
  // 时间线格式示范（与玩家模板同源）：必须清掉 {tlDate}/{tlPlace}，否则原样进正文
  const npcTl = timelineExampleValues(outline, framework);
  const instructions = npcTemplate
    .replace("{characterName}", ch.name)
    .replace(/\{tlDate\}/g, npcTl.date)
    .replace(/\{tlPlace\}/g, npcTl.place)
    .replace("{isMurdererExtra}", ch.isMurderer
      ? `### 五、凶手确认（该NPC是凶手，仅供DM掌握）
⚠️ 该NPC就是凶手（全局唯一真凶）。务必写明（300字以上）：
- 作案经过：**以该NPC本人为主语**，完整还原他/她在何时何地、用什么手法、如何完成下毒/制造密室/取走密文的全过程（与设定集 murderer.method 一致，参照其 realLine）；
- 对外口径：该NPC对外宣称的行踪/不在场证明；
- 破绽：能戳破其伪装的具体线索一两条；
- 关键：本剧本的时间线与"凶手确认"必须自洽——时间线里要体现其作案的关键动作（如取药、送茶、潜入书房），不能与"我不是凶手"矛盾。
此节仅供DM掌握真相，不会被玩家直接看到。`
      : "");

  const npcAxis = buildTimeAxis(outline);
  // 事件表同样必须给 NPC（NPC 也写时间线；无时钟偏差时这是唯一的权威事件来源）
  const npcEventTable = buildEventTable(outline);
  const npcPublicTable = buildPublicEventTable(outline);
  // 关键物件状态表同样必须给 NPC（NPC 也描写现场所见）
  const npcObjTable = buildObjectStateTable(outline);
  const npcHeader = [npcAxis, npcEventTable, npcPublicTable, npcObjTable].filter(Boolean).join("\n\n");
  // 共享事实（死亡时刻禁令 + 该 NPC 的权威时刻锚点）：NPC 也写时间线，同样必须遵守
  const npcShared = buildSharedFacts(outline, ch);
  const hardConstraint = outline
    ? `${npcHeader ? npcHeader + "\n\n" : ""}## ⚠️ 最终名单硬约束（最高优先级，必须严格遵守）
- 本剧本的唯一有效角色名单为：${allNames}（死者：${outline.victim?.name || ""}）。**严禁出现名单外的名字**（framework 初稿中的角色名如与名单不符一律作废，不得使用）。
${npcShared}
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

function buildStructuredSummary(report, opts) {
  // includeTruth=false：与 outlineToText 同一开关——抹掉凶手身份/手法/核心诡计，
  // 供角色与 NPC 提示词使用（见 outlineToText 的注释：靠"知道但别说"维持是单点隐患）。
  const includeTruth = !opts || opts.includeTruth !== false;
  const chars = report.characters || [];
  const players = chars.filter(c => c.type === "player");
  const npcs = chars.filter(c => c.type === "npc");
  const murderer = chars.find(c => c.isMurderer);

  let summary = "## 角色结构摘要\n\n";
  // 若存在大纲（阶段1.3产出），大纲作为权威蓝图最先给出，后续所有阶段必须遵循
  if (report.outline) {
    summary += outlineToText(report.outline, { includeTruth }) + "\n\n";
  }
  summary += `### 玩家角色（${players.length}人）\n`;
  players.forEach((c, i) => {
    summary += `- 玩家${i + 1}：${c.name}（${c.occupation || "待定"}）${includeTruth && c.isMurderer ? "【凶手】" : ""}\n`;
  });

  if (npcs.length > 0) {
    summary += `\n### ${report.isPVE ? 'NPC嫌疑人' : 'NPC目击者/关系人'}（${npcs.length}人）\n`;
    npcs.forEach((c, i) => {
      summary += `- NPC${i + 1}：${c.name}（${c.occupation || "待定"}）${includeTruth && c.isMurderer ? "【凶手】" : ""}\n`;
    });
  } else {
    summary += `\n### NPC\n（无 — 纯PVP模式）\n`;
  }

  if (includeTruth) {
    summary += `\n### 凶手\n- 凶手：${murderer?.name || "未知"}（${murderer?.type === "npc" ? (report.isPVE ? "NPC嫌疑人" : "NPC关系人") : "玩家"}）\n\n`;
  } else {
    summary += `\n### 凶手\n（由 DM 掌握，不向角色公开——真凶在上述名单之中，你的角色不知道是谁。）\n\n`;
  }

  // ===== 关键信息区：以大纲（设定集）为唯一权威，绝不注入 framework 原文 =====
  // 历史上 framework 初稿的角色名/凶手/时间体系与大纲锁定后的最终设定不一致
  // （如：素心vs小翠、柳寒山vs陈风、下午vs晚上时间系），若把 framework 原文传给下游，
  // LLM 会被旧设定带偏，产出"两版凶手/两版时间线"的灾难性剧本。
  if (report.outline) {
    const o = report.outline;
    const extraParts = [];
    if (includeTruth && o.trickSpec) {
      extraParts.push(`### 核心诡计（最终版）\n${o.trickSpec.trick || ""}｜${o.trickSpec.type || ""}\n${o.trickSpec.mechanism || ""}`);
    }
    // 时间线骨架两版都给：事件时刻是所有角色共同遵守的公共事实（与 buildEventTable 同源），
    // 不属于谜底——谜底是"谁干的、怎么干的"。
    if (o.timeline && o.timeline.length) {
      extraParts.push(`### 时间线骨架（最终版，唯一时间体系）\n${o.timeline.map(t => `- ${t.time} ${t.desc}`).join("\n")}`);
    }
    if (includeTruth && o.murderer && o.murderer.method) {
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

/**
 * 角色标题行（宽松）：`### 玩家角色 3：林小满` / `### 玩家角色3:林小满` 都算。
 * 之所以放宽到"可选空格 + 半角冒号"，是因为修订补丁会改写标题行附近的内容，
 * 严格正则一旦认不出，整段就会被当成上一段的一部分（实测事故见 repairMissingCharacterHeadings）。
 */
function isCharacterHeadingLine(line) {
  return /^###\s*(玩家角色|NPC|角色)\s*[一二三四五六七八九十\d]+\s*[：:]\s*\S/.test(String(line || "").trim());
}

/**
 * 修复"角色标题被修订吃掉"的事故（2026-10-19 实测《沪西照相馆除夕谜案》）：
 *
 * 现象：成稿里 `### 玩家角色 3：林小满` 这一行没了，她的 `### 一、你的背景故事` 等正文
 *       成了**没有归属的孤儿段**留在王大富之后；切分时她整个人消失
 *       （库里 3 个角色，而生成时报的是 4 人），玩家选角选不到、AI 也补不上位。
 *
 * 归因：定向修订的补丁 / 整段重写会重写标题附近的一大段文本，模型交回来的正文
 *       常常把中间的标题行丢掉；而**标题行是切分的唯一锚点**，丢了就等于丢角色。
 *
 * 修法（确定性，不靠模型）：按 `report.characters` 的名单比对成稿里已有的标题，
 * 缺谁就把缺的标题补回对应的孤儿段前面。孤儿段按出现顺序与缺失角色按名单顺序配对。
 * @returns {{text:string, fixed:Array<{name:string, at:number}>}}
 */
function repairMissingCharacterHeadings(fullScript, characters) {
  const text = String(fullScript || "");
  const chars = (characters || []).filter((c) => c && c.name);
  if (!chars.length) return { text, fixed: [] };
  const lines = text.split("\n");

  // 已成稿里已经有的角色标题（按名字）
  const present = new Set();
  for (const l of lines) {
    if (!isCharacterHeadingLine(l)) continue;
    const m = l.match(/[：:]\s*(.+?)\s*$/);
    if (!m) continue;
    const nm = cutCharacterName(m[1]) || m[1].trim();
    if (nm) present.add(nm);
  }
  const missing = chars.filter((c) => !present.has(c.name));
  if (!missing.length) return { text, fixed: [] };

  // 孤儿段：以「### 一、你的背景故事/你的时间线」开头，且上方最近的非空行不是角色标题
  const orphans = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^###\s*一、你的(背景故事|时间线|任务)/.test(lines[i].trim())) continue;
    // 向上跳过空行、`> 职业/身份：…` 元数据行、凶手提示行，再看是否命中角色标题。
    // ⚠️ 不跳这些行会把**每个角色**都误判成孤儿（assembleScript 在标题和正文之间正好有
    //    `> ⚠️ 你就是凶手！…` 和 `> 职业/身份：…` 两行）—— 实测一跑就把 4 个全判成孤儿，
    //    标题会被插到别人正文前面，比不修更糟。
    let j = i - 1;
    while (j >= 0) {
      const t = lines[j].trim();
      if (!t || t.startsWith(">")) { j--; continue; }
      break;
    }
    const prev = j >= 0 ? lines[j] : "";
    if (!isCharacterHeadingLine(prev)) orphans.push(i);
  }
  if (!orphans.length) return { text, fixed: [] };

  // 从后往前插入，避免下标错位；孤儿段与缺失角色按顺序配对
  const fixed = [];
  const pairs = orphans.map((at, k) => ({ at, ch: missing[k] })).filter((p) => p.ch);
  for (let k = pairs.length - 1; k >= 0; k--) {
    const { at, ch } = pairs[k];
    const tag = ch.isMurderer ? " [凶手]" : "";
    // 编号用该角色在名单里的序号，与 assembleScript 一致
    const idx = chars.findIndex((c) => c.name === ch.name) + 1;
    const isNpc = ch.type === "npc";
    lines.splice(at, 0, `${isNpc ? "### NPC" : "### 玩家角色"} ${idx}：${ch.name}${tag}`);
    fixed.push({ name: ch.name, at });
  }
  fixed.reverse();
  return { text: lines.join("\n"), fixed };
}

/**
 * 角色段落丢失的**最后防线**：正文也被吞掉时，从 report.characterScripts 整段重建。
 *
 * 2026-10-20《山坳雪夜烛影》实测事故：
 *   5 个角色生成完毕，成稿里却只剩沈砚 1 个 —— 另外 4 个角色的**标题与正文全没了**
 *   （原文从约 35k 掉到 21k）。链路是：逻辑校验误报 9 条假问题 → 送进修订 →
 *   「整段重写」把沈砚那一段替换成了只含沈砚的正文，其余四段被一并吞掉。
 *   repairMissingCharacterHeadings 只能补标题，补不了已经消失的正文 —— 所以要有这一层。
 *
 * 做法：缺谁就从 characterScripts 取回原文，按 assembleScript 的格式补在人物角色区块末尾。
 * @returns {{text:string, restored:Array<{name:string, chars:number}>}}
 */
function restoreMissingCharacterSections(fullScript, characters, characterScripts) {
  const text = String(fullScript || "");
  const chars = (characters || []).filter((c) => c && c.name);
  const scripts = characterScripts || {};
  if (!chars.length) return { text, restored: [] };

  const present = new Set();
  for (const line of text.split("\n")) {
    if (!isCharacterHeadingLine(line)) continue;
    const m = line.match(/[：:]\s*(.+?)\s*$/);
    if (!m) continue;
    const nm = cutCharacterName(m[1]) || m[1].trim();
    if (nm) present.add(nm);
  }
  const missing = chars.filter((c) => !present.has(c.name) && String(scripts[c.name] || "").trim());
  if (!missing.length) return { text, restored: [] };

  const lines = text.split("\n");
  // 插到人物角色区块末尾：下一个一级标题（`# 第X部分`/`# 第三部分`…）之前
  let insertAt = lines.length;
  let seenCharacterBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*玩家角色剧本/.test(lines[i].trim())) seenCharacterBlock = true;
    if (seenCharacterBlock && /^#\s+\S/.test(lines[i]) && !/^#\s*第二部分/.test(lines[i])) {
      insertAt = i;
      break;
    }
  }

  const block = [];
  for (const ch of missing) {
    const idx = chars.findIndex((c) => c.name === ch.name) + 1;
    const isNpc = ch.type === "npc";
    block.push(`${isNpc ? "### NPC" : "### 玩家角色"} ${idx}：${ch.name}${ch.isMurderer ? " [凶手]" : ""}`);
    if (ch.isMurderer) block.push("> ⚠️ 你就是凶手！你的处境与真实过程见下方剧本。", "");
    const meta = [];
    if (ch.occupation) meta.push(`职业/身份：${ch.occupation}`);
    if (ch.personality) meta.push(`语气：${ch.personality}`);
    if (ch.goal) meta.push(`个人任务：${ch.goal}`);
    if (meta.length) block.push(`> ${meta.join(" ｜ ")}`, "");
    block.push(String(scripts[ch.name]).trim(), "");
  }
  lines.splice(insertAt, 0, ...block);
  return {
    text: lines.join("\n"),
    restored: missing.map((c) => ({ name: c.name, chars: String(scripts[c.name]).replace(/\s+/g, "").length })),
  };
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
  // ⚠️ 死亡时间必须**有来源**，不能直接打一个空标签（实测两本都渲染出「- **死亡时间**：」后面什么都没有）：
  //   根因是大纲的 victim 结构里**没有 deathTime 字段**（只有 name/identity/gender/causeOfDeath/deathPlace），
  //   而框架提示词确实要求过"死亡时间"，所以它是**在从框架落到大纲结构时丢掉的**，不是模型没写。
  //   这里用 findDeathMoment(outline) 兜底 —— 那是同一套判定（也是"死者死后不得再活动"
  //   那层约束的依据），所以填进去的值与全篇其它判定**同源**，不会自相矛盾。
  //   ⚠️ 兜底也不许写成"（见权威时间轴）"这类**占位语**：script-parser 会把
  //   `- **死亡时间**：` 后面的文本原样当成 deathTime 存进结构化数据，
  //   占位语会顺着流到 AI 玩家提示词里（ai-player-llm 会念"死亡时间 （见…）"）。
  //   所以取不到就留空 + 出声告警，让人去权威时间轴复核，而不是把噪声写进数据。
  const deadTime = victim.deathTime || findDeathMoment(outline);
  parts.push(`- **死亡时间**：${deadTime || ""}\n`);
  if (!deadTime) console.warn(`[builder] ${victim.name || "死者"} 的死亡时间两头都取不到（victim.deathTime 空 + 时间线里判不出死亡时刻）——成稿该字段留空并需人工复核，未编造时刻`);
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
    // 结构化元数据行：script-parser 从这里把 personality/goal 解析回结构化数据，
    // 运行时（NPC/AI 玩家提示词、复盘判分）都依赖它。改格式务必同步 parser 的正则。
    const playerMeta = [];
    if (players[i].occupation) playerMeta.push(`职业/身份：${players[i].occupation}`);
    if (players[i].personality) playerMeta.push(`语气：${players[i].personality}`);
    if (players[i].goal) playerMeta.push(`个人任务：${players[i].goal}`);
    if (playerMeta.length) parts.push(`> ${playerMeta.join(" ｜ ")}\n\n`);
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
      const npcMeta = [];
      if (npcs[i].occupation) npcMeta.push(`职业/身份：${npcs[i].occupation}`);
      if (npcs[i].personality) npcMeta.push(`语气：${npcs[i].personality}`);
      if (npcs[i].goal) npcMeta.push(`个人任务：${npcs[i].goal}`);
      if (npcMeta.length) parts.push(`> ${npcMeta.join(" ｜ ")}\n\n`);
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

module.exports = { runStage, withTimeout, STAGE_TIMEOUT_MS, buildMurderMystery, LIMITS, extractLayoutPlaces, normalizeClueLocations, buildOutline, outlineToText, extractCharactersFromOutline, extractCharactersFallback, runModuleCrossCheck, assembleScript, fwSection, fwField, MIN_TIMELINE_POINTS, MIN_NPC_TIMELINE_POINTS, countTimelinePoints, extractCharacterTimeline, ensureTimelineComplete, buildCrossCheckDigest, applyPatches, splitScriptSections, replaceSectionBody, finalRewriteBySection, isCharacterHeadingLine, repairMissingCharacterHeadings, restoreMissingCharacterSections, buildSectionDigest, reviseByCrossCheck, buildCharacterPrompt, parseTimeOffset, shiftClock, buildTimeAxis, checkTrickObservability, parseCaseDate, buildFrameworkPrompt, checkEraCarriers, detectEra, checkRoundUnlock, replaceClueBlock, extractClueBlocks, findTamperMoment, minutesOf, findDeathMoment, characterAnchors, buildSharedFacts, checkVictimAfterDeath, buildEventTable, crossesMidnight, nextDayLabel, parseCnNum, cnNum, checkDateLabels, ensureDateConsistent, parseCnDay, parseDateLabel, compareDateLabels, victimActs, buildPublicEventTable, normalizePublicEvents, validatePublicEvents, ensurePublicEvents, checkPublicEventAnchors, rosterNames, midnightRuleText, MIN_PUBLIC_EVENTS, applyLineRewrites, checkDateAgreement, dateDiffDays, buildObjectStateTable, validateObjectStates, ensureObjectStates, MIN_OBJECT_STATES, nameAccuses, buildStructuredSummary, ensureDeathConsistent, onCaseNight, causeKeywords, extractCharacterSections, deterministicSnapshot, snapshotRegressions, hmOf };
