// script_images（剧本配图）在 core/db.js 里的 SQL 契约
//
// 为什么用 mock 而不是真库：tests/unit/ 下的既有测试（见 auth.test.js）都是"注入 mock
// 替换 Redis/PG"，跑 npm test 不应该依赖本机是否起着 PostgreSQL。这里用同一个路子：
// 拦住 require("pg")，用一个内存假表实现被用到的那几条 SQL，
// 于是能锁住"建表语句里有这张表且主键是复合键""写入走的是 upsert""读取失败返回 null"
// 这些真正容易写错的地方。真实字节读写由端到端验证（容器内 node + curl）覆盖。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---- 假 pg：记录 SQL，并用内存表模拟 script_images ----
const seen = [];               // { sql, params }
const rows = new Map();        // `${scriptId}\u0000${imgKey}` → { scriptId, imgKey, mime, bytes }
const key = (s, k) => `${s}\u0000${k}`;

function fakeQuery(text, params) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const p = params || [];
  seen.push({ sql, params: p });
  if (/^INSERT INTO script_images/i.test(sql)) {
    rows.set(key(p[0], p[1]), { scriptId: p[0], imgKey: p[1], mime: p[2], bytes: p[3] });
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT mime, bytes FROM script_images/i.test(sql)) {
    const found = rows.get(key(p[0], p[1]));
    return { rows: found ? [{ mime: found.mime, bytes: found.bytes }] : [], rowCount: found ? 1 : 0 };
  }
  if (/^SELECT img_key, mime, octet_length\(bytes\) AS size FROM script_images/i.test(sql)) {
    const list = [...rows.values()].filter((r) => r.scriptId === p[0])
      .sort((a, b) => a.imgKey.localeCompare(b.imgKey))
      .map((r) => ({ img_key: r.imgKey, mime: r.mime, size: r.bytes.length }));
    return { rows: list, rowCount: list.length };
  }
  return { rows: [], rowCount: 0 };
}

const fakePool = {
  on() { return this; },
  connect: async () => ({ query: fakeQuery, release() {} }),
  query: fakeQuery,
};

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://mock:mock@127.0.0.1:5432/mock";

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === "pg") return { Pool: function FakePool() { return fakePool; } };
  return originalLoad.apply(this, arguments);
};
const db = require("../../src/core/db");
Module._load = originalLoad;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

test("initDB 建表：script_images 存在，且主键是 (script_id, img_key) 复合键", async () => {
  await db.initDB();
  const ddl = seen.map((s) => s.sql).join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS script_images/i, "缺少 script_images 建表语句");
  assert.match(ddl, /script_id TEXT NOT NULL/i);
  assert.match(ddl, /img_key TEXT NOT NULL/i);
  assert.match(ddl, /mime TEXT NOT NULL/i);
  assert.match(ddl, /bytes BYTEA NOT NULL/i);
  assert.match(ddl, /PRIMARY KEY \(script_id, img_key\)/i, "主键必须是复合键（同一剧本可多张图、同键覆盖）");
  // 幂等：重复初始化不该报错 / 不该重建
  await db.initDB();
});

test("saveScriptImage：写入即 upsert，同键再写覆盖字节与 mime（不产生第二行）", async () => {
  await db.saveScriptImage("script-a", "map-villa-1f", "image/png", PNG);
  let r = await db.getScriptImage("script-a", "map-villa-1f");
  assert.strictEqual(r.mime, "image/png");
  assert.ok(Buffer.isBuffer(r.bytes), "bytea 取回来应当是 Buffer");
  assert.strictEqual(r.bytes.length, PNG.length);
  assert.strictEqual(r.bytes.compare(PNG), 0, "字节必须一模一样");

  await db.saveScriptImage("script-a", "map-villa-1f", "image/webp", PNG2);
  r = await db.getScriptImage("script-a", "map-villa-1f");
  assert.strictEqual(r.mime, "image/webp", "同键覆盖：mime 跟着换");
  assert.strictEqual(r.bytes.compare(PNG2), 0, "同键覆盖：字节跟着换");
  assert.strictEqual(rows.size, 1, "upsert 不能多出一行");

  const insert = seen.filter((s) => /^INSERT INTO script_images/i.test(s.sql)).pop();
  assert.match(insert.sql, /ON CONFLICT \(script_id, img_key\) DO UPDATE SET mime=\$3, bytes=\$4/i,
    "写入必须带 ON CONFLICT ... DO UPDATE（否则第二次写会抛主键冲突）");
  assert.deepStrictEqual(insert.params.slice(0, 4), ["script-a", "map-villa-1f", "image/webp", PNG2],
    "参数顺序必须是 (script_id, img_key, mime, bytes)");
});

test("getScriptImage：不存在的键返回 null（而不是抛错或空 Buffer）", async () => {
  assert.strictEqual(await db.getScriptImage("script-a", "nope"), null);
  assert.strictEqual(await db.getScriptImage("no-such-script", "map-villa-1f"), null);
});

test("saveScriptImage 拒绝非法键名：带 / 或空格的键永远取不回来，绝不能存进去", async () => {
  for (const bad of ["", "a/b", "has space", "中文", "k".repeat(129), null, undefined]) {
    await assert.rejects(() => db.saveScriptImage("script-a", bad, "image/png", PNG),
      /键名不合法/, `应当拒绝：${JSON.stringify(bad)}`);
  }
  assert.strictEqual(db.isValidImageKey("map-villa-1f"), true);
  assert.strictEqual(db.isValidImageKey("a_b-C9"), true);
  assert.strictEqual(db.isValidImageKey(" a"), false);
});

test("saveScriptImage 非 Buffer 直接拒绝（防把 base64 字符串当字节写进去）", async () => {
  await assert.rejects(() => db.saveScriptImage("script-a", "k1", "image/png", "iVBORw0KGgo="),
    /必须是 Buffer/);
});

test("listScriptImages：只回键名/mime/体积，按剧本隔离，不带字节", async () => {
  await db.saveScriptImage("script-b", "map-b2", "image/png", PNG);
  await db.saveScriptImage("script-b", "map-b1", "image/png", PNG);
  await db.saveScriptImage("script-b", "portrait-lin", "image/webp", PNG2);
  const list = await db.listScriptImages("script-b");
  assert.deepStrictEqual(list.map((x) => x.imgKey), ["map-b1", "map-b2", "portrait-lin"], "按键名排序");
  assert.deepStrictEqual(list[0], { imgKey: "map-b1", mime: "image/png", size: PNG.length });
  for (const x of list) assert.strictEqual(x.bytes, undefined, "列表接口不能把图片字节带出来");
  assert.deepStrictEqual((await db.listScriptImages("no-such-script")), []);
});

test("导出的取图相关函数齐全（路由依赖这些名字）", () => {
  for (const fn of ["saveScriptImage", "getScriptImage", "listScriptImages", "isValidImageKey"]) {
    assert.strictEqual(typeof db[fn], "function", `缺少导出：${fn}`);
  }
});
