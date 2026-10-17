// 阶段推进规则的端到端验证
//
// 覆盖玩家反馈的两条需求：
//   1) 全员就绪      → 约 10 秒后自动推进
//   2) 只差一个人就绪 → 开始倒计时，到点自动推进（不再干等 10 分钟）
//   3) 断线超过阈值且房里还有人 → 踢出并由 AI 接管其角色
//
// 这些规则横跨 ready 处理器、Redis 锁、倒计时与 AI 补位，单测覆盖不到，
// 必须真的开一局、真的让某些人不点 ready。
//
// 跑法：npm run test:ready（需要服务端 + Redis + PG）
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

const once = (sock, ev, ms = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, extra = "") => { if (c) { pass++; console.log("  ✔ " + n + (extra ? "  " + extra : "")); } else { fail++; console.log("  ✖ " + n + (extra ? "  " + extra : "")); } };

const codes = [];
let redis = null;
async function cleanupRooms() {
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

async function joinRoom(code, token) {
  const s = io(BASE, { transports: ["websocket"] });
  await once(s, "connect");
  const p = once(s, "room_state");
  s.emit("join_room", { roomCode: code, token });
  const st = await p;
  return { sock: s, state: st };
}

/** 等到某个阶段出现（返回该阶段事件；超时返回 null） */
function waitPhase(sock, phase, ms = 40000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.off("phase_changed", on); resolve(null); }, ms);
    const on = (d) => { if (d && d.phase === phase) { clearTimeout(t); sock.off("phase_changed", on); resolve(d); } };
    sock.on("phase_changed", on);
  });
}

(async () => {
  redis = new Redis(REDIS_URL);
  const tokens = [];
  for (const n of ["voicetest_a", "voicetest_b", "voicetest_c"]) tokens.push(await auth(n));
  const scripts = await req("GET", "/api/player/scripts", null, tokens[0]);
  const sid = scripts.body.scripts[0].sessionId;

  const newRoom = async (maxPlayers = 4) => {
    const r = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers }, tokens[0]);
    codes.push(r.body.roomCode);
    return r.body.roomCode;
  };

  /** 建一局 3 人、已进入 reading 的房间 */
  async function startedGame() {
    const code = await newRoom();
    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);
    const c = await joinRoom(code, tokens[2]);
    const chars = a.state.allCharacters.filter(x => x.roleType !== "npc").map(x => x.name);
    for (const [i, cl] of [a, b, c].entries()) {
      const p = once(cl.sock, "character_selected");
      cl.sock.emit("select_character", { roomCode: code, characterName: chars[i] });
      await p;
    }
    const pr = waitPhase(a.sock, "reading");
    a.sock.emit("start_game", { roomCode: code });
    await pr;
    return { code, a, b, c };
  }

  // ================= 1. 全员就绪 → 约 10 秒推进 =================
  console.log("【1】全员就绪 → 应在约 10 秒后推进（不是 5 秒，也不是干等）");
  {
    const { code, a, b, c } = await startedGame();
    const pIntro = waitPhase(a.sock, "intro", 40000);
    const t0 = Date.now();
    a.sock.emit("ready", { roomCode: code });
    b.sock.emit("ready", { roomCode: code });
    c.sock.emit("ready", { roomCode: code });
    const ok = await pIntro;
    const dt = Date.now() - t0;
    check("全员就绪后进入了下一阶段", !!ok, ok ? `${(dt / 1000).toFixed(1)}s` : "超时");
    check("耗时约 10 秒（8~14 秒区间）", dt >= 8000 && dt <= 14000, `${(dt / 1000).toFixed(1)}s`);
    check("落库阶段正确", (await redis.hget(`game:${code}`, "phase")) === "intro");
    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= 2. 只差一人 → 倒计时后自动推进 =================
  console.log("\n【2】只差一人就绪 → 应开始倒计时并自动推进（原来要干等 10 分钟）");
  {
    const { code, a, b, c } = await startedGame();
    // 记录所有 ready_update：既要验证倒计时确实发出来了，
    // 也要验证 mode=partial —— 前端靠它决定"还没到齐时准备按钮不能置灰"。
    const modes = [];
    a.sock.on("ready_update", (d) => { if (typeof d.countdown === "number") modes.push(d.mode || ""); });
    // 先验证"未达阈值时不动"：2 人房，只 1 人 ready 才等于 N-1；这里 3 人只 1 人 ready 不触发
    a.sock.emit("ready", { roomCode: code });
    await sleep(3000);
    check("3 人中仅 1 人准备时不触发倒计时（未达 N-1）",
      (await redis.hget(`game:${code}`, "phase")) === "reading",
      `phase=${await redis.hget(`game:${code}`, "phase")}`);

    // 再来一个人 ready → 达到 N-1 → 应触发倒计时
    const t0 = Date.now();
    const pIntro = waitPhase(a.sock, "intro", 90000);
    b.sock.emit("ready", { roomCode: code });
    await sleep(2500);
    const lockExists = await redis.exists(`game:${code}:countdown`);
    check("达到 N-1 后开始了倒计时", lockExists === 1);
    check("倒计时事件带 mode=partial（前端据此不锁准备按钮）",
      modes.length > 0 && modes.every(m => m === "partial"),
      `modes=${JSON.stringify([...new Set(modes)])} 共 ${modes.length} 次`);

    const ok = await pIntro;
    const dt = Date.now() - t0;
    check("倒计时结束后自动推进", !!ok, ok ? `${(dt / 1000).toFixed(1)}s` : "超时");
    // 默认 PARTIAL_READY_SECONDS=60，所以总耗时应当在 60 秒附近（允许前期的 3 秒观察）
    check("耗时约 60 秒（55~75 秒）", dt >= 55000 && dt <= 75000, `${(dt / 1000).toFixed(1)}s`);
    check("第三人即便没点准备也被带进下一阶段", (await redis.hget(`game:${code}`, "phase")) === "intro");
    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= 3. 倒计时中补上最后一人 → 换成更短的倒计时（不重复推进） =================
  console.log("\n【3】倒计时途中最后一人也准备了 → 换成 10 秒倒计时，且只推进一次");
  {
    const { code, a, b, c } = await startedGame();
    const seen = [];
    a.sock.on("phase_changed", (d) => seen.push(d.phase));
    const modes = [];
    a.sock.on("ready_update", (d) => { if (typeof d.countdown === "number") modes.push({ mode: d.mode || "", cd: d.countdown, reason: d.reason || "" }); });
    a.sock.emit("ready", { roomCode: code });
    b.sock.emit("ready", { roomCode: code });   // 达到 N-1，开始 60 秒倒计时
    await sleep(3000);
    const t0 = Date.now();
    const pIntro = waitPhase(a.sock, "intro", 40000);
    c.sock.emit("ready", { roomCode: code });   // 补上最后一人
    const ok = await pIntro;
    const dt = Date.now() - t0;
    check("最后一人准备后切换到短倒计时并推进", !!ok, ok ? `${(dt / 1000).toFixed(1)}s` : "超时");
    check("切换后约 10 秒内完成（说明 60 秒倒计时被取消）", dt <= 16000, `${(dt / 1000).toFixed(1)}s`);
    const allMode = modes.filter(m => m.mode === "all");
    check("切换后发出 mode=all 的短倒计时", allMode.length > 0,
      `倒计时事件 ${JSON.stringify(modes.slice(-4))}`);
    // 回归：readyCountdowns 曾被误放进 io.on("connection") 回调，导致"每个 socket 各一份"，
    // 取消时读到空表 → 旧的 60 秒倒计时停不下来，玩家会同时看到两个倒计时数字在跳。
    const firstAll = modes.findIndex(m => m.mode === "all");
    const trailing = firstAll >= 0 ? modes.slice(firstAll).filter(m => m.mode === "partial") : [];
    check("切换后旧的长倒计时彻底停止（不再下发 partial 事件）", firstAll >= 0 && trailing.length === 0,
      trailing.length ? `切换后仍收到 ${trailing.length} 个 partial：${JSON.stringify(trailing.slice(0, 3))}` : "0 个残留");
    await sleep(4000);
    const introTimes = seen.filter(x => x === "intro").length;
    check("只推进了一次（没有重复推进/跳级）", introTimes === 1, `intro 事件 ${introTimes} 次，全部 ${JSON.stringify(seen)}`);
    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= 4. AFK 踢出 + AI 接管 =================
  console.log("\n【4】断线超过阈值且房里还有人 → 踢出并由 AI 接管原角色");
  {
    const code = await newRoom();
    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);
    const chars = a.state.allCharacters.filter(x => x.roleType !== "npc").map(x => x.name);
    const pickedB = chars[1];
    for (const [cl, nm] of [[a, chars[0]], [b, pickedB]]) {
      const p = once(cl.sock, "character_selected");
      cl.sock.emit("select_character", { roomCode: code, characterName: nm });
      await p;
    }
    // b 断线（模拟 AFK）
    b.sock.disconnect();
    await sleep(1200);

    // 直接把"断线计时器"的等待时间缩短：测试里不可能真等 5 分钟，
    // 改为直接调用清理逻辑——用模块函数复现定时器到点后做的事。
    const { removePlayer, getPlayers, updatePlayer, getRoom, updateRoom, addChatMessage } = require("../../src/game/game-manager");
    const { syncAiFillers } = require("../../src/game/ai-player");
    const before = await getPlayers(code);
    const meB = before.find(p => p.playerName === "voicetest_b");
    check("B 已被标记为未连接", !!meB && meB.connected === false, meB ? `connected=${meB.connected}` : "未找到 B");
    check("B 断线时角色已被占用", !!(meB && meB.characterName === pickedB), meB ? `角色=${meB.characterName}` : "");

    // 复刻断线计时器到点后的处理
    const leftChar = meB ? (meB.characterName || "") : "";
    await removePlayer(code, meB.playerId);
    await syncAiFillers(code);
    const after = await getPlayers(code);
    const humans = after.filter(p => !p.isNPC);
    const taker = after.find(p => p.isNPC && p.isAI && p.characterName === leftChar);
    check("B 已被踢出房间（真人只剩 A）", humans.length === 1 && !humans.some(p => p.playerName === "voicetest_b"),
      `真人: ${humans.map(p => p.playerName).join(",")}`);
    check("原角色已由 AI 接管", !!taker, taker ? `${leftChar} → ${taker.playerId}` : `没有 AI 接管 ${leftChar}`);
    check("接管者被标记为 AI/NPC", !!taker && taker.isAI === true && taker.isNPC === true);
    check("A 仍在房间里（没有被误踢）", humans.some(p => p.playerName === "voicetest_a"));

    a.sock.disconnect();
  }

  await cleanupRooms();
  console.log(`\n已清理 ${codes.length} 个测试房间`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("FAIL:", e.message);
  await cleanupRooms();
  process.exit(1);
});
