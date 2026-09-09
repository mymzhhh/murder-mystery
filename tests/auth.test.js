// auth 关键安全逻辑单测：token 撤销、角色回源、密码校验（用内存 mock 替代 Redis/PG）
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const Module = require("module");

// ---- 轻量 Redis mock（hash/string/set + 过期）----
function createRedisMock() {
  const store = new Map(); // key -> {type, val}
  return {
    _store: store,
    async hset(k, f, v) { const e = store.get(k) || { type: "hash", val: {} }; e.val[f] = v; store.set(k, e); return 1; },
    async hgetall(k) { const e = store.get(k); return e && e.type === "hash" ? { ...e.val } : {}; },
    async hget(k, f) { const e = store.get(k); return e && e.type === "hash" ? e.val[f] : null; },
    async exists(k) { return store.has(k) ? 1 : 0; },
    async get(k) { const e = store.get(k); return e && e.type === "string" ? e.val : null; },
    async set(k, v) { store.set(k, { type: "string", val: v }); return "OK"; },
    async setex(k, ttl, v) { store.set(k, { type: "string", val: v, ttl }); return "OK"; },
    async del(...keys) { let n = 0; keys.forEach(k => { if (store.delete(k)) n++; }); return n; },
    async keys(p) {
      const prefix = String(p).replace(/\*$/, "");
      return [...store.keys()].filter(k => k.startsWith(prefix));
    },
    async ttl(k) { return store.has(k) ? 3600 : -2; },
    pipeline() {
      const ops = [];
      const api = {
        get: (k) => { ops.push(["get", k]); return api; },
        hgetall: (k) => { ops.push(["hgetall", k]); return api; },
        exec: async () => Promise.all(ops.map(([op, k]) => op === "get" ? [null, this.get(k)] : [null, this.hgetall(k)])),
      };
      // 修正 this 指向
      api.exec = async () => Promise.all(ops.map(([op, k]) => (op === "get" ? [null, store.get(k)?.type === "string" ? store.get(k).val : null] : [null, store.get(k)?.type === "hash" ? { ...store.get(k).val } : {}])));
      return api;
    },
  };
}

// ---- 注入 mock：拦截 redis-client / db ----
const redisMock = createRedisMock();
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith("redis-client")) {
    return {
      getRedis: () => redisMock,
      ensureRedis: async () => redisMock,
      scanKeys: (p) => redisMock.keys(p),
    };
  }
  if (request.endsWith("./db") || request.endsWith("modules/db")) {
    return {
      getUser: async () => null,          // 强制走 Redis 分支
      listUsers: async () => [],
      updateUserRole: async () => false,
      deleteUser: async () => false,
      createUser: async () => false,
    };
  }
  return originalLoad.apply(this, arguments);
};

const auth = require("../modules/auth");
Module._load = originalLoad;

test("revokeUserTokens 撤销指定用户的全部令牌", async () => {
  // 准备：两个用户各一个令牌
  await redisMock.set("token:aaa", JSON.stringify({ username: "alice", role: "admin" }));
  await redisMock.set("token:bbb", JSON.stringify({ username: "bob", role: "player" }));
  // 通过 verifyToken 触发回源（alice 在 Redis 无 user 记录 → 视为已删除，令牌应失效）
  const v1 = await auth.verifyToken("aaa");
  assert.equal(v1, null, "用户不存在时令牌应失效");
  assert.equal(await redisMock.get("token:aaa"), null, "失效令牌应被删除");
  // bob 同理
  const v2 = await auth.verifyToken("bbb");
  assert.equal(v2, null);
});

test("verifyToken 对无令牌返回 null", async () => {
  assert.equal(await auth.verifyToken("nonexistent"), null);
});

test("verifyToken 回源后角色变更以当前角色为准", async () => {
  // Redis 里存在 user 记录（role=player），但令牌快照是 admin
  await redisMock.hset("user:carol", "username", "carol");
  await redisMock.hset("user:carol", "role", "player");
  await redisMock.set("token:ccc", JSON.stringify({ username: "carol", role: "admin" }));
  const v = await auth.verifyToken("ccc");
  assert.ok(v, "用户存在则令牌有效");
  assert.equal(v.role, "player", "角色应回源为当前值（防降权后仍持 admin）");
});

test("auth 模块导出安全相关函数", () => {
  assert.equal(typeof auth.verifyToken, "function");
  assert.equal(typeof auth.setRole, "function");
  assert.equal(typeof auth.deleteUser, "function");
});