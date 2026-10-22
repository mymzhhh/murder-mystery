/**
 * 跨剧本"人名去重"（2026-10-20 用户反馈）。
 *
 * 现象：连续几本里出现了同名角色 ——
 *   《聚源号夜账》林默 / 小栓 / 沈砚秋
 *   《回春堂蜜影》小栓 / 沈砚秋
 *   《临河客栈桐油案》林默
 * 玩家连着玩两本会串戏（"沈砚秋这本不是凶手吗，怎么又出来了"），
 * 而且名字重复会削弱"这是一本新剧本"的感觉。
 *
 * 做法：把最近若干本剧本里用过的角色名收集起来，注入大纲提示词作为**禁用名单**；
 * 生成后再做一次确定性检查，命中就告警并列入待修订问题（不自动改名 —— 改名会牵动
 * 时间线/线索/真相里的所有引用，风险大于收益）。
 */

/** 取最近 N 本剧本已用过的角色名（去重、按最近优先排序） */
async function collectUsedNames({ limit = 30, excludeSessionId = "" } = {}) {
  try {
    const { query } = require("../core/db");
    // scripts 表没有 session_id 列（实测），它的主键 id 就是剧本 id；characters.script_id 指它。
    const rows = await query(
      `SELECT ch.name AS name, MAX(s.created_at) AS last_at
         FROM characters ch
         LEFT JOIN scripts s ON s.id = ch.script_id
        WHERE ($1 = '' OR s.id::text <> $1)
          AND ch.name IS NOT NULL AND ch.name <> ''
        GROUP BY ch.name
        ORDER BY last_at DESC NULLS LAST
        LIMIT $2`,
      [excludeSessionId || "", Math.max(1, Math.min(200, limit))]
    );
    const list = (rows.rows || rows || []).map((r) => String(r.name || "").trim()).filter(Boolean);
    return [...new Set(list)];
  } catch (e) {
    // 表结构/字段名不一致时不要拖垮生成
    console.warn("[name-registry] 读取历史角色名失败（忽略）:", e.message);
    return [];
  }
}

/** 名字相似度：只改一个字也算"近似"（用户反馈里「王福来 / 王顺 / 王学习」就是这种感觉） */
function isSimilarName(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  // 同长度只差一个字 —— **仅对 3 字以上的名字生效**：
  // 2 字名（赵大 / 赵丰）只差一个字就等于差了一半，那不是"近似"，是两个人。
  if (x.length === y.length && x.length >= 3) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    if (diff <= 1) return true;
  }
  // 同姓 + 名字部分重合（王福来 vs 王福生）。**不单独拿"同姓"当近似**：
  // 民国/古风本里 赵大、赵丰、王顺 这类同姓角色本来就多，只看姓氏会天天误报。
  if (x.length >= 2 && y.length >= 2 && x[0] === y[0]) {
    const tailX = x.slice(1);
    const tailY = y.slice(1);
    if (tailX === tailY) return true;
    if (tailX.length >= 2 && tailY.length >= 2 && (tailX.includes(tailY) || tailY.includes(tailX))) return true;
    if (tailX.length >= 2 && tailY.length >= 2 && tailX[0] === tailY[0]) return true;   // 王福来/王福生
  }
  return false;
}

/**
 * 生成后的确定性检查：新剧本里有没有和历史重名/近似的角色。
 * @returns {{hit:Array<{name:string,similar:string}>, text:string}}
 */
function checkNameCollisions({ names, usedNames }) {
  const fresh = (names || []).filter(Boolean);
  const used = (usedNames || []).filter(Boolean);
  const hit = [];
  for (const n of fresh) {
    for (const u of used) {
      if (n === u || isSimilarName(n, u)) {
        hit.push({ name: n, similar: u });
        break;
      }
    }
  }
  if (!hit.length) return { hit, text: "" };
  const text = `【取名重复】${hit.map((h) => `${h.name}${h.name === h.similar ? "（与历史剧本同名）" : `≈${h.similar}`}`).join("、")}` +
    ` —— 最近几本已经用过这些名字，玩家连着玩会串戏。请换一批新名字（含近似名也要换）。`;
  return { hit, text };
}

/** 提示词里注入的禁用名单块 */
function buildAvoidNamesBlock(usedNames) {
  const list = (usedNames || []).filter(Boolean);
  if (!list.length) return "";
  // 名单太长会淹没提示词，取最近 40 个够用
  const shown = list.slice(0, 40);
  return `## 名字去重（硬要求）
最近几本剧本已经用过下面这些角色名，**本次禁止再使用**（包括只改一个字的近似名）：
${shown.join("、")}
请为本次角色另起一批新名字：符合时代背景、彼此不像、也不要与上面的名单相像。`;
}

module.exports = { collectUsedNames, checkNameCollisions, buildAvoidNamesBlock, isSimilarName };
