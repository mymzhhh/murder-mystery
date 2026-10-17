// 阶段流水线测试
//
// 背景：自我介绍（intro）阶段已从流程中移除 —— 玩家不会认真填那个表单，
// 自我介绍本来就该在讨论阶段由各人自己开口。
//
// 移除一个阶段有两处很容易出错、且都是"上线后才炸"的地方，所以必须钉住：
//   1) 旧房间的 phase 字段可能仍是 "intro" —— 必须能安全驶出，不能卡死
//   2) intro 的权限配置必须保留 —— 否则 getPhaseConfig 会回退到 lobby，
//      把 allowChat 从 true 变成…… 其实 lobby 也是 true，但 allowClueReq 等字段会错位
const test = require("node:test");
const assert = require("node:assert");

const { getNextPhase, getPhaseConfig } = require("../../src/game/game-engine");

test("阅读剧本之后直接进入第一轮搜证讨论（跳过已废弃的自我介绍）", () => {
  assert.strictEqual(getNextPhase("reading"), "round1");
});

test("旧房间停在 intro 时能安全驶出（否则会永久卡住）", () => {
  assert.strictEqual(getNextPhase("intro"), "round1");
});

test("完整阶段链：lobby → reading → round1 → round2 → voting → truth_reveal → finished", () => {
  const chain = [];
  let p = "lobby";
  while (p) { chain.push(p); p = getNextPhase(p); }
  assert.deepStrictEqual(chain, ["lobby", "reading", "round1", "round2", "voting", "truth_reveal", "finished"]);
});

test("intro 不在新流程链里", () => {
  const chain = [];
  let p = "lobby";
  while (p) { chain.push(p); p = getNextPhase(p); }
  assert.ok(!chain.includes("intro"), "新房间不该再经过自我介绍阶段");
});

test("finished 之后没有下一阶段", () => {
  assert.strictEqual(getNextPhase("finished"), null);
});

test("未知阶段返回 null（不抛异常）", () => {
  assert.strictEqual(getNextPhase("nonsense"), null);
  assert.strictEqual(getNextPhase(""), null);
});

test("intro 的权限配置仍保留，供旧房间使用", () => {
  const cfg = getPhaseConfig("intro");
  assert.strictEqual(cfg.label, "自我介绍");
  assert.strictEqual(cfg.allowChat, true);
  assert.strictEqual(cfg.allowClueReq, false, "自我介绍阶段不该能搜证");
});

test("intro 的配置没有被 lobby 兜底覆盖（标签能区分）", () => {
  assert.notStrictEqual(getPhaseConfig("intro").label, getPhaseConfig("lobby").label);
  assert.notStrictEqual(getPhaseConfig("intro").label, getPhaseConfig("unknown-phase").label);
});

test("round1/round2 仍可搜证可发言（移除 intro 没有误伤它们）", () => {
  for (const p of ["round1", "round2"]) {
    assert.strictEqual(getPhaseConfig(p).allowClueReq, true, `${p} 应能搜证`);
    assert.strictEqual(getPhaseConfig(p).allowChat, true, `${p} 应能发言`);
  }
});

test("reading 阶段不能发言（自我介绍不在这个阶段发）", () => {
  assert.strictEqual(getPhaseConfig("reading").allowChat, false);
});
