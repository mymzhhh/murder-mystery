// 时间/时间线文本工具 —— 被两个模块共用，所以单独放这里。
//
// 为什么必须抽出来（而不是各写一份）：
//   `murder-mystery-builder` 与 `story-bible`（权威表对账）**都要**从剧本文本里取时刻、
//   取"时间线"章节。若 story-bible 反过来 require builder 就会形成循环依赖；
//   若各写一份，就会出现"两个模块对同一个 11月17日 23:50 的解读不一样"这种最难查的问题
//   ——本项目已经反复吃过"同一份事实在两处各实现一次"的亏（见修改记录里的多次记录）。
//
// 这里的实现**逐字搬自** murder-mystery-builder 的原有实现（含注释），行为不变；
// builder 改为从这里引入并继续对外导出，保持既有调用方与测试不受影响。

/**
 * 从"23:50"、"20：10"、"21:16-21:28"、"**11月17日 23:50**" 这类写法里取出规范化的 "HH:MM"。
 *
 * ⚠️ 为什么要容忍**日期前缀**（实测第四次漏判，1994 郑州·打包机案）：那一轮大纲的 time 字段
 * 全写成「11月17日 23:50」这种"日期+时刻"，而原实现要求字符串**以 HH:MM 开头** →
 * 全部返回 null → `findDeathMoment` 判不出死亡时刻（尽管行里明写着"陈广发**死亡**"）→
 * 「死者死后不得再活动」整层约束与死后校验**又一次静默失效**。
 * 顺带也修掉配套的截断写法（`slice(0,5)` 对「11月17日 23:50」会取成「11月17」）。
 */
function hmOf(s) {
  const m = String(s || "").match(/(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return String(h).padStart(2, "0") + ":" + m[2];
}

/** 时刻字符串 → 当日晚间分钟数（解析失败返回 null） */
function minutesOf(hm) {
  const norm = hmOf(hm);
  if (!norm) return null;
  const [h, mi] = norm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + mi;
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

/** 正则转义（用于把角色名拼进正则） */
function escapeRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { hmOf, minutesOf, extractCharacterTimeline, escapeRe };
