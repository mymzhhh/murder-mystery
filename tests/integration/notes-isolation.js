// 玩家便签的端到端验证：重点是隐私隔离
//
// 为什么必须做集成测试：便签里写满了玩家的推理与怀疑，泄漏等于剧透。
// 而"只能读自己的"这条约束横跨鉴权、房间成员校验与 Redis 键设计，
// 单测怎么测 normalizeNotes 都覆盖不到，必须真的建两个玩家去互相读。
//
// 跑法：npm run test:notes（需要服务端 + Redis + PG 都在跑）
const { io } = require("socket.io-client");
const Redis = require("ioredis");

const BASE = process.env.VOICE_TEST_BASE || "http://127.0.0.1:3000";
const REDIS_URL = process.env.VOICE_TEST_REDIS || "redis://127.0.0.1:6380";

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

const once = (sock, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log("  ✔ " + n + (extra ? "  " + extra : "")); } else { fail++; console.log("  ✖ " + n + (extra ? "  " + extra : "")); } };

(async () => {
  const t1 = await auth("voicetest_a");
  const t2 = await auth("voicetest_b");
  const scripts = await req("GET", "/api/player/scripts", null, t1);
  const sid = scripts.body.scripts[0].sessionId;
  const room = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 4 }, t1);
  const code = room.body.roomCode;
  console.log(`测试房间 ${code}\n`);

  // 两个真人都进房间
  const A = io(BASE, { transports: ["websocket"] });
  const B = io(BASE, { transports: ["websocket"] });
  await Promise.all([once(A, "connect"), once(B, "connect")]);
  A.emit("join_room", { roomCode: code, token: t1 });
  await once(A, "room_state");
  B.emit("join_room", { roomCode: code, token: t2 });
  await once(B, "room_state");

  console.log("【1】基本读写");
  const empty = await req("GET", `/api/player/rooms/${code}/notes`, null, t1);
  check("新房间便签为空", empty.status === 200 && Array.isArray(empty.body.notes) && empty.body.notes.length === 0);

  const SECRET_A = "A的私人推理：我怀疑周大掌柜，标志串 NOTES-A-5F2C";
  const saveA = await req("PUT", `/api/player/rooms/${code}/notes`, {
    notes: [{ id: "a1", title: "A的便签", content: SECRET_A }],
  }, t1);
  check("A 保存成功", saveA.status === 200 && saveA.body.notes.length === 1, `status=${saveA.status}`);

  const readA = await req("GET", `/api/player/rooms/${code}/notes`, null, t1);
  check("A 能读回自己的内容", readA.body.notes.length === 1 && readA.body.notes[0].content.includes("NOTES-A-5F2C"));

  console.log("\n【2】隐私隔离（最关键）");
  const readB = await req("GET", `/api/player/rooms/${code}/notes`, null, t2);
  check("B 看不到 A 的便签", readB.status === 200 && !JSON.stringify(readB.body).includes("NOTES-A-5F2C"),
    readB.status === 200 ? `B 拿到 ${readB.body.notes.length} 条` : "status=" + readB.status);

  const SECRET_B = "B的私人推理：标志串 NOTES-B-9D14";
  await req("PUT", `/api/player/rooms/${code}/notes`, { notes: [{ id: "b1", title: "B的便签", content: SECRET_B }] }, t2);
  const readA2 = await req("GET", `/api/player/rooms/${code}/notes`, null, t1);
  check("互相写之后 A 仍只看到自己的", readA2.body.notes.length === 1 && !JSON.stringify(readA2.body).includes("NOTES-B-9D14"));
  const readB2 = await req("GET", `/api/player/rooms/${code}/notes`, null, t2);
  check("互相写之后 B 仍只看到自己的", readB2.body.notes.length === 1 && !JSON.stringify(readB2.body).includes("NOTES-A-5F2C"));

  console.log("\n【3】越权与未登录");
  const anon = await req("GET", `/api/player/rooms/${code}/notes`, null, null);
  check("未登录被拒", anon.status === 401, `status=${anon.status}`);

  const t3 = await auth("voicetest_c"); // 有效用户但不在该房间
  const outsider = await req("GET", `/api/player/rooms/${code}/notes`, null, t3);
  check("非本房间成员被拒", outsider.status === 403, `status=${outsider.status}`);

  const notFound = await req("GET", "/api/player/rooms/ZZZZZZ/notes", null, t1);
  check("房间不存在返回 404", notFound.status === 404, `status=${notFound.status}`);

  console.log("\n【4】重连后仍在（键按用户名而不是 socket.id）");
  const beforeReconnect = await req("GET", `/api/player/rooms/${code}/notes`, null, t1);
  B.disconnect();
  await new Promise(r => setTimeout(r, 800));
  const B2 = io(BASE, { transports: ["websocket"] });
  await once(B2, "connect");
  B2.emit("join_room", { roomCode: code, token: t2 });
  await once(B2, "room_state");
  const afterReconnect = await req("GET", `/api/player/rooms/${code}/notes`, null, t2);
  check("B 重连后便签没丢", afterReconnect.body.notes.length === 1 && afterReconnect.body.notes[0].content.includes("NOTES-B-9D14"),
    `重连前 ${beforeReconnect.body.notes.length} 条 / 重连后 ${afterReconnect.body.notes.length} 条`);

  console.log("\n【5】清洗规则生效");
  const dirty = await req("PUT", `/api/player/rooms/${code}/notes`, {
    notes: [{ title: "T".repeat(500), content: "C".repeat(9999) }, { title: "", content: "" }, null],
  }, t1);
  check("空便签被丢弃、超长被截断", dirty.body.notes.length === 1 && dirty.body.notes[0].title.length === 120 && dirty.body.notes[0].content.length === 4000,
    `条数=${dirty.body.notes.length}`);
  const badBody = await req("PUT", `/api/player/rooms/${code}/notes`, { notes: "不是数组" }, t1);
  check("notes 非数组返回 400", badBody.status === 400, `status=${badBody.status}`);

  A.disconnect(); B2.disconnect();

  // 清理
  const redis = new Redis(REDIS_URL);
  const keys = await redis.keys(`game:${code}*`);
  if (keys.length) await redis.del(...keys);
  await redis.srem("rooms:open", code);
  await redis.quit();
  console.log(`\n已清理测试房间 ${code} 的 ${keys.length} 个 Redis 键`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
