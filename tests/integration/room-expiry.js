// 房间最大存活时间的端到端验证
//
// 真实背景：房间原本永不过期，唯一的自动清理（断线 5 分钟后无人则删房）把定时器放在
// 内存里，服务器一重启就全丢 —— 线上出现过"9 天前创建的房间仍可重连进入"，
// games:index 里积了 59 条索引、其中 54 条指向不存在的房间。
//
// 判定逻辑单测覆盖了，但"过期房间真的进不去"横跨 getRoom / join_room / 房间列表，
// 只有真建房间、真把它改老、真去连，才能证明。
//
// 跑法：npm run test:rooms（需要服务端 + Redis + PG 都在跑）
const { io } = require("socket.io-client");
const Redis = require("ioredis");

const BASE = process.env.VOICE_TEST_BASE || "http://127.0.0.1:3000";
const REDIS_URL = process.env.VOICE_TEST_REDIS || "redis://127.0.0.1:6380";
// ⚠ 必须在 require 任何业务模块之前设置：modules/redis-client 在模块加载时读一次
// REDIS_URL，默认值是 localhost:6379 —— 而本项目的 Redis 映射在 6380。
// 不设这一行，测试里的扫描器会去扫另一个实例，表现为"扫描器什么都没回收"。
process.env.REDIS_URL = REDIS_URL;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const r = require("http").request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    }, (res) => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function auth(name) {
  const body = { username: name, password: "voicetest123" };
  let r = await req("POST", "/api/auth/register", body);
  if (r.status !== 200 || !r.body.token) r = await req("POST", "/api/auth/login", body);
  if (!r.body.token) throw new Error("认证失败: " + JSON.stringify(r.body));
  return r.body.token;
}

const once = (sock, ev, ms = 12000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log("  ✔ " + n + (extra ? "  " + extra : "")); } else { fail++; console.log("  ✖ " + n + (extra ? "  " + extra : "")); } };

const connectAndJoin = (code, token) => new Promise((resolve) => {
  const s = io(BASE, { transports: ["websocket"] });
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; try { s.disconnect(); } catch (e) {} resolve(v); } };
  s.on("connect", () => s.emit("join_room", { roomCode: code, token }));
  s.on("room_state", () => done({ ok: true }));
  s.on("error", (d) => done({ ok: false, code: d && d.code, message: d && d.message }));
  setTimeout(() => done({ ok: false, code: "TIMEOUT", message: "无响应" }), 11000);
});

(async () => {
  const token = await auth("voicetest_a");
  const scripts = await req("GET", "/api/player/scripts", null, token);
  const sid = scripts.body.scripts[0].sessionId;
  const redis = new Redis(REDIS_URL);
  const { MAX_LIFETIME_MS } = require("../../modules/room-lifecycle");

  console.log("【1】刚创建的房间可以正常进入");
  const room = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 4 }, token);
  const code = room.body.roomCode;
  console.log(`测试房间 ${code}`);
  const fresh = await connectAndJoin(code, token);
  check("新房间可加入", fresh.ok === true, fresh.ok ? "" : JSON.stringify(fresh));

  console.log("\n【2】把创建时间改老到超过上限后，应拒绝加入");
  const created = await redis.hget(`game:${code}`, "createdAt");
  await redis.hset(`game:${code}`, "createdAt", String(Date.now() - MAX_LIFETIME_MS - 60 * 60 * 1000));
  const expired = await connectAndJoin(code, token);
  check("过期房间被拒绝", expired.ok === false, JSON.stringify(expired));
  check("拒绝原因明确提到保留时间", /保留时间|不存在/.test(String(expired.message || "")), String(expired.message || ""));

  console.log("\n【3】过期房间不出现在房间列表里");
  const listed = await req("GET", "/api/player/rooms", null, token);
  check("列表里没有这个过期房间", !(listed.body.rooms || []).some(r => r.roomCode === code));

  console.log("\n【4】扫描器能回收它");
  const { sweepOnce } = require("../../modules/room-lifecycle");
  const s = await sweepOnce();
  check("扫描器报告回收了过期房间", s.expired >= 1, `expired=${s.expired} freedKeys=${s.freedKeys}`);
  const stillThere = await redis.exists(`game:${code}`);
  check("房间键已被删除", stillThere === 0);
  const inIndex = await redis.zscore("games:index", code);
  check("索引里的条目也清掉了", inIndex === null);

  console.log("\n【5】改回正常时间戳的房间不受影响（确认没有误杀）");
  const room2 = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 4 }, token);
  const code2 = room2.body.roomCode;
  const ok2 = await connectAndJoin(code2, token);
  check("另一个新房间仍可加入", ok2.ok === true, ok2.ok ? "" : JSON.stringify(ok2));
  check("它的创建时间是刚才", Math.abs(Date.now() - Number(await redis.hget(`game:${code2}`, "createdAt"))) < 60000);

  console.log("\n【6】残留子键回收（房间主键已删、只剩 game:{code}:xxx）");
  // 复现真实场景：AI 动作已通过存在性检查，房间随后被删，它的写入把子键建了回来。
  // 这类房间不在 games:index 里，只按索引枚举的扫描器永远回收不掉。
  const code3 = "ZQ" + Math.random().toString(36).slice(2, 6).toUpperCase();
  await redis.hset(`game:${code3}:chat`, { probe: "1" });
  await redis.hset(`game:${code3}:intro`, { probe: "1" });
  const s3 = await sweepOnce();
  check("扫描器发现了残留子键", s3.orphanKeys >= 1, `orphanKeys=${s3.orphanKeys} freedKeys=${s3.freedKeys}`);
  check("残留子键已被删除", (await redis.exists(`game:${code3}:chat`)) === 0 && (await redis.exists(`game:${code3}:intro`)) === 0);

  console.log("\n【7】建房占位锁不能被误删");
  // 扫描器按 game:* 枚举时会看到 game:{code}:creating，那是建房时的唯一性占位锁，
  // 仍在有效期内时清掉它会导致并发建房拿到同一个房号。
  const lockCode = "ZL" + Math.random().toString(36).slice(2, 6).toUpperCase();
  await redis.set(`game:${lockCode}:creating`, "1", "EX", 60);
  await sweepOnce();
  check("creating 占位锁仍存在", (await redis.exists(`game:${lockCode}:creating`)) === 1);
  await redis.del(`game:${lockCode}:creating`);

  // 清理
  for (const c of [code, code2]) {
    const keys = await redis.keys(`game:${c}*`);
    if (keys.length) await redis.del(...keys);
    await redis.srem("rooms:open", c);
    await redis.zrem("games:index", c);
  }
  await redis.quit();
  console.log(`\n已清理测试房间 ${code} / ${code2}`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
