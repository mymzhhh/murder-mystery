// 两轮线索的分工（2026-10-20 用户要求）：
//   第一轮 = 杀机轮（人人有动机，不摆杀人物证）
//   第二轮 = 指凶轮（尸体/手法证据，且必须结合各人剧本才能推出）
//   线索不能太明显：任何单条不得同时含"凶手名 + 手法"
const test = require("node:test");
const assert = require("node:assert");
const { checkRoundPurpose, roundOf } = require("../../src/script/difficulty-checks.js");

const CHARS = ["甲", "乙", "丙", "丁"];
const c = (id, content) => ({ id, content });

test("轮次判定：A 系列=1、B 系列=2、显式 round 优先", () => {
  assert.strictEqual(roundOf(c("A3", "x")), 1);
  assert.strictEqual(roundOf(c("B7", "x")), 2);
  assert.strictEqual(roundOf({ id: "A1", content: "x", round: 2 }), 2);
});

test("第一轮出现尸体/凶器证据 → 告警", () => {
  const clues = [
    c("A1", "甲欠乙三十块大洋"),
    c("A2", "乙的当票"),
    c("A3", "丙与死者争吵过"),
    c("A4", "丁被死者扣了工钱"),
    c("A5", "库房地面有喷溅血迹"),      // ← 第一轮不该有
    c("A6", "门闩上有钝器砸痕"),        // ← 第一轮不该有
    c("B1", "死者头部有凹陷创口"),
    c("B2", "抽屉夹层里有钓线"),
  ];
  const r = checkRoundPurpose({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some((s) => s.includes("第一轮提前给答案")), r.issues.join(" | "));
  assert.strictEqual(r.stats.round1Killing.length, 2);
});

test("第一轮缺某个人的杀机 → 点名告警", () => {
  const clues = [
    c("A1", "甲欠乙三十块大洋"),
    c("A2", "乙的当票"),
    c("A3", "丙与死者争吵过"),
    // 丁 完全没有杀机线索
    c("B1", "死者头部有凹陷创口"),
    c("B2", "抽屉夹层里有钓线"),
  ];
  const r = checkRoundPurpose({ clues, characters: CHARS, murderer: "甲" });
  assert.ok(r.issues.some((s) => s.includes("缺杀机") && s.includes("丁")), r.issues.join(" | "));
});

test("第二轮某条同时含凶手名 + 手法 → 太明显，告警", () => {
  const clues = [
    c("A1", "甲欠乙三十块大洋"),
    c("A2", "乙的当票"),
    c("A3", "丙与死者争吵过"),
    c("A4", "丁被扣了工钱"),
    c("B1", "甲的钓线绕在门闩上，勒痕与死者颈部伤口一致"), // ← 单条定案
    c("B2", "排水洞边有锦纶纤维"),
  ];
  const r = checkRoundPurpose({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some((s) => s.includes("线索太明显")), r.issues.join(" | "));
  assert.deepStrictEqual(r.stats.singleClueGiveaway, ["B1"]);
});

test("第二轮证据不足 2 条 → 告警", () => {
  const clues = [
    c("A1", "甲欠乙三十块大洋"),
    c("A2", "乙的当票"),
    c("A3", "丙与死者争吵过"),
    c("A4", "丁被扣了工钱"),
    c("B1", "抽屉夹层里有钓线"),   // 勉强算 1 条（无手法词、无凶手名）
  ];
  const r = checkRoundPurpose({ clues, characters: CHARS, murderer: "甲" });
  assert.ok(r.issues.some((s) => s.includes("证据太薄")), r.issues.join(" | "));
});

test("合规的两轮结构 → 通过", () => {
  const clues = [
    c("A1", "账本上记着甲欠死者三十块大洋，多次被催讨"),
    c("A2", "乙的当票压着死者的名字，赎期已过"),
    c("A3", "丙与死者在院中争吵，说「这事没完」"),
    c("A4", "丁被死者扣了半年工钱，准备辞工"),
    c("B1", "死者头部有凹陷创口，创口边缘沾有铜锈"),
    c("B2", "库房门闩铁环上绕着一圈锦纶钓线，从墙根排水洞通向河边"),
    c("B3", "排水洞外的湿泥上有一枚布鞋印，尺码比死者小一号"),
  ];
  const r = checkRoundPurpose({ clues, characters: CHARS, murderer: "甲" });
  assert.strictEqual(r.ok, true, `不该告警，实际：${r.issues.join(" | ")}`);
});

test("空输入安全", () => {
  assert.strictEqual(checkRoundPurpose({ clues: [], characters: CHARS, murderer: "甲" }).ok, true);
  assert.strictEqual(checkRoundPurpose({ clues: [c("A1", "x")], characters: CHARS, murderer: "甲" }).ok, true);
});
