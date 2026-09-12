// 端到端回归：玩家端"我的剧本"接口必须返回字符串正文
//
// 为什么必须做集成测试：这个 bug 出在路由层（routes/player.js 把对象当字符串返回），
// 单元测试怎么测 normalizeCharacterScript 都拦不住。只有真的建房间、选角色、调接口，
// 才能证明玩家看到的不再是 [object Object]。
//
// 跑法：npm run test:myscript（需要服务端 + Redis + PG 都在跑）
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

const once = (sock, ev, ms = 10000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✔ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ✖ " + name + (extra ? "  " + extra : "")); }
}

(async () => {
  const token = await auth("voicetest_a");
  const scripts = await req("GET", "/api/player/scripts", null, token);
  const sid = scripts.body.scripts[0].sessionId;
  const room = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 5 }, token);
  const code = room.body.roomCode;
  console.log(`测试房间 ${code}`);

  const S = io(BASE, { transports: ["websocket"] });
  await once(S, "connect");
  S.emit("join_room", { roomCode: code, token });
  const st = await once(S, "room_state");

  const candidates = (st.allCharacters || []).filter(c => c.roleType !== "npc");
  const pick = candidates[0];
  console.log(`选择角色 ${pick.name}\n`);

  const sel = once(S, "character_selected");
  S.emit("select_character", { roomCode: code, characterName: pick.name });
  await sel;

  const my = await req("GET", `/api/player/rooms/${code}/my-script`, null, token);
  const d = my.body;

  console.log("【接口返回】");
  check("HTTP 200", my.status === 200, `status=${my.status}`);
  check("script 是字符串（不是对象）", typeof d.script === "string", `typeof=${typeof d.script}`);
  check("secret 是字符串（不是对象）", typeof d.secret === "string", `typeof=${typeof d.secret}`);
  check("正文不含 [object Object]", !String(d.script).includes("[object Object]"),
    String(d.script).slice(0, 60).replace(/\n/g, "\\n"));
  check("正文非空（真的取到了剧本）", String(d.script).trim().length > 200, `长度=${String(d.script).length}`);
  check("秘密非空（split 路径下秘密藏在 script.secret 里）", String(d.secret).trim().length > 0, `长度=${String(d.secret).length}`);

  // 复刻前端 GameView 的拼接，确认最终渲染文本是干净的
  const shown = d.script + (d.secret ? "\n\n【你的秘密】\n" + d.secret : "");
  console.log("\n【模拟前端拼接后】");
  check("拼接结果不含 [object Object]", !shown.includes("[object Object]"));
  check("拼接结果包含秘密小节", shown.includes("【你的秘密】"));
  console.log("  · 渲染文本前 120 字：" + shown.slice(0, 120).replace(/\n/g, "\\n"));

  S.disconnect();

  const redis = new Redis(REDIS_URL);
  const keys = await redis.keys(`game:${code}*`);
  if (keys.length) await redis.del(...keys);
  await redis.srem("rooms:open", code);
  await redis.quit();
  console.log(`\n已清理测试房间 ${code} 的 ${keys.length} 个 Redis 键`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
