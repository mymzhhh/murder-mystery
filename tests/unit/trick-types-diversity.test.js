// 诡计类型多样性：连着几本全是时间诡计是用户实测反馈的问题。
//
// 背景（2026-10-20）：提示词把 6 种类型并列让模型自由选，推理模型天然偏好
// "最容易自证"的时间诡计（时钟偏移能给出精确时刻、又能被物证锚定），于是每本都是它。
// 修法是记住最近用过的类型并在下一次禁掉它 —— 但必须永远保留足够的选择空间。
const test = require("node:test");
const assert = require("node:assert");
const { computeBannedTypes } = require("../../src/script/trick-types-memory.js");

const ALL = ["密室", "身份错位", "时间诡计", "不在场证明", "叙述性诡计", "多重解答"];

test("最近用过 1 种 → 只禁这 1 种", () => {
  assert.deepStrictEqual(computeBannedTypes(["时间诡计"], ALL), ["时间诡计"]);
});

test("最近用过多种 → 全禁，但至少保留 3 种可选", () => {
  const banned = computeBannedTypes(["密室", "时间诡计", "多重解答", "身份错位"], ALL);
  assert.strictEqual(banned.length, ALL.length - 3, "6 种里最多禁 3 种，留 3 种可选");
  assert.ok(!banned.includes("叙述性诡计") || banned.length <= 3);
});

test("禁止数量上限不会把可选类型清空", () => {
  const banned = computeBannedTypes(ALL, ALL);
  assert.ok(ALL.length - banned.length >= 3, `禁完后至少要剩 3 种，实际剩 ${ALL.length - banned.length}`);
});

test("最近列表里混入未知类型时忽略", () => {
  assert.deepStrictEqual(computeBannedTypes(["不存在的类型", "时间诡计"], ALL), ["时间诡计"]);
});

test("空输入安全", () => {
  assert.deepStrictEqual(computeBannedTypes([], ALL), []);
  assert.deepStrictEqual(computeBannedTypes(undefined, ALL), []);
  assert.deepStrictEqual(computeBannedTypes(["时间诡计"], []), []);
});

test("越近的类型优先被禁（列表末尾是最新）", () => {
  const banned = computeBannedTypes(["密室", "身份错位", "时间诡计"], ALL);
  assert.strictEqual(banned[0], "时间诡计", "最新的排在前面优先禁");
});
