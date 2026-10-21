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

module.exports = { checkEvidenceBalance, mentions, isHiddenChild };
