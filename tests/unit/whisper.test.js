// 私聊测试
//
// 私聊是"信息博弈"的另一半：公屏之外拉拢、诈供、串供。
// 最要紧的一条性质是**隔离** —— 第三方绝不能拿到两人的私聊内容。
// 这里把它当红线测：任何一条取数路径都不能漏给无关玩家。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

/** 最小 Redis 假实现，够 addWhisper / getWhispersFor 用 */
function fakeRedis() {
  const lists = new Map();
  const kv = new Map([["game:R1", "1"]]); // 房间存在，避免 addWhisper 的孤儿清理把写入撤掉
  const L = (k) => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
  return {
    _lists: lists,
    async rpush(k, ...vs) { L(k).push(...vs); return L(k).length; },
    async lrange(k, start, stop) {
      const a = L(k); const len = a.length;
      const s = start < 0 ? Math.max(0, len + start) : start;
      const e = stop < 0 ? len + stop : stop;
      return a.slice(s, e + 1);
    },
    async ltrim(k, start, stop) {
      const a = L(k); const len = a.length;
      const s = start < 0 ? Math.max(0, len + start) : start;
      const e = stop < 0 ? len + stop : stop;
      lists.set(k, a.slice(s, e + 1));
    },
    async expire() { return 1; },
    async del(...ks) { for (const k of ks) lists.delete(k); return ks.length; },
    async exists(k) { return kv.has(k) ? 1 : 0; },
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, String(v)); return "OK"; },
    async smembers() { return []; },
    async sadd() { return 1; },
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

test("写入后能按参与者读回", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "张三", "p2", "李四", "你昨晚到底在哪", "round1");
  const forP1 = await gm.getWhispersFor("R1", "p1");
  assert.strictEqual(forP1.length, 1);
  assert.strictEqual(forP1[0].content, "你昨晚到底在哪");
  assert.strictEqual(forP1[0].fromName, "张三");
});

test("接收方也能读到（收发都算）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "张三", "p2", "李四", "在书房", "round1");
  assert.strictEqual((await gm.getWhispersFor("R1", "p2")).length, 1);
});

test("隔离红线：第三方读不到别人的私聊", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "张三", "p2", "李四", "我们结盟吧，别投我", "round1");
  const forP3 = await gm.getWhispersFor("R1", "p3");
  assert.deepStrictEqual(forP3, [], "无关玩家绝不能拿到私聊内容");
});

test("隔离红线：只看得到与自己有关的那几条", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "甲乙的悄悄话", "round1");
  await gm.addWhisper("R1", "p3", "丙", "p4", "丁", "丙丁的悄悄话", "round1");
  await gm.addWhisper("R1", "p1", "甲", "p3", "丙", "甲丙的悄悄话", "round1");

  const forP1 = await gm.getWhispersFor("R1", "p1");
  assert.strictEqual(forP1.length, 2);
  assert.ok(!forP1.some(m => m.content === "丙丁的悄悄话"), "不含与自己无关的那条");

  const forP2 = await gm.getWhispersFor("R1", "p2");
  assert.strictEqual(forP2.length, 1);
  assert.ok(!forP2.some(m => m.content === "甲丙的悄悄话"));
});

test("不同房间互不串扰", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "R1的话", "round1");
  assert.deepStrictEqual(await gm.getWhispersFor("R2", "p1"), []);
});

test("按时间正序返回（读起来才像对话）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "第一句", "round1");
  await gm.addWhisper("R1", "p2", "乙", "p1", "甲", "第二句", "round1");
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "第三句", "round1");
  const thread = await gm.getWhispersFor("R1", "p1");
  assert.deepStrictEqual(thread.map(m => m.content), ["第一句", "第二句", "第三句"]);
});

test("内容超长被截断（防止把长篇内容灌进私聊）", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "x".repeat(1000), "round1");
  const [m] = await gm.getWhispersFor("R1", "p1");
  assert.ok(m.content.length <= 400);
});

test("条数上限：超出后丢弃最早的", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  for (let i = 0; i < 520; i++) {
    await gm.addWhisper("R1", "p1", "甲", "p2", "乙", `第${i}句`, "round1");
  }
  assert.ok(redis._lists.get("game:R1:whisper").length <= 500, "列表应被裁剪");
  const thread = await gm.getWhispersFor("R1", "p1");
  assert.ok(!thread.some(m => m.content === "第0句"), "最早的那条应已被丢弃");
});

test("房间已被删时撤销写入（不留孤儿子键）", async () => {
  const redis = fakeRedis();
  redis.exists = async () => 0; // 房间不存在
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "不该留下", "round1");
  assert.strictEqual(redis._lists.has("game:R1:whisper"), false, "房间已删就不该留下私聊键");
});

test("私聊与公屏分开存：不会混进聊天记录", async () => {
  const redis = fakeRedis();
  const gm = loadGM(redis);
  await gm.addWhisper("R1", "p1", "甲", "p2", "乙", "悄悄话", "round1");
  // 私聊写在独立键里，公屏读的是 game:{code}:chat
  assert.ok(redis._lists.has("game:R1:whisper"));
  assert.ok(!redis._lists.has("game:R1:chat"), "私聊不能落进公屏键");
});
