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
  const { MAX_LIFETIME_MS } = require("../../src/game/room-lifecycle");

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
  const { sweepOnce } = require("../../src/game/room-lifecycle");
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

  console.log("\n【8】房间已删除后仍有人写聊天/自我介绍 → 不留孤儿键");
  // 复现"删除与写入竞争"：房间被回收的同一瞬间，AI 回答或系统消息正在落盘，
  // 结果是 game:{code} 没了、game:{code}:chat 留下（每次跑回归测试都会漏一个 KHUMKA 这种）。
  // 现在写入方会在写完后复查房间主键，发现房间没了就把自己刚写的键撤掉。
  {
    const gm = require("../../src/game/game-manager");
    const code4 = "ZW" + Math.random().toString(36).slice(2, 6).toUpperCase();
    await redis.del(`game:${code4}`);
    await gm.addChatMessage(code4, "sys", "系统", "系统", "房间已经没了的消息", "lobby");
    check("房间不存在时写聊天不会留下 game:{code}:chat", (await redis.exists(`game:${code4}:chat`)) === 0,
      `chat 键存在=${await redis.exists(`game:${code4}:chat`)}`);
    await gm.addIntroduction(code4, "某人", "迟到的自我介绍");
    check("房间不存在时写自我介绍不会留下 game:{code}:intro", (await redis.exists(`game:${code4}:intro`)) === 0);
    // 反向确认：房间还在时写入必须正常保留，别把正常消息也删了
    await redis.hset(`game:${code4}`, { roomCode: code4, phase: "lobby" });
    await gm.addChatMessage(code4, "sys", "系统", "系统", "房间还在的消息", "lobby");
    check("房间还在时聊天正常保留", (await redis.llen(`game:${code4}:chat`)) === 1);
    await redis.del(...(await redis.keys(`game:${code4}*`)));
  }

  console.log("\n【9】人全走光（记录还在但一个真人都没连着）→ 超过阈值就回收");
  // 真实场景：所有人先后掉线，期间服务器重启过一次 —— 断线定时器在内存里，重启即丢，
  // 于是玩家记录永远留着（connected=false）。只判断"玩家记录为 0"的旧规则看不到这种情况，
  // 房间会一直撑到 6 小时上限。线上案例：昨晚开的房，第二天还能重连进去且没有真人。
  {
    const stale = Date.now() - 31 * 60 * 1000;
    const code5 = "ZY" + Math.random().toString(36).slice(2, 4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    await redis.hset(`game:${code5}`, { roomCode: code5, phase: "round1", createdAt: String(stale), ownerId: "p1" });
    await redis.zadd("games:index", stale, code5);
    await redis.set(`game:${code5}:player:p1`, JSON.stringify({ playerId: "p1", playerName: "u1", characterName: "角色甲", isNPC: false, connected: false }));
    // AI 补位通常还在房间里，且 connected 也不一定是 false —— 判定必须只看真人
    await redis.set(`game:${code5}:player:ai_x`, JSON.stringify({ playerId: "ai_x", playerName: "AI 玩家", characterName: "角色乙", isNPC: true, isAI: true, connected: true }));
    await redis.hset(`game:${code5}:chat`, { probe: "1" });
    const s5 = await sweepOnce();
    check("真人全部掉线的房间被回收", (await redis.exists(`game:${code5}`)) === 0,
      `abandoned=${s5.abandoned} freedKeys=${s5.freedKeys}`);
    check("它的子键也一起清了", (await redis.exists(`game:${code5}:chat`)) === 0);
    check("索引里也不再有它", (await redis.zscore("games:index", code5)) === null);

    // 反向：只要还有一个真人连着，就不能回收 —— 正在进行的局不能被误杀
    const code6 = "ZX" + Math.random().toString(36).slice(2, 4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    await redis.hset(`game:${code6}`, { roomCode: code6, phase: "round1", createdAt: String(stale), ownerId: "p2" });
    await redis.zadd("games:index", stale, code6);
    await redis.set(`game:${code6}:player:p2`, JSON.stringify({ playerId: "p2", playerName: "u2", characterName: "角色丙", isNPC: false, connected: true }));
    await sweepOnce();
    check("仍有真人连着时不会被回收", (await redis.exists(`game:${code6}`)) === 1);
    await redis.del(...(await redis.keys(`game:${code6}*`)));
    await redis.zrem("games:index", code6);

    // 只剩 AI、连一个真人记录都没有的房间同样要回收
    const code7 = "ZV" + Math.random().toString(36).slice(2, 4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    await redis.hset(`game:${code7}`, { roomCode: code7, phase: "round1", createdAt: String(stale) });
    await redis.zadd("games:index", stale, code7);
    await redis.set(`game:${code7}:player:ai_y`, JSON.stringify({ playerId: "ai_y", playerName: "AI 玩家", characterName: "角色丁", isNPC: true, isAI: true, connected: true }));
    await sweepOnce();
    check("只剩 AI 的房间被回收（AI 的 connected 不算'有人'）", (await redis.exists(`game:${code7}`)) === 0);
  }

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
