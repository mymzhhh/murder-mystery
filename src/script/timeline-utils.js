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

/** 他人视角 / 基准类标题不算角色自己的时间线 */
const EXCLUDE_TIMELINE = /(故事时间线|表面时间线|真实时间线|完整时间线|上帝时间线)/;

/**
 * 判断一行是不是"时间线"小节标题，并给出该标题的形态与层级。
 *
 * ⚠️ 2026-10-17 修的真缺口：原实现只认 markdown 的 `### ...时间线`，
 * 而**真实剧本（商业本）普遍用 `【三、时间线（严格遵循全局时间线，精确到分钟）】`
 * 或加粗 `**时间线**`**，于是一整类剧本的时间线对后端完全不可见
 *（导入的《吉普赛女郎之死（再见卡门）》里 4 个角色都各有时间线小节，一个都读不到）。
 * 前端 `frontend/src/lib/player-timeline.mjs` 里有同一套规则 —— 两边必须一致，
 * 否则会出现"页面上有时间线、体检却说没有"这类最难查的问题。
 *
 * @returns {{kind:"md"|"bracket"|"bold", level:number}|null}
 */
function timelineHeadingInfo(line) {
  const s = String(line || "").trim();
  if (!s || !/时间线/.test(s)) return null;
  const md = s.match(/^(#{1,4})\s+(.*)$/);
  if (md) return EXCLUDE_TIMELINE.test(md[2]) ? null : { kind: "md", level: md[1].length };
  const br = s.match(/^【([^】]{1,40})】$/);
  if (br) return EXCLUDE_TIMELINE.test(br[1]) ? null : { kind: "bracket", level: 0 };
  const bd = s.match(/^\*\*([^*]{1,40})\*\*$/);
  if (bd) return EXCLUDE_TIMELINE.test(bd[1]) ? null : { kind: "bold", level: 0 };
  return null;
}

/** 该行是否标识"时间线小节结束"（与起始标题同级或更高级） */
function isTimelineBoundary(line, head) {
  const s = String(line || "").trim();
  if (head.kind === "md") {
    const h = s.match(/^(#+)\s+/);
    return !!h && h[1].length <= head.level;
  }
  if (head.kind === "bracket") return /^【[^】]{1,40}】$/.test(s);   // 下一个【…】小节
  if (head.kind === "bold") return /^\*\*[^*]{1,40}\*\*$/.test(s);
  return false;
}

/** 抽取角色剧本中「时间线」章节正文；无该章节返回 null（排除基准类章节） */
function extractCharacterTimeline(text) {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = timelineHeadingInfo(lines[i]);
    if (!head) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (isTimelineBoundary(lines[j], head)) break;
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
