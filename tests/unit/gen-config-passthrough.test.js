// 配置透传：调用方传给生成器的选项不能在中间被裁掉。
//
// 实测事故（2026-10-19）：script-writer 里曾有**内联重新构造**的 genConfig 对象字面量，
// 只带了 playerCount/npcCount/isPVE/advancedMode，漏了 images。
// 于是调用方明明传了 `images:{enabled:true}`，builder 里 `cfg.images` 却是 null，
// 整轮生成跑完 **108 分钟**，「配图」阶段一次都没执行 —— 而且日志里一行都没有
// （hook 的判断是 `if (imgCfg.enabled)`，假值静默跳过）。
// 这类"重新构造配置时漏字段"的坑只有可测才防得住，所以抽出了 buildGenConfig。
const test = require("node:test");
const assert = require("node:assert");
const { buildGenConfig } = require("../../src/script/script-writer.js");

const BASE = { playerCount: 4, npcCount: 0, isPVE: false };

test("images 必须原样透传给生成器", () => {
  const cfg = buildGenConfig(BASE, { images: { enabled: true, cover: true, characters: true } });
  assert.deepStrictEqual(cfg.images, { enabled: true, cover: true, characters: true });
});

test("没有 images 时是 null（builder 据此判断是否出图）", () => {
  assert.strictEqual(buildGenConfig(BASE, {}).images, null);
  assert.strictEqual(buildGenConfig(BASE, undefined).images, null);
  assert.strictEqual(buildGenConfig(BASE, { images: "yes" }).images, null, "非对象不接受");
});

test("基础字段与 advancedMode 照旧", () => {
  const cfg = buildGenConfig(BASE, { advancedMode: "hardcore" });
  assert.strictEqual(cfg.playerCount, 4);
  assert.strictEqual(cfg.npcCount, 0);
  assert.strictEqual(cfg.isPVE, false);
  assert.strictEqual(cfg.advancedMode, "hardcore");
  assert.strictEqual(buildGenConfig(BASE, { advancedMode: "乱写" }).advancedMode, "standard");
});

test("images 与 advancedMode 同时透传（不互相干扰）", () => {
  const cfg = buildGenConfig(BASE, { advancedMode: "emotional", images: { enabled: true } });
  assert.strictEqual(cfg.advancedMode, "emotional");
  assert.deepStrictEqual(cfg.images, { enabled: true });
});

test("不修改调用方传来的对象（避免上游被悄悄改掉）", () => {
  const sc = { images: { enabled: true }, advancedMode: "hardcore" };
  const before = JSON.stringify(sc);
  buildGenConfig(BASE, sc);
  assert.strictEqual(JSON.stringify(sc), before);
});

test("sessionId 要能透传（配图按 scriptId 落库，builder 里拿不到会话）", () => {
  const cfg = buildGenConfig({ playerCount: 5, npcCount: 0, isPVE: false }, { images: { enabled: true } });
  cfg.sessionId = "abc-123";
  assert.strictEqual(cfg.sessionId, "abc-123");
});
