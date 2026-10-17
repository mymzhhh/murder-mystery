#!/usr/bin/env node
/**
 * 一次性库存维护：清理已存数据里的**模板占位词残留**。
 *
 * 背景：提示词模板曾把字段名当格式样板（`- **日期 时间**：地点 — 事件`），
 * 模型照抄标签 → `**日期12月4日 20:10（真实）**：地点一层车间工具房`。
 * 源头已修（模板改成注入真实日期/房间名的示范行），**新剧本不会再出现**；
 * 已入库的仍带着它 —— 本脚本用于清理库存。
 *
 * ⚠️ 为什么必须扫**多张表**（第一版只扫了 scripts.original_markdown，是错的）：
 * 玩家/测试房真正读到的角色剧本来自 `characters.player_script`
 *（见 src/game/game-room-creator.js 的 createGameRoom → getScript），
 * 不是 original_markdown。只清理后者时，真库 31 处一处也没少 ——
 * 浏览器里实测仍然显示 `10月13日：地点 一楼大堂 — …`（截图取证）。
 *
 * 安全性：变换是**无损**的（只删掉"日期/时间/地点"这三个纯字段名及其后一个分隔空格），
 * 已对真库逐行证明过（去掉这些标签并压缩空白后，每一行与原文完全相同）。
 * 仍要求显式 `--apply`，并先把命中的原文备份到 `_verify/`。
 *
 * 用法：
 *   node scripts/fix-placeholder-residues.js                 # 试运行
 *   node scripts/fix-placeholder-residues.js --apply          # 写库（先自动备份）
 *   node scripts/fix-placeholder-residues.js --apply --port 5433
 */
const fs = require("fs");
const path = require("path");

// 只处理"会被玩家/DM 读到"的表；test_reports 是历史报告（里面的引用是当时的取证记录），不动
const TABLES = ["scripts", "characters", "clues", "dm_manuals"];

function loadEnvUrl() {
  const p = path.join(__dirname, "..", ".env");
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l));
  if (!line) throw new Error(".env 里没有 DATABASE_URL");
  return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
}

(async () => {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const portArg = argv.indexOf("--port");
  const sb = require("../src/script/story-bible.js");
  const { Client } = require("pg");

  const u = new URL(loadEnvUrl());
  if (!process.env.DSH_IN_CONTAINER) {
    if (portArg >= 0 && argv[portArg + 1]) u.port = argv[portArg + 1];
    if (u.hostname === "pg" || u.hostname === "localhost") u.hostname = "127.0.0.1";
    if (u.port === "5432") u.port = "5433";
  }
  console.log(`${apply ? "【写库模式】" : "【试运行】"} 目标 ${u.hostname}:${u.port}${u.pathname}`);

  const c = new Client({ connectionString: u.toString() });
  await c.connect();

  const plan = [];   // { table, ctid, cols:{name,from,to}, fixed, left }
  let totalFixed = 0;

  for (const t of TABLES) {
    const { rows: cols } = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('text','character varying') ORDER BY ordinal_position", [t]);
    if (!cols.length) { console.log(`- ${t}: 无文本列，跳过`); continue; }
    const names = cols.map(r => r.column_name);
    const { rows } = await c.query(`SELECT ctid, ${names.map(n => `"${n}"`).join(", ")} FROM ${t}`);
    let tFixed = 0;
    for (const row of rows) {
      const changes = {};
      let leftAll = [];
      for (const n of names) {
        const before = row[n];
        if (typeof before !== "string" || !before) continue;
        const r = sb.repairPlaceholderResidues(`(${t})`, before);
        if (r.fixed) { changes[n] = { from: before, to: r.script }; tFixed += r.fixed; }
        for (const h of r.left) leftAll.push(`[${n}] ${h.word}｜${h.line.slice(0, 80)}`);
      }
      if (Object.keys(changes).length) plan.push({ table: t, ctid: row.ctid, changes });
      for (const l of leftAll) console.log(`    ⚠️ 需人工 ${t}: ${l}`);
    }
    totalFixed += tFixed;
    console.log(`- ${t}: ${rows.length} 行，命中 ${tFixed} 处`);
  }

  console.log(`\n合计命中 ${totalFixed} 处，涉及 ${plan.length} 行 / ${new Set(plan.map(p => p.table)).size} 张表`);
  if (!totalFixed) { await c.end(); return; }
  if (!apply) { console.log("（试运行，未写库；确认后加 --apply）"); await c.end(); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(__dirname, "..", "_verify", `library-backup-${stamp}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(plan.map(p => ({
    table: p.table, ctid: p.ctid,
    cols: Object.fromEntries(Object.entries(p.changes).map(([k, v]) => [k, v.from])),
  })), null, 1), "utf8");
  console.log(`已备份命中行原文 → ${backup}`);

  for (const p of plan) {
    const keys = Object.keys(p.changes);
    await c.query(
      `UPDATE ${p.table} SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(", ")} WHERE ctid=$${keys.length + 1}`,
      [...keys.map(k => p.changes[k].to), p.ctid]);
  }

  // 复核：逐表重扫，增量必须归零
  let rest = 0;
  for (const t of TABLES) {
    const { rows: cols } = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('text','character varying')", [t]);
    if (!cols.length) continue;
    const names = cols.map(r => r.column_name);
    const { rows } = await c.query(`SELECT ${names.map(n => `"${n}"`).join(", ")} FROM ${t}`);
    for (const row of rows) for (const n of names) if (typeof row[n] === "string") rest += sb.findPlaceholderResidues("(复核)", row[n]).length;
  }
  console.log(`\n复核：清理后全库残留 = ${rest} ${rest === 0 ? "✅" : "❌"}`);
  await c.end();
  if (rest) process.exit(1);
})().catch(e => { console.error("FAILED:", e.message); process.exit(2); });
