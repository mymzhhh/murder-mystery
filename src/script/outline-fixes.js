/**
 * 大纲/线索的三处补齐（2026-10-20 用户要求，来自《回春堂蜜影》暴露的三个真实缺陷）：
 *
 *   ① 隐藏线索父子必须成对 —— 那本出了「父 1 条、子 0 条」，验收显示"真本格式 ❌"，
 *      但生成流程只是提示，不阻断、不进修订队列 → 玩家永远搜不到那层内容。
 *   ② 死者身亡时刻缺失 —— victim.deathTime 为 undefined，
 *      「死者死后不得再活动」这层校验会**静默失效**。现在从时间线/真相里确定性推断。
 *   ③ 关系网里有杀机、但第一轮没落到线索上 —— 那本 小栓 的关系写着"打碎老山参要被送官"，
 *      第一轮却没有他的杀机线索 → 第一轮没能把嫌疑人摊平。
 *
 * 原则：全部是**确定性**的（不调 LLM），能推断才推断、推断不出就不动。
 */

const HIDDEN_PARENT_RE = /发现隐藏线索|可深入调查|可深挖/;
const { CHILD_RE: HIDDEN_CHILD_RE, PARENT_RE: HIDDEN_PARENT_RE_SHARED } = require("./hidden-clue-re");

function textOf(c) {
  return String((c && (c.content || c.text || c)) || "");
}

/**
 * ① 隐藏线索父子成对校验。
 * 每一组"通过深入调查 A6"都必须真的存在一条 A6 父线索，且父线索要带"可深入调查"标记。
 * @returns {{ok:boolean, issues:string[], stats:object}}
 */
function checkHiddenCluePairs({ clues }) {
  const list = Array.isArray(clues) ? clues : [];
  const issues = [];
  const byId = new Map();
  for (const c of list) {
    const id = String((c && c.id) || "").trim().toUpperCase();
    if (id) byId.set(id, c);
  }
  const parents = [];
  const children = [];
  for (const c of list) {
    const t = textOf(c);
    const id = String((c && c.id) || "").trim().toUpperCase();
    const childRef = HIDDEN_CHILD_RE.exec(t);
    if (childRef) {
      children.push({ id, ref: childRef[1].toUpperCase() });
    } else if (HIDDEN_PARENT_RE.test(t)) {
      parents.push({ id });
    }
  }
  const parentIds = new Set(parents.map((p) => p.id));
  const childParentIds = new Set(children.map((c) => c.ref));

  // 有父无子
  const lonelyParents = parents.filter((p) => !childParentIds.has(p.id)).map((p) => p.id);
  if (lonelyParents.length) {
    issues.push(
      `【隐藏线索·有父无子】${lonelyParents.join("、")} 标了「可深入调查」，但没有对应的子线索 —— ` +
      `玩家花一次深入调查拿到的还是同一条内容。请为每条父线索补一条独立编号的子线索。`
    );
  }
  // 有子无父 / 引用不存在的编号
  const orphanChildren = children.filter((c) => !parentIds.has(c.ref));
  if (orphanChildren.length) {
    issues.push(
      `【隐藏线索·子线索无主】${orphanChildren.map((c) => `${c.id}→${c.ref}`).join("、")} 引用的父线索不存在或没标「可深入调查」——` +
      `这条子线索永远搜不到。请检查编号，或给被引用的那条补上父线索标记。`
    );
  }
  return {
    ok: issues.length === 0,
    issues,
    stats: { parents: parents.map((p) => p.id), children: children.map((c) => `${c.id}←${c.ref}`) },
  };
}

/**
 * ② 死者身亡时刻推断。
 * 顺序：victim.deathTime → victimLine.deathTime → 时间线里提到"死者+死/身亡/毒发"的条目 →
 *       真相复盘里「HH:MM …… 身亡/死亡」。
 * 只在**唯一**候选时写回，多候选一律不动（宁可留空也不猜）。
 * @returns {{deathTime:string, source:string, candidates:string[]}}
 */
function inferVictimDeathTime(outline) {
  const o = outline || {};
  const victim = String((o.victim && o.victim.name) || "").trim();
  const direct = String((o.victim && o.victim.deathTime) || (o.victimLine && o.victimLine.deathTime) || "").trim();
  if (direct) return { deathTime: direct, source: "explicit", candidates: [direct] };

  const hm = (s) => {
    const m = /(\d{1,2})[:：](\d{2})/.exec(String(s || ""));
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  };
  const DEATH_WORD = /身亡|死亡|断气|毒发|咽气|毙命|倒在|被杀|遇害/;

  const cands = [];
  // 时间线条目：动作里同时出现死者名与死亡词
  for (const e of o.timeline || []) {
    const body = `${e.desc || e.doing || ""}`;
    if (!body) continue;
    if (victim && !body.includes(victim)) continue;
    if (!DEATH_WORD.test(body)) continue;
    const t = hm(e.time) || hm(body);
    if (t) cands.push(t);
  }
  // 真相复盘：抓「时刻 … 死亡词」的短句
  const truthText = String(o.truthReview || "");
  for (const m of truthText.matchAll(/(\d{1,2}[:：]\d{2})[^。；\n]{0,40}?(身亡|死亡|断气|毒发|毙命)/g)) {
    cands.push(m[1].replace("：", ":").replace(/^(\d):/, "0$1:"));
  }
  const uniq = [...new Set(cands)];
  if (uniq.length === 1) return { deathTime: uniq[0], source: "inferred", candidates: uniq };
  return { deathTime: "", source: uniq.length ? "ambiguous" : "none", candidates: uniq };
}

/**
 * ③ 给"关系网里有杀机、但第一轮没写线索"的角色补一条动机线索。
 *
 * 不用 LLM：把关系里的冲突事实改写成一条**证言类**线索，地点固定「证言」
 * （play 端一定有这个人造地点，不会落到空地点的死线索）。
 *
 * @param {string} cluesText 线索 markdown 全文（含 ## 第一轮线索 / ## 第二轮线索）
 * @param {object} p { missing: string[], relations: Array<{a,b,link,tension}>, victim?: string }
 * @returns {{text:string, added:Array<{id:string, for:string, content:string}>}}
 */
function appendMotiveClues(cluesText, { missing, relations, victim } = {}) {
  const text = String(cluesText || "");
  const names = (missing || []).filter(Boolean);
  if (!text || !names.length) return { text, added: [] };

  const round2Idx = text.search(/^#{1,3}\s*第二轮线索/m);
  const head = round2Idx >= 0 ? text.slice(0, round2Idx) : text;
  const tail = round2Idx >= 0 ? text.slice(round2Idx) : "";

  // 找第一轮最大编号
  let maxA = 0;
  for (const m of head.matchAll(/^#{3,4}\s*A(\d{1,3})/gm)) maxA = Math.max(maxA, Number(m[1]));

  const added = [];
  const blocks = [];
  let next = maxA + 1;
  for (const name of names) {
    const rel = (relations || []).find((r) => (r.a === name || r.b === name) && r.tension);
    const fact = rel ? String(rel.tension) : "";
    if (!fact) continue;   // 没有可用的关系事实就不编
    const other = rel.a === name ? rel.b : rel.a;
    const id = `A${next++}`;
    const content = `有伙计私下提起：${name}与${other}之间的纠葛——${fact}`;
    blocks.push(
      `\n### ${id}：证言｜证言\n- 线索类型：证词\n- 发现地点：证言\n- 线索内容：${content}\n`
    );
    added.push({ id, for: name, content });
  }
  if (!added.length) return { text, added };

  const cleaned = head.replace(/\s*$/, "\n");
  return { text: `${cleaned}${blocks.join("")}\n${tail}`, added };
}

module.exports = {
  checkHiddenCluePairs, inferVictimDeathTime, appendMotiveClues,
  HIDDEN_PARENT_RE, HIDDEN_CHILD_RE,
};
