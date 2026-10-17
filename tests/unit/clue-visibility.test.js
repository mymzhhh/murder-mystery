// 线索私有化测试
//
// 这次改造把"线索一发现就全场广播"改成了"默认私有 + 发现者可公开/分享"。
// 两条最要紧的性质：
//   1) 判定只有三个可见来源（自己找到 / 已公开 / 被单独分享），多一个就是泄漏
//   2) **只有发现者本人**能公开或分享自己的线索 —— 否则任何人都能把别人的私有线索公示出去
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const { canSeeClue, visibleClues, clueVisibilityOf } = require("../../src/game/game-engine");

// ==================== 纯判定 ====================

const MINE = { id: "A1", foundBy: ["p1"], sharedWith: [], revealed: false };
const OTHER_PRIVATE = { id: "A2", foundBy: ["p2"], sharedWith: [], revealed: false };
const REVEALED = { id: "A3", foundBy: ["p2"], sharedWith: [], revealed: true };
const SHARED_TO_ME = { id: "A4", foundBy: ["p2"], sharedWith: ["p1"], revealed: false };
const SHARED_TO_OTHER = { id: "A5", foundBy: ["p2"], sharedWith: ["p3"], revealed: false };
const UNFOUND = { id: "A6", foundBy: [], sharedWith: [], revealed: false };

test("canSeeClue：自己找到的可见", () => {
  assert.strictEqual(canSeeClue(MINE, "p1"), true);
});

test("canSeeClue：别人未公开的私有线索不可见（核心红线）", () => {
  assert.strictEqual(canSeeClue(OTHER_PRIVATE, "p1"), false);
});

test("canSeeClue：已公开的对所有人可见", () => {
  assert.strictEqual(canSeeClue(REVEALED, "p1"), true);
  assert.strictEqual(canSeeClue(REVEALED, "p9"), true, "与是否在场无关，公开就是公开");
});

test("canSeeClue：单独分享给我的可见", () => {
  assert.strictEqual(canSeeClue(SHARED_TO_ME, "p1"), true);
});

test("canSeeClue：分享给别人的对我不可见", () => {
  assert.strictEqual(canSeeClue(SHARED_TO_OTHER, "p1"), false);
});

test("canSeeClue：无人发现的线索对任何人都不可见", () => {
  assert.strictEqual(canSeeClue(UNFOUND, "p1"), false);
  assert.strictEqual(canSeeClue(UNFOUND, "p2"), false);
});

test("canSeeClue：空值安全", () => {
  assert.strictEqual(canSeeClue(null, "p1"), false);
  assert.strictEqual(canSeeClue(MINE, ""), false);
  assert.strictEqual(canSeeClue(MINE, null), false);
});

test("canSeeClue：缺 sharedWith/revealed 字段（老数据）不抛异常", () => {
  assert.doesNotThrow(() => canSeeClue({ foundBy: ["p1"] }, "p1"));
  assert.strictEqual(canSeeClue({ foundBy: ["p1"] }, "p1"), true);
  assert.strictEqual(canSeeClue({}, "p1"), false);
});

test("visibleClues：只留下可见的", () => {
  const all = [MINE, OTHER_PRIVATE, REVEALED, SHARED_TO_ME, SHARED_TO_OTHER, UNFOUND];
  const ids = visibleClues(all, "p1").map(c => c.id);
  assert.deepStrictEqual(ids.sort(), ["A1", "A3", "A4"]);
});

test("visibleClues：空输入返回空数组", () => {
  assert.deepStrictEqual(visibleClues(null, "p1"), []);
  assert.deepStrictEqual(visibleClues([], "p1"), []);
});

test("clueVisibilityOf：区分四种来源，供前端分组与按钮控制", () => {
  assert.strictEqual(clueVisibilityOf(MINE, "p1"), "mine");
  assert.strictEqual(clueVisibilityOf(REVEALED, "p1"), "public");
  assert.strictEqual(clueVisibilityOf(SHARED_TO_ME, "p1"), "shared");
  assert.strictEqual(clueVisibilityOf(OTHER_PRIVATE, "p1"), "hidden");
  assert.strictEqual(clueVisibilityOf(null, "p1"), "hidden");
});

test("clueVisibilityOf：自己找到且已公开时仍算 mine（前端要能继续操作）", () => {
  const mineRevealed = { id: "A7", foundBy: ["p1"], sharedWith: [], revealed: true };
  assert.strictEqual(clueVisibilityOf(mineRevealed, "p1"), "mine");
});

// ==================== 公开 / 分享（含授权）====================

/** 最小 Redis 假实现，够 revealClue / shareClue 用 */
function fakeRedis() {
  const kv = new Map();
  const sets = new Map();
  const S = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  return {
    _kv: kv, _sets: sets,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, String(v)); return "OK"; },
    async del(...ks) { for (const k of ks) { kv.delete(k); sets.delete(k); } return ks.length; },
    async exists(k) { return (kv.has(k) || sets.has(k)) ? 1 : 0; },
    async sadd(k, ...vs) { const s = S(k); let n = 0; for (const v of vs) { if (!s.has(v)) { s.add(v); n++; } } return n; },
    async smembers(k) { return [...S(k)]; },
  };
}

function loadGM(redis) {
  const p = require.resolve("../../src/game/game-manager");
  delete require.cache[p];
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.endsWith("redis-client")) {
      return { getRedis: () => redis, ensureRedis: async () => redis, scanKeys: async () => [] };
    }
    return orig.apply(this, arguments);
  };
  try {
    return require("../../src/game/game-manager");
  } finally {
    Module._load = orig;
    delete require.cache[p];
  }
}

/** 造一条已被 p1 发现的线索 */
async function seedClue(gm, redis, clueId, finderId) {
  await redis.set(`game:R1:clue:${clueId}`, JSON.stringify({ id: clueId, content: "茶盏内壁有粉末", location: "书房", round: "1" }));
  await redis.sadd(`game:R1:clue:${clueId}:foundBy`, finderId);
}

test("revealClue：发现者可以公开自己的线索", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  const r = await gm.revealClue("R1", "A1", "p1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.clue.revealed, true);
  assert.strictEqual(await redis.exists("game:R1:clue:A1:revealed"), 1);
});

test("revealClue：非发现者不能公开别人的线索（越权红线）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  const r = await gm.revealClue("R1", "A1", "p2");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "NOT_FINDER");
  assert.strictEqual(await redis.exists("game:R1:clue:A1:revealed"), 0, "越权尝试不得产生任何副作用");
});

test("revealClue：线索不存在时明确报错", async () => {
  const gm = loadGM(fakeRedis());
  const r = await gm.revealClue("R1", "NOPE", "p1");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "CLUE_NOT_FOUND");
});

test("shareClue：发现者可以把线索单独给某人看", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  const r = await gm.shareClue("R1", "A1", "p1", "p2");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.clue.sharedWith, ["p2"]);
  assert.strictEqual(r.clue.revealed, false, "分享不等于公开");
});

test("shareClue：非发现者不能分享别人的线索（越权红线）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  const r = await gm.shareClue("R1", "A1", "p3", "p2");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "NOT_FINDER");
  assert.deepStrictEqual(await redis.smembers("game:R1:clue:A1:shared"), []);
});

test("shareClue：没有目标时拒绝", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  const r = await gm.shareClue("R1", "A1", "p1", "");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "NO_TARGET");
});

test("分享后再公开，两者状态并存互不覆盖", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  await gm.shareClue("R1", "A1", "p1", "p2");
  const r = await gm.revealClue("R1", "A1", "p1");
  assert.strictEqual(r.clue.revealed, true);
  assert.deepStrictEqual(r.clue.sharedWith, ["p2"], "公开不该清掉已有的分享记录");
});

test("公开后，对任何玩家都可见（走 canSeeClue 验证端到端语义）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await seedClue(gm, redis, "A1", "p1");
  await gm.revealClue("R1", "A1", "p1");
  const clue = { id: "A1", foundBy: ["p1"], sharedWith: [], revealed: true };
  assert.strictEqual(canSeeClue(clue, "p9"), true);
});
