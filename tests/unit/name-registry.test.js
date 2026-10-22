// 跨剧本名字去重（2026-10-20 用户反馈：连续几本出现同名/近似角色）
const test = require("node:test");
const assert = require("node:assert");
const {
  isSimilarName, checkNameCollisions, buildAvoidNamesBlock,
} = require("../../src/script/name-registry.js");

test("完全同名 → 命中", () => {
  assert.strictEqual(isSimilarName("沈砚秋", "沈砚秋"), true);
});

test("3 字以上同长度只差一个字 → 算近似", () => {
  assert.strictEqual(isSimilarName("沈砚秋", "沈砚秋"), true);
  assert.strictEqual(isSimilarName("沈砚秋", "沈砚冬"), true, "三字名差一个字很容易看串");
});

test("2 字名只认完全相同（同姓在民国本里太常见，不能误报）", () => {
  // 权衡：林陌/林默 确实相似，但同姓 2 字名（赵大/赵丰、王顺/王福来）在该题材里遍地都是，
  // 拿"同姓"当近似会天天误报，反而让告警失去意义。只保证**完全相同**必报。
  assert.strictEqual(isSimilarName("林陌", "林默"), false);
  assert.strictEqual(isSimilarName("林默", "林默"), true);
});

test("同姓 + 名字有重合 → 算近似", () => {
  assert.strictEqual(isSimilarName("王福来", "王福生"), true);
});

test("只是同姓、名字完全不同 → 不算近似（不要误伤）", () => {
  assert.strictEqual(isSimilarName("赵大", "赵丰"), false);
  assert.strictEqual(isSimilarName("陈景", "陈守拙"), false);
});

test("checkNameCollisions 汇总成人话", () => {
  const used = ["林默", "小栓", "沈砚秋"];
  const r = checkNameCollisions({ names: ["沈砚秋", "沈砚冬", "新名字甲"], usedNames: [...used, "沈砚冬"] });
  assert.strictEqual(r.hit.length, 2);
  assert.ok(r.text.includes("取名重复"), r.text);
  assert.ok(r.text.includes("沈砚秋"), r.text);
  assert.ok(r.hit.some((h) => h.name === "沈砚冬"), r.text);
});

test("没有历史名字时不产生禁用块（不要给提示词塞空块）", () => {
  assert.strictEqual(buildAvoidNamesBlock([]), "");
  assert.strictEqual(buildAvoidNamesBlock(null), "");
});

test("禁用块列出名字并给出硬要求", () => {
  const b = buildAvoidNamesBlock(["林默", "小栓"]);
  assert.ok(b.includes("林默") && b.includes("小栓"));
  assert.ok(b.includes("禁止再使用"));
  assert.ok(b.includes("近似"));
});

test("禁用块最多列 40 个（避免淹没提示词）", () => {
  const many = Array.from({ length: 80 }, (_, i) => `名字${i}`);
  const b = buildAvoidNamesBlock(many);
  const shown = (b.match(/名字\d+/g) || []).length;
  assert.ok(shown <= 40, `实际列了 ${shown} 个`);
});
