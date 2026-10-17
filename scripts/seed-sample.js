// 示例剧本种子 — 将内置《沪上迷局：血色寿宴》剧本写入 Redis 并同步到 PG
// 用法:
//   node scripts/seed-sample.js                    # 使用内置 seed/sample-script.json
//   node scripts/seed-sample.js 路径.json           # 或指定导出文件
// 环境变量: REDIS_URL / DATABASE_URL（默认连本地）
//
// 说明: 写入后通过 pg-sync.syncOne 直接落 PG（与切分流程同一套异步同步逻辑）。

const fs = require("fs");
const path = require("path");
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
// 只允许业务数据前缀（与 admin 导出白名单一致，绝不写 token 等敏感 key）
const ALLOW_PREFIXES = ["split:", "user:", "session:", "sessions:index", "scripts:split"];

async function main() {
  const seedPath = process.argv[2] || path.join(__dirname, "..", "seed", "sample-script.json");
  if (!fs.existsSync(seedPath)) {
    console.error("[seed] 文件不存在:", seedPath);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const entries = Object.entries(parsed.data || parsed);

  const r = new Redis(REDIS_URL);
  let count = 0;
  let rejected = 0;
  for (const [key, info] of entries) {
    if (!ALLOW_PREFIXES.some(p => key.startsWith(p))) { rejected++; continue; }
    if (!info || typeof info !== "object") { rejected++; continue; }
    if (info.type === "string" && typeof info.val === "string") await r.set(key, info.val);
    else if (info.type === "hash" && info.val) await r.hset(key, info.val);
    else if (info.type === "set" && Array.isArray(info.val)) await r.sadd(key, ...info.val);
    else if (info.type === "zset" && Array.isArray(info.val)) await r.zadd(key, ...info.val);
    else if (info.type === "list" && Array.isArray(info.val)) await r.rpush(key, ...info.val);
    else { rejected++; continue; }
    count++;
  }
  console.log(`[seed] Redis 写入完成: ${count} 个 key${rejected ? `，跳过 ${rejected} 个` : ""}`);

  // 同步到 PG（复用 pg-sync，与运行时切分同一逻辑）
  const splitIds = await r.smembers("scripts:split");
  if (splitIds.length) {
    // 注入环境变量供 pg-sync/db 使用（宿主运行时）
    process.env.REDIS_URL = REDIS_URL;
    const { syncOne } = require("../src/core/pg-sync");
    let ok = 0;
    for (const id of splitIds) {
      try { await syncOne(id); ok++; }
      catch (e) { console.warn(`[seed] PG 同步失败(${id}):`, e.message); }
    }
    console.log(`[seed] PG 同步完成: ${ok}/${splitIds.length} 个剧本`);
  } else {
    console.warn("[seed] Redis 中无 scripts:split 索引，跳过 PG 同步");
  }

  await r.quit();
  console.log("[seed] 完成。可登录管理端查看示例剧本并创建房间。");
}

main().then(() => process.exit(0)).catch(e => { console.error("[seed] 失败:", e.message); process.exit(1); });