// 角色剧本「时间线」小节的解析 —— 纯逻辑，供 admin/PlayerTimeline.jsx 用，可被 node --test 直接测。
//
// 为什么抽出来：这段逻辑原来内联在 PlayerTimeline.jsx 里，既没法单测，也无法与后端
// `src/script/timeline-utils.js` 的规则摆在一起对照。两个文件必须**规则一致**
// （前端漏一条、后端多一条，就会出现"页面上没有、体检却报重复"这类最难查的问题）。
//
// ⚠️ 2026-10-17 修的真缺口：标题识别原来只认 markdown 的 `#` 标题，
// 而**真实剧本（商业本）普遍用 `【三、时间线（严格遵循全局时间线）】` 或加粗 `**时间线**`**，
// 于是导入的真实剧本「全员时间线」永远是 0 个时刻 —— 实测《吉普赛女郎之死（再见卡门）》
// 的原书里 4 个角色都各自有时间线小节，我们的解析一个都看不见。
//
// 条目形态的容忍度**跟着标题形态走**（这是本轮的关键取舍）：
//   · markdown 小节（= 本项目自己生成的格式）→ 仍然**只认条列式行**（`- ` / `* ` / `1. ` / `（1）`）。
//     理由是生成的剧本在该节里全是条目，放宽只会把正文里顺口提到的时刻也算进来。
//   · `【…时间线…】` / `**…时间线…**` 小节（= 真实剧本格式）→ **连非条列式行也认**。
//     理由是作者已经把这些文字放在"时间线"标题之下，那就是该书对该节的读法；
//     实测《占卜师》那份的这一节就是一段散文（"…23：50之后我目击了一些重要的事…"），
//     若仍要求条列式，就会永远读出 0 条。
//   · 两种情况都**只在小节内部扫**，绝不扫描全篇正文 —— 叙事体里的时刻不能当时间线用。

/** 他人视角/基准类标题不算角色自己的时间线（与后端 timeline-utils 的 EXCLUDE 一致） */
const EXCLUDE = /(故事时间线|表面时间线|真实时间线|完整时间线|上帝时间线)/;

/**
 * 判断一行是不是"时间线"小节标题。
 * @returns {{kind:"md"|"bracket"|"bold", level:number, title:string}|null}
 */
export function timelineHeading(line) {
  const s = String(line === null || line === undefined ? "" : line).trim();
  if (!s || !/时间线/.test(s)) return null;

  // ① markdown 标题：`### 三、时间线（…）`
  const md = s.match(/^(#{1,4})\s+(.*)$/);
  if (md) {
    if (EXCLUDE.test(md[2])) return null;
    return { kind: "md", level: md[1].length, title: md[2].trim() };
  }
  // ② 真实剧本的【…】小节：`【三、时间线（严格遵循全局时间线，精确到分钟）】`
  const br = s.match(/^【([^】]{1,40})】$/);
  if (br) {
    if (EXCLUDE.test(br[1])) return null;
    return { kind: "bracket", level: 0, title: br[1].trim() };
  }
  // ③ 加粗标题：`**时间线**`
  const bd = s.match(/^\*\*([^*]{1,40})\*\*$/);
  if (bd) {
    if (EXCLUDE.test(bd[1])) return null;
    return { kind: "bold", level: 0, title: bd[1].trim() };
  }
  return null;
}

/** 该行是否标识"小节结束"（与起始标题同级或更高级） */
function isBoundary(line, head) {
  const s = String(line || "").trim();
  if (head.kind === "md") {
    const h = s.match(/^(#+)\s+/);
    return !!h && h[1].length <= head.level;      // 只在同级或更高级标题处结束（与后端一致）
  }
  if (head.kind === "bracket") return /^【[^】]{1,40}】$/.test(s);   // 下一个【…】小节
  if (head.kind === "bold") return /^\*\*[^*]{1,40}\*\*$/.test(s);
  return false;
}

/**
 * 取出角色剧本里"时间线"小节的正文行。
 * @returns {string[]} 找不到该小节时返回空数组
 */
export function timelineLines(script) {
  const lines = String(script === null || script === undefined ? "" : script).split(/\r?\n/);
  let start = -1, head = null;
  for (let i = 0; i < lines.length; i++) {
    const h = timelineHeading(lines[i]);
    if (h) { start = i; head = h; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isBoundary(lines[i], head)) break;
    out.push(lines[i]);
  }
  return out;
}

const BULLET_RE = /^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/;

/**
 * 解析一行时间线条目。
 * @param {string} line
 * @param {{allowProse?:boolean}} [opts] allowProse=true 时非条列式行也认（见文件头说明）
 * @returns {{time:string, body:string}|null}
 */
export function parseEntry(line, opts) {
  const raw = String(line === null || line === undefined ? "" : line).trim();
  if (!raw) return null;
  const bulleted = BULLET_RE.test(raw);
  if (!bulleted && !(opts && opts.allowProse)) return null;     // 只认条列式行
  const bare = raw.replace(BULLET_RE, "").replace(/\*\*/g, "");
  const m = bare.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return null;
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = m[2];
  const body = bare
    // 去掉行首的日期前缀（"1月8日" / "2005年10月16日"）。
    // ⚠️ 原来写的是 `.replace(/^[^0-9]{0,12}/, "")` —— 本意同上，但它会**吞掉散文开头最多
    // 12 个非数字字符**：真实剧本的时间线小节是散文，实测「我是塞维利亚德高望重的占卜师，…」
    // 被削成「卜师，与诸位萍水相逢…」，看着像坏了。所以收紧成"只认真正的日期形状"。
    .replace(/^\s*(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日\s*/, "")
    .replace(/\d{1,2}\s*[:：]\s*\d{2}/, "")                    // 去掉时刻本身
    .replace(/[（(](真实|座钟)[^）)]*[）)]/g, "")
    .replace(/[【\[][^】\]]*[】\]]/g, "")
    .replace(/^[\s—\-–:：、，,。;；]+/, "")
    .trim();
  return { time: `${hh}:${mm}`, body: body || bare };
}

/**
 * 把"全部角色剧本"整理成「时刻 × 角色」表。
 * @param {Array|{characters?:Array}} scripts 接口返回的形状两种都兼容
 * @returns {{chars:Array<{name:string, noTimeline:boolean}>, times:string[], table:Array<{time:string,cells:Array<{name:string,body:string}>}>}}
 */
export function buildTimelineTable(scripts) {
  const list = !scripts ? [] : Array.isArray(scripts) ? scripts : (scripts.characters || scripts.list || []);
  const chars = (Array.isArray(list) ? list : [])
    .map((c) => {
      const name = String((c && (c.name || c.characterName)) || "");
      const script = String((c && (c.playerScript || c.script || c.text)) || "");
      return { name, script };
    })
    .filter((c) => c.name && c.script);

  const map = new Map();                       // name -> Map(time -> body)
  const noTimeline = new Set();
  for (const c of chars) {
    const lines = timelineLines(c.script);
    if (!lines.some((l) => String(l).trim())) noTimeline.add(c.name);
    // 条目形态跟着标题形态走：先看该角色用的是哪种标题
    const head = (() => {
      for (const l of c.script.split(/\r?\n/)) { const h = timelineHeading(l); if (h) return h; }
      return null;
    })();
    const allowProse = !!head && head.kind !== "md";
    const m = new Map();
    for (const line of lines) {
      const e = parseEntry(line, { allowProse });
      if (e && !m.has(e.time)) m.set(e.time, e.body);          // 同一时刻只取第一条
    }
    map.set(c.name, m);
  }

  const all = new Set();
  for (const m of map.values()) for (const t of m.keys()) all.add(t);
  const times = [...all].sort();                               // "HH:MM" 字符串序即时间序
  const table = times.map((t) => ({
    time: t,
    cells: chars.map((c) => ({ name: c.name, body: (map.get(c.name) && map.get(c.name).get(t)) || "" })),
  }));

  return {
    chars: chars.map((c) => ({ name: c.name, noTimeline: noTimeline.has(c.name) })),
    times,
    table,
  };
}
