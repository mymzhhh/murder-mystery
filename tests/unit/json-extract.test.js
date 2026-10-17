// 回归：截断 JSON 的抢救（repairTruncatedJson）
// 背景（实测）：定向修订的模型输出因 finish_reason=length 被截断时，
// extractJsonStrict 一律返回 null（它的括号扫描要求成对闭合），而调用方写成
// `extractJsonStrict(...) || {}` → 得到 0 条补丁 → 整轮修订白跑，
// 日志只留一句"模型未产出可用补丁"，看不出其实是"输出被截断"。
// 而截断前往往已经写好了若干条**完整**补丁——拿到它们比拿到空集强得多。
const test = require("node:test");
const assert = require("node:assert");
const { extractJsonStrict, repairTruncatedJson } = require("../../src/script/json-extract");

// 取自实测形态的"修订补丁"输出（真实键名：oldText / newText）。
// ⚠️ 夹具要按真实 JSON 拼：元素之间必须有逗号（第一版漏了这个逗号，导致"完整输出"
// 本身就是非法 JSON，函数按截断处理只抢救到 2 条——是夹具错，不是代码错）。
const P_FIRST = `  {"oldText":"11月19日【座钟】07:50**：厂区大院 — 到厂","newText":"11月8日【座钟】07:50**：厂区大院 — 到厂"}`;
const P_SECOND = `,\n  {"oldText":"柜子里的备用自记钟，账面上是三只","newText":"柜子里的备用自记钟，账实倒还相符"}`;
const P_THIRD = `,\n  {"oldText":"见她要领的又正是账上对不上的那只备用钟","newText":"见她要领的又正是账上对不上的那卷自记纸"}`;
// 截断形态：只写完两条，第三条根本没出现
const PATCHES_2 = `{"patches":[\n${P_FIRST}${P_SECOND}`;
const PATCHES_2_FULL = `{"patches":[\n${P_FIRST}${P_SECOND}${P_THIRD}\n]}`;

test("extractJsonStrict：截断的 JSON 必须返回 null（这是整轮白跑的根因，先钉住）", () => {
  assert.strictEqual(extractJsonStrict(PATCHES_2), null);
  assert.strictEqual(extractJsonStrict(`{"patches":[{"oldTex`), null);
});

test("repairTruncatedJson：截断前写完的完整元素要全部抢救回来", () => {
  const r = repairTruncatedJson(PATCHES_2);
  assert.ok(r && typeof r === "object", "不该返回 null");
  assert.strictEqual(r.patches.length, 2, "截断前写完的 2 条都要在");
  assert.strictEqual(r.patches[0].oldText.includes("11月19日"), true);
  assert.strictEqual(r.patches[1].newText.includes("账实倒还相符"), true);
});

test("repairTruncatedJson：没写完的半截元素必须整条丢掉，不能留半条", () => {
  const r = repairTruncatedJson(PATCHES_2);
  // 半截的第三条绝不能出现在结果里：applyPatches 要 oldText+newText 都非空，
  // 半条会带着"只有 oldText"或"残缺 newText"溜进去，造成错误改写。
  assert.ok(r.patches.every((p) => typeof p.oldText === "string" && p.oldText.length > 8
    && typeof p.newText === "string" && p.newText.trim().length > 0), "每条补丁都必须完整");
});

test("repairTruncatedJson：完整输出应当原样返回（不因这条兜底而变形）", () => {
  const r = repairTruncatedJson(PATCHES_2_FULL);
  assert.ok(r && r.patches.length === 3, "完整输出要保留全部 3 条");
  assert.strictEqual(r.patches[2].newText.includes("卷自记纸"), true);
});

test("repairTruncatedJson：顶层是数组时同样能抢救", () => {
  const r = repairTruncatedJson(`[{"a":"一","b":"二"},{"a":"三","b":"四"}`);
  assert.ok(r && Array.isArray(r) && r.length === 2, JSON.stringify(r));
});

test("repairTruncatedJson：截断发生在字符串中途 → 该条丢掉，但之前完整的仍在", () => {
  // 第二条截断在字符串里（"b 被截断），第一条完整
  const r = repairTruncatedJson(`{"patches":[{"oldText":"完整的上一条，长度足够","newText":"换成这样"},{"oldText":"第二条还没写完`);
  assert.ok(r && r.patches.length === 1, "只保留完整的第一条");
  assert.strictEqual(r.patches[0].oldText.includes("完整的上一条"), true);
});

test("repairTruncatedJson：字符串里的花括号不能被当成切点（含转义引号）", () => {
  const r = repairTruncatedJson(`{"patches":[{"oldText":"他写\\"{旧\\"，照抄了框架 {","newText":"换成新的说法"},{"oldText":"还没`);
  assert.ok(r, "不能返回 null");
  assert.strictEqual(r.patches.length, 1, "第一句里的 { 不该制造出可切点");
  assert.ok(r.patches[0].oldText.includes("{旧"), "整句要原样保留");
});

test("repairTruncatedJson：救不出来时返回 null（绝不假成功）", () => {
  assert.strictEqual(repairTruncatedJson(""), null);
  assert.strictEqual(repairTruncatedJson(null), null);
  assert.strictEqual(repairTruncatedJson("不是 JSON"), null);
  assert.strictEqual(repairTruncatedJson(`{"patches":[{"oldTex`), null, "开头就截断、没有任何完整元素 → 无从抢救");
  assert.strictEqual(repairTruncatedJson(`{"p":`), null);
});

test("repairTruncatedJson：多层嵌套的截断（补丁里的 newText 是对象/数组）也能切干净", () => {
  const r = repairTruncatedJson(`{"patches":[{"oldText":"第一句长度要过八","newText":{"x":"甲"}},{"oldText":"第二句长度要过八","newText":`);
  assert.ok(r, "不该返回 null");
  assert.strictEqual(r.patches.length, 1, "第二条未写完 → 丢掉");
  assert.strictEqual(r.patches[0].newText.x, "甲", "第一条要完整");
});
