// 孤儿资源审计 — 检查"写进去但没人删"的持久化数据
//
// 起因：房间在 Redis 里原本没有任何清理机制，线上出现过创建于 9 天前仍可重连的房间，
// games:index 里堆了 59 条索引、其中 54 条指向已删除的房间。
// 这类"忘删"不会报错、不会告警，只会慢慢堆积，所以需要能随时跑一遍的检查工具。
//
// 用法：
//   容器内  docker exec -w /app murder-app node scripts/audit-orphans.js
//   宿主机  REDIS_URL=redis://127.0.0.1:6380 DATABASE_URL=postgresql://... node scripts/audit-orphans.js
//
// 退出码：0 = 未发现孤儿；1 = 发现孤儿（可用于定时巡检）
//
// ⚠ 从宿主机直接 `npm run audit:orphans` 时，脚本不会自动读 .env，
//   会退化成 redis://localhost:6379 —— 那可能是另一个（本地开发用的）Redis 实例，
//   于是要么误报一大堆"孤儿"，要么对着空库报"一切正常"。
//   这里显式加载 .env（dotenv 默认不覆盖已有环境变量，所以容器内跑仍然以容器 env 为准）。
require("dotenv").config();
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL || "";

function bucket(keys, re) {
  const m = new Map();
  for (const k of keys) {
    const mm = k.match(re);
    if (!mm) continue;
    const id = mm[1];
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(k);
  }
  return m;
}

(async () => {
  const r = new Redis(REDIS_URL);
  const all = await r.keys("*");
  console.log("Redis: " + REDIS_URL);
  console.log("键总数: " + all.length + "\n");

  // ---- PG 对照数据（连不上就跳过相关检查，不误报）----
  let pgScriptIds = new Set();
  let pgUsers = new Set();
  let pgOk = false;
  if (DATABASE_URL) {
    try {
      const { Client } = require("pg");
      const c = new Client({ connectionString: DATABASE_URL });
      await c.connect();
      pgScriptIds = new Set((await c.query("SELECT id FROM scripts")).rows.map(x => x.id));
      pgUsers = new Set((await c.query("SELECT username FROM users")).rows.map(x => x.username));
      await c.end();
      pgOk = true;
    } catch (e) { console.log("（PG 不可用，跳过 PG 对照检查：" + e.message + "）\n"); }
  }

  const splitIndex = new Set(await r.smembers("scripts:split"));
  const sessionIndex = new Set(await r.zrange("sessions:index", 0, -1));
  const roomsOpen = new Set(await r.smembers("rooms:open"));
  const gamesIndex = new Set(await r.zrange("games:index", 0, -1));

  const splitGroups = bucket(all, /^split:([^:]+):/);
  const sessionHashGroups = bucket(all, /^session:([^:]+)$/);
  const sessionMsgGroups = bucket(all, /^session:([^:]+):messages$/);
  const gameGroups = bucket(all, /^game:([A-Z0-9]{6})/);
  const userGroups = bucket(all, /^user:(.+)$/);

  const problems = [];
  const report = (title, items) => {
    console.log(title + ": " + items.length);
    items.slice(0, 10).forEach(x => console.log("    " + x));
    if (items.length > 10) console.log("    ... 另有 " + (items.length - 10) + " 条");
    if (items.length) problems.push(title + " = " + items.length);
  };

  console.log("=== 剧本/会话链路 ===");
  report("split:* 不在 scripts:split 索引里", [...splitGroups.keys()].filter(id => !splitIndex.has(id)));
  report("scripts:split 里的条目已无 split:* 数据", [...splitIndex].filter(id => !splitGroups.has(id)));
  if (pgOk) report("split:* 在 PG 里没有对应剧本", [...splitGroups.keys()].filter(id => !pgScriptIds.has(id)));
  report("session:* 不在 sessions:index 里", [...new Set([...sessionHashGroups.keys(), ...sessionMsgGroups.keys()])].filter(id => !sessionIndex.has(id)));
  report("sessions:index 里的会话已不存在", [...sessionIndex].filter(id => !sessionHashGroups.has(id) && !sessionMsgGroups.has(id)));
  const half = [];
  for (const id of new Set([...sessionHashGroups.keys(), ...sessionMsgGroups.keys()])) {
    const h = sessionHashGroups.has(id), m = sessionMsgGroups.has(id);
    if (h !== m) half.push(id + " (hash=" + h + " messages=" + m + ")");
  }
  report("会话被删了一半（只剩 hash 或只剩 messages）", half);
  if (pgOk) report("PG 有剧本但 split 数据缺失", [...pgScriptIds].filter(id => !splitGroups.has(id)));

  console.log("\n=== 房间链路 ===");
  const deadOpen = [];
  for (const code of roomsOpen) { if (!(await r.exists("game:" + code))) deadOpen.push(code); }
  report("rooms:open 里的房间已不存在", deadOpen);
  report("games:index 里的房间已不存在", [...gamesIndex].filter(code => !gameGroups.has(code)));
  report("存在 game:{code}* 键但索引里没有（扫描器可能漏收）", [...gameGroups.keys()].filter(code => !gamesIndex.has(code)));

  console.log("\n=== 用户链路 ===");
  if (pgOk) report("user:* 在 PG 里没有对应用户", [...userGroups.keys()].filter(u => !pgUsers.has(u)));

  console.log("\n=== 无 TTL 的键（长期堆积的候选）===");
  const byPrefix = {};
  for (const k of all) {
    const p = k.replace(/:[^:]*$/, ":*").replace(/^game:[A-Z0-9]{6}/, "game:{code}");
    if (!byPrefix[p]) byPrefix[p] = { n: 0, noTtl: 0 };
    byPrefix[p].n++;
    if (await r.ttl(k) === -1) byPrefix[p].noTtl++;
  }
  Object.entries(byPrefix).sort((a, b) => b[1].n - a[1].n).slice(0, 12).forEach(([p, v]) =>
    console.log("    " + p.padEnd(36) + " 数量=" + String(v.n).padStart(5) + "  无TTL=" + v.noTtl));

  await r.quit();
  console.log("");
  if (problems.length) {
    console.log("✖ 发现 " + problems.length + " 类孤儿资源：");
    problems.forEach(p => console.log("    " + p));
    process.exit(1);
  }
  console.log("✔ 未发现孤儿资源");
  // 没有 DATABASE_URL 时一半的对照检查（PG 是否有对应剧本/用户）是静默跳过的，
  // 此时"未发现孤儿"并不等于真的干净，必须把这件事说出来。
  if (!pgOk) console.log("（注意：PG 对照检查未执行（未配置 DATABASE_URL 或连不上），结论不完整）");
  process.exit(0);
})().catch(e => { console.error("审计失败: " + e.message); process.exit(2); });
