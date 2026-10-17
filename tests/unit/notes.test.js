// 玩家便签的清洗逻辑（纯函数，不依赖 Redis）
//
// 便签是玩家手写的自由文本，脏数据（超长、空壳、非法结构）必须在这里被挡掉：
// 它会被整段塞进 Redis 并且每次切页都全量回传，不设上限会拖垮房间数据。
const test = require("node:test");
const assert = require("node:assert");
const { normalizeNotes } = require("../../src/game/game-manager");

test("正常便签原样保留（补 id 与 updatedAt）", () => {
  const out = normalizeNotes([
    { id: "a1", title: "张三的时间线", content: "他说八点半在楼下" },
    { title: "疑点", content: "水缸边的鞋印" },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, "a1");
  assert.strictEqual(out[0].title, "张三的时间线");
  assert.ok(out[1].id, "缺 id 时应自动补一个");
  assert.ok(out[1].updatedAt);
});

test("全空的便签被丢弃（不留下空壳）", () => {
  const out = normalizeNotes([
    { title: "", content: "" },
    { title: "", content: "   " },
    { title: "有内容", content: "" },
    null,
    "字符串不是便签",
    123,
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, "有内容");
});

test("超长正文与标题被截断", () => {
  const out = normalizeNotes([{ title: "T".repeat(500), content: "C".repeat(9999) }]);
  assert.strictEqual(out[0].title.length, 120);
  assert.strictEqual(out[0].content.length, 4000);
});

test("便签条数有上限（默认 30）", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: "n" + i, content: "c" + i }));
  const out = normalizeNotes(many);
  assert.strictEqual(out.length, 30);
  assert.strictEqual(out[0].title, "n0");
});

test("总长度有上限：超出后停止收录，不超量存", () => {
  // 每条 4000 字，20 条就 8 万字，超过 6 万上限，应当提前截断
  const big = Array.from({ length: 20 }, (_, i) => ({ title: "t" + i, content: "x".repeat(4000) }));
  const out = normalizeNotes(big);
  const total = out.reduce((a, n) => a + n.title.length + n.content.length, 0);
  assert.ok(total <= 60000, `总长度 ${total} 超过上限`);
  assert.ok(out.length < 20, "应当提前停止收录");
});

test("非数组输入返回空数组，不抛异常", () => {
  for (const bad of [null, undefined, "abc", 123, {}]) {
    assert.doesNotThrow(() => normalizeNotes(bad));
    assert.deepStrictEqual(normalizeNotes(bad), []);
  }
});
