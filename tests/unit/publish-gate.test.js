// 上架闸门（2026-10-20）：硬缺陷不许带病上架
const test = require("node:test");
const assert = require("node:assert");
const { checkPublishReady, isReachable, extractCluesFromMarkdown } = require("../../src/script/publish-gate.js");

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

// 生成期前置：从 markdown 提取结构化线索，供闸门提前判定（2026-10-20）
test("extractCluesFromMarkdown：提取 id/地点/轮次/子线索关系", () => {
  const md = [
    "## 第一轮线索",
    "",
    "### A1：柜台账房｜文件",
    "- 线索类型：文件",
    "- 发现地点：柜台账房",
    "- 线索内容：账册上记着一笔短款。",
    "",
    "## 第二轮线索",
    "",
    "### B13：炮制工具间｜物证",
    "- 线索类型：物证",
    "- 发现地点：炮制工具间",
    "- 线索内容：毛刷上有粉末（发现隐藏线索，可深入调查）",
    "",
    "### B14：炮制工具间｜物证",
    "- 线索类型：物证",
    "- 发现地点：炮制工具间",
    "- 线索内容：通过深入调查B13，粉末是草乌汁",
  ].join("\n");
  const cs = extractCluesFromMarkdown(md);
  assert.strictEqual(cs.length, 3);
  assert.strictEqual(cs[0].id, "A1");
  assert.strictEqual(cs[0].location, "柜台账房");
  assert.strictEqual(cs[0].round, 1);
  assert.strictEqual(cs[1].round, 2);
  assert.strictEqual(cs[2].hiddenBehind, "B13", "子线索要能提取出父编号");
});

test("提取出的线索可直接喂给 checkPublishReady", () => {
  const md = ["## 第一轮线索", "", "### A1：账房｜文件", "- 发现地点：账房", "- 线索内容：甲欠死者三十两", ""].join("\n");
  const cs = extractCluesFromMarkdown(md);
  const r = checkPublishReady({ clues: cs, characters: [{ name: "甲", isMurderer: true }], murderer: "甲" });
  assert.strictEqual(r.ok, false, "只有 1 条线索必然不合格");
  assert.ok(r.blockers.some((b) => b.code === "too_few_reachable"), JSON.stringify(r.blockers));
});