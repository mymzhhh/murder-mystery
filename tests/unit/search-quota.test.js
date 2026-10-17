// 搜证配额测试
//
// 这个机制经历过一次策略反转，两种模式都必须钉住：
//
//   不限次数（当前默认，SEARCH_MAX_PER_ROUND 未设或为 0）
//     —— 起因：3 次/轮时实测一局 42 条线索、1 个真人玩家，至少有 18 条永远不会被发现，
//        推理缺证据、游戏走不通。"搜哪里"的取舍价值远小于"线索根本搜不出来"的伤害。
//        注意"不限"不等于不计数：用量照记，便于审计每局搜证量。
//
//   有限次数（SEARCH_MAX_PER_ROUND > 0）
//     —— 机制保留，随时可以改环境变量启用。上限逻辑本身仍需正确：
//        到限拒绝、且**被拒绝的尝试不能把计数顶上去**（否则会越拒越死）。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

/** 最小 Redis 假实现：只覆盖配额部分用到的方法 */
function fakeRedis() {
  const hashes = new Map();
  const ttls = new Map();
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  return {
    _hashes: hashes,
    _ttls: ttls,
    async hincrby(key, field, by) {
      const m = h(key);
      const v = (parseInt(m.get(field), 10) || 0) + by;
      m.set(field, String(v));
      return v;
    },
    async hget(key, field) { return h(key).get(field); },
    async expire(key, sec) { ttls.set(key, sec); return 1; },
    async del(...keys) { for (const k of keys) hashes.delete(k); return keys.length; },
  };
}

/** 用假 Redis 重新加载 game-manager；env 为 null 表示不设该变量（走默认） */
function loadGM(redis, env = null) {
  if (env === null) delete process.env.SEARCH_MAX_PER_ROUND;
  else process.env.SEARCH_MAX_PER_ROUND = String(env);

  const p = require.resolve("../../src/game/game-manager");
  delete require.cache[p];
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.endsWith("redis-client")) {
      return {
        getRedis: () => redis, ensureRedis: async () => redis,
        scanKeys: async (pat) => {
          const re = new RegExp("^" + pat.replace(/\*/g, ".*") + "$");
          return [...redis._hashes.keys()].filter(k => re.test(k));
        },
      };
    }
    return orig.apply(this, arguments);
  };
  try {
    return require("../../src/game/game-manager");
  } finally {
    Module._load = orig;
    delete require.cache[p];
    delete process.env.SEARCH_MAX_PER_ROUND; // 别污染后面的用例
  }
}

// ==================== 不限次数（当前默认）====================

test("默认是不限次数（上限为 0）", () => {
  const gm = loadGM(fakeRedis());
  assert.strictEqual(gm.SEARCH_MAX_PER_ROUND, 0, "默认应关闭上限");
});

test("不限次数时永远放行，且标记 unlimited", async () => {
  const gm = loadGM(fakeRedis());
  for (let i = 1; i <= 50; i++) {
    const r = await gm.consumeSearchQuota("R1", 1, "alice");
    assert.strictEqual(r.allowed, true, `第 ${i} 次应放行`);
    assert.strictEqual(r.unlimited, true);
  }
});

test("不限次数时仍然计数（便于审计每局搜证量）", async () => {
  const gm = loadGM(fakeRedis());
  await gm.consumeSearchQuota("R1", 1, "alice");
  await gm.consumeSearchQuota("R1", 1, "alice");
  const q = await gm.getSearchQuota("R1", 1, "alice");
  assert.strictEqual(q.used, 2, "用量要照记，只是不据此拒绝");
  assert.strictEqual(q.unlimited, true);
});

test("不限次数时首次消耗仍设兜底 TTL（防键永久残留）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.consumeSearchQuota("R1", 1, "alice");
  assert.strictEqual(redis._ttls.get("game:R1:searches:1"), 24 * 3600);
});

// ==================== 有限次数（可选启用）====================

test("设成 3 时上限生效：逐次放行，到限后拒绝", async () => {
  const gm = loadGM(fakeRedis(), 3);
  assert.strictEqual(gm.SEARCH_MAX_PER_ROUND, 3);
  for (let i = 1; i <= 3; i++) {
    const r = await gm.consumeSearchQuota("R1", 1, "alice");
    assert.strictEqual(r.allowed, true, `第 ${i} 次应放行`);
    assert.strictEqual(r.remaining, 3 - i);
  }
  const over = await gm.consumeSearchQuota("R1", 1, "alice");
  assert.strictEqual(over.allowed, false, "超出上限应拒绝");
  assert.strictEqual(over.unlimited, false);
});

test("被拒绝的尝试不会把计数顶上去（否则会越拒越死）", async () => {
  const gm = loadGM(fakeRedis(), 3);
  for (let i = 0; i < 3; i++) await gm.consumeSearchQuota("R1", 1, "alice");
  for (let i = 0; i < 5; i++) await gm.consumeSearchQuota("R1", 1, "alice"); // 连续被拒
  const q = await gm.getSearchQuota("R1", 1, "alice");
  assert.strictEqual(q.used, 3, "被拒绝的请求不应累加计数");
  assert.strictEqual(q.remaining, 0);
});

test("有限模式下轮次 / 玩家 / 房间各自独立", async () => {
  const gm = loadGM(fakeRedis(), 2);
  await gm.consumeSearchQuota("R1", 1, "alice");
  await gm.consumeSearchQuota("R1", 1, "alice");

  assert.strictEqual((await gm.consumeSearchQuota("R1", 2, "alice")).allowed, true, "新一轮应恢复满额");
  assert.strictEqual((await gm.consumeSearchQuota("R1", 1, "bob")).allowed, true, "其他玩家不受影响");
  assert.strictEqual((await gm.consumeSearchQuota("R2", 1, "alice")).allowed, true, "其他房间不受影响");
});

test("设成负数或非数字时回退为不限", () => {
  assert.strictEqual(loadGM(fakeRedis(), -5).SEARCH_MAX_PER_ROUND, 0);
  assert.strictEqual(loadGM(fakeRedis(), "abc").SEARCH_MAX_PER_ROUND, 0);
});

// ==================== 通用 ====================

test("配额键沿用 game:{code}: 前缀，才能被房间清理逻辑带走", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.consumeSearchQuota("ABC123", 2, "alice");
  assert.ok(redis._hashes.has("game:ABC123:searches:2"), "键名必须在 game:{code}: 家族下");
});

test("clearSearchQuota 清掉该房间全部轮次", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.consumeSearchQuota("R1", 1, "alice");
  await gm.consumeSearchQuota("R1", 2, "alice");
  assert.strictEqual(redis._hashes.size, 2);
  await gm.clearSearchQuota("R1");
  assert.strictEqual(redis._hashes.size, 0, "两个轮次的配额键都应被清掉");
});

test("未消耗时 getSearchQuota 返回已用 0", async () => {
  const gm = loadGM(fakeRedis());
  const q = await gm.getSearchQuota("R1", 1, "newbie");
  assert.strictEqual(q.used, 0);
});

// ==================== hasSearchBudget：判"还能不能搜"必须看 unlimited ====================
// 实测 bug：AI 的"续搜"判据写成 `if (quota.remaining <= 0) return;`，
// 而不限次数时 remaining 恒为 0（占位值）→ **每个 AI 每轮只搜一次就永久停手**。
// 一局 50 条线索 4 分钟里只被翻出 6 条（6 个 AI 各一条），数字一动不动。
// 这个 helper 就是那个判据的唯一实现，必须把两种模式都钉死。
test("hasSearchBudget：不限次数即使 remaining=0 也算有额度（这就是那个 bug 的根因）", async () => {
  const gm = loadGM(fakeRedis(), null);   // 默认 = 不限次数
  const q = await gm.consumeSearchQuota("R1", 1, "ai_1");
  assert.strictEqual(q.remaining, 0, "不限次数时 remaining 是 0（占位值）");
  assert.strictEqual(q.unlimited, true);
  assert.strictEqual(gm.hasSearchBudget(q), true, "必须判为『还能搜』，否则 AI 只搜一次就停");
  assert.strictEqual(gm.hasSearchBudget(await gm.getSearchQuota("R1", 1, "ai_1")), true);
});

test("hasSearchBudget：有限次数时按剩余量判断", async () => {
  const gm = loadGM(fakeRedis(), 2);
  const first = await gm.consumeSearchQuota("R1", 1, "ai_1");   // 用 1，剩 1
  assert.strictEqual(gm.hasSearchBudget(first), true);
  const second = await gm.consumeSearchQuota("R1", 1, "ai_1");  // 用 2，剩 0
  assert.strictEqual(gm.hasSearchBudget(second), false, "到限就该停");
  const denied = await gm.consumeSearchQuota("R1", 1, "ai_1");  // 被拒（计数回退）
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(gm.hasSearchBudget(denied), false, "被拒绝时也不该判成有额度（否则会无限重试）");
});

test("hasSearchBudget：缺字段/空值一律判无额度（宁可少搜也不能死循环）", () => {
  const gm = loadGM(fakeRedis(), null);
  assert.strictEqual(gm.hasSearchBudget(null), false);
  assert.strictEqual(gm.hasSearchBudget(undefined), false);
  assert.strictEqual(gm.hasSearchBudget({}), false);
  assert.strictEqual(gm.hasSearchBudget({ remaining: 0 }), false);
});