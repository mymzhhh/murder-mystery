// 剧本正文里"图片引用行"的解析契约（纯逻辑，无 DOM / 无 Redis / 无 PG）
//
// 锁定的是这一次新增的约定与它的两条红线：
//   约定：`![说明](img:键名)` 必须**独立成行**，键名只含 [A-Za-z0-9_-]；
//   红线 1：解析不出来的一律按普通文本渲染，绝不能吞掉内容（正文是玩家的全部信息）；
//   红线 2：行数与顺序必须与原文完全一致（渲染层靠 key=i 对齐，也靠它保证不丢行）。
import test from "node:test";
import assert from "node:assert";
import {
  parseImageLine, imageUrl, isMapImageKey, buildBodyNodes, collectImageRefs, IMG_LINE_RE, MAP_KEY_PREFIX,
} from "../../frontend/src/lib/script-body.mjs";

test("认得出独立成行的图片引用，并取出说明与键名", () => {
  assert.deepStrictEqual(parseImageLine("![别墅一层平面图](img:map-villa-1f)"),
    { alt: "别墅一层平面图", key: "map-villa-1f" });
  assert.deepStrictEqual(parseImageLine("   ![门厅](img:hall)   "),
    { alt: "门厅", key: "hall" }, "前后空白允许（缩进过的正文里很常见）");
  assert.deepStrictEqual(parseImageLine("\t![带下划线的键](img:a_b-c9)\t"),
    { alt: "带下划线的键", key: "a_b-c9" }, "制表符也算空白，键名允许 _ 与 -");
  assert.deepStrictEqual(parseImageLine("![](img:no-alt)"), { alt: "", key: "no-alt" });
});

test("不是图片行的返回 null（包括写坏了的图片语法）", () => {
  const notImages = [
    "",
    "这是一段普通正文。",
    "![别墅一层平面图](img:map-villa-1f) 后面还有文字",   // 不是独立成行
    "正文先来一句 ![图](img:k)",                          // 行首不是图片
    "![图](img:)",                                        // 键名为空
    "![图](img:has space)",                               // 键名带空格
    "![图](img:斜杠/不行)",                                // 键名带中文/斜杠
    "![图](image:k)",                                     // 前缀必须是 img:
    "![图][img:k]",                                       // 不是行内图片语法
    "![图](img:k",                                        // 少了右括号
    `![图](img:${"a".repeat(129)})`,                       // 键名超长（与写入侧同一口径）
    "### 标题",
    "- 列表项",
  ];
  for (const line of notImages) {
    assert.strictEqual(parseImageLine(line), null, `不该被认成图片行：${JSON.stringify(line)}`);
  }
});

test("buildBodyNodes：行数与顺序与原文完全一致（不丢行、不合并行）", () => {
  const text = [
    "### 你的身份",
    "你是别墅的管家。",
    "",
    "![别墅一层平面图](img:map-villa-1f)",
    "（上面这张图里，西翼是锁着的）",
    "![写坏的图](img: bad key)",
    "最后一行。",
  ].join("\n");
  const nodes = buildBodyNodes(text);
  assert.strictEqual(nodes.length, text.split("\n").length, "一行一个节点");
  assert.deepStrictEqual(nodes.map(n => n.kind),
    ["line", "line", "line", "image", "line", "line", "line"],
    "只有那个合法图片行被标成 image，写坏的那行仍是 line");
  assert.deepStrictEqual(nodes[3], { kind: "image", alt: "别墅一层平面图", key: "map-villa-1f", raw: "![别墅一层平面图](img:map-villa-1f)" });
  // 红线：把节点还原回去必须一字不差（解析失败不许吞内容）
  assert.strictEqual(nodes.map(n => n.raw).join("\n"), text);
});

test("buildBodyNodes 对空/未定义输入也不抛（正文还没下发时的兜底）", () => {
  assert.deepStrictEqual(buildBodyNodes(undefined), [{ kind: "line", raw: "" }]);
  assert.deepStrictEqual(buildBodyNodes(null), [{ kind: "line", raw: "" }]);
  assert.deepStrictEqual(buildBodyNodes(""), [{ kind: "line", raw: "" }]);
});

test("CRLF 正文也认（服务端拼出来的正文可能带 \\r）", () => {
  const nodes = buildBodyNodes("第一行\r\n![图](img:one)\r\n第三行");
  assert.deepStrictEqual(nodes.map(n => n.kind), ["line", "image", "line"]);
  assert.strictEqual(nodes[1].key, "one");
});

test("imageUrl 拼出的地址就是后端的取图路由", () => {
  assert.strictEqual(imageUrl("abc-123", "map-villa-1f"), "/api/scripts/abc-123/images/map-villa-1f");
  // 剧本 id / 键名都要转义，否则特殊字符会把路径切错
  assert.strictEqual(imageUrl("a/b", "k"), "/api/scripts/a%2Fb/images/k");
  assert.strictEqual(imageUrl(undefined, "k"), "/api/scripts//images/k");
});

test("地图键名按 map- 前缀筛（房间里的场景地图靠它）", () => {
  assert.strictEqual(isMapImageKey("map-villa-1f"), true);
  assert.strictEqual(isMapImageKey("map-"), true);
  assert.strictEqual(isMapImageKey("portrait-lin"), false);
  assert.strictEqual(isMapImageKey("Map-villa"), false, "前缀大小写敏感，别把 Map- 也算进来");
  assert.strictEqual(isMapImageKey(""), false);
  assert.strictEqual(isMapImageKey(undefined), false);
  assert.strictEqual(MAP_KEY_PREFIX, "map-");
});

test("collectImageRefs：键名 → 说明，同键取第一次出现的说明", () => {
  const alts = collectImageRefs([
    "![平面图（旧）](img:map-a)",
    "中间正文",
    "![平面图（新）](img:map-a)",
    "![书房](img:study)",
  ].join("\n"));
  assert.strictEqual(alts.get("map-a"), "平面图（旧）");
  assert.strictEqual(alts.get("study"), "书房");
  assert.strictEqual(alts.size, 2);
  assert.strictEqual(collectImageRefs("没有任何图片").size, 0);
});

test("正则本身：只吃独立成行的那一种写法", () => {
  assert.ok(IMG_LINE_RE.test("![x](img:k)"));
  assert.ok(!IMG_LINE_RE.test("前导文字 ![x](img:k)"));
});
