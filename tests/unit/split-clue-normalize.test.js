// 布尔归一化：Redis hash 的值都是字符串，`!!"false"` 是 true —— 实测导致
// 《冬至钟影》《沪西照相馆除夕谜案》两本"全部线索都可深入调查"（点任意线索报错）。
const test = require("node:test");
const assert = require("node:assert");
const { normalizeSplitClue } = require("../../src/script/script-splitter.js");

test("normalizeSplitClue：字符串 \"false\" 必须归一成布尔 false", () => {
  const n = normalizeSplitClue({ id: "A1", diggable: "false", round: "1" });
  assert.strictEqual(n.diggable, false, "**这正是 bug 的核心**：!!\"false\" === true");
  assert.strictEqual(n.round, 1);
  assert.strictEqual(typeof n.round, "number");
});

test("normalizeSplitClue：字符串 \"true\"/\"1\"/1/true 都算可挖掘", () => {
  for (const v of ["true", "1", 1, true]) {
    assert.strictEqual(normalizeSplitClue({ id: "A6", diggable: v }).diggable, true, `${JSON.stringify(v)} 应为 true`);
  }
  for (const v of ["false", "0", 0, false, "", undefined, null]) {
    assert.strictEqual(normalizeSplitClue({ id: "A1", diggable: v }).diggable, false, `${JSON.stringify(v)} 应为 false`);
  }
});

test("normalizeSplitClue：保留其它字段并归一 round", () => {
  const n = normalizeSplitClue({
    id: "B3", content: "内容", location: "大堂", round: "2",
    clueType: "物证", hiddenContent: "", hiddenBehind: "B2", name: "",
  });
  assert.deepStrictEqual(n, {
    id: "B3", name: "", content: "内容", location: "大堂", round: 2,
    clueType: "物证", hiddenContent: "", diggable: false, hiddenBehind: "B2",
  });
});

test("normalizeSplitClue：空输入不炸", () => {
  const n = normalizeSplitClue(undefined);
  assert.strictEqual(n.id, undefined);
  assert.strictEqual(n.diggable, false);
  assert.strictEqual(n.round, 1);
});
