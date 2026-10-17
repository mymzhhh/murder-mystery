/**
 * 诡计设计与证明链 —— 生成流程的"推理链"第一步。
 *
 * ## 为什么需要它
 *
 * 改造前，整个流水线只有 outline 一个"思考产物"，而且它的 prompt 明文禁止模型输出思考过程。
 * 结果是：诡计能不能立住、时间轴闭不闭合、线索能不能真的证明诡计，只在一次调用里隐式决定一次，
 * 之后**再没有任何地方检查**。
 *
 * 最典型的后果在 builder 的 checkTrickObservability：它检查"核心诡计在物证上是否可观测"，
 * 但失败时只 console.warn + 推一条进度消息，**不回炉、不阻断**。
 * 用户可能拿到一个"诡计无法被任何线索证明"的本子，而流程显示成功。
 *
 * ## 做法：把思考变成可校验的中间产物，而不是让模型把思考写出来
 *
 * 字面的"思维链"（让模型先输出一段推理再输出答案）在这里是坑：推理型模型的思考已经在
 * reasoning_content 里了，再要求它把思考写进正文，只会更贵、更难解析，而且思考文本常常
 * 混进交付物。正确做法是让**产出物本身具有可推理的结构**：
 *
 *   机制 → 物理可行性 → 目击条件 → 最弱处 → 证明链（每条线索各自说明它能推出什么）
 *
 * 这条链的每一步都能被**确定性代码**校验（见 validateTrickDesign），
 * 所以失败可以只回退这一个几百 token 的小步骤，而不是写完四万字之后才发现，或者整线重跑。
 *
 * ## 校验必须是代码，不是再叫一次 LLM
 * 否则只是把不可靠性叠了一层——用一次不确定的判断去校验另一次不确定的输出。
 */

const { generate } = require("../llm/generator");
const { extractJsonStrict } = require("./json-extract");

/** 诡计类型枚举（与 outline 的 coreTrick 描述、时间轴逻辑保持一致） */
const TRICK_TYPES = [
  "密室",
  "身份错位",
  "时间诡计",
  "不在场证明",
  "叙述性诡计",
  "多重解答",
];

/**
 * 线索种类枚举。前三种是"玩家伸手就能拿到"的实体线索，
 * 后三种是结构性的锚点（独立时间源 / 时钟异常 / 身份）。
 */
const CLUE_KINDS = [
  "physical-trace",          // 物证 / 痕迹（凶器、残留、撬痕）
  "testimony",               // 证词 / 目击
  "record",                  // 书面记录（账本、排班表、书信、带时间戳的登记）
  "independent-time-source", // 独立时间源（怀表/手表读数、尸检死亡时间判定）
  "clock-anomaly",           // 公共时钟本身的异常（机芯拨动痕迹、与可靠时间源对不上）
  "identity",                // 身份相关（伪造的身份、笔迹、胎记）
];

/** 玩家可实际获取的实体线索种类（至少要有一条，否则诡计只存在于设定里） */
const OBTAINABLE_KINDS = ["physical-trace", "testimony", "record"];

/**
 * 每条证明链线索"支撑真相的哪个维度"（动机-手法-机会三锁 + 时间线）。
 *
 * 为什么需要它：改造前校验器只数条数和 kind，不问"这条线索推得动哪一维"。
 * 结果是可能凑够 3 条全是物证、动机零支撑——玩家能把人送进去，但说不清"为什么是他"。
 * 三锁必须齐备且各自可推导（借鉴 MYSTERY_ENGINE 的"动机-手法-机会三锁"规则）。
 */
const SUPPORTS = ["motive", "means", "opportunity", "timeline", "identity"];
/** 三锁：任何诡计都必须齐备；timeline 只对涉及时钟/时间差的诡计额外要求；
 *  identity 只对身份类诡计额外要求（见 involvesIdentity） */
const THREE_LOCKS = ["motive", "means", "opportunity"];
/** 支撑维度的中文标签（注入下游 prompt 时用，模型与人都要能读） */
const SUPPORTS_LABEL = { motive: "动机", means: "手法", opportunity: "机会", timeline: "时间线", identity: "身份" };

/**
 * 把 supports 拆成维度数组。
 *
 * 为什么容忍复合值：实测身份诡计里模型会写 `identity`，被打回后又改成 `identity-motive`
 * （它想同时表达"身份+动机"）。如果只接受单值枚举，这类写法会连续失败并最终让
 * **整个诡计阶段降级**（实测发生：身份诡计两次都被打回 → 本次生成不注入诡计硬约束）。
 * 复合值是合理的表达，拆开按多维度计即可。
 */
function splitSupports(value) {
  return String(value || "").split(/[-–—/／、,，|+]+/).map((s) => s.trim()).filter(Boolean);
}

/** 是否是身份类诡计（只在 type 明确为身份错位时要求 identity 支撑，避免误伤） */
function involvesIdentity(design) {
  return String((design && design.type) || "").trim() === "身份错位";
}

/** 时长单位 → 分钟（只收本模块需要的） */
const MAG_UNITS = { "分钟": 1, "分": 1, "刻": 15, "小时": 60, "钟头": 60, "时辰": 120 };

/** 中文/阿拉伯数量词 → 数值（两=2，半=0.5，支持一~九十九） */
function magNumeral(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (t === "两") return 2;
  if (t === "半") return 0.5;
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === "十") return 10;
  const m = t.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (t.length === 1 && CN[t]) return CN[t];
  return null;
}

/** 提取文字里所有"数量+单位"的时长（换算成分），带位置 */
function parseDurations(text) {
  const out = [];
  const re = /([0-9]{1,3}(?:\.[0-9]+)?|两|半|[一二三四五六七八九十]{1,3})\s*(?:个)?\s*(分钟|分|刻|小时|钟头|时辰)/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const n = magNumeral(m[1]);
    if (n === null) continue;
    out.push({ minutes: n * MAG_UNITS[m[2]], index: m.index, text: m[0] });
  }
  return out;
}

/**
 * 时钟偏移幅度是否足以支撑诡计声称的"时间差"。
 *
 * 实测（1890 广州）：设定集称"拨快两刻"（30 分钟）即可让死亡时刻被推后约两个时辰
 * （午初≈11:00 → 未时≈13:00，2 小时）——两刻根本不够，交叉校验事后才把它抓出来。
 * 这条把它变成**设计期**的确定性校验：偏移量必须至少等于要伪造的时间差。
 *
 * 判据刻意保守（只比对"紧邻调校动词"与"紧邻伪装动词"的时长）：
 * 文本里无关的时长（如"死者在书房待了一个时辰"）不参与比较，避免误伤。
 * 两个方向都取极端（偏移取最小、声称取最大）来比较，宁可放过也不误判。
 *
 * @returns {{ offset:number|null, claimed:number|null, errors:string[] }}
 */
function checkClockMagnitude(design) {
  const errors = [];
  const texts = [design && design.coreTrick, design && design.mechanism,
    design && design.conceal, design && design.breakPoint]
    .map((t) => String(t || "")).filter(Boolean);
  const CLOCK_VERB = /(拨快|调快|拨慢|调慢|回调)/g;
  const DECEIT_VERB = /(推迟|推后|推远|误判|伪装|错位|让人以为|误导|以为)/g;
  let offset = null, claimed = null;
  for (const s of texts) {
    let m;
    CLOCK_VERB.lastIndex = 0;
    while ((m = CLOCK_VERB.exec(s))) {
      // 取紧跟在调校动词之后 16 字内的时长 = 偏移量
      const d = parseDurations(s.slice(m.index, m.index + m[0].length + 16))[0];
      if (d && (offset === null || d.minutes < offset)) offset = d.minutes;
    }
    DECEIT_VERB.lastIndex = 0;
    while ((m = DECEIT_VERB.exec(s))) {
      const d = parseDurations(s.slice(m.index, m.index + m[0].length + 16))[0];
      if (d && (claimed === null || d.minutes > claimed)) claimed = d.minutes;
    }
  }
  if (offset !== null && claimed !== null && claimed > offset) {
    errors.push(
      `时钟偏移幅度不足：手法只把钟调了 ${offset} 分钟，却声称能造成 ${claimed} 分钟的时间差` +
      `（推后/提前/伪装）——偏移量必须至少等于要伪造的时间差，否则这个诡计在物理上不成立`
    );
  }
  return { offset, claimed, errors };
}

/** 超自然内容一律拒绝：剧本杀的诡计必须能被人在物理世界里做出来 */
const SUPERNATURAL_RE = /魔法|超能力|穿越|重生|鬼魂|亡灵|诅咒|预知|读心|瞬间移动|意念/;

/** 结论句：线索卡必须是客观描述，"这证明了…"是 DM 手册该说的话，不是线索 */
const CONCLUSION_RE = /这(就)?(证明|说明|意味着|表明)|由此可见|可见(他|她|凶手)|因此(凶手|他|她)就是|(凶手|真凶)就是/;

/** 时间/公共时钟相关的判定（与 builder 的 checkTrickObservability 同源思路） */
const CLOCK_RE = /(?<!分)钟|座钟|挂钟|时钟|落地钟|时差|时间差|拨快|拨慢|调慢|调快|报时|对表/;

/**
 * 是否涉及公共时钟/时间诡计。三种信号任一命中即算：
 * 显式字段 dependsOnClock、类型为时间诡计、或文本里提到钟表。
 */
function involvesClock(design) {
  if (!design || typeof design !== "object") return false;
  if (design.dependsOnClock === true) return true;
  if (String(design.type || "").trim() === "时间诡计") return true;
  const text = [
    design.coreTrick,
    design.mechanism,
    design.conceal,
    design.breakPoint,
  ].filter(Boolean).join(" ");
  return CLOCK_RE.test(text);
}

function nonEmpty(v, min = 1) {
  return typeof v === "string" && v.trim().length >= min;
}

/**
 * 确定性校验：返回 { ok, errors[] }。
 * errors 会原样回灌给模型用于定向重试——所以每条都要说清"哪里不合格、该怎么改"。
 */
function validateTrickDesign(design) {
  const errors = [];

  if (!design || typeof design !== "object" || Array.isArray(design)) {
    return { ok: false, errors: ["输出不是 JSON 对象"] };
  }

  // ---- 必填字段 ----
  const required = [
    ["coreTrick", 4, "核心诡计（一句话）"],
    ["type", 2, "诡计类型"],
    ["mechanism", 30, "诡计机制（说清怎么做到的）"],
    ["conceal", 10, "隐藏方式"],
    ["breakPoint", 10, "破绽方向"],
  ];
  for (const [key, min, label] of required) {
    if (!nonEmpty(design[key], min)) {
      errors.push(`字段 ${key}（${label}）缺失或过短（至少 ${min} 字）`);
    }
  }

  // ---- 类型枚举 ----
  const type = String(design.type || "").trim();
  if (type && !TRICK_TYPES.includes(type)) {
    errors.push(`type「${type}」不在允许的类型内，必须是：${TRICK_TYPES.join(" / ")}`);
  }

  // ---- 可行性三问 ----
  const feas = design.feasibility;
  if (!feas || typeof feas !== "object" || Array.isArray(feas)) {
    errors.push("缺少 feasibility 对象（physics / witness / weakest 三项）");
  } else {
    if (!nonEmpty(feas.physics, 10)) errors.push("feasibility.physics 缺失：要说清物理/时空上为什么做得到");
    if (!nonEmpty(feas.witness, 8)) errors.push("feasibility.witness 缺失：要说清关键动作可能被谁看到（确实无人目击也要写明是哪个时段）");
    if (!nonEmpty(feas.weakest, 8)) errors.push("feasibility.weakest 缺失：要说清这条诡计最容易被识破的地方");
  }

  // ---- 超自然 ----
  const allText = [
    design.coreTrick, design.mechanism, design.conceal, design.breakPoint,
    feas && feas.physics, feas && feas.witness, feas && feas.weakest,
  ].filter(Boolean).join(" ");
  const sup = allText.match(SUPERNATURAL_RE);
  if (sup) {
    errors.push(`出现超自然设定「${sup[0]}」——诡计必须能在现实物理条件内实现`);
  }

  // ---- 证明链 ----
  const chain = Array.isArray(design.proofChain) ? design.proofChain : [];
  if (chain.length < 3) {
    errors.push(`proofChain 至少需要 3 条线索（当前 ${chain.length} 条）——证明链不足时玩家无法推出真相`);
  }
  const kinds = [];
  const supports = [];
  chain.forEach((c, i) => {
    const idx = `proofChain[${i}]`;
    if (!c || typeof c !== "object") {
      errors.push(`${idx} 不是对象`);
      return;
    }
    const clue = String(c.clue || "").trim();
    if (clue.length < 10) {
      errors.push(`${idx}.clue 缺失或过短（至少 10 字，要写成玩家能读到的客观描述）`);
    } else {
      const concl = clue.match(CONCLUSION_RE);
      if (concl) {
        errors.push(`${idx}.clue 含结论句「${concl[0]}」——线索只写客观描述（读数、痕迹、别人的话），推断留给玩家`);
      }
    }
    const kind = String(c.kind || "").trim();
    if (!CLUE_KINDS.includes(kind)) {
      errors.push(`${idx}.kind「${kind || "(空)"}」非法，必须是：${CLUE_KINDS.join(" / ")}`);
    } else {
      kinds.push(kind);
    }
    // 支撑维度：三锁覆盖度的前提，缺失即整条线索无法归因
    const supRaw = String(c.supports || "").trim();
    const sups = splitSupports(supRaw);
    if (!sups.length) {
      errors.push(`${idx}.supports 缺失，必须是：${SUPPORTS.join(" / ")}`);
    } else {
      const bad = sups.filter((t) => !SUPPORTS.includes(t));
      if (bad.length) {
        errors.push(`${idx}.supports 含非法维度「${bad.join("、")}」，必须是：${SUPPORTS.join(" / ")}`);
      } else {
        supports.push(...sups);
      }
    }
    if (!nonEmpty(c.proves, 6)) {
      errors.push(`${idx}.proves 缺失：要说清这条线索让玩家能推出什么`);
    }
  });

  // ---- 至少一条玩家拿得到的实体线索 ----
  if (chain.length >= 3 && !kinds.some((k) => OBTAINABLE_KINDS.includes(k))) {
    errors.push(`证明链里没有一条实体线索（${OBTAINABLE_KINDS.join(" / ")}）——诡计将只存在于设定里，玩家无从获取`);
  }

  // ---- 三锁覆盖度（动机-手法-机会缺一不可）----
  // 只有线索齐了才算"可推导"：三锁各需至少一条 proofChain 线索把它撑起来。
  // 没有动机支撑 = 玩家锁定不了"为什么是他"；没有机会支撑 = 不在场证明无法被证伪。
  if (chain.length >= 3) {
    const missingLocks = THREE_LOCKS.filter((lock) => !supports.includes(lock));
    if (missingLocks.length) {
      errors.push(
        `三锁不齐备，proofChain 缺少支撑「${missingLocks.join("、")}」的线索` +
        `（三锁=动机/手法/机会，各需至少一条；玩家要能从线索推出全部三者，才能锁定并说服）`
      );
    }
  }

  // ---- 时间诡计的硬性要求（把 builder 的事后警告变成事前约束）----
  if (involvesClock(design)) {
    if (chain.length >= 3 && !supports.includes("timeline")) {
      errors.push("本诡计涉及公共时钟，但 proofChain 没有任何线索支撑「timeline」维度（如独立时间源与座钟读数之差）");
    }
    if (!kinds.includes("independent-time-source")) {
      errors.push("本诡计涉及公共时钟，但证明链缺少 independent-time-source（独立时间源：怀表/手表读数、尸检死亡时间判定、带时间戳的记录）——没有它，玩家无法证明钟被动过");
    }
    if (!kinds.includes("clock-anomaly")) {
      errors.push("本诡计涉及公共时钟，但证明链缺少 clock-anomaly（公共时钟本身的异常：机芯拨动痕迹、与可靠时间源对不上）");
    }
    // 幅度可行性：偏移量必须至少等于要伪造的时间差（实测"拨快两刻却要推后两个时辰"这类）
    const mag = checkClockMagnitude(design);
    mag.errors.forEach((e) => errors.push(e));
  }

  // ---- 身份诡计的额外要求：必须有线索支撑"身份"这一维度 ----
  // 身份诡计里玩家要证明的不是"谁有动机"，而是"谁是谁"——
  // 没有一条支撑 identity 的线索，身份互换就无法被推出（而模型天然会写出这类支撑，见 splitSupports 注释）。
  if (involvesIdentity(design) && chain.length >= 3 && !supports.includes("identity")) {
    errors.push("本诡计是身份错位类，但 proofChain 没有任何线索支撑「identity」维度（如孪生/顶替/易容的物证或旁证）——没有它，玩家无法证明身份被互换");
  }

  return { ok: errors.length === 0, errors };
}

/** 渲染成注入大纲 prompt 的硬约束文本 */
function trickDesignToText(design) {
  if (!design) return "";
  const feas = design.feasibility || {};
  const L = [];
  L.push("## 核心诡计设计（已定稿 —— 最高优先级）");
  L.push("下面是已经过校验的核心诡计。**大纲必须与此完全一致，不得另立诡计、不得改动机制。**");
  L.push(`- 类型：${design.type || ""}`);
  L.push(`- 核心诡计：${design.coreTrick || ""}`);
  L.push(`- 机制：${design.mechanism || ""}`);
  L.push(`- 隐藏方式：${design.conceal || ""}`);
  L.push(`- 破绽方向：${design.breakPoint || ""}`);
  L.push(`- 物理可行性：${feas.physics || ""}`);
  L.push(`- 目击条件：${feas.witness || ""}`);
  L.push(`- 最易被识破处：${feas.weakest || ""}`);
  const chain = Array.isArray(design.proofChain) ? design.proofChain : [];
  if (chain.length) {
    L.push("");
    // 三锁摘要：让下游（大纲/线索阶段）一眼看到动机-手法-机会各自有证据支撑
    const covered = new Set(chain.flatMap((c) => splitSupports(c.supports)));
    const lockText = THREE_LOCKS
      .map((lock) => `${SUPPORTS_LABEL[lock]}${covered.has(lock) ? "✔" : "⚠缺失"}`)
      .join(" / ");
    L.push(`- 三锁覆盖：${lockText}${involvesClock(design) ? ` / 时间线${covered.has("timeline") ? "✔" : "⚠缺失"}` : ""}`);
    L.push("");
    L.push("### 已确定的证明链（线索体系必须完整回收以下每一条，一条都不能丢）");
    chain.forEach((c, i) => {
      const supLabel = splitSupports(c.supports).map((t) => SUPPORTS_LABEL[t] || t).join("+");
      L.push(`${i + 1}. [${c.kind}·${supLabel}] ${c.clue}　→ 让玩家能推出：${c.proves}`);
    });
  }
  return L.join("\n");
}

/** 组装提示词。注意：不要求模型"输出思考过程"——要的是结构化的设计结论（见文件头注释）。 */
function buildTrickPrompt(userInput, cfg, feedback) {
  const { playerCount = 6, npcCount = 0, isPVE = false } = cfg || {};
  const system = `你是剧本杀核心诡计设计师。你的产出是**一份可直接施工的诡计设计书**，后续的大纲、角色剧本、线索、DM 手册全部以它为准。

## 输出铁律
- 只输出**一个 JSON 代码块**，代码块内是完整 JSON。
- **不要把思考过程、分析草稿写进正文**。想好了就直接给结论 JSON。
- 所有描述用中文，具体、可施工，不要写空话（"设计巧妙的诡计"这类一律不合格）。

## 合格标准（会被自动校验，不达标会被打回重做）
1. mechanism 必须说清"具体怎么做到的"：谁、在什么时间、用什么物品、做了什么动作。物理与时空上必须真的可行。
2. feasibility.witness 必须说清关键动作**可能被谁看到**；若确实无人目击，要写明是哪个时段、为什么没人。
3. proofChain 是**证明链**：玩家要能靠这几条线索一步步推出真相。至少 3 条，且至少 1 条是玩家伸手就能拿到的实体线索（物证痕迹 / 证词 / 书面记录）。
4. **三锁必须齐备**：每条 proofChain 线索都要标 \`supports\`（它支撑真相的哪个维度，可写多个、用 \`-\` 连接如 \`identity-motive\`）。三锁=动机(\`motive\`)/手法(\`means\`)/机会(\`opportunity\`)，**每锁至少要有一条线索撑起来**——没有动机支撑，玩家锁定不了"为什么是他"；没有机会支撑，不在场证明无法被证伪。若涉及公共时钟，还要有一条支撑时间线(\`timeline\`)；若 type 是身份错位，还要有一条支撑身份(\`identity\`)。
5. **线索一律客观描述**：只写读数、痕迹、别人的原话。禁止出现"这证明了…""说明…""凶手就是…"这类结论句——推断是玩家的乐趣，不能替他们做完。
6. 若诡计涉及公共时钟（时间诡计），证明链里**必须同时包含**：
   - 一条 \`independent-time-source\`（独立时间源：怀表/手表的具体读数、尸检对死亡时间的判定、带时间戳的记录），
   - 一条 \`clock-anomaly\`（公共时钟本身的异常：机芯有近期拨动痕迹、与可靠时间源对不上）。
   注意：**停摆的钟不能充当时间基准**，它只能说明自己停在哪一刻。
7. 禁止超自然设定（魔法/穿越/超能力/鬼魂等）。`;

  const user = `## 用户需求
${userInput}

## 规模约束
- 玩家角色 ${playerCount} 人${npcCount > 0 ? `，NPC ${npcCount} 人` : "，无 NPC"}
- 模式：${isPVE ? "PVE（NPC 为嫌疑人）" : "PVP（玩家互疑）"}
- 凶手有且仅有一个

## 输出格式（严格 JSON）
\`\`\`json
{
  "genre": "本格 / 变格 / 社会派 / 新本格（选一）",
  "type": "${TRICK_TYPES.join(" / ")}（选一）",
  "coreTrick": "核心诡计一句话（30字内）",
  "dependsOnClock": false,
  "mechanism": "诡计具体运作原理：谁、何时、用什么物品、做了什么（100字内，物理可行）",
  "conceal": "凶手如何隐藏它（伪装身份/伪造时间线/布置现场）",
  "breakPoint": "会被哪 2-3 条线索逐步暴露",
  "feasibility": {
    "physics": "为什么在物理与时空上做得到",
    "witness": "关键动作可能被谁看到；确实无人目击则写明时段与原因",
    "weakest": "这条诡计最容易被识破的地方"
  },
  "proofChain": [
    {
      "clue": "客观描述的线索：读数/痕迹/原话，禁止结论句",
      "kind": "${CLUE_KINDS.join(" | ")}",
      "supports": "${SUPPORTS.join(" | ")}（可多值，如 identity-motive）",
      "proves": "这条线索让玩家能推出什么"
    }
  ]
}
\`\`\`
要求：proofChain 至少 3 条，且三锁（motive/means/opportunity）各至少一条线索支撑；若 dependsOnClock 为 true（或 type 为时间诡计），必须包含 independent-time-source 与 clock-anomaly 各至少一条，且有一条 supports=timeline；若 type 为身份错位，需有一条 supports 含 identity。`;

  const fb = Array.isArray(feedback) && feedback.length
    ? `\n\n## ⚠️ 上一版被打回，必须逐条修正以下问题\n${feedback.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n\n请重新输出完整 JSON，不要只给差异说明。`
    : "";

  return { system, user: user + fb };
}

/**
 * 生成并校验诡计设计。
 *
 * 失败策略（重要）：**校验不通过只重试本步骤**（输出只有几百 token），
 * 全部失败则返回 null 并由调用方降级继续——绝不能让新增步骤把整条流水线搞挂，
 * 改造前没有这一步也能出本子，这里必须保持同样的可用性下限。
 *
 * @returns {Promise<{design: object|null, attempts: number, lastErrors: string[]}>}
 */
async function designTrick(userInput, cfg, onProgress, opts = {}) {
  const maxAttempts = Math.max(1, Math.min(3, opts.maxAttempts || 2));
  let feedback = [];
  let lastErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tag = maxAttempts > 1 ? `（第 ${attempt}/${maxAttempts} 次）` : "";
    if (onProgress) onProgress("trick", `正在设计核心诡计与证明链${tag}...`);

    const { system, user } = buildTrickPrompt(userInput, cfg, feedback);
    let result;
    try {
      // 预算与升级策略与大纲阶段保持一致（同为本项目的"结构化 JSON + 推理型模型"场景）：
      // 实测给 4096 会被 reasoning 占满，触发 4096→8192→16384→32768 四次递增升级，
      // 单次调用从数十秒膨胀到 250 秒（全是白等的重试）。一次给足 24000 并关掉升级，
      // 正文为空时由下方"从推理过程提取 JSON"兜底——推理里本就包含完整设计。
      result = await generate(system, user, { maxTokens: 24000, temperature: 0.8, noEscalate: true });
    } catch (e) {
      lastErrors = [`调用失败：${e.message}`];
      console.warn(`[trick-design] 第 ${attempt} 次调用失败：${e.message}`);
      if (attempt < maxAttempts) { feedback = lastErrors; continue; }
      break;
    }

    // 与大纲阶段同一套兜底：正文为空但推理里已有 JSON 时，从推理过程提取
    let parsed = extractJsonStrict(result && result.content);
    if (!parsed && result && result.reasoningContent) {
      parsed = extractJsonStrict(result.reasoningContent);
      if (parsed) console.warn("[trick-design] 正文为空，已从推理过程提取 JSON");
    }

    if (!parsed) {
      lastErrors = ["未能从返回中解析出 JSON（必须只输出一个 JSON 代码块）"];
      console.warn(`[trick-design] 第 ${attempt} 次解析失败`);
      if (attempt < maxAttempts) { feedback = lastErrors; continue; }
      break;
    }

    const v = validateTrickDesign(parsed);
    if (v.ok) {
      if (onProgress) onProgress("trick", `核心诡计已定稿并通过校验：${String(parsed.coreTrick || "").slice(0, 40)}`);
      console.log(`[trick-design] 第 ${attempt} 次通过校验：type=${parsed.type} chain=${(parsed.proofChain || []).length}`);
      return { design: parsed, attempts: attempt, lastErrors: [] };
    }

    lastErrors = v.errors;
    console.warn(`[trick-design] 第 ${attempt} 次校验未通过（${v.errors.length} 项）：${v.errors.join("；")}`);
    if (onProgress) onProgress("trick", `诡计设计未通过校验（${v.errors.length} 项），正在定向重做...`);
    feedback = v.errors;
  }

  console.warn("[trick-design] 全部尝试未通过校验，降级继续（本次生成不注入诡计硬约束）");
  // 把具体原因一并推到进度里：只写"降级继续"的话，管理端看不出是模型没按格式输出
  // 还是设计本身不合格，排查时只能去翻容器控制台。这里带上前两条错误就够定位了。
  const brief = (lastErrors || []).slice(0, 2).join("；");
  if (onProgress) {
    onProgress(
      "trick",
      `诡计设计未通过校验（${(lastErrors || []).length} 项），已降级继续：本次生成不注入诡计硬约束` +
        (brief ? `　原因：${brief}` : "")
    );
  }
  return { design: null, attempts: maxAttempts, lastErrors };
}

/** 现有线索里某前缀（默认 B）的最大编号；补写的线索从这里往下排，避免 ID 撞车 */
function nextClueId(cluesText, prefix = "B") {
  const re = new RegExp("^###\\s+" + prefix + "(\\d+)", "gm");
  let max = 0;
  let m;
  while ((m = re.exec(String(cluesText || "")))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 把补写的线索块插进「第二轮线索」区间。
 *
 * ⚠️ 为什么不能直接追加到文末：解析器（script-parser.extractAllClues）按
 * `## 第X轮` 标题切区间、再在区间内按 `### B12：` 取条目。
 * 若文末存在 `## 第三轮线索`，直接追加会落进第三轮；而落错轮次等于这条线索
 * **在游戏里根本不会被发出来**——补了等于没补。
 * 所以这里定位到第二轮标题之后、下一个轮次标题（或文末）之前插入。
 */
function insertCluesIntoRound2(cluesText, blocks) {
  const text = String(cluesText || "");
  const payload = (Array.isArray(blocks) ? blocks : []).filter(Boolean).join("\n\n");
  if (!payload) return text;

  const anchor = /^##\s*第[二2]轮[^\n]*$/m.exec(text);
  if (!anchor) {
    // 没有轮次标题：解析器有"按 ID 前缀归轮"的兜底（B→第二轮），接在末尾即可
    return text.replace(/\s*$/, "") + "\n\n" + payload + "\n";
  }
  const afterAnchor = anchor.index + anchor[0].length;
  const nextRound = /^##\s*第[一二三2-9\d]/m.exec(text.slice(afterAnchor));
  const at = nextRound ? afterAnchor + nextRound.index : text.length;
  return text.slice(0, at).replace(/\s*$/, "") + "\n\n" + payload + "\n\n" + text.slice(at).replace(/^\s*/, "");
}

/**
 * 把模型补写的线索块整理成可插入的形态：
 * 统一标题为 `### B{n}：`（模型自己编的编号一律不信，避免与现有 ID 撞车），
 * 并丢弃不含「线索内容」的块。
 */
function normalizeClueBlocks(rawText, startId, prefix = "B") {
  const text = String(rawText || "");
  const parts = text.split(/\n(?=#{2,4}\s*)/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let id = startId;
  for (const p of parts) {
    if (!/线索内容/.test(p)) continue;
    const body = p.replace(/^#{2,4}\s*[^\n]*\n?/, "").trim();
    if (!body) continue;
    out.push(`### ${prefix}${id}：\n${body}`);
    id++;
  }
  return out;
}

module.exports = {
  designTrick,
  validateTrickDesign,
  trickDesignToText,
  involvesClock,
  nextClueId,
  insertCluesIntoRound2,
  normalizeClueBlocks,
  TRICK_TYPES,
  CLUE_KINDS,
  OBTAINABLE_KINDS,
  SUPPORTS,
  THREE_LOCKS,
  splitSupports,
  involvesIdentity,
  magNumeral,
  parseDurations,
  checkClockMagnitude,
};
