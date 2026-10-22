/**
 * 时间线一致性**确定性自愈**（2026-10-22，用户实测《听雨书寓6月18日夜》"时间线对不上"的根因修复）。
 *
 * 两个缺陷都不是模型幻觉，是代码/模板漏洞：
 *   ① 权威表里 actor=「所有人」的事件（21:20 看尸体、22:30 集合梳理线索）
 *      从来不是任何角色的必覆盖锚点 —— 旧 characterAnchors 只认"desc 里出现该角色名"。
 *      结果苏晚晴的时间线停在 22:00，别人都有 22:30，读起来就是"她缺席了那场戏"。
 *   ② 死者有化名（顾松亭 = 对外伪装成伙计阿庆）时，同一本里两个名字混用
 *      （江砚 12 次真名 / 周阿贵 7 真 1 假混着写），玩家会当成两个人。
 *
 * 这里给的是**不依赖模型**的修复：生成后直接改文本，改完再核对。
 * 提示词里的规则（锚点注入、称呼统一）仍然保留，但不再把正确性押在模型身上。
 *
 * 与 timeline-consistency.js 的分工：那个是用 LLM 做整段校准（贵、可能失败）；
 * 这个只做两件确定的事，幂等、可单测、失败不影响主流程。
 */

/** 时间线行：`- **6月18日 22:30**：地点 — 内容` */
const TL_LINE_RE = /^-\s*\*\*(\d{1,2}月\d{1,2}日)\s*(\d{1,2}:\d{2})\*\*[：:]/;

/**
 * ① 统一时间线里死者称呼：混用时按**多数派**统一。
 * 只有真名和化名都出现才动手（那才是"混用"）；只出现一个 → 原样返回。
 *
 * @returns {{text:string, changed:number, from:string, to:string}}
 */
function unifyVictimAliasInTimeline(text, { realName, alias } = {}) {
  const src = String(text || "");
  const real = String(realName || "").trim();
  const al = String(alias || "").trim();
  if (!src || !real || !al || real === al) return { text: src, changed: 0, from: "", to: "" };

  const lines = src.split("\n");
  let realN = 0, aliasN = 0;
  for (const line of lines) {
    if (!TL_LINE_RE.test(line)) continue;
    realN += (line.match(new RegExp(real, "g")) || []).length;
    aliasN += (line.match(new RegExp(al, "g")) || []).length;
  }
  if (!realN || !aliasN) return { text: src, changed: 0, from: "", to: "" };

  const [from, to] = realN >= aliasN ? [al, real] : [real, al];
  let changed = 0;
  const out = lines.map((line) => {
    if (!TL_LINE_RE.test(line)) return line;
    const n = (line.match(new RegExp(from, "g")) || []).length;
    if (!n) return line;
    changed += n;
    return line.split(from).join(to);
  });
  return { text: out.join("\n"), changed, from, to };
}

/**
 * ② 补齐全员事件：缺哪条补哪条，插在时间顺序正确的位置；已有的跳过（幂等）。
 *
 * @param {string} text 角色本正文
 * @param {{events:Array<{time,place,desc}>, caseDate?:string, pov?:(ev)=>string}} p
 * @returns {{text:string, added:Array<{time:string,line:string}>}}
 */
function ensureCollectiveAnchors(text, { events, caseDate, pov } = {}) {
  const src = String(text || "");
  const list = (events || []).filter((e) => e && e.time);
  if (!src || !list.length) return { text: src, added: [] };
  const date = String(caseDate || "").trim() ||
    ((src.match(/(\d{1,2}月\d{1,2}日)/) || [])[1] || "");

  const lines = src.split("\n");
  const existing = [];
  lines.forEach((line, i) => {
    const m = TL_LINE_RE.exec(line);
    if (m) existing.push({ time: m[2], index: i });
  });
  if (!existing.length) return { text: src, added: [] };
  const have = new Set(existing.map((e) => e.time));

  const added = [];
  const inserts = [];
  for (const ev of list) {
    if (have.has(ev.time)) continue;
    const place = String(ev.place || "").trim() || "现场";
    const body = typeof pov === "function"
      ? pov(ev)
      : `我跟着众人来到${place}，${String(ev.desc || "与众人一同在场").replace(/^众人/, "")}。`;
    const line = `- **${date} ${ev.time}**：${place} — ${body}`;
    const later = existing.find((e) => e.time > ev.time);
    const at = later ? later.index : existing[existing.length - 1].index + 1;
    inserts.push({ index: at, line });
    added.push({ time: ev.time, line });
    have.add(ev.time);
  }
  if (!inserts.length) return { text: src, added: [] };

  inserts.sort((a, b) => b.index - a.index);   // 从后往前插，避免下标位移
  const out = [...lines];
  for (const ins of inserts) out.splice(ins.index, 0, ins.line);
  return { text: out.join("\n"), added };
}

/** 从大纲时间线里挑出"全员事件"（actor=所有人/全员/众人…） */
function collectiveEventsOf(outline) {
  const COLLECTIVE = /^(所有人|全员|众人|大家|全体|全场)$/;
  return (((outline && outline.timeline) || []))
    .filter((r) => COLLECTIVE.test(String((r && r.actor) || "").trim()))
    .map((r) => ({
      time: String(r.time || "").trim(),
      place: String(r.place || "").trim(),
      desc: String((r.desc || r.doing) || "").trim(),
    }))
    .filter((e) => e.time);
}

module.exports = {
  unifyVictimAliasInTimeline, ensureCollectiveAnchors, collectiveEventsOf, TL_LINE_RE,
};
