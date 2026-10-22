// 上架闸门（2026-10-20）：硬缺陷不许带病上架
const test = require("node:test");
const assert = require("node:assert");
const { checkPublishReady, isReachable } = require("../../src/script/publish-gate.js");

const mkClues = (n, loc = "账房") =>
  Array.from({ length: n }, (_, i) => ({ id: `A${i + 1}`, content: `桌上有茶杯${i}`, location: loc, round: 1 }));

const CHARS = [{ name: "甲", isMurderer: true }, { name: "乙" }, { name: "丙" }];

test("线索充足 + 凶手有证据 → 允许上架", () => {
  const clues = mkClues(12).concat([{ id: "B1", content: "铜镇纸上沾着甲的指纹", location: "炮制房", round: 2 }]);
  const r = checkPublishReady({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.blockers));
});

test("没有线索 → 不许上架", () => {
  const r = checkPublishReady({ clues: [], characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "no_clues"));
});

test("父线索没有子线索 → 不许上架", () => {
  const clues = mkClues(12).concat([
    { id: "B13", content: "毛刷上有粉末（发现隐藏线索，可深入调查）", location: "炮制房", round: 2 },
    { id: "B1", content: "铜镇纸上沾着甲的指纹", location: "炮制房", round: 2 },
  ]);
  const r = checkPublishReady({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "hidden_pair"), JSON.stringify(r.blockers));
});

test("子线索没标隐藏（正文写了通过深入调查）→ 不许上架", () => {
  const clues = mkClues(12).concat([
    { id: "B13", content: "毛刷上有粉末（发现隐藏线索，可深入调查）", location: "炮制房", round: 2, hiddenBehind: "" },
    { id: "B14", content: "通过深入调查B13，粉末是草乌汁", location: "炮制房", round: 2, hiddenBehind: "" },
    { id: "B1", content: "铜镇纸上沾着甲的指纹", location: "炮制房", round: 2 },
  ]);
  const r = checkPublishReady({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "child_leaked"), JSON.stringify(r.blockers));
});

test("可搜线索少于 10 条 → 不许上架", () => {
  const clues = [
    { id: "A1", content: "桌上有茶杯", location: "账房", round: 1 },
    { id: "B1", content: "铜镇纸上沾着甲的指纹", location: "炮制房", round: 2 },
  ];
  const r = checkPublishReady({ clues, characters: CHARS, murderer: "甲" });
  assert.ok(r.blockers.some((b) => b.code === "too_few_reachable"), JSON.stringify(r.blockers));
});

test("凶手零证据 → 不许上架", () => {
  const clues = mkClues(14);   // 全都没提到"甲"
  const r = checkPublishReady({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => b.code === "killer_no_evidence"), JSON.stringify(r.blockers));
});

test("隐藏子线索不计入「可搜」", () => {
  assert.strictEqual(isReachable({ id: "X", content: "通过深入调查A1，某物", location: "账房" }), false);
  assert.strictEqual(isReachable({ id: "Y", content: "某物", location: "" }), false);
  assert.strictEqual(isReachable({ id: "Z", content: "某物", location: "账房", hiddenBehind: "A1" }), false);
  assert.strictEqual(isReachable({ id: "W", content: "某物", location: "账房" }), true);
});
