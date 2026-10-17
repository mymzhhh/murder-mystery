// 剧本正文里的图片引用（纯逻辑，不依赖 DOM，便于单元测试）
//
// 约定（已定）：正文里用**独立成行**的 markdown 图片语法引用配图
//
//     ![图片说明](img:键名)
//
//   · 键名只含 [A-Za-z0-9_-]；
//   · 这一行必须独立成行（前后可有空白）；
//   · 正文其余部分仍是纯文本 —— 前端**没有** markdown 渲染器，
//     所以这里只认这一种形状，别的一律原样当文本渲染。
//   · 键名以 map- 开头的表示"地图/场景布局图"，房间页面要单独放地图区展示。
//
// 为什么把解析单独抽成一个 .mjs：渲染组件是 .jsx，node --test 直接 require 不进来，
// 而这些判断（是不是图片行、键名合不合法、解析失败怎么办）正是最需要被测试锁住的部分。

/** 独立成行的图片引用行。前后空白（空格/制表符）允许，键名严格按约定限制 */
export const IMG_LINE_RE = /^[ \t]*!\[([^\]]*)\]\(img:([A-Za-z0-9_-]{1,128})\)[ \t]*$/;

/** 地图/场景布局图的键名前缀 */
export const MAP_KEY_PREFIX = "map-";

/**
 * 解析一行，判断它是不是图片引用行。
 * @returns {{alt: string, key: string}|null} 不是图片行（或键名非法）时返回 null
 */
export function parseImageLine(line) {
  const src = String(line === null || line === undefined ? "" : line);
  const m = IMG_LINE_RE.exec(src);
  if (!m) return null;
  const key = m[2];
  // 长度上限之外的键名一律不认（与后端写入侧同一口径）
  if (key.length > 128) return null;
  return { alt: m[1].trim(), key };
}

/** 由剧本 id + 键名拼出取图地址（与后端 GET /api/scripts/:id/images/:key 对应） */
export function imageUrl(scriptId, key) {
  return `/api/scripts/${encodeURIComponent(String(scriptId === null || scriptId === undefined ? "" : scriptId))}/images/${encodeURIComponent(String(key))}`;
}

/** 键名是否是地图/场景布局图 */
export function isMapImageKey(key) {
  return String(key || "").startsWith(MAP_KEY_PREFIX);
}

/**
 * 把正文切成渲染节点：一行一个节点，顺序与行数**完全保持**。
 * 只有确认是图片引用的行才标成 image，其余（含写坏了的图片语法）都是 line，
 * 由渲染层按原来的方式渲染成文本 —— 绝不允许"解析失败就整段不显示"。
 * @returns {Array<{kind:'image', alt:string, key:string, raw:string}|{kind:'line', raw:string}>}
 */
export function buildBodyNodes(text) {
  const lines = String(text === null || text === undefined ? "" : text).split(/\r?\n/);
  return lines.map((raw) => {
    const img = parseImageLine(raw);
    return img ? { kind: "image", alt: img.alt, key: img.key, raw } : { kind: "line", raw };
  });
}

/**
 * 从任意正文里收集 键名 → 说明 的对照表（同一键名取第一次出现的说明）。
 * 房间里的"场景地图"只有键名（后端列表接口按设计不下发给说明），
 * 想给地图配上人话说明就得从正文里把 alt 捞出来。
 */
export function collectImageRefs(text) {
  const out = new Map();
  for (const node of buildBodyNodes(text)) {
    if (node.kind === "image" && !out.has(node.key)) out.set(node.key, node.alt);
  }
  return out;
}
