// 难度校验：剧本不能"一眼看穿凶手"（2026-10-20 用户需求）
const test = require("node:test");
const assert = require("node:assert");
const { checkEvidenceBalance, mentions, isHiddenChild } = require("../../src/script/difficulty-checks.js");

const CHARS = ["甲", "乙", "丙", "丁"];
const mk = (id, content, extra) => ({ id, content, ...(extra || {}) });

test("证据过度集中在凶手身上 → 告警", () => {
  const clues = [
    mk("A1", "甲的袖口有血迹"),
    mk("A2", "甲在账房出现过"),
    mk("A3", "甲买过毒药"),
    mk("A4", "甲的鞋印在密室"),
    mk("B1", "乙欠了钱"),
    mk("B2", "丙和死者吵过"),
    mk("B3", "丁迟到"),
  ];
  const r = checkEvidenceBalance({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some((s) => s.includes("证据失衡")), "应报证据失衡");
  assert.strictEqual(r.stats.killer, 4);
  assert.strictEqual(r.stats.maxOther, 1);
});

test("有嫌疑人一条线索都没被提到 → 告警（等于白送排除）", () => {
  const clues = [
    mk("A1", "甲袖口有血迹"),
    mk("A2", "乙欠债"),
    mk("A3", "丙吵架"),
  ];
  const r = checkEvidenceBalance({ clues, characters: CHARS, murderer: "甲" });
  assert.ok(r.issues.some((s) => s.includes("白送排除") && s.includes("丁")), `应点名丁，实际：${r.issues.join(" | ")}`);
});

test("凶手的线索全在明面上 → 告警缺最后一块拼图", () => {
  const clues = [
    mk("A1", "甲袖口有血迹"),
    mk("A2", "乙欠债"),
    mk("A3", "丙吵架"),
    mk("A4", "丁迟到"),
  ];
  const r = checkEvidenceBalance({ clues, characters: CHARS, murderer: "甲" });
  assert.ok(r.issues.some((s) => s.includes("最后一块拼图")), "应报缺隐藏线索");
  assert.strictEqual(r.stats.hiddenKillerClues, 0);
});

test("凶手关键线索藏在隐藏子线索里 → 不报该问题", () => {
  const clues = [
    mk("A1", "账房桌面有便签（发现隐藏线索，可深入调查）"),
    mk("A2", "便签背面是甲的笔迹（通过深入调查A1「账房桌面有便签」获取）"),
    mk("A3", "乙欠债"),
    mk("A4", "丙吵架"),
    mk("A5", "丁迟到"),
  ];
  const r = checkEvidenceBalance({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.stats.hiddenKillerClues, 1);
  assert.ok(!r.issues.some((s) => s.includes("最后一块拼图")), "已有隐藏线索，不该再报");
});

test("均衡且带隐藏线索 → 通过", () => {
  const clues = [
    mk("A1", "账房桌面有便签（发现隐藏线索，可深入调查）"),
    mk("A2", "便签是甲的笔迹（通过深入调查A1「账房桌面有便签」获取）"),
    mk("A3", "乙的当票"),
    mk("A4", "丙的借据"),
    mk("A5", "丁的辞退信"),
  ];
  const r = checkEvidenceBalance({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, true, `不应有问题，实际：${r.issues.join(" | ")}`);
});

test("空输入安全", () => {
  assert.strictEqual(checkEvidenceBalance({ clues: [], characters: CHARS, murderer: "甲" }).ok, true);
  assert.strictEqual(checkEvidenceBalance({ clues: [mk("A1", "甲")], characters: CHARS, murderer: "" }).ok, true);
});

test("isHiddenChild 能识别「通过深入调查 A1」这类引用", () => {
  const all = [mk("A1", "x"), mk("A2", "y（通过深入调查A1「x」获取）")];
  assert.strictEqual(isHiddenChild(all[1]), true);
  assert.strictEqual(isHiddenChild(all[0]), false, "父线索不能被当成隐藏子线索");
});

test("mentions 只看正文是否含名字", () => {
  assert.strictEqual(mentions(mk("A1", "甲的袖口"), "甲"), true);
  assert.strictEqual(mentions(mk("A1", "袖口有血迹"), "甲"), false);
});
