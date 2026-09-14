// 口令哈希（纯函数，不依赖 Redis/PG）
//
// 这里钉住三件在这次安全审计里才补上的事：
//   1) 新哈希把参数（迭代次数）写进串里 —— 以后调整强度不会把老用户锁在门外；
//   2) 旧格式 salt:hash（1 万次迭代）仍然验得过，且能被识别为"需要升级"；
//   3) 异常输入不能让校验抛错或误判通过（原来的实现只要字符串里有冒号就往下算，
//      并把比较写成 hash === verify，既不是定时安全比较，也挡不住畸形数据）。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { hashPassword, verifyPassword, needsRehash, PBKDF2_ITERATIONS, LEGACY_ITERATIONS } = require("../modules/auth");

test("新哈希带参数前缀，且能自我校验", async () => {
  const stored = await hashPassword("correct horse battery staple");
  const parts = stored.split("$");
  assert.strictEqual(parts.length, 4, "格式应为 pbkdf2$迭代次数$盐$哈希");
  assert.strictEqual(parts[0], "pbkdf2");
  assert.strictEqual(Number(parts[1]), PBKDF2_ITERATIONS);
  assert.ok(parts[2].length >= 32, "盐不应过短");
  assert.ok(parts[3].length >= 64, "哈希不应过短");
  assert.strictEqual(await verifyPassword("correct horse battery staple", stored), true);
  assert.strictEqual(await verifyPassword("wrong password", stored), false);
});

test("同一口令每次哈希都不同（盐随机），但都能验过", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notStrictEqual(a, b, "两次哈希不应相同，否则说明没加随机盐");
  assert.strictEqual(await verifyPassword("same-password", a), true);
  assert.strictEqual(await verifyPassword("same-password", b), true);
});

test("旧的 salt:hash（1 万次迭代）仍能验过 —— 不能让已有用户登不进来", async () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const legacy = salt + ":" + crypto.pbkdf2Sync("old-password", salt, LEGACY_ITERATIONS, 64, "sha512").toString("hex");
  assert.strictEqual(await verifyPassword("old-password", legacy), true, "老格式必须兼容");
  assert.strictEqual(await verifyPassword("not-the-password", legacy), false);
});

test("needsRehash：旧格式与低迭代次数标记为需要升级，当前参数不标记", async () => {
  const legacy = "abcd:" + "0".repeat(128);
  assert.strictEqual(needsRehash(legacy), true, "旧格式应升级");
  assert.strictEqual(needsRehash(`pbkdf2$10000$abcd$` + "0".repeat(128)), true, "迭代次数偏低应升级");
  assert.strictEqual(needsRehash(await hashPassword("x")), false, "当前参数不应反复重算");
  assert.strictEqual(needsRehash(""), false);
  assert.strictEqual(needsRehash(null), false);
});

test("畸形哈希一律返回 false，不抛异常也不误判通过", async () => {
  const bad = [
    "", null, undefined, "no-colon-no-prefix", "onlysalt:",
    ":onlyhash", "pbkdf2$", "pbkdf2$abc$salt$hash", "pbkdf2$0$salt$hash",
    `pbkdf2$10000$salt$ZZZZ`, "pbkdf2$10000$$" + "0".repeat(128), "a:b:c",
    "pbkdf2$10000$salt$00",   // 哈希过短 → 长度不等
  ];
  for (const stored of bad) {
    const ok = await verifyPassword("anything", stored);
    assert.strictEqual(ok, false, `畸形哈希不应通过校验: ${JSON.stringify(stored)}`);
  }
});

test("哈希长度不同时走长度检查分支（timingSafeEqual 遇到不同长度会抛错）", async () => {
  // 造一个盐/次数都合法、但哈希长度与 64 字节不一致的串
  const short = `pbkdf2$${PBKDF2_ITERATIONS}$abcd$` + "ab".repeat(8);
  assert.strictEqual(await verifyPassword("x", short), false);
});
