// 前端信息隔离与语音信令安全的端到端验证
//
// 起因（实测复现过的两个漏洞）：
//   1) 严重：select_character 把整个角色对象（含 secret / isMurderer）写进了玩家记录，
//      而 room_updated 把 getPlayers() 原样广播给全房间 —— 同房间任何人（哪怕没选角色、
//      只是旁观）打开 DevTools 的 WS 面板就能看到凶手身份、别人的秘密和完整剧本。
//      实测单帧 28KB，内容里能直接读出 "isMurderer":true 和凶手的作案过程。
//   2) 中危：voice_signal 中转对 to/data 不做任何校验也不限流。socket.io 匿名可连，
//      于是任何连上服务端的人拿到 socketId 就能往任意连接注入 SDP/ICE ——
//      既能刷帧，也能伪造 offer 逼对方建 P2P 连接（ICE 会暴露真实 IP）。
//
// 这个测试把"房间里下发的每一帧都不得含私有数据"和"跨房间信令必须被拒"钉死，
// 以后谁再把原始玩家记录 emit 出去、或把 voice_signal 的校验删掉，都会在这里红。
//
// 跑法：npm run test:security（需要服务端 + Redis + PG）
const { io } = require("socket.io-client");
const Redis = require("ioredis");

const BASE = process.env.VOICE_TEST_BASE || "http://127.0.0.1:3000";
const REDIS_URL = process.env.VOICE_TEST_REDIS || "redis://127.0.0.1:6380";
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
      res.on("end", () => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
        try { resolve({ status: res.statusCode, body: JSON.parse(b), headers }); }
        catch (e) { resolve({ status: res.statusCode, body: b, headers }); }
      });
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
const once = (s, ev, ms = 20000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("等待 " + ev + " 超时")), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = "") => { if (c) { pass++; console.log("  ✔ " + n + (x ? "  " + x : "")); } else { fail++; console.log("  ✖ " + n + (x ? "  " + x : "")); } };

const codes = [];
let redis = null;
async function cleanup() {
  if (!redis) return;
  for (const c of codes) {
    try {
      const keys = await redis.keys(`game:${c}*`);
      if (keys.length) await redis.del(...keys);
      await redis.srem("rooms:open", c);
      await redis.zrem("games:index", c);
    } catch (e) { /* 尽力而为 */ }
  }
  try { await redis.quit(); } catch (e) { /* ignore */ }
}

// 私有数据指示器。注意 characterScript 是"JSON 串套 JSON"，内层引号是转义的，
// 所以扫描前必须先反转义，否则 /"isMurderer"/ 这类模式会漏掉。
const FORBIDDEN = [
  { re: /isMurderer/i, label: "isMurderer（凶手标记）" },
  { re: /characterScript/, label: "characterScript（完整角色对象）" },
  { re: /playerScript/, label: "playerScript（整篇个人剧本）" },
  { re: /dmGuide/, label: "dmGuide（DM 手册）" },
  { re: /"murderer"\s*:/, label: "murderer 对象" },
  { re: /你需要隐瞒的事/, label: "秘密正文" },
];
function scanForbidden(payload) {
  const flat = JSON.stringify(payload).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  return FORBIDDEN.filter(f => f.re.test(flat)).map(f => f.label);
}

(async () => {
  redis = new Redis(REDIS_URL);
  const tokens = [];
  for (const n of ["voicetest_a", "voicetest_b", "voicetest_c"]) tokens.push(await auth(n));
  const scripts = await req("GET", "/api/player/scripts", null, tokens[0]);
  if (!scripts.body.scripts?.length) throw new Error("没有可用剧本，无法测试");
  const sid = scripts.body.scripts[0].sessionId;

  const newRoom = async (maxPlayers = 4) => {
    const r = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers }, tokens[0]);
    codes.push(r.body.roomCode);
    return r.body.roomCode;
  };
  const joinRoom = async (code, token) => {
    const s = io(BASE, { transports: ["websocket"] });
    await once(s, "connect");
    const p = once(s, "room_state");
    s.emit("join_room", { roomCode: code, token });
    return { sock: s, state: await p };
  };

  // ================= 1. 房间里下发的每一帧都不得含私有数据 =================
  console.log("【1】旁观者视角：房间广播里不得出现凶手身份/别人的秘密/完整剧本");
  {
    const code = await newRoom();
    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);   // b 全程不选角色：纯旁观者
    const c = await joinRoom(code, tokens[2]);
    const chars = a.state.allCharacters.filter(x => x.roleType !== "npc").map(x => x.name);

    // 抓 b 收到的每一帧
    const frames = [];
    const orig = b.sock.onevent.bind(b.sock);
    b.sock.onevent = (packet) => {
      try {
        const ev = packet?.data?.[0];
        const payload = packet?.data?.[1];
        if (ev) frames.push({ ev, payload });
      } catch (e) { /* ignore */ }
      return orig(packet);
    };

    // 只有 a、c 选角；b 什么都不做。
    // 这样"b 收到的任何一帧都不该含私有数据"是无歧义的 ——
    // 如果让 b 也选角，它收到的 character_selected 是它**自己**的角色（含 isMurderer），
    // 那是应该给的，会把断言变成误报。
    for (const [cl, nm] of [[a, chars[0]], [c, chars[1]]]) {
      const p = once(cl.sock, "character_selected");
      cl.sock.emit("select_character", { roomCode: code, characterName: nm });
      await p;
    }
    // 让 AI 补位把剩余角色也填上（历史上正是 AI 补位那几条记录泄的凶手）
    await sleep(2500);

    check("旁观者收到了房间广播（否则测不到东西）", frames.some(f => f.ev === "room_updated"),
      `共 ${frames.length} 帧，事件: ${JSON.stringify([...new Set(frames.map(f => f.ev))])}`);

    const offenders = [];
    for (const f of frames) {
      const hits = scanForbidden(f.payload);
      if (hits.length) offenders.push(`${f.ev}: ${hits.join("/")}`);
    }
    check("旁观者收到的每一帧都不含私有数据", offenders.length === 0,
      offenders.length ? `泄露: ${JSON.stringify([...new Set(offenders)].slice(0, 5))}` : `${frames.length} 帧全部干净`);

    // 反向确认：投影没有把 UI 需要的字段弄丢
    const ru = frames.filter(f => f.ev === "room_updated").pop();
    const first = (ru?.payload?.players || [])[0] || {};
    const need = ["playerId", "playerName", "characterName", "connected", "isNPC", "isAI"];
    const missing = need.filter(k => !(k in first));
    check("投影保留了前端需要的字段", missing.length === 0,
      missing.length ? `缺字段 ${JSON.stringify(missing)}` : `字段: ${Object.keys(first).join(",")}`);
    check("room_updated 里仍带 ownerId（前端靠它算房主皇冠）", ru?.payload?.ownerId !== undefined);

    // 选角的人自己必须仍然拿得到自己的角色（别把功能一起修没了）
    const own = [];
    const origA = a.sock.onevent.bind(a.sock);
    a.sock.onevent = (packet) => {
      try { if (packet?.data?.[0] === "character_selected") own.push(packet.data[1]); } catch (e) { /* ignore */ }
      return origA(packet);
    };
    const p2 = once(a.sock, "character_selected");
    a.sock.emit("select_character", { roomCode: code, characterName: chars[2] });
    await p2;
    await sleep(300);
    const mine = own.pop() || {};
    check("选角者本人仍能拿到自己的角色信息", !!(mine.character && mine.character.name === chars[2]),
      `角色=${mine.character?.name} isMurderer 字段存在=${Object.prototype.hasOwnProperty.call(mine, "isMurderer")}`);
    const d = await req("GET", `/api/player/rooms/${code}/my-script`, null, tokens[0]);
    check("玩家自己的剧本接口仍正常返回正文", d.status === 200 && (d.body.script || "").length > 200,
      `长度=${(d.body.script || "").length}`);

    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= 2. 语音信令不得跨房间转发 =================
  console.log("\n【2】voice_signal 只允许在同一语音房间内转发");
  {
    const code = await newRoom();
    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);

    // 双方加入语音
    const ra = once(a.sock, "voice_roster");
    a.sock.emit("voice_join", { roomCode: code });
    await ra;
    const rb = once(b.sock, "voice_roster");
    b.sock.emit("voice_join", { roomCode: code });
    await rb;
    await sleep(400);

    // (1) 同房成员之间必须能转发（别把语音修坏了）
    const gotByB = [];
    b.sock.on("voice_signal", (d) => gotByB.push(d));
    a.sock.emit("voice_signal", { to: b.sock.id, data: { sdp: { type: "offer", sdp: "v=0 test" } } });
    await sleep(600);
    check("同房间成员之间正常转发", gotByB.length === 1 && gotByB[0].from === a.sock.id,
      `收到 ${gotByB.length} 条`);

    // (2) 外部 socket（连上但没进任何房间、没加入语音）注入必须被丢弃
    const outsider = io(BASE, { transports: ["websocket"] });
    await once(outsider, "connect");
    const before = gotByB.length;
    outsider.emit("voice_signal", { to: b.sock.id, data: { sdp: { type: "offer", sdp: "v=0 evil" } } });
    await sleep(700);
    check("未加入语音的外部 socket 无法注入信令", gotByB.length === before,
      `旁观者注入后新增 ${gotByB.length - before} 条`);

    // (3) 同房但没加入语音的成员也不能注入
    const c = await joinRoom(code, tokens[2]);
    const before2 = gotByB.length;
    c.sock.emit("voice_signal", { to: b.sock.id, data: { sdp: { type: "offer", sdp: "v=0 notin" } } });
    await sleep(700);
    check("在房间但没加入语音的成员无法注入信令", gotByB.length === before2,
      `新增 ${gotByB.length - before2} 条`);

    // (4) 向自己转发无意义，应被丢弃
    const selfGot = [];
    b.sock.on("voice_signal", (d) => selfGot.push(d));
    b.sock.emit("voice_signal", { to: b.sock.id, data: { sdp: { type: "offer", sdp: "v=0 self" } } });
    await sleep(500);
    check("向自己转发被丢弃", selfGot.length === 0, `收到 ${selfGot.length} 条`);

    // (5) 限流：3 秒内远超上限的帧不能全部通过
    const before3 = gotByB.length;
    for (let i = 0; i < 120; i++) {
      a.sock.emit("voice_signal", { to: b.sock.id, data: { candidate: { candidate: "c" + i } } });
    }
    await sleep(1200);
    const passed = gotByB.length - before3;
    check("超过滑动窗口上限的帧被丢弃（限流生效）", passed < 120 && passed > 0,
      `发出 120 条，通过 ${passed} 条`);

    for (const cl of [a, b, c]) cl.sock.disconnect();
    outsider.disconnect();
  }

  // ================= 3. 房间准入：人数上限 + 进行中的局不收新人 =================
  console.log("\n【3】房间准入：maxPlayers 生效，且进行中的局不收新人");
  {
    // maxPlayers=2 的房间：前 2 人进得去，第 3 人必须被拒
    const nr = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 2 }, tokens[0]);
    const code = nr.body.roomCode;
    codes.push(code);

    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);
    const cSock = io(BASE, { transports: ["websocket"] });
    await once(cSock, "connect");
    const cErrs = [];
    cSock.on("error", d => cErrs.push(d.code));
    const cState = await new Promise(res => { const t = setTimeout(() => res(null), 5000); cSock.once("room_state", d => { clearTimeout(t); res(d); }); cSock.emit("join_room", { roomCode: code, token: tokens[2] }); });
    await sleep(500);
    check("超过 maxPlayers 的加入被拒（ROOM_FULL）", !cState && cErrs.includes("ROOM_FULL"),
      `拿到房间状态=${!!cState}，错误=${JSON.stringify(cErrs)}`);

    // 开局 → 进 reading 阶段（start_game 要求所有真人都已选角，所以 a、b 都要选）
    const chars = a.state.allCharacters.filter(x => x.roleType !== "npc").map(x => x.name);
    for (const [cl, nm] of [[a, chars[0]], [b, chars[1]]]) {
      const p = once(cl.sock, "character_selected");
      cl.sock.emit("select_character", { roomCode: code, characterName: nm });
      await p;
    }
    const startErrs = [];
    a.sock.on("error", d => startErrs.push(d.code + ":" + d.message));
    let started = false;
    const pr = new Promise(res => { const on = d => { if (d.phase === "reading") { a.sock.off("phase_changed", on); res(true); } }; a.sock.on("phase_changed", on); setTimeout(() => res(false), 30000); });
    a.sock.emit("start_game", { roomCode: code });
    started = await pr;
    check("开局成功进入 reading（后续准入测试的前提）", started, started ? "" : `错误=${JSON.stringify(startErrs)}`);

    // 局外人此时加入：必须被拒
    const dSock = io(BASE, { transports: ["websocket"] });
    await once(dSock, "connect");
    const dErrs = [];
    dSock.on("error", d => dErrs.push(d.code));
    const dState = await new Promise(res => { const t = setTimeout(() => res(null), 5000); dSock.once("room_state", d => { clearTimeout(t); res(d); }); dSock.emit("join_room", { roomCode: code, token: tokens[2] }); });
    await sleep(500);
    check("进行中的局拒绝新人加入（GAME_STARTED）", !dState && dErrs.includes("GAME_STARTED"),
      `拿到房间状态=${!!dState}，错误=${JSON.stringify(dErrs)}`);

    // 原班底换一个 socket 重连（同一账号）：必须放行，否则刷新页面就回不来了
    const aAgain = await joinRoom(code, tokens[0]);
    check("原班底掉线重连仍被放行", !!aAgain.state && aAgain.state.phase === "reading",
      `phase=${aAgain.state?.phase}`);

    for (const s of [a.sock, b.sock, cSock, dSock, aAgain.sock]) s.disconnect();
  }

  // ================= 4. 安全响应头 =================
  console.log("\n【4】安全响应头");
  {
    const r = await req("GET", "/api/health", null, null);
    const h = r.headers || {};
    const need = {
      "content-security-policy": "CSP",
      "x-content-type-options": "nosniff",
      "x-frame-options": "防点击劫持",
      "referrer-policy": "Referrer-Policy",
    };
    for (const [k, label] of Object.entries(need)) {
      check(`${label} 已设置`, !!h[k], h[k] ? String(h[k]).slice(0, 60) : "缺失");
    }
    check("不再暴露 X-Powered-By", !h["x-powered-by"], h["x-powered-by"] || "已移除");
    const csp = String(h["content-security-policy"] || "");
    check("CSP 允许语音所需 media-src blob: 与 ws 连接", /media-src[^;]*blob:/.test(csp) && /connect-src[^;]*ws:/.test(csp));
  }

  await cleanup();
  console.log(`\n已清理 ${codes.length} 个测试房间`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("FAIL:", e.message);
  await cleanup();
  process.exit(1);
});
