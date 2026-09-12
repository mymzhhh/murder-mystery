// 语音聊天信令集成测试
//
// 为什么放在 tests/integration/ 而不是 tests/：
// 它需要"真实运行中的服务端 + Redis"，属于集成测试；tests/*.test.js 那批是纯离线单测，
// 混在一起会让 `npm test` 在没起服务的机器上直接失败。跑法：npm run test:voice
//
// 覆盖范围：语音成员管理（加入/名册/名字表）、SDP-ICE 中转、开关状态广播、退出与断线自动清理。
// 音频本身是 WebRTC 点对点，服务端不经手，因此这里不验证音频内容（需要真实浏览器 + 麦克风）。
const { io } = require("socket.io-client");
const Redis = require("ioredis");

const BASE = process.env.VOICE_TEST_BASE || "http://127.0.0.1:3000";
const REDIS_URL = process.env.VOICE_TEST_REDIS || "redis://127.0.0.1:6380";
const NL = "\n";

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

const once = (sock, ev, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✔ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ✖ " + name + (extra ? "  " + extra : "")); }
}

(async () => {
  const t1 = await auth("voicetest_a");
  const t2 = await auth("voicetest_b");
  const scripts = await req("GET", "/api/player/scripts", null, t1);
  const sid = scripts.body.scripts[0].sessionId;
  const room = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 5 }, t1);
  const code = room.body.roomCode;
  console.log(`测试房间 ${code}（${room.body.title}）` + NL);

  const A = io(BASE, { transports: ["websocket"] });
  const B = io(BASE, { transports: ["websocket"] });
  await Promise.all([once(A, "connect"), once(B, "connect")]);

  A.emit("join_room", { roomCode: code, token: t1 });
  const stateA = await once(A, "room_state");
  B.emit("join_room", { roomCode: code, token: t2 });
  const stateB = await once(B, "room_state");

  // 角色名后面要用来校验名字表
  const aName = (stateA.players.find(p => p.playerId === A.id) || {}).characterName || "voicetest_a";
  console.log("【1】语音加入与名册");

  // A 先加入语音：名册应为空
  const pRosterA = once(A, "voice_roster");
  A.emit("voice_join", { roomCode: code });
  const rosterA = await pRosterA;
  check("A 加入后名册为空（没有更早的语音成员）", Array.isArray(rosterA.peers) && rosterA.peers.length === 0);

  // B 加入语音：应先收到 A 的 voice_join，且名册里含 A
  const pJoinAtA = once(A, "voice_join");
  const pRosterB = once(B, "voice_roster");
  B.emit("voice_join", { roomCode: code });
  const rosterB = await pRosterB;
  const joinAtA = await pJoinAtA;
  check("B 的名册含 A（由新加入者发起 offer）", rosterB.peers.length === 1 && rosterB.peers[0] === A.id, `peers=${JSON.stringify(rosterB.peers)} A.id=${A.id}`);
  check("A 收到 B 的 voice_join 通知", joinAtA.playerId === B.id);
  // 名册必须带名字：否则先加入的人在新加入者的界面上只显示一串 socketId
  check("名册带角色名（不只是 socketId）", !!(rosterB.names && rosterB.names[A.id] === aName),
    `names=${JSON.stringify(rosterB.names)} 期望 ${A.id}=${aName}`);
  check("voice_join 通知带角色名", !!joinAtA.playerName && joinAtA.playerName === ((stateB.players.find(p => p.playerId === B.id) || {}).characterName || "voicetest_b"),
    `playerName=${joinAtA.playerName}`);

  console.log(NL + "【2】SDP / ICE 中转");
  const pSigAtA = once(A, "voice_signal");
  B.emit("voice_signal", { to: A.id, data: { sdp: { type: "offer", sdp: "v=0 fake" } } });
  const sigAtA = await pSigAtA;
  check("A 收到来自 B 的信令", sigAtA.from === B.id && sigAtA.data && sigAtA.data.sdp.type === "offer");

  const pSigAtB = once(B, "voice_signal");
  A.emit("voice_signal", { to: B.id, data: { candidate: { candidate: "candidate:fake" } } });
  const sigAtB = await pSigAtB;
  check("B 收到来自 A 的 ICE 候选", sigAtB.from === A.id && sigAtB.data.candidate);

  console.log(NL + "【3】开关状态广播");
  const pStateAtB = once(B, "voice_state");
  A.emit("voice_state", { roomCode: code, micOn: true, listenOn: false });
  const st = await pStateAtB;
  check("B 看到 A 的麦克风已开", st.playerId === A.id && st.micOn === true && st.listenOn === false);

  console.log(NL + "【4】退出与断线清理");
  const pLeaveAtA = once(A, "voice_leave");
  B.emit("voice_leave", { roomCode: code });
  const lv = await pLeaveAtA;
  check("A 收到 B 的语音退出", lv.playerId === B.id);

  // B 重新加入后直接断线，A 应收到 voice_leave（断线清理）
  const pRosterB2 = once(B, "voice_roster");
  B.emit("voice_join", { roomCode: code });
  await pRosterB2;

  // ⚠️ socket.io-client v4 在 disconnect() 之后会把 socket.id 置为 undefined，
  //    所以断线相关的断言必须先用断线前捕获的 id（否则比较的是 undefined，会变成假失败）
  const bId = B.id;
  const redis = new Redis(REDIS_URL);
  async function snap(tag) {
    const keys = await redis.keys(`game:${code}:player:*`);
    const humans = [];
    for (const k of keys) {
      const me = JSON.parse((await redis.get(k)) || "{}");
      if (!me.isNPC && !me.isAI) humans.push(`${me.playerName}(${me.connected})`);
    }
    console.log(`  · [${tag}] 真人玩家：${humans.join(", ") || "无"}`);
  }
  await snap("B 断线前");

  const pLeaveAtA2 = once(A, "voice_leave");
  B.disconnect();
  let lv2 = null;
  try { lv2 = await pLeaveAtA2; } catch (e) { /* 记为失败，继续跑后面的落库检查 */ }
  check("B 断线后 A 收到 voice_leave（自动清理）", !!(lv2 && lv2.playerId === bId),
    lv2 ? `payload=${JSON.stringify(lv2)}` : "未收到事件");

  // 既有 bug 回归：socket.io v4 在 emit("disconnect") 之前已 leaveAll()，原实现读 socket.rooms
  // 得到空集合 → 断线处理器对所有房间空转，connected 永远停在 true。
  // 而 humanCount 用 connected 过滤 → 幽灵玩家会让人永远凑不满"全员已准备"。
  await new Promise(res => setTimeout(res, 600));
  await snap("B 断线后");
  const rawMe = await redis.get(`game:${code}:player:${bId}`);
  const meB = rawMe ? JSON.parse(rawMe) : null;
  check("B 断线后 connected 落库为 false（幽灵玩家 bug 修复）", !!(meB && meB.connected === false),
    meB ? `connected=${meB.connected}` : "未找到玩家记录");

  A.disconnect();

  // 清理本次测试自己造出来的房间数据（不动脚本会话，那是公共素材）
  const roomKeys = await redis.keys(`game:${code}*`);
  if (roomKeys.length) await redis.del(...roomKeys);
  await redis.srem("rooms:open", code);
  await redis.quit();
  console.log(NL + `已清理测试房间 ${code} 的 ${roomKeys.length} 个 Redis 键`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  // 测试账号 voicetest_a / voicetest_b 保留复用（下次运行直接登录，不重复注册）
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
