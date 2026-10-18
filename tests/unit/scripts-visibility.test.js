// 剧本"玩家可见性"开关在 core/db.js 里的 SQL 契约
//
// 这个开关的实际后果是"玩家大厅看不到 / 建不了房"，一旦 SQL 写错（比如过滤条件
// 写反、或者 UPDATE 忘了 RETURNING），页面不会报错，只会静默地把剧本照常放出去 ——
// 所以用 mock 把 SQL 形状钉住，真实行为另由端到端验证（玩家列表 + 建房 403）覆盖。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const seen = [];      // 捕获的 SQL
let fakeRows = [];    // query 的返回值

const fakeClient = {
  query: async (text, params) => {
    const sql = String(text).replace(/\s+/g, " ").trim();
    seen.push({ sql, params: params || [] });
    if (/^UPDATE scripts SET is_public/i.test(sql)) {
      return { rows: [{ id: params[0], is_public: params[1] }], rowCount: 1 };
    }
    return { rows: fakeRows, rowCount: fakeRows.length };
  },
  release: () => {},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "pg") {
    return { Pool: function Pool() { this.connect = async () => fakeClient; this.on = () => {}; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.DATABASE_URL = "postgres://fake/fake";
const db = require("../../src/core/db.js");

test("listScripts() 默认不过滤可见性（管理端要看到全部）", async () => {
  seen.length = 0;
  fakeRows = [{ id: "a", title: "X", is_public: false }];
  const list = await db.listScripts();
  const sql = seen[seen.length - 1].sql;
  assert.ok(!/is_public IS NOT FALSE/i.test(sql), "管理端查询不得带可见性过滤");
  assert.strictEqual(list.length, 1);
  assert.ok(sql.includes("s.is_public"), "列表要带出 is_public 供管理端显示状态");
});

test("listScripts({publicOnly:true}) 只查可见剧本（玩家大厅）", async () => {
  seen.length = 0;
  fakeRows = [{ id: "a", title: "X", is_public: true }];
  await db.listScripts({ publicOnly: true });
  const sql = seen[seen.length - 1].sql;
  assert.ok(/WHERE s\.is_public IS NOT FALSE/i.test(sql), "玩家列表必须过滤掉下架剧本");
});

test("setScriptPublic 走 UPDATE 并 RETURNING（要能回读真实状态）", async () => {
  seen.length = 0;
  const row = await db.setScriptPublic("f391", false);
  const { sql, params } = seen[seen.length - 1];
  assert.ok(/^UPDATE scripts SET is_public=\$2 WHERE id=\$1/i.test(sql), "SQL 形状变了");
  assert.deepStrictEqual(params, ["f391", false]);
  assert.strictEqual(row.is_public, false, "要返回写入后的值，否则前端无法确认状态");
});

test("建表/迁移语句里必须有 is_public 列（老库补列）", async () => {
  seen.length = 0;
  await db.initDB().catch(() => {});
  const all = seen.map((s) => s.sql).join("\n");
  assert.ok(/ALTER TABLE scripts ADD COLUMN IF NOT EXISTS is_public/i.test(all),
    "已有部署的库不会因 CREATE TABLE IF NOT EXISTS 补列，必须有 ALTER");
});

process.on("exit", () => { Module._load = origLoad; });
