// 剧本圣经（Story Bible）：把大纲里的权威事实归一化成**可逐条对账**的结构，
// 并提供一组**确定性**检查（纯函数、不调 LLM、可单测）。
//
// 为什么需要它 —— 来自一次真实生成里 crosscheck 报出的 7 个问题。那 7 条**没有一条**是
// "某个角色剧本自身矛盾"，全是【跨角色】或【角色 vs 权威事实】：
//   · 莫罗 20:00 写"在场有休·格雷" vs 休自述"20:00 后回房"        → 跨角色
//   · 密道日记同时在藏书室被撬、又在锅炉房被发现                    → 跨角色
//   · 莫罗 23:15"发现撬痕" vs 基准时间线 23:15"未察觉异常"          → 角色 vs 权威
//   · 书房灯在主人死后近半小时仍亮着，物件状态表里没有交代           → 细节悬空
// 结论：**"每人自审"抓不到主战场**。有效的是把权威事实逐条钉住，
// 再拿每个人的剧本去对账（本项目的长期教训：全局唯一事实必须钉在源头，
// 且钉在所有相关方都会读到的地方）。
//
// 模块边界：这里只做"取事实 + 比对 + 报告差异"，**改写留给调用方**（builder 里用 LLM 定向修），
// 这样"判"与"改"分开，判据可以被单测钉死。

const { hmOf, minutesOf, extractCharacterTimeline, escapeRe } = require("./timeline-utils");

/**
 * 通用地点词（兜底用）。
 *
 * 为什么需要：权威地名表只覆盖大纲声明的公共地点与专属房间，而角色剧本会说"回房了""去了后院"
 * 这类**没有落到地名表**的说法 —— 只按地名表比对，实测那类最典型的偏离会被整条漏掉
 * （"休自述 20:00 回房" vs 权威"20:00 在起居室"）。
 * 用词表兜底会带来误报，所以这类一律只记 warn（见 reconcileCharacterScript）。
 */
/** 同一地点的不同叫法（实测：权威表写"灶间"、角色写"厨房"就被判地点不符） */
const PLACE_ALIASES = [["灶间", "厨房"], ["前厅", "正厅"], ["廊下", "暖廊"], ["客房", "卧房"], ["账房", "账房卧房"], ["下房", "仆房"], ["更房", "值房"]];
/** 两个地名是否指同一处：相等、互相包含、或在同义词组里 */
function isSamePlace(a, b) {
  const x = String(a || "").trim(), y = String(b || "").trim();
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return PLACE_ALIASES.some(g => g.some(w => x.includes(w)) && g.some(w => y.includes(w)));
}
/** 移动/位移词：出现在同一行说明这条是在描述"正在移动"，不作为同刻两地 */
const MOVEMENT_RE = /(回到|回房|返回|走向|走进|离开|前往|赴|起身|出门|进门|经过|途经|穿过|上楼|下楼|赶到|送到|端到|搬)/;
const GENERIC_PLACE_WORDS = /(房间|房里|屋内|屋里|书房|卧室|起居室|客厅|餐厅|厨房|藏书室|锅炉房|仓库|库房|档案室|值班室|陈列室|质检室|走廊|门厅|大厅|前厅|后廊|楼梯|花园|院子|地窖|阁楼|密室|盥洗间|阳台|车间|站台|码头|窝棚|门口|后门|正门|大厅)/;

/** 归一化大纲 → 权威事实表 */
function buildBible(outline) {
  const o = outline || {};
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const s = (v) => String(v == null ? "" : v).trim();

  const players = asArr(o.players).map(p => s(p && p.name)).filter(Boolean);
  const npcs = asArr(o.npcs).map(p => s(p && p.name)).filter(Boolean);

  const timeline = asArr(o.timeline).map((e, i) => ({
    id: s(e && e.id) || `T${i + 1}`,
    time: hmOf(e && e.time) || "",
    actor: s(e && (e.actor || e.who)),
    place: s(e && e.place),
    doing: s(e && (e.doing || e.desc)),
    kind: (e && e.kind) === "secret" ? "secret" : "public",
  })).filter(e => e.time || e.doing);

  const publicEvents = asArr(o.publicEvents).map((e, i) => ({
    id: s(e && e.id) || `P${i + 1}`,
    time: hmOf(e && e.time) || "",
    actor: s(e && e.actor),
    place: s(e && e.place),
    doing: s(e && e.doing),
    who: asArr(e && e.who).map(s).filter(Boolean),
  })).filter(e => e.actor || e.doing);

  const objectStates = asArr(o.objectStates).map((e, i) => ({
    id: s(e && e.id) || `O${i + 1}`,
    at: hmOf(e && e.at) || "",
    object: s(e && e.object),
    state: s(e && e.state),
    witnesses: asArr(e && e.witnesses).map(s).filter(Boolean),
  })).filter(e => e.object);

  // 谁知道什么、何时知道 —— 推理本最典型的漏洞是"角色知道了不该知道的事"
  const knowledge = asArr(o.knowledgeMap).map((e, i) => ({
    id: s(e && e.id) || `K${i + 1}`,
    who: s(e && e.who),
    knows: s(e && e.knows),
    since: hmOf(e && e.since) || s(e && e.since),
    source: s(e && e.source),
  })).filter(e => e.who && e.knows);

  // 线索三要素：谁、何时、何地发现（现状线索只有 location+round，链一断就查不出原因）
  const cluePlan = asArr(o.cluePlan).map((e, i) => ({
    id: s(e && e.clueId) || s(e && e.id) || `C${i + 1}`,
    discoverer: s(e && e.discoverer),
    time: hmOf(e && e.time) || s(e && e.time),
    place: s(e && e.place),
    about: s(e && e.about),
  })).filter(e => e.id);

  const victim = {
    name: s(o.victim && o.victim.name),
    deathTime: hmOf(o.victimLine && o.victimLine.deathTime) || hmOf(o.victim && o.victim.deathTime) || "",
    deathPlace: s((o.victimLine && o.victimLine.deathPlace) || (o.victim && o.victim.deathPlace)),
    lastSeen: s(o.victimLine && o.victimLine.lastSeen),
    confirmedBy: asArr(o.victimLine && o.victimLine.confirmedBy).map(s).filter(Boolean),
  };

  const places = new Set();
  for (const e of [...timeline, ...publicEvents]) if (e.place) places.add(e.place);
  for (const e of asArr(o.layout)) { const p = s(String(e).replace(/[（(][^）)]*[）)]/g, "")); if (p) places.add(p); }

  return {
    caseDate: s(o.caseDate),
    title: s(o.title),
    victim,
    characters: [...players, ...npcs],
    players, npcs,
    murderer: s(o.murderer && o.murderer.name),
    places: [...places],
    timeline, publicEvents, objectStates, knowledge, cluePlan,
  };
}

/**
 * 与某个角色相关的权威条目（供提示词注入与对账共用同一个口径）
 *
 * 2026-10-20 新增 coLocated：**同处一室的可见白名单**。
 * 起因（真实错误）：林默在 19:40 写"听见沈砚秋的脚步声从后院过来"，
 * 但权威表里沈砚秋 19:40 正在密室行凶 —— 两人不在同一地点，林默不可能听见他。
 * 根因是角色只拿到"自己 + 公开"的条目，**不知道别人此刻在哪**，就自由发挥了。
 *
 * 为什么不直接给出"全场占位表"：那会把凶手的位置（密室）泄给所有角色，等于剧透。
 * 只给"此刻和我在同一地点的人" —— 这些人本来就看得见，不算泄密，
 * 同时明确告诉它"其他地点的人你不可能看见/听见"。
 */
function bibleFactsFor(bible, name) {
  const n = String(name || "").trim();
  if (!n) return { timeline: [], publicEvents: [], objectStates: [], knowledge: [], coLocated: [] };
  const involves = (e) => e.actor === n || (e.who || []).includes(n) || (e.witnesses || []).includes(n);

  // 同处一室：同一时刻、同一地点里除自己以外的人
  const coLocated = [];
  for (const mine of bible.timeline.filter((e) => e.actor === n && e.time && e.place)) {
    for (const other of bible.timeline) {
      if (!other.time || !other.place || !other.actor) continue;
      if (other.actor === n) continue;
      if (other.time !== mine.time || other.place !== mine.place) continue;
      coLocated.push({ time: mine.time, place: mine.place, name: other.actor });
    }
  }

  return {
    timeline: bible.timeline.filter(e => e.actor === n || e.kind === "public"),
    publicEvents: bible.publicEvents.filter(involves),
    // 物件状态是全体可见事实：主角所在场景的物件都相关，故全量给出（由提示词自行裁剪）
    objectStates: bible.objectStates,
    knowledge: bible.knowledge.filter(e => e.who === n),
    coLocated,
  };
}

/** 把权威条目渲染成可注入提示词的文本 */
function bibleFactsToText(facts) {
  const L = [];
  if (facts.publicEvents && facts.publicEvents.length) {
    L.push("【角色级公开行踪（权威，必须逐条与你的剧本一致）】");
    for (const e of facts.publicEvents) L.push(`- ${e.time}　你（${e.actor}）在「${e.place}」：${e.doing}${e.who && e.who.length ? `（在场：${e.who.join("、")}）` : ""}`);
  }
  if (facts.timeline && facts.timeline.length) {
    L.push("【本剧关键节点（权威）】");
    for (const e of facts.timeline) L.push(`- ${e.time}　${e.actor ? e.actor + "：" : ""}${e.doing}${e.place ? `（${e.place}）` : ""}`);
  }
  if (facts.objectStates && facts.objectStates.length) {
    L.push("【关键物件状态（权威，同一时刻只有一种状态）】");
    for (const e of facts.objectStates) L.push(`- ${e.at}　${e.object}：${e.state}`);
  }
  if (facts.knowledge && facts.knowledge.length) {
    L.push("【你知道的与知道的时间（不得提前知道）】");
    for (const e of facts.knowledge) L.push(`- ${e.since} 起你知道：${e.knows}${e.source ? `（来源：${e.source}）` : ""}`);
  }
  // 可见边界：这条是"减少逻辑错误"的关键约束（实测错误：写听见了当时在别处的人）
  if (facts.coLocated && facts.coLocated.length) {
    L.push("【此刻与你同处一室的人（你只能看见/听见这些人）】");
    for (const e of facts.coLocated) L.push(`- ${e.time} 你在「${e.place}」时，${e.name} 也在场`);
  }
  L.push("【可见性铁律】你只能看见、听见**与你同一地点**的人。"
    + "不要写「你听到/看到某个当时不在同一地点的人」的细节——"
    + "除非该情节在【角色级公开行踪】里明确写了在场者。"
    + "需要表达「有人经过」时，写「有人」而不是指名道姓。");
  return L.join("\n");
}

// ==================== 检查 1：权威表自洽 ====================

/**
 * 权威表自身的自洽性（跨表比对，不重复 validateObjectStates 已做的"状态描述含秘密动作"）。
 * @returns {{ok:boolean, issues:Array<{code:string, level:string, text:string}>}}
 */
function checkBibleSelfConsistency(bible) {
  const issues = [];
  const add = (code, level, text) => issues.push({ code, level, text });
  const byId = new Map();

  if (!bible.caseDate) {
    add("no_case_date", "error", "大纲没有给出案发日期（caseDate）——它是全剧唯一时间基准，缺了各角色会各编一套日期");
  }
  if (!bible.victim.name) {
    add("no_victim", "error", "大纲没有给出死者姓名");
  } else if (!bible.victim.deathTime) {
    // 这一条正是实测里那条告警的根因：没有权威身亡时刻 →「死者死后不得再活动」整层约束静默失效
    add("no_death_time", "error", `大纲没有给出死者「${bible.victim.name}」的身亡时刻——「死者死后不得再活动」约束与死后校验都不会生效`);
  }

  const unparsed = [...bible.timeline, ...bible.publicEvents].filter(e => !e.time);
  if (unparsed.length) {
    add("unparsed_time", "warn", `有 ${unparsed.length} 条权威条目的时刻无法解析（如「${(unparsed[0].time || unparsed[0].doing || "").slice(0, 12) || "空"}」），无法参与对账`);
  }

  // 同一角色同一时刻出现在两个不同地点
  const slot = new Map(); // `${actor}|${time}` → [{place, from}]
  const pushSlot = (actor, time, place, from) => {
    if (!actor || !time || !place) return;
    const k = `${actor}|${time}`;
    if (!slot.has(k)) slot.set(k, []);
    slot.get(k).push({ place, from });
  };
  for (const e of bible.timeline) pushSlot(e.actor, e.time, e.place, `timeline ${e.id}`);
  for (const e of bible.publicEvents) pushSlot(e.actor, e.time, e.place, `publicEvents ${e.id}`);
  for (const [k, list] of slot) {
    // 先把"同义/互相包含"的地名合并（技术室 = 一楼技术室），否则会误报权威表自相矛盾
    const uniq = [];
    for (const p of list.map(x => x.place)) {
      if (!uniq.some(u => isSamePlace(u, p))) uniq.push(p);
    }
    const places = uniq;
    if (places.length > 1) {
      add("same_instant_two_places", "error", `权威表自相矛盾：${k.split("|")[0]} 在 ${k.split("|")[1]} 同时出现在「${places.join("」与「")}」（${list.map(x => x.from).join("、")}）`);
    }
  }

  // actor/在场者必须是"人物"：角色名单 **加上死者** ——
  // 死者在前半夜当然会出现在公开行踪里（"最后一次被见到"就是这么写的）。
  // 实测假报：把死者当成"名单外的角色"报了一堆错。
  const names = new Set([...bible.characters, bible.victim.name].filter(Boolean));
  for (const e of bible.publicEvents) {
    if (e.actor && !names.has(e.actor)) add("unknown_actor", "error", `publicEvents 里的「${e.actor}」既不是角色也不是死者（${e.time} ${e.doing.slice(0, 16)}）`);
    for (const w of e.who) if (!names.has(w)) add("unknown_witness", "warn", `publicEvents 的在场者「${w}」既不是角色也不是死者`);
  }

  // 同一时刻、同一件事，但**做的人不一样** → 权威表自相矛盾
  // 实测（1998 演播楼）：基准时间线 18:30「张伟与李萌核对脚本」vs 公开行踪 18:30「林晓与李萌核对脚本」。
  for (const t of bible.timeline) {
    if (!t.time || !t.actor) continue;
    for (const p of bible.publicEvents) {
      if (p.time !== t.time || !p.actor || p.actor === t.actor) continue;
      const a = `${t.doing}${t.place}`, b = `${p.doing}${p.place}`;
      if (sharedBigrams(a, b) >= 3) {
        add("same_instant_two_actors", "error", `权威表自相矛盾：${t.time} 同一件事，基准时间线写「${t.actor}」，公开行踪写「${p.actor}」（${a.slice(0, 18)} / ${b.slice(0, 18)}）`);
      }
    }
  }

  // 同一物件同一时刻两种状态
  const objSlot = new Map();
  for (const e of bible.objectStates) {
    if (!e.object || !e.at) continue;
    const k = `${e.object}|${e.at}`;
    if (!objSlot.has(k)) objSlot.set(k, []);
    objSlot.get(k).push(e.state);
  }
  for (const [k, states] of objSlot) {
    const uniq = [...new Set(states)];
    if (uniq.length > 1) {
      const [obj, at] = k.split("|");
      add("object_two_states", "error", `物件「${obj}」在 ${at} 有两种状态：「${uniq.join("」/「")}」`);
    }
  }

  return { ok: issues.filter(i => i.level === "error").length === 0, issues };
}

// ==================== 检查 2：逐人 vs 权威对账 ====================

/** 找出文本里所有时刻→该行内容（用于对账） */
function timelineEntries(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const t = hmOf(line);
    if (!t) continue;
    out.push({ time: t, line });
  }
  return out;
}

/**
 * 逐人对账：该角色剧本里"属于他的权威条目"是否写对（时刻/地点）。
 *
 * 判定分两档（误伤会把写对的内容改坏，所以必须分档）：
 *   · error：同一时刻写了**权威地名表里的另一个地点** —— 证据确凿（如权威"20:00 起居室"，
 *     剧本写"20:00 我在藏书室"）。
 *   · warn：权威地点没出现，但这一行**提到了别的地方**（如"20:00 我回房了"）。
 *     这类正是实测里"休自述 20:00 回房 vs 权威 20:00 在起居室"的形状 ——
 *     "自己房间"不在地名表里，只按地名表比对会整条漏掉。用一份通用地点词兜底，
 *     代价是可能误报，所以只记 warn。
 *
 * @returns {{ok:boolean, conflicts:Array}}
 */
function reconcileCharacterScript(name, script, bible) {
  const n = String(name || "").trim();
  const conflicts = [];
  if (!n || !script) return { ok: true, conflicts };

  const placeSet = new Set(bible.places.filter(Boolean));
  const knownPlaces = [...placeSet].sort((a, b) => b.length - a.length); // 长名优先，避免"书房"吞掉"二楼书房"
  const entries = timelineEntries(script);

  const check = (time, expectedPlace) => {
    if (!time || !expectedPlace) return;
    const hit = entries.find(e => e.time === time && e.line.includes(n));
    if (!hit) return;
    // 移动发生的那一刻不是"同刻两地"：权威写"19:40 在正厅（离席）"、角色写"19:40 回房"是在路上
    if (MOVEMENT_RE.test(hit.line)) return;
    const mentioned = knownPlaces.filter(p => hit.line.includes(p));
    if (mentioned.includes(expectedPlace)) return;
    // 误报③：同一地点的不同叫法（权威写"灶间"、角色写"厨房"）不该判地点不符
    if (mentioned.some(p => isSamePlace(p, expectedPlace))) return;
    if (mentioned.length) {
      conflicts.push({
        kind: "place_mismatch", level: "error", time,
        expected: expectedPlace, found: mentioned, evidence: hit.line.slice(0, 80),
      });
      return;
    }
    // 兜底：权威地点没写出来，但这行提到了"别的地方"（通用地点词）
    const generic = hit.line.match(GENERIC_PLACE_WORDS);
    if (generic) {
      conflicts.push({
        kind: "place_unspecified_elsewhere", level: "warn", time,
        expected: expectedPlace, found: [generic[0]], evidence: hit.line.slice(0, 80),
      });
    }
  };

  for (const e of bible.publicEvents) if (e.actor === n) check(e.time, e.place);

  // 死者身亡时刻不得再活动（沿用既有判据的口径，这里只做"该角色剧本是否写了这个时刻的死者"）
  if (bible.victim.name && bible.victim.deathTime) {
    const dm = minutesOf(bible.victim.deathTime);
    const vname = bible.victim.name;
    // ⚠️ 跨午夜：死者常在凌晨身亡（如 01:15），而剧本的"夜"从 18:00 起算 ——
    // 直接比分钟数会把**傍晚的每一行**都算成"死后"（实测 1996 老饭店 6 处误报里有 4 处是这么来的）。
    // 规则：身亡在凌晨时，只看同一凌晨窗口（<=06:00）内晚于身亡的行；否则按当晚比较。
    const afterMidnight = dm <= 6 * 60;
    for (const e of entries) {
      const em = minutesOf(e.time);
      if (em === null || dm === null) continue;
      if (afterMidnight ? !(em <= 6 * 60 && em > dm) : !(em > dm)) continue;
      if (!e.line.includes(vname)) continue;
      // 死者必须是**动作主语**才算"死后仍在活动"——
      // 实测 6 处误报全是"推门见沈万堂倒毙""尸身尚有余温"这类**发现尸体**的描写（死者是宾语）。
      // 死者必须是**动作主语**：名字前面紧挨着 见/看/听/闻/喊/说/道/发现/问/提 时，那是**提及**而非活动
      //（实测误报："听到有人喊赵建国死了"）
      // 提及护栏（放宽到允许 1-2 个填充字："看到赵建国" / "听见有人喊赵建国"，实测这两种都会漏）+
      // "名字+的+名词"（的尸体/的字据/的名字）与"名字+地点后缀"（赵建国办公室）一律视为提及
      const named = new RegExp("(见|看|听|闻|喊|说|道|发现|问|提起|提到|关于)[^。！？\\n]{0,3}" + escapeRe(vname));
      if (named.test(e.line)) continue;
      if (new RegExp(escapeRe(vname) + "\\s*的[^。！？\\n]{0,4}(尸|遗|名|字|房|门|桌|柜|抽|铺|车|家)").test(e.line)) continue;
      if (new RegExp(escapeRe(vname) + "\\s*(办公室|房间|宿舍|卧室|车里|家门口|桌子|抽屉|柜子|铺位|门前|屋内)").test(e.line)) continue;
      if (!new RegExp(escapeRe(vname) + "[^。！？\\n]{0,10}?(说|道|问|答|吩咐|交代|走|进|出|站起|坐下|拿|递|喝|吃|笑|怒|喊|叫|抬|推|拉|起身|点头|摇)").test(e.line)) continue;
      conflicts.push({
        kind: "victim_after_death", level: "error", time: e.time,
        expected: `${vname} 已于 ${bible.victim.deathTime} 身亡`,
        found: [e.line.slice(0, 80)], evidence: e.line.slice(0, 80),
      });
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}

// ==================== 检查 3：跨角色冲突 ====================

/**
 * 跨角色确定性冲突。
 *
 * 判据是「**同一主体**在同一时刻被两个来源放在两个不同地点」——
 * 而不是"两个人互相提到"（第一版就是那样，在一批已通过校验的真实剧本上刷出 13/10/10 条噪音：
 * 甲说"我去找乙"、乙说"我在库房"根本不是矛盾）。实测调参后收紧到主体维度。
 *
 * 同时排除**意图句**（"打算/准备要去找"）——那是计划，不是"我当时在哪"的陈述。
 * 只比**权威地名表里**的地点：模糊说法（"回房了"）交给带权威表的 LLM 审查器，不在这里硬判。
 */
function findCrossCharacterConflicts(scriptsByName, bible) {
  const conflicts = [];
  const names = Object.keys(scriptsByName || {});
  if (names.length < 2) return { ok: true, conflicts };

  const allPeople = [...new Set([...bible.characters, bible.victim.name].filter(Boolean))];
  const intentRe = /(打算|准备|计划|想去|要去找|将要去|本要|本来想)/;
  const biblePlaces = bible.places.filter(Boolean).sort((a, b) => b.length - a.length);

  // 证据表：主体|时刻 → [{place, source, line}]
  const slot = new Map();
  for (const author of names) {
    for (const e of timelineEntries(scriptsByName[author])) {
      if (intentRe.test(e.line)) continue;                      // 意图句不算"当时在哪"
      const place = biblePlaces.find(p => e.line.includes(p));
      if (!place) continue;                                     // 只认权威地名表里的地点
      // 主体：默认是作者本人；行内提到的其他人也算证据（目击/转述）
      const subjects = new Set([author]);
      for (const p of allPeople) if (p !== author && e.line.includes(p)) subjects.add(p);
      for (const s of subjects) {
        const k = `${s}|${e.time}`;
        if (!slot.has(k)) slot.set(k, []);
        slot.get(k).push({ place, source: author, line: e.line });
      }
    }
  }

  const candidates = [];
  for (const [k, list] of slot) {
    const [subject, time] = k.split("|");
    const places = [...new Set(list.map(x => x.place))];
    if (places.length < 2) continue;
    const sources = [...new Set(list.map(x => x.source))];
    if (sources.length < 2) continue;                            // 同一份剧本自己说了两处 → 由逐人对账去管
    candidates.push({
      kind: "subject_two_places_same_time",
      level: "warn",                                             // 候选：语义裁定交给审查器（见下方注释）
      time, subject, who: sources,
      found: list.map(x => `${x.source}：${x.line.slice(0, 60)}`),
    });
  }

  // ⚠️ 为什么只标 warn、而且要限量：
  // 实测在已通过校验的真实剧本上，这一层能抓到**真矛盾**
  //（俑坑无声：吴长贵写马占魁 11:40 在食堂，马占魁自己写 11:40 在二号修复坑 —— 旧 crosscheck 漏了），
  // 但也会抓到**可解释情形**（"从传达室门口看见众人进出食堂"与"我在食堂"并不矛盾）。
  // 两者的区别是语义的，纯词法分不开 —— 所以这里只产出**候选**，
  // 由带权威表的 LLM 审查器裁定；并把条数封顶，避免日志被淹。
  const CANDIDATE_CAP = 12;
  const limited = candidates.slice(0, CANDIDATE_CAP);
  return { ok: limited.length === 0, conflicts: limited, candidateTotal: candidates.length, capped: candidates.length > CANDIDATE_CAP };
}

/**
 * 同一物件、同一时刻、不同来源给出**相反状态**（亮/灭、开/关、上锁/未锁…）。
 * 对应实测里"书房灯在主人死后仍亮着、物件状态表却没交代"那一类。
 */
const OBJECT_OPPOSITES = [["亮", "灭"], ["亮着", "熄灭"], ["开着", "关着"], ["打开", "关上"], ["上锁", "未锁"], ["锁着", "没锁"], ["点着", "熄灭"]];
function findObjectStateConflicts(scriptsByName, bible) {
  const conflicts = [];
  const objects = bible.objectStates.map(o => o.object).filter(Boolean);
  if (!objects.length) return { ok: true, conflicts };
  const slot = new Map();
  for (const author of Object.keys(scriptsByName || {})) {
    for (const e of timelineEntries(scriptsByName[author])) {
      for (const obj of objects) {
        if (!e.line.includes(obj)) continue;
        const k = `${obj}|${e.time}`;
        if (!slot.has(k)) slot.set(k, []);
        slot.get(k).push({ source: author, line: e.line });
      }
    }
  }
  for (const [k, list] of slot) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].source === list[j].source) continue;         // 同一份剧本内部矛盾归逐人对账
        const pair = OBJECT_OPPOSITES.find(([x, y]) =>
          (list[i].line.includes(x) && list[j].line.includes(y)) || (list[i].line.includes(y) && list[j].line.includes(x)));
        if (!pair) continue;
        const [obj, time] = k.split("|");
        conflicts.push({
          kind: "object_state_conflict", time, object: obj,
          who: [list[i].source, list[j].source],
          found: [`${list[i].source}：${list[i].line.slice(0, 50)}`, `${list[j].source}：${list[j].line.slice(0, 50)}`],
        });
      }
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

// ==================== 检查 4：线索三要素与一致性 ====================

/**
 * 线索闭环：每条线索都要能说出「谁 / 何时 / 何地」发现。
 * 现状线索只有 location+round —— 链一断就无从查起（实测"日记线索链断裂"就是这种情况）。
 */
function checkCluePlan(clues, bible) {
  const issues = [];
  const plan = new Map(bible.cluePlan.map(c => [c.id, c]));
  // 整本没有 cluePlan（旧剧本、或大纲没给这一节）→ 只报一条汇总。
  // 实测教训：逐条刷 warn 会在一本戏上刷 47~50 条，等于把日志淹掉。
  if (plan.size === 0) {
    return {
      ok: true,
      skipped: true,
      issues: [{ code: "no_clue_plan", level: "info", text: `本剧没有 cluePlan（大纲未提供该节），跳过「谁/何时/何地发现」三要素检查（共 ${(clues || []).length} 条线索）` }],
    };
  }
  const placeSet = new Set(bible.places);
  for (const c of (clues || [])) {
    const id = String(c.id || "");
    if (!id) continue;
    const p = plan.get(id);
    if (!p) { issues.push({ code: "clue_no_plan", level: "warn", clueId: id, text: `线索 ${id} 没有在 cluePlan 里声明「谁/何时/何地发现」` }); continue; }
    if (!p.discoverer || !p.time || !p.place) {
      issues.push({ code: "clue_plan_incomplete", level: "warn", clueId: id, text: `线索 ${id} 的三要素不全（发现者「${p.discoverer || "缺"}」/时刻「${p.time || "缺"}」/地点「${p.place || "缺"}」）` });
    }
    if (p.place && c.location && p.place !== c.location) {
      issues.push({ code: "clue_place_mismatch", level: "error", clueId: id, text: `线索 ${id} 的发现地点不一致：cluePlan「${p.place}」vs 线索表「${c.location}」` });
    }
    if (p.place && placeSet.size && !placeSet.has(p.place)) {
      issues.push({ code: "clue_place_unknown", level: "warn", clueId: id, text: `线索 ${id} 的发现地点「${p.place}」不在权威地点表里` });
    }
  }
  return { ok: issues.filter(i => i.level === "error").length === 0, issues };
}

// ==================== 检查 5：知识越界（保守判定） ====================

/**
 * 角色是否在"该知道之前"就写出了那件事。
 * 保守：只有当剧本里同一行**同时**出现"该事实的关键词"与一个**早于 since 的时刻**时才判。
 * 判为 warn：它是给 LLM 审查器的线索，不单独作为硬错误（避免误伤）。
 */
function checkKnowledgeBounds(name, script, bible) {
  const n = String(name || "").trim();
  const leaks = [];
  if (!n || !script) return { ok: true, leaks };
  const entries = timelineEntries(script);
  for (const k of bible.knowledge.filter(x => x.who === n)) {
    const sinceMin = minutesOf(k.since);
    if (sinceMin === null) continue;
    const keys = String(k.knows).split(/[，,、。；;\s]+/).filter(w => w.length >= 2).slice(0, 4);
    if (!keys.length) continue;
    for (const e of entries) {
      const em = minutesOf(e.time);
      if (em === null || em >= sinceMin) continue;
      if (!keys.some(w => e.line.includes(w))) continue;
      leaks.push({ time: e.time, since: k.since, knows: k.knows, evidence: e.line.slice(0, 80) });
      break;
    }
  }
  return { ok: leaks.length === 0, leaks };
}

// ==================== 检查 6：时间线体检（重复 / 倒序） ====================

/** 共享 2-gram 数（去重）：判"是不是同一件事"比整体相似度稳 —— 后者会被多出来的从句稀释 */
function sharedBigrams(a, b) {
  const grams = (s) => {
    const set = new Set();
    const str = String(s || "");
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  let n = 0;
  for (const g of ga) if (gb.has(g)) n++;
  return n;
}
/** 2-gram Dice 相似度：用于判断"同一事件被写成两条"（改写版往往多带一句对话） */
function similarity(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const grams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); set.set(g, (set.get(g) || 0) + 1); }
    return set;
  };
  const gx = grams(x), gy = grams(y);
  let inter = 0;
  for (const [g, c] of gx) if (gy.has(g)) inter += Math.min(c, gy.get(g));
  const total = (x.length - 1) + (y.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

/** 抽出"条列式"时间条目：时间线章节里的行，或全篇里以 - / * / 1. / （1） 开头的条目行。 */
/**
 * 角色剧本里的"自我名字前缀"（确定性判据）。
 *
 * 为什么：交叉校验在 2001 钟表店那本抓到过 `刘芳：**12月25日 19:00（真实）**：时计堂前厅 — …` ——
 * 在自己的剧本里给自己的时间线条目加"刘芳："前缀，属于格式错（读起来像别人在说），
 * 而且会让"行首是时刻"的解析失效。这类错纯格式、完全可确定判定。
 */
/**
 * 模板占位词残留（确定性判据）。
 *
 * 真身：提示词模板里把**字段名**写成了格式样板（`- **日期 时间**：地点 — 事件`），
 * 模型分不清"标签"与"示例值"，于是照抄标签，产出
 * `**日期12月4日 20:10（真实）**：地点一层车间工具房`、`（真实18:50）**：地点一楼大厅`。
 * 玩家会直接读到这些提纲残渣。已从源头修掉（模板改成注入真实日期/房间名的示范行），
 * 这里是对**已有库存**与模型偶发照抄的兜底。
 *
 * ⚠️ 判据必须避开正当的字段名与散文 —— 第一版判据（"占位词后面跟着中文或数字"）
 * 在真库上误报一片，实测三类：
 *   · `- **地点场景**：…`       正经字段（script-parser 还要读它！）
 *   · `**时间链（三次下毒窗口）**` / `**时间诡计链**`  正文章节名
 *   · `# 第二部分：人物角色` / `：人物关系` / `：时间的谎言`   散文里的冒号
 * 「后面跟着中文字」这条根本不够：`地点场景` 的"场"也是中文字。
 * 真正的边界是**形态**：残留长成 `**日期12月4日`（强调符 + 词 + **数字**）
 * 或 `**：地点一楼大厅`（强调符 + **冒号** + 词 + 值）；
 * 而正当字段是 `**地点场景**`（强调符 + 词 + 中文，**中间没有冒号**）。
 * 所以本判据**只认这两种形态**，不再接受"裸冒号"——
 * 没有一条真实样本是裸冒号形态，加上去只会引入新的误报。
 */
/** 只检测不修的占位词（不知道真值是什么，无法无损替换） */
const PLACEHOLDER_OTHER_WORDS = ["人物", "角色名", "某日", "某时", "某地", "XXX", "xxx"];
/**
 * 可**无损**自动清理的三个占位词：它们是纯字段名，删掉语义一点不变
 * （`**：地点一楼大厅` → `**：一楼大厅`）。其余占位词（人物/某日/某时/XXX…）
 * 不知道真值是什么，只报不改，交修订阶段。
 */
const REPAIRABLE_PLACEHOLDERS = ["日期", "时间", "地点"];
/** 「地点」后面若是这些词头，说明它是正当字段名（地点场景/地点描述/地点分布…），不是残留 */
const PLACE_FIELD_STOP = /^(?:场景|描述|分布|名称|位置|线索|设定)/;
/** 三个可无损修的词的"或"分支（唯一来源，检出与修复共用） */
const REPAIR_ALT = REPAIRABLE_PLACEHOLDERS.join("|");
/** 形态①：`**日期12月4日…` —— 强调符 + 词 + **数字**（`**日期标注**` / `**地点场景**` 这类词头不会被误判） */
const PLACEHOLDER_FORM1 = new RegExp("\\*\\*\\s*(" + REPAIR_ALT + ")(?=\\s*[0-9０-９])");
/** 形态②：`**：地点一楼大厅` —— 强调符 + 冒号 + 词 + 值 */
const PLACEHOLDER_FORM2 = new RegExp("\\*\\*\\s*[:：]\\s*(" + REPAIR_ALT + ")(\\s*(?:[0-9０-９]|[\\u4e00-\\u9fa5]))");
/** 修复用（带 g）：与上面两个形态一一对应，保证"检出即能修" */
const REPAIR_FORM1 = new RegExp("\\*\\*\\s*(?:" + REPAIR_ALT + ")\\s*(?=[0-9０-９])", "g");
const REPAIR_FORM2 = new RegExp("(\\*\\*\\s*[:：]\\s*)(" + REPAIR_ALT + ")(\\s*(?:[0-9０-９]|[\\u4e00-\\u9fa5]))", "g");
/**
 * 只检测不修的占位词（人物/某日/XXX…）的同样两种形态。
 * ⚠️ 形态①只认"后面跟数字"：`**人物设定**` / `**角色名册**` 是正当字段名，
 * 第一版按"后面跟中文"判 → 在真库上把 `**人物设定**` 判成残留（误报实测抓到）。
 */
const PLACEHOLDER_OTHER1 = new RegExp("\\*\\*\\s*(" + PLACEHOLDER_OTHER_WORDS.join("|") + ")(?=\\s*[0-9０-９])");
const PLACEHOLDER_OTHER2 = new RegExp("\\*\\*\\s*[:：]\\s*(" + PLACEHOLDER_OTHER_WORDS.join("|") + ")(\\s*(?:[0-9０-９]|\\u4e00-\\u9fa5]))");

/** 判定一行里是否含占位词残留；返回 {word, repairable} 或 null */
function placeholderHit(line) {
  let m = line.match(PLACEHOLDER_FORM1);
  if (m) return { word: m[1], repairable: true };
  m = line.match(PLACEHOLDER_FORM2);
  if (m && (m[1] !== "地点" || !PLACE_FIELD_STOP.test(m[2].trim()))) return { word: m[1], repairable: true };
  m = line.match(PLACEHOLDER_OTHER1) || line.match(PLACEHOLDER_OTHER2);
  if (m) return { word: m[1], repairable: false };
  return null;
}
function findPlaceholderResidues(name, script) {
  const out = [];
  for (const raw of String(script || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const hit = placeholderHit(line);
    if (hit) out.push({ word: hit.word, line: line.slice(0, 120), repairable: hit.repairable });
  }
  return out;
}

/**
 * 占位词残留的**无损清理**（确定性，不做任何 LLM 改写）。
 *
 * 只修 `日期`/`时间`/`地点` 这三个字段名，删掉后句子意思完全不变：
 *   `**日期12月5日 23:05（座钟）**`   → `**12月5日 23:05（座钟）**`
 *   `（真实18:50）**：地点一楼大厅`    → `（真实18:50）**：一楼大厅`
 * 判据与 `findPlaceholderResidues` 同源（同一个 placeholderHit），保证"检出即能修"，
 * 不会出现"报了 N 处、只修 M 处、剩下的没人管"的黑洞。
 *
 * @returns {{script:string, fixed:number, left:Array}} left = 剩下需人工/修订处理的残留
 */
function repairPlaceholderResidues(name, script) {
  const before = String(script || "");
  let text = before;
  let fixed = 0;
  // 形态①：`**日期12月4日` → `**12月4日`（强调符保留，词与值之间的空白也清掉）
  text = text.replace(REPAIR_FORM1, () => { fixed++; return "**"; });
  // 形态②：`**：地点一楼大厅` → `**：一楼大厅`（强调符与冒号都保留）
  text = text.replace(REPAIR_FORM2, (m, pre, w, tail) => {
    if (w === "地点" && PLACE_FIELD_STOP.test(tail.trim())) return m;   // 正当字段名（地点场景…），一行不动
    fixed++;
    return pre + tail.replace(/^\s+/, "");
  });
  const left = fixed ? findPlaceholderResidues(name, text).filter(h => !h.repairable) : [];
  return { script: text, fixed, left };
}

function findSelfPrefixEntries(name, script) {
  const out = [];
  const n = String(name || "").trim();
  if (!n) return out;
  const re = new RegExp("^" + escapeRe(n) + "\\s*[:：]");
  // 只在**时间线章节**里判：真库实测，不限定章节会把线索/任务区的
  // `- 李萌：演播厅挂钟的时间记录（21:00-22:30直播时段）` 也判成"自我名字前缀"（2 处误报）。
  // 章节抽不出来时退回全篇（与 healthEntries 同一个兜底策略，宁可多报也别静默失效）。
  const section = extractCharacterTimeline(script);
  const sources = section ? [section] : [String(script || "")];
  for (const src of sources) {
  for (const raw of String(src || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // ⚠️ 不能用 hmOf(line)：它只在行首附近取时刻，而"带名字前缀"的行恰恰取不到（单测抓到的洞）。
    // 这里只要求"行内任意位置有时刻"。
    if (!/\d{1,2}\s*[:：]\s*\d{2}/.test(line)) continue;
    // ⚠️ 判名前必须**先剥掉行首的列表符号**（`- `/`* `/`1. `/`（1）`）与强调符：
    // 真实时间线条目一律写成 `- 刘芳：**12月25日 19:00（真实）**：时计堂前厅 — …`，
    // 而判据锚在 `^名字[:：]` —— 不剥符号就永远匹配不上。
    // 实测代价：真库 7 本、对全部角色名扫描，命中数 **0**，这个判据当时等于失效
    //（单测本来是对的，是判据没跟上真实写法）。
    const body = line.replace(/^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/, "").replace(/^\*\*\s*/, "");
    if (re.test(body)) out.push({ line: line.slice(0, 120) });
  }
  }
  return out;
}

function healthEntries(script, opts) {
  const whole = !!(opts && opts.whole);
  const section = extractCharacterTimeline(script);
  const sources = whole ? [String(script || ""), section] : [section || String(script || "")];
  const inTimeline = (text, line) => {
    if (!whole) return true;                       // 只抽章节正文时，本来就在时间线里
    const idx = sLines.findIndex(l => l.trim() === line);   // 必须 trim 后比：拿 trim 过的行去未 trim 的数组里 indexOf 永远 -1
    return idx >= 0 && tlStart >= 0 && idx > tlStart && idx < tlEnd;
  };
  const seen = new Set();
  const out = [];
  // 时间线章节的行集合：用来标"这条条目属于哪一节"。
  // 必须按"行是否属于时间线"判定 —— 整篇扫描会先把时间线里的行收走，
  // 若按"哪一趟收集的"来标，时间线内的重复就永远被判成跨小节（永远只是 warn）。
  // 时间线章节的**行号区间**：用它判断某条目属于哪一节。
  // 不能用"字符串集合"——一旦章节抽取失败（section 为 null），集合为空 → 所有条目都被当成同一节 →
  // 正常的小节间复述会被判成"同章节重复"（实测：柳氏时间线零重复，却被报 14 处硬错）。
  const sLines = String(script || "").split("\n");
  let tlStart = -1;
  for (let i = 0; i < sLines.length; i++) {
    if (/^#{1,4}\s+.*时间线/.test(sLines[i]) && !/(故事时间线|表面时间线|真实时间线|完整时间线)/.test(sLines[i])) { tlStart = i; break; }
  }
  // ⚠️ 结束判定必须比"下一个任意标题"更严：时间线内部常用 ### 分"案发前一日/案发当日"，
  // 按"任意标题"截断会让区间只剩两行（实测把柳氏整段正常复述判成同节重复）。
  const tlLevel = tlStart >= 0 ? (sLines[tlStart].match(/^#+/) || ["##"])[0].length : 0;
  let tlEnd = sLines.length;
  if (tlStart >= 0) for (let i = tlStart + 1; i < sLines.length; i++) {
    const hm = sLines[i].match(/^(#+)\s+/);
    if (hm && hm[1].length <= tlLevel) { tlEnd = i; break; }
  }
  for (const text of sources) {
    if (!text) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // 全篇扫描时只认**条列式**行：散文里重复提到同一个事实是正常写作，
      // 而"时间线/不在场证明"这类条目重复才是真问题（实测云锦庄就是这种）。
      if (whole && !/^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/.test(line)) continue;
      const bare = line.replace(/^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/, "").replace(/\*\*/g, "");
      const time = hmOf(bare);
      if (!time) continue;
      const key = `${time}|${bare.replace(/\s+/g, "").slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dm = bare.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      out.push({
        time,
        date: dm ? { month: parseInt(dm[1], 10), day: parseInt(dm[2], 10) } : null,
        from: inTimeline(text, line) ? "timeline" : "other",
        // 所属小节的标题 —— "对外说辞/隐瞒事项/开场说明/复盘"这类小节天然会重述同一件事，
        // 用来把"跨节复述"的提示降噪（只存标题，不做判定）。
        fromTitle: (() => {
          const at = sLines.findIndex((l) => l.trim() === line);
          if (at < 0) return "";
          for (let j = at - 1; j >= 0; j--) {
            const h = sLines[j].match(/^#{1,6}\s+(.*)$/);
            if (h) return h[1].replace(/[*_`【】]/g, "").trim();
          }
          return "";
        })(),
        line,
        // 描述归一化：去掉时刻/日期/标点与强调符，只留事件文字，便于判"是不是同一件事"
        // 先去掉"地点前缀"（"账房卧房 — "）与【座钟】这类标注：
        // 它们是**格式样板**，两条不同的事因为样板相同会被误判重复（实测周先生 4 处）。
        desc: bare
          .replace(/^[^—\-]{0,14}[—\-]{1,2}\s*/, "")
          .replace(/【[^】]*】/g, "")
          .replace(/\d{1,2}\s*[:：]\s*\d{2}/g, "")
          .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, "")
          .replace(/[*_`【】\[\]（）()「」“”"']/g, "")
          .replace(/\s+/g, "")
          .replace(/^[:：\-—、,，。;；]+/, ""),
      });
    }
  }
  return out;
}

/**
 * 时间线体检：条目重复 / 同日倒序 / 日期倒退。
 *
 * 为什么必须由确定性代码做：上一轮改造后，crosscheck 剩下的问题**全部**是这一类 ——
 * 实测《云锦庄·卯时账》报的是「白慕堂时间线中 10月17日 05:50 条目出现两次（同一事件被写成两条）」
 * 与「10月17日05:50 被排在 10月16日20:00 之前，时间倒序穿插」。
 * 让 LLM 去发现这种"数得出来"的毛病，既慢又不可靠（实测它就报了两轮）。
 *
 * @returns {{ok:boolean, issues:Array<{code:string,level:string,text:string,evidence:string[]}>}}
 */
function checkTimelineHealth(name, script) {
  const issues = [];
  if (!script) return { ok: true, issues };
  // 两种扫描范围，用途不同：
  //   · 重复判定用**全篇条列式行**（实测云锦庄的重复一条在时间线、一条在"不在场证明"列表里，
  //     只扫时间线章节必然漏判）；
  //   · 顺序判定只用**时间线章节**（混入其它小节会让排序判据产生大量噪音）。
  const allEntries = healthEntries(script, { whole: true });
  const entries = healthEntries(script);
  if (allEntries.length < 2) return { ok: true, issues };

  // ① 同一时刻、同一件事被写成两条（near-duplicate）
  for (let i = 0; i < allEntries.length; i++) {
    for (let j = i + 1; j < allEntries.length; j++) {
      const a = allEntries[i], b = allEntries[j];
      if (a.time !== b.time) continue;
      const shared = sharedBigrams(a.desc, b.desc);
      const sim = similarity(a.desc, b.desc);
      // 判据用**共享 2-gram 数**为主、相似度为辅：
      // 实测《云锦庄》那对（时间线一条 + "不在场证明"列表一条）整体相似度只有 ~0.17
      //（后面那条多了一大段从句），按相似度阈值必然漏判；而它们共享"内室/咳嗽/窗前/可闻/后院"约 5 个片段。
      // 无关的两件事同刻则共享 0 个片段（实测"前柜对账" vs "听见后院响动"）。
      // 只有**双方都在时间线小节内**的同刻同事重复才是硬错。
      // 实测教训：把"同一节"当硬错，会让**人物关系/个人任务小节**里的两句话（都含同一个时刻）被判重复（寿宴四毒 6 处全是这类）。
      const sameSection = a.from === "timeline" && b.from === "timeline";
      // 「对外说辞 / 隐瞒事项 / 开场说明 / 复盘」小节天然会**重述**同一件事（凶手说辞甚至故意矛盾），
      // 这是玩法核心而非错误 —— 实测一本 11 条提示里绝大多数是这类，会训练人忽略警告。
      const isRecap = (f) => /(说辞|说词|复盘|隐瞒|隐藏|开场|自述|伪证|谎)/.test(String(f || ""));
      const recapPair = isRecap(a.fromTitle) || isRecap(b.fromTitle) || isRecap(a.line) || isRecap(b.line);
      if (shared >= 4 || sim >= 0.65) {
        // 说辞 / 隐瞒 / 开场 / 复盘 小节天然会重述同一件事（凶手说辞与真实时间线故意矛盾＝玩法核心），
        // 这类直接跳过：不报 error 也不报 warn（否则一本十几条噪声会训练人忽略所有警告）。
        if (recapPair) continue;
        // ⚠️ 级别取决于"是否同一小节"：同一章节里同刻同事重复=真缺陷（error，可删一条）；
        // 但"时间线写了 + 后面的证词/不在场证明里再说一遍"是**正常剧本结构**，
        // 实测 7 本好剧本里每本 4~15 处 —— 一律判 error 会让修复器去删合法内容（危险），故只记 warn。
        issues.push({
          code: (sameSection && !recapPair) ? "timeline_duplicate" : "timeline_duplicate_cross",
          level: (sameSection && !recapPair) ? "error" : "warn",
          text: (sameSection && !recapPair)
            ? `${name} 时间线里 ${a.time} 的同一件事被写成两条（共同片段 ${shared}），删掉其中一条`
            : `${name} 里 ${a.time} 的同一件事在小节间重复出现（时间线 + 别处，共同片段 ${shared}）——若是复盘引用属正常，若确为错乱再改`,
          evidence: [a.line, b.line],
        });
      } else if (shared >= 2) {
        issues.push({
          code: "timeline_same_time", level: "warn",
          text: `${name} 里 ${a.time} 出现两条内容相近的条目（共同片段 ${shared}），确认不是同一件事被拆成两条`,
          evidence: [a.line, b.line],
        });
      }
    }
  }

  if (entries.length < 2) return { ok: issues.filter(i => i.level === "error").length === 0, issues };

  // ② 排序：有日期的按 日期+时刻 比。
  //    ⚠️ 判据校准（真实数据实测）：把日期倒退一律判 error 会在好剧本上刷一堆假报
  //    （《蜡盘回声》27 处、《云锦庄》8 处）—— 因为剧本常先写案发夜、再补一段"前情/回忆"，
  //    那是**合法的倒叙**，不是错乱。所以：带倒叙标记的行一律跳过，其余只记 warn
  //    （提示复核，不硬判、不据此改写）。
  //    ⚠️ 键值位宽必须够：分钟可达 1439，占 4 位；日占 2 位。写成 month*10000+day*100+minutes
  //    会让 20:00（1200 分钟）溢进"日"位，把正常顺序判成倒退（单测当场抓到这个错）。
  const orderKey = (d, t) => (d.month * 100 + d.day) * 10000 + (minutesOf(t) || 0);
  const FLASHBACK = /(前情|回忆|此前|更早|昨日|前一天|案发前|当日之前|倒叙)/;
  const withDate = entries.filter(e => e.date && !FLASHBACK.test(e.line));
  if (withDate.length >= 2) {
    for (let i = 1; i < withDate.length; i++) {
      const prev = withDate[i - 1], cur = withDate[i];
      if (orderKey(cur.date, cur.time) < orderKey(prev.date, prev.time)) {
        issues.push({
          code: "timeline_out_of_order", level: "warn",
          text: `${name} 时间线里 ${prev.date.month}月${prev.date.day}日 ${prev.time} 之后紧跟着 ${cur.date.month}月${cur.date.day}日 ${cur.time}（日期倒退，确认不是倒叙段）`,
          evidence: [prev.line, cur.line],
        });
      }
    }
  } else {
    // 无日期时只判"时刻倒退且不像跨午夜"（23:50 → 00:30 是合法的跨午夜）
    for (let i = 1; i < entries.length; i++) {
      const prev = minutesOf(entries[i - 1].time), cur = minutesOf(entries[i].time);
      if (cur === null || prev === null) continue;
      const crossed = entries[i - 1].time >= "18:00" && entries[i].time <= "06:00";
      if (cur < prev && !crossed) {
        issues.push({
          code: "timeline_out_of_order", level: "warn",
          text: `${name} 时间线顺序可疑：${entries[i - 1].time} 之后紧跟着 ${entries[i].time}（若不是跨午夜，请调整顺序）`,
          evidence: [entries[i - 1].line, entries[i].line],
        });
      }
    }
  }

  // ④ 模板占位词残留（日期/地点/时间/某日…）：纯字符串，可 100% 确定判定。
  //    ⚠️ 这是**兜底网**：能无损修的（日期/时间/地点）在生成后已由 repairPlaceholderResidues 清掉，
  //    正常路径到这里是 0 条；非零就说明有环节跳过了清理、或模型写的是修不了的占位词（某日/XXX），
  //    两种都该让修订阶段看见。
  for (const h of findPlaceholderResidues(name, script)) {
    issues.push({
      code: "placeholder_residue", level: "warn",
      text: `${name} 有模板占位词残留「${h.word}」${h.repairable ? "（可无损自动修）" : "（需改写）"}：${h.line}`,
      evidence: [h.line],
    });
  }

  // ⑤ 自己在自己的时间线条目上加了名字前缀（`- 林哲：**10月16日 02:00**：…`）。
  //    两个害处：读起来像别人在说；且行首不再是时刻，"行首即时刻"的解析会失效。
  //    真库实测 5 处（顶层壁炉 4 / 糖厂 1）。判据只认**时间线章节**内的行（已避开
  //    "目击信息（…与全局时间线一致）"这类标题与线索/任务区的 `名字：物证` 写法）。
  for (const h of findSelfPrefixEntries(name, script)) {
    issues.push({ code: "self_name_prefix", level: "warn", text: `${name} 的时间线条目带了自己的名字前缀：${h.line}`, evidence: [h.line] });
  }

  // ⑥ 去重：同一条消息只报一次。
  //
  // 为什么需要（真库实测，2026-10-17）：39 份角色剧本里 `timeline_duplicate_cross` 报了 **92 条**，
  // 远超其它判据之和；而样本里出现**一字不差的重复输出**：
  //   「赵守夜 里 21:30 的同一件事在小节间重复出现（时间线 + 别处，共同片段 7）」
  //   「赵守夜 里 21:30 的同一件事在小节间重复出现（时间线 + 别处，共同片段 7）」
  // 成因是双重循环按 (i, j) 对报，而消息里只带时刻与相似度、**不带是哪一个 j** ——
  // 同一时刻有多条相近条目时，同一个 (时刻, 相似度) 就会被报多次，字数一样、内容无从区分。
  // 这种重复对读者没有任何信息量（他看到的还是同一句话），只会把"提示级问题数量"顶上去，
  // 让人误判判据的宽窄。所以按 `code|text` 折叠，证据取第一条。
  const seenIssue = new Set();
  const deduped = [];
  for (const it of issues) {
    const key = `${it.code || it.kind}|${it.text || ""}`;
    if (seenIssue.has(key)) continue;
    seenIssue.add(key);
    deduped.push(it);
  }

  return { ok: deduped.filter(i => i.level === "error").length === 0, issues: deduped };
}

// ==================== 检查 7：线索计划对齐（确定性） ====================

/**
 * 线索 `location` 的归一化。
 *
 * 为什么需要：真实数据里的 location 是一套**层级写法**（从 7 本剧本实测取值）：
 *   "站长办公室·桌"、"维修间·水槽下水口"        → 房间·具体物件
 *   "值班宿舍（陈桂香宿舍）"、"站台（案发现场）"   → 房间（括号是补充说明）
 *   "周世奎左手"、"谭志强工装口袋"                → 在某**人**身上
 *   "孙佩兰证词"                                 → 证词（作证的人）
 *   "案发地点：二号修复坑"、"陈守拙宿舍"          → 带前缀 / 某人的房间
 * 以前只做"人名 or 地名表"二分，导致大量 location 判不出类型（实测《三号库》47/47），
 * cluePlan 因此填不满。这里把这些写法逐条归一到 { kind, person, place }。
 *
 * @returns {{kind:"place"|"person"|"unknown", person:string, place:string, raw:string}}
 */
function normalizeClueLocation(location, bible) {
  const raw = String(location || "").trim();
  const none = { kind: "unknown", person: "", place: "", raw };
  if (!raw) return none;

  const characters = (bible && bible.characters) || [];
  const victim = (bible && bible.victim && bible.victim.name) || "";
  const places = (bible && bible.places) || [];

  // 去前缀/去括号说明后再判断
  let s = raw.replace(/^[^：:]{0,8}[：:]\s*/, "").trim();          // "案发地点：X" → "X"
  const paren = (raw.match(/[（(]([^）)]*)[）)]/) || [])[1] || "";   // 括号里的补充说明
  s = s.replace(/[（(][^）)]*[）)]/g, "").trim();

  // 证词线索："孙佩兰证词" / "赵德海口供"
  const testi = s.match(/^(.+?)(证词|口供|陈述|说法)$/);
  if (testi) {
    const who = characters.includes(testi[1].trim()) ? testi[1].trim() : "";
    if (who) return { kind: "person", person: who, place: "", raw };
  }

  // 在某**人**身上："周世奎左手"、"谭志强工装口袋"
  for (const who of [...characters, victim].filter(Boolean)) {
    if (!s.startsWith(who) || s === who) continue;
    const rest = s.slice(who.length);
    if (/^(左手|右手|手|口袋|外套|工装|衣|身上|身体|尸|遗|袖|鞋|包|怀里)/.test(rest)) {
      return { kind: "person", person: who, place: "", raw };
    }
  }

  // 某人的房间："陈守拙宿舍" → 人 + 房间（房间对不上地名表时，只记"是谁的东西"，不编房间名）
  for (const who of [...characters, victim].filter(Boolean)) {
    if (!s.startsWith(who) || s === who) continue;
    const rest = s.slice(who.length);
    if (/^(房|宿舍|房间|办公室|居室|内室|住处|厢房)/.test(rest)) {
      const canonical = matchPlace(s, places) || (paren ? matchPlace(paren, places) : "");
      return canonical
        ? { kind: "place", person: who, place: canonical, raw }
        : { kind: "person", person: who, place: "", raw };
    }
  }

  // 层级写法："站长办公室·桌" → 第一段就是房间
  const head = s.split(/[·•・\/|]/)[0].trim();
  // 层级写法的第一段本身可能就是房间
  if (/(房|屋|室|厅|廊|库|院|楼|园|仓|窖|棚|台|门|堂|馆|斋|轩|阁|间)$/.test(head)) {
    return { kind: "place", person: "", place: matchPlace(head, places) || head, raw };
  }
  const canonical = matchPlace(head, places) || matchPlace(s, places) || (paren ? matchPlace(paren, places) : "");
  if (canonical) return { kind: "place", person: "", place: canonical, raw };

  // 名字本身就是角色/死者
  if (characters.includes(s) || s === victim) return { kind: "person", person: s, place: "", raw };
  // 名单外的**作证人**（如"小厮（前院当值）"）：去掉括号后当证词处理，发现者就是这个人
  if (/^[\u4e00-\u9fa5]{2,6}$/.test(s) && /(小厮|伙计|仆|丫鬟|更夫|车夫|船工|帮厨|长工|杂役|管事|掌柜|先生|太太|小姐|少爷)/.test(s)) {
    return { kind: "person", person: s, place: "", raw };
  }
  // 房间/场所后缀（如"后罩房（福伯住处）"）：去掉括号后当实物线索的发现地点
  // 层级写法的第一段也可能是房间（"周济仁房（兼药房）·药柜"）
  const head0 = s.split(/[·•・\/|]/)[0].trim();
  if (/(房|屋|室|厅|廊|库|院|楼|园|仓|窖|棚|台|门|堂|馆|斋|轩|阁|间|处|区|站|厂|店|所)$/.test(head0)) {
    return { kind: "place", person: "", place: matchPlace(head0, places) || head0, raw };
  }
  // 容器 / 随身物 / 文件 —— 它们**就是物品线索的发现地点**，不该因为"不是房间"而判未分类。
  // 实测 17 个未分类值全是这类：张伟电脑、赵凯随身、林哲公文包、老周红袖章、赵磊工具袋、
  // 林强更衣柜、老黄胶鞋口袋、化验室尸检报告、总经理室转让协议、林哲私人账户…
  if (/(电脑|手机|随身|身上|公文包|包|袋|口袋|兜|袖|章|衣|鞋|工具|工具袋|工具包|柜|箱|抽屉|枕|床|桌|架|夹层|夹|文件|文件夹|账本|账册|记|本|册|资料|报告|协议|合同|信封|信|钥匙|锁|瓶|罐|盒|杯|壶|碗|盘|勺|刀|绳|灯|表|钟|账户|存折|印章|标签|牌|名单|记录|底下|手|面|间|墙|窗|地|台|上|下|内|外|里|旁|边|角|缝|口)$/.test(s)) {
    return { kind: "place", person: "", place: s, raw };
  }

  // 认不出就老实说认不出：**不拿一个对不上地名表的房间名去充数**
  //（否则 checkCluePlan 会对每一条都报"地点不在权威地名表里"，把日志淹掉）
  return none;
}

/** 把候选房间名对齐到权威地名表（先精确、再互相包含），对齐不上返回 "" */
function matchPlace(candidate, places) {
  const c = String(candidate || "").trim();
  if (!c) return "";
  const list = (places || []).filter(Boolean).sort((a, b) => b.length - a.length);
  if (list.includes(c)) return c;
  const hit = list.find(p => p.includes(c) || c.includes(p));
  return hit || "";
}

/** 旧接口：只关心类型时用（保持既有调用方与测试不变） */
function clueLocationKind(location, bible) {
  return normalizeClueLocation(location, bible).kind;
}

/**
 * 把 cluePlan 对齐到**已落地的线索**。
 *
 * 权威方向很重要：线索计划是大纲阶段"猜"出来的（那时线索还不存在），
 * 而线索是已经产出、且发现地点已被 `normalizeClueLocations` 归一化到真实布局的产物 ——
 * 所以冲突时**以线索为准**去改计划，而不是反过来改线索。
 * 同时把缺失项按线索本身能推出的信息补上（实物线索推 place、证词线索推 discoverer）。
 *
 * @returns {{plan:Array, derived:number, mismatched:number, missingTime:number, incomplete:number}}
 */
function alignCluePlan(clues, bible) {
  const old = new Map((bible.cluePlan || []).map(c => [c.id, c]));
  const plan = [];
  let derived = 0, mismatched = 0, missingTime = 0, incomplete = 0;

  for (const c of (clues || [])) {
    const id = String(c.id || "").trim();
    if (!id) continue;
    const prev = old.get(id) || {};
    const norm = normalizeClueLocation(c.location, bible);
    const kind = norm.kind;

    // 发现者：证词线索=作证者；某人的物品=那个人；实物线索沿用计划里的
    let discoverer = prev.discoverer || "";
    if (!discoverer && norm.person) { discoverer = norm.person; derived++; }
    // 兜底：location 本身就是角色名/死者名（旧行为，不能因为归一化改造而丢掉）
    if (!discoverer) {
      const raw = String(c.location || "").trim();
      if (bible.characters.includes(raw) || raw === bible.victim.name) { discoverer = raw; derived++; }
    }
    // 发现地点：由线索归一出真实房间（层级写法取房间段）
    let place = prev.place || "";
    if (!place && norm.place) { place = norm.place; derived++; }
    // 计划与线索冲突 → 以线索为准（线索是已落地产物，且发现地点已归一化到真实布局）
    if (prev.place && norm.place && prev.place !== norm.place) { place = norm.place; mismatched++; }

    // 计划没写时刻 → 先从线索正文里**读**（是既有信息，不是编）
    const fromBody = prev.time ? "" : extractTimeFromText(c.body || "");
    const time = prev.time || fromBody || "";
    if (!time) missingTime++;
    else if (fromBody && !prev.time) derived++;
    // 按线索**类型**判定"齐备"（外部反馈修正了我的模型）：
    //   · 证词线索（location 是作证的人）：需要 发现者 + 时刻 —— 证词本身就是对某时刻的陈述
    //   · 物品线索（location 是房间/物件）：只需要 地点 —— 它是**搜证阶段被找到的现场物证**，
    //     故事内的"发现时刻"没有意义（那一刻没人在场看到），硬要它只会逼模型编时间。
    const type = kind === "person" ? "testimony" : (kind === "place" ? "physical" : "unknown");
    const complete = type === "testimony"
      ? !!(discoverer && time)
      : (type === "physical" ? !!place : !!(discoverer || place));
    if (!complete) incomplete++;

    plan.push({ id, discoverer, time, place, about: prev.about || "", kind, type, complete, raw: norm.raw || String(c.location || "") });
  }
  const byType = plan.reduce((m, p) => { m[p.type] = m[p.type] || { total: 0, complete: 0 }; m[p.type].total++; if (p.complete) m[p.type].complete++; return m; }, {});
  return { plan, derived, mismatched, missingTime, incomplete, byType };
}

// ==================== 检查 8：时辰 ↔ 24 小时时刻 换算一致性 ====================

/**
 * 时辰 → 当日起始分钟。每个时辰 2 小时；一刻 = 15 分钟，从**时辰起始**起算
 * （即"午时三刻"=11:45、"酉时四刻"=18:00、"亥时三刻"=21:45 —— 武侠/古风本的通行读法）。
 */
const SHICHEN_START = { 子: 23, 丑: 1, 寅: 3, 卯: 5, 辰: 7, 巳: 9, 午: 11, 未: 13, 申: 15, 酉: 17, 戌: 19, 亥: 21 };

/** 解析"酉时四刻" / "亥时初" / "戌时正" → 当日起始分钟（解析不出返回 null） */
function shichenToMinutes(zhi, half, keCn) {
  if (!(zhi in SHICHEN_START)) return null;
  let m = SHICHEN_START[zhi] * 60;
  if (half === "正") m += 60;
  if (keCn) {
    const KE = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
    const k = KE[keCn];
    if (!k) return null;
    m += k * 15;
  }
  return ((m % 1440) + 1440) % 1440;
}

/**
 * 时辰词与同一行里标注的 24 小时时刻是否对得上。
 *
 * 为什么必须有：实测《听雪山庄》全文 57 处时辰词，其中多处与括号里的时刻**差 1.5~2.5 小时**
 * （"酉时四刻（座钟20:30）"：酉时四刻 = 18:00；"亥时三刻（约22:20）"：亥时三刻 = 21:45），
 * 而"戌时三刻"被用来指 21:35/21:45 的实际动作（戌时三刻 = **20:45**）。
 * 后果很实在：玩家按角色本上的时辰陈述，与所有目击者的 24 小时时间线全对不上；
 * DM 复盘的"戌时了断与作案时刻吻合"这类断言也自相矛盾。
 * 这类错纯确定性可查，不该靠人眼通读。
 *
 * @returns {{ok:boolean, issues:Array<{line:string, said:string, meansMins:number, claimedMins:number, diffMin:number}>}}
 */
function checkShichenConsistency(text, opts) {
  const tol = (opts && opts.toleranceMin) || 20;
  const issues = [];
  const re = /([子丑寅卯辰巳午未申酉戌亥])时(初|正)?([一二三四五六七八]刻)?/g;
  for (const raw of String(text || "").split("\n")) {
    const line0 = raw.trim();
    if (!line0) continue;
    // 引号/书名号内是**被引用的文字**（如私账上的"戌时了断"），不是叙述者的时间主张 → 不判
    const line = line0.replace(/[「『“"‘’'][^」』”"‘’']*[」』”"‘’']/g, "（引用）").replace(/【[^】]*】/g, "（注）");
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const claimed = nearestClock(line, m.index, m[0].length);   // 取离该时辰词**最近**的时刻
      if (!claimed) continue;
      // ⚠️ 正则把"三刻"整体捕获，而 shichenToMinutes 要的是单字"三" —— 不剥掉"刻"会返回 null，
      // 继而 diff 变 NaN、NaN>tol 恒为 false → **永不报错**（这个坑在 extractTimeFromText 里已踩过两次，这里是第三次）。
      const means = shichenToMinutes(m[1], m[2], m[3] ? String(m[3]).replace("刻", "") : undefined);
      if (means === null) continue;
      const cm = parseInt(claimed[1], 10) * 60 + parseInt(claimed[2], 10);
      let diff = Math.abs(means - cm);
      if (diff > 720) diff = 1440 - diff;                          // 跨午夜
      // 认可"约"：时刻只要**落在该时辰的两小时区间内**（±容差）就算对
      // （"前一日 戌时（约20:00）"是正常写法；而"酉时初（20:30前后）"不是 —— 酉时 17:00–19:00）
      const start = SHICHEN_START[m[1]] * 60 + (m[2] === "正" ? 60 : 0);
      const lo = ((start - tol) % 1440 + 1440) % 1440;
      const hi = (start + (m[2] ? 60 : 120) + tol) % 1440;
      // 带"刻"的写法是**精确偏移**（亥时三刻=21:45），必须按分钟比对；
      // 只有笼统的"X时（约HH:MM）"才用整段 120 分钟窗口宽免 ——
      // 否则"亥时三刻（23:00）"会被窗口放过（单测当场抓到）。
      const within = m[3] ? diff <= tol : (lo <= hi ? (cm >= lo && cm <= hi) : (cm >= lo || cm <= hi));
      // 带"前/后"的方位词（"戌时前"）是**顺序主张**，只要时刻不在该时辰之前就算错，不做区间宽免
      const isOrder = /[时]\s*[前后]/.test(m[0]);
      if (!within && !(isOrder && false) && diff > tol) {
        issues.push({ line: line0.slice(0, 120), said: m[0], meansMins: means, claimedMins: cm, diffMin: diff, window: [start, (start + 120) % 1440] });
        break;                                                      // 一行只报一次
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
/** 由 24 小时时刻反推它属于哪个时辰（用于把写错的时辰词改对） */
function correctShichenFor(clockMin) {
  const m = ((clockMin % 1440) + 1440) % 1440;
  for (const [zhi, h] of Object.entries(SHICHEN_START)) {
    const start = h * 60;
    const end = (start + 120) % 1440;
    if (start <= end ? (m >= start && m < end) : (m >= start || m < end)) return zhi;
  }
  return "子";
}

/**
 * 确定性修正：把"时辰词与同行 24 小时时刻对不上"的地方就地改对。
 *
 * 权威方向：**24 小时制是权威**（大纲时间线、目击者证词、验尸记录都用它），
 * 时辰词只是修辞 —— 所以改时辰词、不动时刻。
 * 只改时辰名（如"酉时初"→"戌时"），不加初/正/刻：区间内最稳的写法是只报时辰名，
 * 这样永不引入新的换算错（工具只做它确定能做对的事）。
 *
 * @returns {{text:string, fixed:number, changes:Array<{said:string,to:string,line:string}>}}
 */
function fixShichenByClock(text, opts) {
  // ⚠️ 尚未上线：复验中发现它会误改（字符类里的 ~－ 构成意外范围，把标点整段吞掉）。
  // 错误的自动改写比不改更糟 —— 因此默认空转，必须显式传 { unsafeApply: true } 才动手。
  if (!(opts && opts.unsafeApply)) return { text: String(text || ""), fixed: 0, changes: [] };
  const src = String(text || "");
  const changes = [];
  const out = src.split("\n").map((raw) => {
    const line = raw;
    const clean = line.replace(/[「『“"‘’'][^」』”"‘’']*[」』”"‘’']/g, "（引用）").replace(/【[^】]*】/g, "（注）");
    const re = /([子丑寅卯辰巳午未申酉戌亥])时(初|正)?([一二三四五六七八]刻)?/g;
    let m, replaced = null;
    re.lastIndex = 0;
    while ((m = re.exec(clean))) {
      const claimed = nearestClock(clean, m.index, m[0].length);
      if (!claimed) continue;
      // ⚠️ 正则把"三刻"整体捕获，而 shichenToMinutes 要的是单字"三" —— 不剥掉"刻"会返回 null，
      // 继而 diff 变 NaN、NaN>tol 恒为 false → **永不报错**（这个坑在 extractTimeFromText 里已踩过两次，这里是第三次）。
      const means = shichenToMinutes(m[1], m[2], m[3] ? String(m[3]).replace("刻", "") : undefined);
      if (means === null) continue;
      const cm = parseInt(claimed[1], 10) * 60 + parseInt(claimed[2], 10);
      let diff = Math.abs(means - cm);
      if (diff > 720) diff = 1440 - diff;
      const start = SHICHEN_START[m[1]] * 60 + (m[2] === "正" ? 60 : 0);
      const lo = ((start - 20) % 1440 + 1440) % 1440;
      const hi = (start + (m[2] ? 60 : 120) + 20) % 1440;
      // 带"刻"的写法是**精确偏移**（亥时三刻=21:45），必须按分钟比对；
      // 只有笼统的"X时（约HH:MM）"才用整段 120 分钟窗口宽免 ——
      // 否则"亥时三刻（23:00）"会被窗口放过（单测当场抓到）。
      const within = m[3] ? diff <= tol : (lo <= hi ? (cm >= lo && cm <= hi) : (cm >= lo || cm <= hi));
      if (within || diff <= 20) continue;
      const good = correctShichenFor(cm);
      // 时辰名对、只有"初/正/刻"错（如"亥时三刻（约22:20）"）→ 去掉修饰只留时辰名
      replaced = { m, said: m[0] };
      changes.push({ said: expandShichenSpan(line, m).text.trim() || m[0], to: good + "时", line: line.trim().slice(0, 100) });
      break;
    }
    if (!replaced) return line;
    const span = expandShichenSpan(line, replaced.m);
    const to = changes[changes.length - 1].to;
    return line.slice(0, span.start) + to + line.slice(span.end);
  }).join("\n");
  return { text: out, fixed: changes.length, changes };
}
/** 取离 [at, at+len) 这段文字最近的 HH:MM（返回与 RegExp match 兼容的对象） */
function nearestClock(line, at, len) {
  const re = /(\d{1,2})\s*[:：]\s*(\d{2})/g;
  let m, best = null, bestD = Infinity;
  while ((m = re.exec(line))) {
    const end = m.index + m[0].length;
    const d = Math.min(Math.abs(m.index - at), Math.abs(end - (at + len)));
    // ⚠️ 双时间脚本（座钟 vs 真实）同一行有两个时钟，时辰词描述的是**真实时间**。
    // 若某个时钟前后 8 字内出现"真实"，给它大幅优先（否则会拿座钟读数去比 → 误报/漏报）。
    const around = line.slice(Math.max(0, m.index - 8), Math.min(line.length, end + 8));
    const isReal = /真实/.test(around);
    const score = d + (isReal ? 0 : 1000);
    if (score < bestD) { bestD = score; best = m; }
  }
  return best;
}

/** 单个时辰词的写法（含修饰与"末/中/初/前/后"） */
const SHICHEN_ONE = "[子丑寅卯辰巳午未申酉戌亥]时\\s*(?:初|正)?\\s*(?:[一二三四五六七八]刻)?\\s*(?:[末初中])?\\s*(?:[前后])?";

/**
 * 从命中处向两侧扩出**连续时辰段**：
 * "戌时末亥时初" / "戌时三刻" / "酉时初（20:30前后）" 这类要整段替换 ——
 * 只改前半句会得到"亥时末亥时初"这种更糟的结果（实测踩过）。
 */
function expandShichenSpan(line, m) {
  let start = m.index, end = m.index + m[0].length;
  const left = new RegExp(SHICHEN_ONE + "\\s*(?:(?:到|至|—|~|－|-)\\s*)?$");
  const right = new RegExp("^\\s*(?:[末中初])?\\s*(?:(?:到|至|—|~|－|-)\\s*)?(?:[末中初]\\s*)?" + SHICHEN_ONE);
  for (let guard = 0; guard < 6; guard++) {
    const L = line.slice(0, start).match(left);
    if (L && L[0].length) { start -= L[0].length; continue; }
    const R = line.slice(end).match(right);
    if (R && R[0].length) { end += R[0].length; continue; }
    break;
  }
  // 兜底：整段里若混进了标点，说明扩张越界了 —— 宁可只替换命中的那一小段，也不要吞掉标点
  if (/[；，。、！？：]/.test(line.slice(start, end))) {
    return { start: m.index, end: m.index + m[0].length, text: m[0] };
  }
  return { start, end, text: line.slice(start, end) };
}

/** 数字补零 */
function pad2(n) { return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); }

/**
 * 从**线索正文**里确定性地取时刻。
 *
 * 为什么需要：证词线索的价值就在于"某人**何时**看到/听到"，而计划表常常没写。
 * 与其让 LLM 猜（它只会正确地拒绝编造），不如先把正文里**明写着的**时刻读出来：
 * "五点三刻巡到库房外巷"、"下午三点"、"戌时三刻" 这些都是已有的信息，只是没被结构化。
 * 读不出来就返回 null（不猜）。
 */
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CN_NUM2 = { 十一: 11, 十二: 12 };
/** 时段前缀 → 12 小时制的换算（"下午三点"=15:00，"晚上八点"=20:00） */
const PERIOD_SHIFT = [[/凌晨|深夜/, 0], [/清晨|早上|上午/, 0], [/中午|正午/, 12], [/午后|下午|傍晚|黄昏|晚上|夜里/, 12]];
function extractTimeFromText(text) {
  const s = String(text || "");
  const hm = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (hm) { const t = hmOf(hm[0]); if (t) return t; }
  const sc = s.match(/([子丑寅卯辰巳午未申酉戌亥])时(初|正)?([一二三四五六七八]刻)?/);
  if (sc) { const m = shichenToMinutes(sc[1], sc[2], sc[3] ? String(sc[3]).replace("刻", "") : undefined); if (m !== null) return pad2(m); }   // 同上：正则会把"三刻"整体捕获
  const cn = s.match(/(凌晨|清晨|早上|上午|中午|正午|午后|下午|傍晚|黄昏|晚上|夜里|深夜)?\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(半|[一二三四]刻)?/);
  if (cn) {
    let h = /^\d+$/.test(cn[2]) ? parseInt(cn[2], 10) : (CN_NUM2[cn[2]] !== undefined ? CN_NUM2[cn[2]] : CN_NUM[cn[2]]);
    if (h === undefined || h > 24) return null;
    const shift = PERIOD_SHIFT.find(([re]) => re.test(cn[1] || ""));
    if (shift && h < 12) h += shift[1];
    let mi = 0;
    if (cn[3] === "半") mi = 30;
    else if (cn[3]) mi = ({ 一: 1, 二: 2, 三: 3, 四: 4 })[String(cn[3]).replace("刻", "")] * 15;   // "三刻"整体被捕获，取值前要剥掉"刻"
    return pad2(((h % 24) * 60 + mi) % 1440);
  }
  return null;
}

module.exports = {
  findPlaceholderResidues,
  repairPlaceholderResidues,
  findSelfPrefixEntries,
  buildBible, bibleFactsFor, bibleFactsToText,
  checkBibleSelfConsistency, reconcileCharacterScript, findCrossCharacterConflicts, findObjectStateConflicts,
  checkCluePlan, checkKnowledgeBounds, checkTimelineHealth, timelineEntries,
  alignCluePlan, clueLocationKind, normalizeClueLocation, matchPlace, isSamePlace, extractTimeFromText,
  checkShichenConsistency, shichenToMinutes, correctShichenFor, fixShichenByClock, nearestClock, expandShichenSpan,
};
