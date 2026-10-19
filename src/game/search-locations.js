// 地点搜证 — 把"打字猜关键词"换成"选地点"
//
// 改造前的问题（老玩家第一眼就会吐槽）：
//   1. 搜证没有失败状态。game-engine.searchClues 关键词匹配不上时照样随机给一条，
//      前端还提示"但 DM 给了你一条其他线索" —— 搜哪里、搜得对不对，结果都必有收获。
//   2. query 留空也能搜（socket 里判的是 `if (query && query.trim())`，空则直接随机）。
//   3. 于是"这轮搜哪里"不构成决策，二轮搜证也失去意义。
//
// 现在：玩家从**地点列表**里选一个房间，只有该房间还有未被取走的线索才搜得到，
// 否则就是一次实实在在的空手而归（并且照常消耗次数）。
//
// 关于地点列表的口径（一个刻意的取舍）：
//   列表**只由线索的发现地点归纳而来**，不掺入布局描述里的"空房间"。
//   理由是生成阶段并不能保证布局里每个房间都真放了线索，若把空房间也列出来，
//   玩家会为一个生成缺陷白白浪费一次机会 —— 那是不公平的随机惩罚。
//   代价是"列出来的地点一定有货"这一点被泄漏了，但搜不到的情况依然真实存在：
//   同房间的线索会被别人先取走，越到后面越可能扑空。这个代价换来的公平更值。

const MAX_LOCATIONS = 24;
const MIN_LOC_LEN = 2;
const MAX_LOC_LEN = 16;

/** 归一化地点文本用于比较：去掉括号注记、空白与标点 */
function normalizeLoc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·・,，。.、:：;；!！?？"'“”‘’\-—/\\]/g, "")
    .trim();
}

/**
 * 地点匹配：精确相等，或一方包含另一方。
 *
 * 刻意**不做**"核心词"匹配（把"沈曼青闺房"和"闺房"都归到"闺房"）：
 * 那样会把"东厢房"和"西厢房"判成同一个地方 —— 两个不同的房间串线索，
 * 比漏配几条严重得多。包含关系已经覆盖了"书房桌面"→"书房"这类真实情况。
 */
function matchLocation(clueLocation, chosen) {
  const a = normalizeLoc(clueLocation);
  const b = normalizeLoc(chosen);
  if (!a || !b) return false;
  if (a.length < MIN_LOC_LEN || b.length < MIN_LOC_LEN) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * 归纳本局可搜证的地点列表（保持稳定顺序：按线索出现顺序）。
 * @param {Array<{location?:string}>} clues 本局全部线索
 * @param {string} [layoutDescription] 仅当线索完全没有地点时的兜底来源
 * @returns {string[]}
 */
function buildSearchLocations(clues, layoutDescription) {
  const list = [];
  const seen = new Set();
  const push = (raw) => {
    const display = String(raw === null || raw === undefined ? "" : raw)
      .replace(/[（(][^）)]*[）)]/g, "")
      .trim();
    if (display.length < MIN_LOC_LEN || display.length > MAX_LOC_LEN) return;
    const key = normalizeLoc(display);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(display);
  };

  for (const c of clues || []) if (c) push(c.location);

  // 线索里没有可用地点（老剧本 / 生成异常）→ 退回布局描述里归纳的场所。
  // 懒加载 murder-mystery-builder：它是 100KB+ 的大模块，正常路径用不到。
  if (list.length < 2 && layoutDescription) {
    try {
      const { extractLayoutPlaces } = require("../script/murder-mystery-builder");
      for (const p of extractLayoutPlaces(layoutDescription) || []) push(p);
    } catch (e) { /* 兜底失败就接受地点列表为空 */ }
  }

  return mergeSublocations(list).slice(0, MAX_LOCATIONS);
}

/**
 * 把子位置/兄弟位置并成**一个搜证点**（显示层合并，匹配层不变）。
 *
 * ⚠️ 为什么这不是"锦上添花"，而是必修（实测报告 20 / 房间 XGFQWQ）：
 *   可搜地点列表由"每条线索的发现地点"归纳而来，且上限 MAX_LOCATIONS=24。
 *   实测这本 36 条线索 → **26 个不同地点** → 被 slice 截掉最后 2 个：
 *     B4「二层操作平台地面」、B9「二层操作平台尸体旁」
 *   → 这两条线索**谁都搜不到**（真人玩家也一样）。而 AI 侧更隐蔽：
 *     每轮清扫都报"剩余 0"，报告却是 clueFound 34/36。
 *
 * 合并分两步，都只影响**显示名**（匹配用的是 matchLocation 的"互相包含"，不受影响）：
 *   ① 互相包含 → 保留更短的（"书房桌面" → "书房"）；
 *   ② 兄弟位置 → 并到**共同前缀**（"二层操作平台楼梯口"/"二层操作平台地面" → "二层操作平台"）。
 *      阈值 3 字：`二层操作平台` 命中；而 `东厢房`/`西厢房` 没有共同前缀、
 *      `一楼大厅`/`二楼走廊` 只有 2 字 → 都不会被并到一起（这两个反例是这条规则的安全底线）。
 */
function mergeSublocations(list) {
  // 差异部分**含数字**就不并：`房间1` 与 `房间10`、`东厢房` 与 `西厢房`（后者本就无共同前缀）
  // 都是两个不同的地方。这条守卫是既有单测"地点数量有上限"（40 个 `房间N` 必须保留 24 个）
  // 抓出来的 —— 第一版没有它，`房间1` 把 `房间10..19` 全并进去了。
  const diffHasDigit = (a, b) => /\d/.test(a) || /\d/.test(b);
  // ① 包含关系：保留更短的（父地点）。差异部分含数字 → 视为不同地点。
  const step1 = [];
  for (const loc of list) {
    const key = normalizeLoc(loc);
    if (!key) continue;
    const at = step1.findIndex((x) => {
      const k = normalizeLoc(x);
      if (!(k.includes(key) || key.includes(k))) return false;
      const [short, long] = k.length <= key.length ? [k, key] : [key, k];
      if (short === long) return true;
      return !diffHasDigit(long.slice(0, long.indexOf(short)), long.slice(long.indexOf(short) + short.length));
    });
    if (at < 0) { step1.push(loc); continue; }
    if (key.length < normalizeLoc(step1[at]).length) step1[at] = loc;
  }
  // ② 兄弟位置：并到共同前缀（`二层操作平台楼梯口`/`二层操作平台地面` → `二层操作平台`）。
  //    差异部分含数字 → 不并（`房间1`/`房间10`）。
  const MIN_SHARED_PREFIX = 3;
  const step2 = [];
  for (const loc of step1) {
    const key = normalizeLoc(loc);
    let merged = false;
    for (let i = 0; i < step2.length; i++) {
      const other = normalizeLoc(step2[i]);
      let n = 0;
      while (n < key.length && n < other.length && key[n] === other[n]) n++;
      if (n < MIN_SHARED_PREFIX) continue;
      if (diffHasDigit(key.slice(n), other.slice(n))) continue;   // 数字差异 → 不同地点
      step2[i] = key.slice(0, n);                                  // 两者都换成共同前缀
      merged = true;
      break;
    }
    if (!merged) step2.push(loc);
  }
  // 前缀化之后可能产生重复，去一次重
  return [...new Set(step2)];
}

/**
 * 本轮所有**尚未被取走**的线索（不限地点）。随机搜证用的就是这个池子。
 * @param {Array} clues
 * @param {number} [round] 限定轮次；不传则不限
 */
function availableClues(clues, round) {
  return (clues || []).filter((c) => {
    if (!c) return false;
    if (round !== undefined && round !== null && c.round != round) return false; // == 兼容 Redis 字符串轮次
    // 隐藏子线索（真本格式：正文标「通过深入调查 A6…获取」）不进普通搜证池 ——
    // 它只能通过「深入调查」父线索拿到，否则玩家不花额外行动点就白拿（344 共 45 条里 8 条是这种）。
    if (c.hiddenBehind) return false;
    return !(c.foundBy && c.foundBy.length > 0);
  });
}

/**
 * 某条线索在「深入调查」时会吐出来的隐藏子线索（真本格式）。
 * @param {Array} clues 本局全部线索
 * @param {string} parentId 父线索编号（如 A6）
 */
function hiddenChildrenOf(clues, parentId) {
  const pid = String(parentId || "").trim();
  if (!pid) return [];
  return (clues || []).filter((c) => c && String(c.hiddenBehind || "").trim() === pid);
}

/**
 * 指定地点上"当前还能被搜到"的线索。
 * @param {Array} clues 本局全部线索
 * @param {string} chosen 玩家选择的地点
 * @param {number} [round] 限定轮次；不传则不限
 */
function cluesAtLocation(clues, chosen, round) {
  return availableClues(clues, round).filter(c => matchLocation(c.location, chosen));
}

/**
 * 从指定地点挑一条线索。优先非红鲱鱼（与既有 pickRandomClue 的口径一致）。
 * @returns {object|null} 该地点已无线索时返回 null —— 这就是"搜空"这个失败状态
 */
function pickClueAtLocation(clues, chosen, round) {
  const pool = cluesAtLocation(clues, chosen, round);
  if (!pool.length) return null;
  const nonRedHerring = pool.filter(c => c.isRedHerring !== true);
  const finalPool = nonRedHerring.length > 0 ? nonRedHerring : pool;
  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

/**
 * **本轮**可搜证的地点池：先用本轮线索过滤，再归纳地点。
 *
 * 为什么必须单独抽出这一个函数（2026-10-17）：`buildSearchLocations` 本身只看"线索的地点"，
 * 不知道轮次；而调用方有两种写法 —— 有的先按 round 过滤线索（ai-player、auto-search 都这么做，
 * 是对的），有的直接把**全部**线索丢进去（routes/player 的地点列表、socket 里对客户端传参的校验）。
 * 后者会把**下一轮**的地点也摆出来/也认成合法：玩家选了必然空手，白耗一次配额
 * —— 正是本文件开头点名的"不公平的随机惩罚"。
 * 两处各写一遍过滤必然漂移，所以收敛到这一个函数，调用方只许用它。
 *
 * @param {Array<{location?:string, round?:number}>} clues 本局全部线索
 * @param {number} round 当前轮次（1/2）；<=0（非搜证阶段）时不筛，保持原有行为
 * @param {string} [layoutDescription] 仅当线索完全没有地点时的兜底来源
 */
function buildRoundSearchLocations(clues, round, layoutDescription) {
  const list = Array.isArray(clues) ? clues : [];
  const r = Number(round);
  const sameRound = Number.isFinite(r) && r > 0 ? list.filter((c) => Number(c && c.round) === r) : list;
  return buildSearchLocations(sameRound, layoutDescription);
}

module.exports = {
  MAX_LOCATIONS,
  normalizeLoc,
  matchLocation,
  mergeSublocations,
  buildSearchLocations,
  buildRoundSearchLocations, hiddenChildrenOf,
  availableClues,
  cluesAtLocation,
  pickClueAtLocation,
};
