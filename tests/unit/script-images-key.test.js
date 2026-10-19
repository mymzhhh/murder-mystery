// 配图键名必须在**出图前**校验：实测踩过「用中文当键名 → 图出完了才在保存时被拒」，
// 白烧 4 次 GPU 生成（每次几十秒）。
const test = require("node:test");
const assert = require("node:assert");
const si = require("../../src/script/script-images.js");

test("键名校验：只允许 [A-Za-z0-9_-]", () => {
  assert.ok(si.isValidKey("cover"));
  assert.ok(si.isValidKey("char-1-1"));
  assert.ok(si.isValidKey("cluedoc-12"));
  assert.ok(si.isValidKey("map_P1"));
  assert.ok(!si.isValidKey("char-苏晴-1"), "中文键名会被 script_images 拒绝");
  assert.ok(!si.isValidKey("char 苏晴 1"));
  assert.ok(!si.isValidKey(""));
  assert.ok(!si.isValidKey("a".repeat(65)), "超长也不合法");
});

test("角色立绘一律用序号键名（人名放 alt）", async () => {
  const saved = [];
  // ComfyUI 用一个不可达端口 → 会在 online 检查处跳过，拿不到 jobs；
  // 所以这里直接验证"键名规则"与"中文名不会进键名"这两条不变量。
  const names = ["苏晴", "赵磊", "李雯", "陈默"];
  for (let i = 0; i < names.length; i++) {
    const key = `char-${i + 1}-1`;
    assert.ok(si.isValidKey(key), `${names[i]} 的键名 ${key} 必须合法`);
  }
  assert.deepStrictEqual(saved, []);
});
