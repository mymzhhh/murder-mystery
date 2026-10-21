/**
 * 难度校验：剧本不能"一眼看穿凶手"。
 *
 * 为什么需要（2026-10-20 用户需求："不能一眼看过去就知道凶手及手法"）：
 *   语义评审 rubric 的三本自评里，「唯一锁定」三本都是 2/3 ——
 *   删掉一两条关键线索仍能推出凶手，说明**证据过度集中在凶手身上**：
 *   其他人各 0–1 条线索指向，凶手却有 5 条，玩家扫一眼线索表就锁定了。
 *
 * 三条确定性判据（全部可自动检测，不依赖语义判断）：
 *   ① **证据不均衡**：凶手被点名的线索数 > 其他人最高值的 2 倍 + 1 → 太显眼
 *   ② **有人被白送排除**：某个非凶手嫌疑人一条线索都没被提到 → 等于帮他洗清
 *   ③ **缺少"最后一块拼图"**：凶手的关键线索全部摆在明面上，没有一条藏在隐藏子线索里
 *      → 玩家第一轮就能定案，第二轮的深入调查失去意义
 *
 * 注意：这里数的是"线索文本里出现了这个人名"，是**粗糙代理**。
 * 真实嫌疑强度还取决于线索内容（"袖口有血迹"远比"认识死者"重），
 * 所以本检查只做"明显失衡"的兜底告警，不做精细打分。
 */

/** 线索正文里是否点名了某个角色 */
function mentions(clue, name) {
  const text = String((clue && (clue.content || clue.text || clue)) || "");
  if (!name) return false;
  return text.includes(name);
}

/** 线索是否属于隐藏子线索（父线索的深入调查产物） */
function isHiddenChild(clue) {
  if (!clue) return false;
  if (clue.hiddenBehind || clue.hidden_behind) return true;
  const own = String((clue.content || clue.text || clue) || "");
  // 子线索的标记写在**它自己的正文**里：「（通过深入调查A1「…」获取）」
  // 反过来，若别的线索引用了本条的编号，说明本条是**父线索**，不能算隐藏子线索。
  return /通过深入调查\s*[A-Za-z]?\d+/.test(own);
}

/**
 * @param {object} p
 * @param {Array} p.clues       线索数组（每项含 id + content，可选 hiddenBehind）
 * @param {Array} p.characters  角色名数组
 * @param {string} p.murderer   凶手名
 * @returns {{ok:boolean, issues:string[], stats:object}}
 */
function checkEvidenceBalance({ clues, characters, murderer }) {
  const list = Array.isArray(clues) ? clues : [];
  const chars = (Array.isArray(characters) ? characters : []).filter(Boolean);
  const killer = String(murderer || "").trim();
  const issues = [];
  const stats = { counts: {}, killer: 0, maxOther: 0, hiddenKillerClues: 0 };

  if (!list.length || !killer) {
    return { ok: true, issues: [], stats };
  }

  // 统计每个角色被多少条线索点名（凶手本人可能也在 characters 里，分开算）
  const counts = {};
  for (const name of chars) {
    counts[name] = list.filter((c) => mentions(c, name)).length;
  }
  if (!(killer in counts)) counts[killer] = list.filter((c) => mentions(c, killer)).length;
  stats.counts = counts;
  stats.killer = counts[killer] || 0;

  const others = Object.entries(counts).filter(([n]) => n !== killer).map(([, v]) => v);
  stats.maxOther = others.length ? Math.max(...others) : 0;

  // ① 证据不均衡
  if (stats.killer > stats.maxOther * 2 + 1) {
    issues.push(
      `【难度·证据失衡】指向凶手的线索 ${stats.killer} 条，其他人最多 ${stats.maxOther} 条 —— ` +
      `玩家扫一眼线索表就会锁定凶手。请给其他嫌疑人各补至少 1 条"看起来同样致命"的线索，` +
      `或把凶手的一部分线索改成"也能用别的方式解释"。`
    );
  }

  // ② 有人被白送排除
  const naked = Object.entries(counts).filter(([n, v]) => n !== killer && v === 0).map(([n]) => n);
  if (naked.length) {
    issues.push(
      `【难度·有人被白送排除】${naked.join("、")} 一条线索都没有指向 —— 等于帮他们洗清嫌疑，` +
      `嫌疑人范围被白减。请给他们各安排至少 1 条可疑线索。`
    );
  }

  // ③ 缺少"最后一块拼图"
  const killerClues = list.filter((c) => mentions(c, killer));
  stats.hiddenKillerClues = killerClues.filter((c) => isHiddenChild(c)).length;
  if (killerClues.length && stats.hiddenKillerClues === 0) {
    issues.push(
      `【难度·缺最后一块拼图】指向凶手的 ${killerClues.length} 条线索全在明面上，` +
      `没有一条藏在隐藏子线索里 —— 玩家第一轮就能定案。请把其中最关键的一条` +
      `（能排除最强误导的那条）挪到「深入调查」里。`
    );
  }

  return { ok: issues.length === 0, issues, stats };
}

// ==================== 两轮线索的"分工"校验 ====================
// 2026-10-20 用户明确要求：
//   · 第一轮 = **杀机轮**：揭露每个人的杀机与关系，不摆杀人物证；
//   · 第二轮 = **指凶轮**：才出现尸体与手法证据，且必须结合各人剧本才能推出凶手；
//   · 线索不能太明显：任何**单条**都不得同时含"凶手名 + 手法"，否则一眼定案。
//
// 轮次判定：A 系列 = 第一轮，B 系列 = 第二轮（与 play 端 parser 一致）；
// 若线索自带 round 字段则以它为准。

// 动机/关系词（2026-10-20 补全：实测「私拿窖藏花雕…报官则按窃盗论」这种把柄也是动机，
// 旧词表没有「私拿/窃盗/报官」，把王顺的动机线索误判成「缺杀机」）
const MOTIVE_RE = /欠|债|借据|当票|威胁|勒索|争吵|争执|仇|恨|嫉妒|私情|秘密|把柄|辞退|扣|亏空|家产|继承|婚约|悔婚|丑闻|名声|旧怨|恩怨|分账|侵吞|私拿|私藏|窃|盗|报官|告发|被告|赔付|赔偿|抵押|典当|赶走|逐出|丑事|隐情|怕被|不敢/;
const KILLING_RE = /血迹|血痕|喷溅|创口|伤口|尸斑|尸僵|勒痕|钝器|锐器|凶器|毒|砒霜|吗啡|砒|锤|扳手|镇纸|刀|刃|溺|掐|窒息|骨裂|凹陷|致命|死于/;
// 手法/机关类词：真实剧本里"怎么做到的"往往不写成血迹，而写成"线/闩/机关/撬/换"
const METHOD_RE = /钓线|鱼线|绳索|绳子|麻绳|绳结|机关|闩|插销|锁舌|锁扣|撬|钳|螺丝|铁钉|钉|钩|滑轮|配重|冰块|冰锥|蜡|胶|缝|换|调换|伪装|伪造|布置|移尸|拖|擦|刷|洗|水渍|纤维|粉末|残渣/;

function roundOf(clue) {
  const r = Number((clue && (clue.round || clue.roundNo)) || 0);
  if (r === 1 || r === 2) return r;
  const id = String((clue && clue.id) || "").trim().toUpperCase();
  if (/^A\d+/.test(id)) return 1;
  if (/^B\d+/.test(id)) return 2;
  return 0;
}

function textOf(clue) {
  return String((clue && (clue.content || clue.text || clue)) || "");
}

/**
 * @returns {{ok:boolean, issues:string[], stats:object}}
 */
function checkRoundPurpose({ clues, characters, murderer }) {
  const list = Array.isArray(clues) ? clues : [];
  const chars = (Array.isArray(characters) ? characters : []).filter(Boolean);
  const killer = String(murderer || "").trim();
  const issues = [];
  const stats = { round1: 0, round2: 0, motivePerSuspect: {}, round1Killing: [], singleClueGiveaway: [], killerEvidenceCount: 0 };

  if (!list.length) return { ok: true, issues: [], stats };

  const r1 = [];
  const r2 = [];
  for (const c of list) {
    const r = roundOf(c);
    if (r === 1) r1.push(c);
    else if (r === 2) r2.push(c);
  }
  stats.round1 = r1.length;
  stats.round2 = r2.length;
  if (!r1.length || !r2.length) return { ok: true, issues: [], stats };

  // ① 第一轮不该出现杀人/尸体/凶器类证据
  for (const c of r1) {
    const m = KILLING_RE.exec(textOf(c));
    if (m) stats.round1Killing.push(`${c.id || "?"}（「${m[0]}」）`);
  }
  if (stats.round1Killing.length > 1) {
    issues.push(
      `【轮次分工·第一轮提前给答案】第一轮里有 ${stats.round1Killing.length} 条线索含杀人/尸体/凶器类证据：` +
      `${stats.round1Killing.slice(0, 5).join("、")}。第一轮只该揭露**杀机与关系**，` +
      `尸体与手法证据一律留到第二轮——否则玩家第一轮就拿到物证，后面不用推理了。`
    );
  }

  // ② 每个非凶手嫌疑人，第一轮至少要有一条揭示杀机的线索
  const missing = [];
  for (const name of chars) {
    if (!name || name === killer) continue;
    const hit = r1.some((c) => textOf(c).includes(name) && MOTIVE_RE.test(textOf(c)));
    stats.motivePerSuspect[name] = hit ? 1 : 0;
    if (!hit) missing.push(name);
  }
  if (missing.length) {
    issues.push(
      `【轮次分工·缺杀机】第一轮没有揭示 ${missing.join("、")} 的杀机线索 —— ` +
      `第一轮的作用就是"人人都有动机"，把嫌疑人摊平。请给这些人各补一条能看出动机/关系的线索` +
      `（欠债、威胁、旧怨、私情、把柄等），且不要写与杀人手法有关的内容。`
    );
  }

  // ③ 第二轮：单条不得同时含"凶手名 + 手法"
  for (const c of r2) {
    const t = textOf(c);
    if (killer && t.includes(killer) && KILLING_RE.test(t)) stats.singleClueGiveaway.push(String(c.id || "?"));
  }
  if (stats.singleClueGiveaway.length) {
    issues.push(
      `【轮次分工·线索太明显】第二轮有线索同时写出凶手姓名与手法/凶器（${stats.singleClueGiveaway.slice(0, 4).join("、")}），` +
      `单条就能定案。请把"谁"和"怎么做的"拆到两条不同线索里，并且让"归属"这一步必须结合该角色的剧本` +
      `（例如线索只写"账房抽屉夹层里有钓线"，谁能接触到账房抽屉要看角色剧本）。`
    );
  }

  // ④ 第二轮的指凶证据必须分散在 ≥2 条
  // 决定性线索：点名凶手、或含尸体/凶器词、或描述手法机关
  const decisive = (c) => {
    const t = textOf(c);
    return (killer && t.includes(killer)) || KILLING_RE.test(t) || METHOD_RE.test(t);
  };
  const killerEvidence = r2.filter(decisive).length;
  stats.killerEvidenceCount = killerEvidence;
  if (killerEvidence < 2) {
    issues.push(
      `【轮次分工·证据太薄】第二轮只有 ${killerEvidence} 条线索指向真相 —— ` +
      `要求"结合每个人的剧本 + 全部线索才能推出"，至少需要 2 条互相印证的证据。`
    );
  }

  return { ok: issues.length === 0, issues, stats };
}

module.exports = {
  checkEvidenceBalance, checkRoundPurpose, mentions, isHiddenChild, roundOf,
  MOTIVE_RE, KILLING_RE,
};
