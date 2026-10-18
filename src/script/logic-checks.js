// 逻辑层确定性校验 —— 补上"管道自检查不出来"的四类问题。
//
// 为什么需要它（2026-10-18 实测，对生成稿逐字读出来的）：
//   ① 凶手剧本自相矛盾：`### 四、凶手确认` 写"21:30 制作勒颈陷阱"，
//      而 `### 二、你的时间线` 的 21:30 是"翻抽屉找发条"、22:35 是"我听见闷响跑过去"——
//      凶手玩家会以为自己是目击者。管道的交叉校验报了这条，但修订没修掉。
//   ② 「座钟」在不同角色剧本里含义相反：凶手写 `（真实，座钟20:55）`（被调慢的钟），
//      其他人写 `（座钟）`（真实时间）——跨角色对时间整体错 15 分钟，玩家不可能发现。
//   ③ 真相复盘的算术不自洽："维修间挂钟显示20:55，说明慢了15分钟"（差 0）、
//      "前厅挂钟正常走时，22:30显示22:45"（正常却快 15）、"22:60"（不存在的时刻）。
//   ④ 真相自称"全部线索逐条解析（共22条，无遗漏）"，而库里是 40 条，且编号对不上。
//
// 这四类都**不需要 LLM**，纯字符串与算术就能判 —— 所以它们必须由确定性代码把关，
// 否则会一路通过管道进入成稿（实测就是这样）。
const CLOCK_RE = /(\d{1,2})\s*[:：]\s*(\d{1,2})/g;
const METHOD_KW = /陷阱|发条|勒|调慢|调快|下毒|投毒|放毒|氰化物|扳机|动手|推下|砸|刺|掐|捂|挂钟|座钟/;
const ACT_VERB = /做|制作|安装|布置|设定|固定|系上|系|绕|调|下|放|投|砸|勒|刺|推|捂|掐|动手|触发|拉|引|带|骗/;

/** 一行里出现的所有时刻 */
function clocksIn(line) {
  const out = [];
  CLOCK_RE.lastIndex = 0;
  let m;
  while ((m = CLOCK_RE.exec(line)) !== null) {
    const h = Number(m[1]), mi = Number(m[2]);
    out.push({ h, mi, minutes: h * 60 + mi, raw: m[0] });
  }
  return out;
}

/** 环形时间差（分钟，0..720） */
function ringDiff(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/** 时刻是否合法（分钟 ≥ 60 就是"22:60"这类错误） */
function illegalClocks(text) {
  const bad = [];
  for (const line of String(text || "").split("\n")) {
    CLOCK_RE.lastIndex = 0;
    let m;
    while ((m = CLOCK_RE.exec(line)) !== null) {
      if (Number(m[2]) > 59) bad.push({ raw: m[0], line: line.trim().slice(0, 120) });
    }
  }
  return bad;
}

/** 把 `22:60` 这类非法时刻规范化成 `23:00`（确定性修复，不动别的字） */
function fixIllegalClockTimes(text) {
  let fixed = 0;
  const out = String(text || "").replace(/(\d{1,2})\s*[:：]\s*(\d{2,})/g, (all, h, mi) => {
    const m = Number(mi);
    if (m <= 59) return all;
    const total = (Number(h) * 60 + m) % 1440;
    const nh = Math.floor(total / 60), nm = total % 60;
    fixed++;
    return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
  });
  return { text: out, fixed };
}

/** 抽出角色本里的时间线条目（行首是时刻，允许「10月21日 21:30」这种带日期的写法） */
function timelineEntries(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    // ⚠️ 必须容忍日期前缀：真实剧本写的是 `- **10月21日 21:30（真实，座钟21:15）**：…`，
    //    第一版只认行首时刻，于是一条都抽不到 —— 校验形同虚设（被单测当场抓出）。
    const m = s.match(/^[-*•]?\s*\**\s*(?:\d{1,2}\s*月\s*\d{1,2}\s*日\s*)?(\d{1,2})\s*[:：]\s*(\d{2})/);
    if (!m) continue;
    out.push({ minutes: Number(m[1]) * 60 + Number(m[2]), text: s });
  }
  return out;
}

/**
 * ① 凶手的手法必须落在自己的时间线里。
 * 从凶手的「凶手确认/作案过程/手法」段落取出**带时刻的手法声明**，
 * 再去他的时间线里找同一时刻的条目：该条目必须同时出现手法词与动作词。
 */
function checkMurdererMethodInTimeline(opts) {
  const o = opts || {};
  const sections = o.sections || [];
  const name = o.murdererName;
  const sec = sections.find((s) => s.name === name) || sections.find((s) => /凶手|确认/.test(s.name));
  if (!sec) return [];
  const text = String(sec.text || "");
  const issues = [];
  // 手法声明：优先取「凶手确认」章节；没有就全文找
  const mSection = text.split(/###\s*[^\n]*(?:凶手确认|作案过程|手法)[^\n]*\n/)[1] || text;
  const claims = [];
  for (const seg of mSection.split(/[；;\n]/)) {
    const cs = clocksIn(seg);
    if (!cs.length) continue;
    if (!METHOD_KW.test(seg) || !ACT_VERB.test(seg)) continue;
    claims.push({ minutes: cs[0].minutes, text: seg.trim().slice(0, 80) });
  }
  if (!claims.length) {
    return [`【逻辑·凶手手法】${name} 的「凶手确认」里找不到带时刻的手法声明，无法核对时间线是否落地`];
  }
  const entries = timelineEntries(text);
  for (const c of claims.slice(0, 8)) {
    const hit = entries.find((e) => e.minutes === c.minutes);
    if (!hit) {
      issues.push(`【逻辑·凶手手法】${name} 手法声明要求 ${fmtHM(c.minutes)} 做「${c.text}」，但时间线里没有这个时刻的条目`);
      continue;
    }
    if (!METHOD_KW.test(hit.text) || !ACT_VERB.test(hit.text)) {
      issues.push(`【逻辑·凶手手法】${name} 时间线 ${fmtHM(c.minutes)} 与手法声明不一致：声明是「${c.text}」，时间线写的是「${hit.text.slice(0, 60)}」`);
    }
  }
  return issues;
}

/** ② 时间基准（座钟/挂钟等）在全剧本里必须只有一个偏差，且不能"同一个词两种含义" */
function checkTimeBaseConsistency(opts) {
  const sections = (opts && opts.sections) || [];
  const anchorRe = /[（(]\s*真实\s*[，,]\s*([^\d）)]{0,6}?)\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[）)]/g;
  const termDeltas = new Map();   // term -> Set(delta)
  const termPlainUsers = new Map(); // term -> Set(角色名) 只以「（term）」形式出现
  const issues = [];

  for (const s of sections) {
    const text = String(s.text || "");
    for (const line of text.split("\n")) {
      const real = clocksIn(line)[0];
      if (!real) continue;
      anchorRe.lastIndex = 0;
      let m;
      while ((m = anchorRe.exec(line)) !== null) {
        const term = (m[1] || "").trim();
        if (!term) continue;
        const ann = Number(m[2]) * 60 + Number(m[3]);
        let delta = ((ann - real.minutes) % 1440 + 1440) % 1440;
        if (delta > 720) delta -= 1440;
        if (!termDeltas.has(term)) termDeltas.set(term, new Set());
        termDeltas.get(term).add(delta);
      }
    }
  }
  // 只以「（术语）」出现、没有真实锚点的用法
  for (const s of sections) {
    const text = String(s.text || "");
    for (const m of text.matchAll(/[（(]\s*(座钟|挂钟|怀表|手表)\s*[）)]/g)) {
      const term = m[1];
      if (!termPlainUsers.has(term)) termPlainUsers.set(term, new Set());
      termPlainUsers.get(term).add(s.name);
    }
  }

  for (const [term, set] of termDeltas) {
    if (set.size > 1) {
      issues.push(`【逻辑·时间基准】「${term}」被赋了多个偏差值（${[...set].map((d) => (d > 0 ? "+" : "") + d + "分").join("、")}），跨角色对时会错位`);
    }
  }
  for (const [term, users] of termPlainUsers) {
    const anchored = termDeltas.has(term);
    const plainOnly = [...users].filter((u) => !(sections.find((s2) => s2.name === u && /（\s*真实/.test(String(s2.text || "")))));
    if (anchored && plainOnly.length) {
      issues.push(`【逻辑·时间基准】「${term}」在部分角色剧本里是"被调过的钟"（带真实时间锚点），在 ${plainOnly.join("、")} 的剧本里却当真实时间用 —— 同一术语两种含义`);
    }
  }
  return issues;
}

/** ③ 真相复盘里的时间算术必须自洽（非法时刻 + 同一挂钟偏差唯一 + 双时刻差值声明） */
function checkTruthArithmetic(truthText) {
  const t = String(truthText || "");
  const issues = [];
  for (const bad of illegalClocks(t)) {
    issues.push(`【逻辑·时间算术】出现不存在的时刻「${bad.raw}」：${bad.line}`);
  }
  // 同一只钟在同一份真相里只能有一个偏差值。
  // 实测缺陷：线索1 说「真实20:55、前厅挂钟显示21:00」（+5），
  // 结论句说「死亡时间22:35、前厅挂钟显示22:45」（+10）—— 同一只钟两个偏差，
  // 玩家按哪句算都会和另一句打架。
  const offsets = new Map();   // 钟名 -> Map(偏差 -> 次数)
  const CLOCK_NAME = /([^\s，,。；;：:（(]{0,8}?(?:挂钟|座钟|怀表|手表))[^\d]{0,6}(\d{1,2})\s*[:：]\s*(\d{2})/g;
  for (const raw of t.split(/[。\n；;]/)) {
    const sent = raw.trim();
    if (sent.length < 8) continue;
    const cs = clocksIn(sent);
    const realM = sent.match(/(?:真实时间|真实)\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    const deathM = sent.match(/死亡时间\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
    const real = realM ? (Number(realM[1]) * 60 + Number(realM[2]))
      : (deathM ? (Number(deathM[1]) * 60 + Number(deathM[2])) : null);
    if (real !== null) {
      CLOCK_NAME.lastIndex = 0;
      let m;
      while ((m = CLOCK_NAME.exec(sent)) !== null) {
        const name = m[1].trim();
        if (!name) continue;
        const val = Number(m[2]) * 60 + Number(m[3]);
        let d = ((val - real) % 1440 + 1440) % 1440;
        if (d > 720) d -= 1440;
        if (!offsets.has(name)) offsets.set(name, new Map());
        offsets.get(name).set(d, (offsets.get(name).get(d) || 0) + 1);
      }
    }
    // 恰好两个时刻 + "差N分钟/慢N分钟" → 直接验算（保守，不多判）
    const claim = sent.match(/差\s*(\d+)\s*分钟/) || sent.match(/(?:慢|快)了?\s*(\d+)\s*分钟/);
    if (claim && cs.length === 2) {
      const d = ringDiff(cs[0].minutes, cs[1].minutes);
      if (d !== Number(claim[1])) {
        issues.push(`【逻辑·时间算术】「${sent.slice(0, 70)}」：文中说差 ${claim[1]} 分钟，实际两个时刻（${cs[0].raw} / ${cs[1].raw}）相差 ${d} 分钟`);
      }
    }
  }
  for (const [name, map] of offsets) {
    if (map.size > 1) {
      issues.push(`【逻辑·时间算术】「${name}」在同一份真相里被赋了多个偏差值（${[...map.keys()].map((d) => (d > 0 ? "+" : "") + d + "分").join("、")}），玩家按哪句算都和另一句打架`);
    }
  }
  return issues;
}

/** ④ 真相必须覆盖绝大多数线索，且编号要与库里的线索编号对得上 */
function checkTruthClueCoverage(truthText, clueIds) {
  const ids = (clueIds || []).filter(Boolean);
  if (!ids.length) return [];
  const t = String(truthText || "");
  const issues = [];
  const mentioned = new Set();
  for (const m of t.matchAll(/(?:^|[^A-Za-z0-9])([AB]\d{1,3})(?![0-9])/g)) mentioned.add(m[1]);
  const hit = ids.filter((id) => mentioned.has(id)).length;
  const rate = hit / ids.length;
  if (rate < 0.8) {
    issues.push(`【逻辑·线索覆盖】真相只提到 ${hit}/${ids.length} 条线索（${Math.round(rate * 100)}%），低于 80% —— 玩家复盘时对不齐自己搜到的线索`);
  }
  const unknown = [...mentioned].filter((id) => !ids.includes(id));
  if (mentioned.size && unknown.length > ids.length * 0.3) {
    issues.push(`【逻辑·线索覆盖】真相用了 ${unknown.length} 个不存在的线索编号（如 ${unknown.slice(0, 5).join("、")}），与库里的编号体系对不上`);
  }
  const claim = t.match(/共\s*(\d+)\s*条/);
  if (claim && Number(claim[1]) !== ids.length) {
    issues.push(`【逻辑·线索覆盖】真相自称"共${claim[1]}条"，实际线索是 ${ids.length} 条`);
  }
  return issues;
}

function fmtHM(minutes) {
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 一把跑完，返回 { issues, fixed, details } */
function runLogicChecks(opts) {
  const o = opts || {};
  const sections = o.sections || [];
  const issues = [];
  const details = {};
  try { details.method = checkMurdererMethodInTimeline({ sections, murdererName: o.murdererName }); issues.push(...details.method); }
  catch (e) { details.methodError = e.message; }
  try { details.timeBase = checkTimeBaseConsistency({ sections }); issues.push(...details.timeBase); }
  catch (e) { details.timeBaseError = e.message; }
  try { details.arithmetic = checkTruthArithmetic(o.dmText || ""); issues.push(...details.arithmetic); }
  catch (e) { details.arithmeticError = e.message; }
  try { details.coverage = checkTruthClueCoverage(o.dmText || "", o.clueIds || []); issues.push(...details.coverage); }
  catch (e) { details.coverageError = e.message; }
  return { issues, details };
}

module.exports = {
  clocksIn, ringDiff, illegalClocks, fixIllegalClockTimes, timelineEntries,
  checkMurdererMethodInTimeline, checkTimeBaseConsistency, checkTruthArithmetic, checkTruthClueCoverage,
  runLogicChecks, fmtHM, METHOD_KW, ACT_VERB,
};
