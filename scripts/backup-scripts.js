#!/usr/bin/env node
/**
 * 剧本库的**备份 / 还原**（补齐"删了能恢复"这一半）。
 *
 * 为什么需要（实测代价，2026-10-17）：整个剧本库被逐条删空 ——
 * scripts / characters / clues / dm_manuals 四张表全 0，而 test_reports 与 users 完好。
 * 那是"deleteScript(id) + 外键级联"的形态，但当时**一份备份都没有**：
 * 只能靠两份临时文件恢复 3~4 本，其余四本永久丢失。
 * 已另补了删除审计（能查到是谁删的），但"能查到"不等于"能恢复"—— 本脚本补后者。
 *
 * 用法（**在宿主机跑**，会自行把 DATABASE_URL 的端口改成映射端口）：
 *   node scripts/backup-scripts.js                    # 备份到 backups/
 *   node scripts/backup-scripts.js --out D:\bak       # 指定目录
 *   node scripts/backup-scripts.js --restore <file>   # 从备份还原（只补不删）
 *
 * 安全约定：还原**只做 upsert**（按主键 INSERT … ON CONFLICT DO UPDATE），
 * 绝不删除任何现有行 —— 备份文件不完整时也不会把现状清空。
 */
const fs = require("fs");
const path = require("path");

const TABLES = ["scripts", "characters", "clues", "dm_manuals"];

function envUrl() {
  const p = path.join(__dirname, "..", ".env");
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l));
  if (!line) throw new Error(".env 里没有 DATABASE_URL");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

/** 宿主机视角的连接串：容器内写的是 pg:5432，映射端口是 5433 */
function hostUrl() {
  const u = new URL(envUrl());
  if (process.env.DSH_IN_CONTAINER) return u.toString();
  if (u.hostname === "pg" || u.hostname === "localhost") u.hostname = "127.0.0.1";
  if (u.port === "5432" || !u.port) u.port = "5433";
  return u.toString();
}

async function backup(outDir) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: hostUrl() });
  await c.connect();
  const dump = { at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const { rows } = await c.query(`SELECT * FROM ${t}`);
    dump.tables[t] = rows;
  }
  await c.end();
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `scripts-backup-${dump.at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(dump), "utf8");
  const brief = TABLES.map(t => `${t} ${dump.tables[t].length}`).join(" / ");
  const titles = dump.tables.scripts.map(r => r.title).filter(Boolean);
  console.log(`✅ 已备份 → ${file}`);
  console.log(`   ${brief}`);
  if (titles.length) console.log(`   含 ${titles.length} 本：${titles.slice(0, 8).join("、")}${titles.length > 8 ? " …" : ""}`);
  if (!dump.tables.scripts.length) console.warn("   ⚠️ scripts 为空 —— 这份备份救不了任何书，请确认是不是备份了空库");
  return file;
}

async function restore(file) {
  const { Client } = require("pg");
  const dump = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = new Client({ connectionString: hostUrl() });
  await c.connect();
  let written = 0;
  for (const t of TABLES) {
    const rows = (dump.tables && dump.tables[t]) || [];
    if (!rows.length) { console.log(`- ${t}: 备份里 0 行，跳过`); continue; }
    // ⚠️ 主键**必须从系统目录查**，不能靠猜列名。
    // 第一版猜的是 (script_id, clue_id) / (script_id, name)，实测直接报
    //   `there is no unique or exclusion constraint matching the ON CONFLICT specification`
    // —— 结果是 scripts 还原了、characters 与 clues 一行都没进去（往返测试当场抓到）。
    const pkq = await c.query(
      `SELECT a.attname AS col FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [t]);
    const pk = pkq.rows.map(r => r.col);
    let n = 0;
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(k => row[k]);
      const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colSql = cols.map(k => `"${k}"`).join(", ");
      let sql;
      if (pk.length && pk.every(k => cols.includes(k))) {
        const set = cols.filter(k => !pk.includes(k)).map(k => `"${k}"=EXCLUDED."${k}"`).join(", ");
        sql = `INSERT INTO ${t} (${colSql}) VALUES (${ph}) ON CONFLICT (${pk.map(k => `"${k}"`).join(", ")}) DO ${set ? `UPDATE SET ${set}` : "NOTHING"}`;
      } else {
        // 没有主键的表：先看有没有一模一样的一行，有就跳过（保持"只补不删、不重复插"）
        const where = cols.map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`).join(" AND ");
        const dup = await c.query(`SELECT 1 FROM ${t} WHERE ${where} LIMIT 1`, vals);
        if (dup.rows.length) continue;
        sql = `INSERT INTO ${t} (${colSql}) VALUES (${ph})`;
      }
      try { await c.query(sql, vals); n++; }
      catch (e) { console.warn(`   ⚠️ ${t} 有一行写不进去：${e.message}`); }
    }
    written += n;
    console.log(`- ${t}: 还原 ${n}/${rows.length} 行${pk.length ? `（主键 ${pk.join("+")}）` : "（无主键，按整行去重）"}`);
  }
  await c.end();
  console.log(`✅ 还原完成，共写入 ${written} 行（只补不删：现有行一律保留）`);
}

(async () => {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const resAt = argv.indexOf("--restore");
  if (resAt >= 0) {
    if (!argv[resAt + 1]) { console.error("--restore 需要文件名"); process.exit(2); }
    return restore(argv[resAt + 1]);
  }
  const outDir = outAt >= 0 && argv[outAt + 1] ? argv[outAt + 1] : path.join(__dirname, "..", "backups");
  await backup(outDir);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
