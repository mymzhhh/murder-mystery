// 协议层并发测试 — 数据层的竞态由 race-test.js 覆盖，这里测"多个客户端同时做同一件事"
//
// 数据层（assignClue/updatePlayer/投票）已有 race-test.js；但真正会毁掉一局的
// 是流程层竞态：同时 ready 导致阶段跳级、同时抢同一角色、同时搜证拿到同一条线索。
// 这些只有在真实 socket 上并发发起才能测出来。
//
// 跑法：npm run test:concurrency（需要服务端 + Redis + PG）
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

// 测试房间登记在模块级，保证中途异常退出也能清理 ——
// 之前清理写在流程末尾，断言失败/抛错时会被跳过，留下 0 玩家的房间
// （会被生命周期扫描器按"无人 30 分钟"回收，但没必要留垃圾）。
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

/** 连上并加入房间，返回 {sock, state} */
async function joinRoom(code, token) {
  const s = io(BASE, { transports: ["websocket"] });
  await once(s, "connect");
  const p = once(s, "room_state");
  s.emit("join_room", { roomCode: code, token });
  const st = await p;
  return { sock: s, state: st };
}

(async () => {
  redis = new Redis(REDIS_URL);
  const tokens = [];
  for (const n of ["voicetest_a", "voicetest_b", "voicetest_c"]) tokens.push(await auth(n));
  const scripts = await req("GET", "/api/player/scripts", null, tokens[0]);
  const sid = scripts.body.scripts[0].sessionId;

  const newRoom = async () => {
    const r = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 6 }, tokens[0]);
    codes.push(r.body.roomCode);
    return r.body.roomCode;
  };

  // ================= A. 并发 ready → 阶段只能推进一次 =================
  console.log("【A】3 人同时 ready → 阶段只能推进一次（否则会跳级）");
  {
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
    const pReading = new Promise(res => {
      const t = setTimeout(() => res(null), 25000);
      a.sock.on("phase_changed", (d) => { if (d.phase === "reading") { clearTimeout(t); res(d); } });
    });
    a.sock.emit("start_game", { roomCode: code });
    await pReading;

    // 统计所有客户端收到的阶段事件
    const seen = [];
    for (const cl of [a, b, c]) cl.sock.on("phase_changed", (d) => seen.push(d.phase));
    // 三人同时 ready
    a.sock.emit("ready", { roomCode: code });
    b.sock.emit("ready", { roomCode: code });
    c.sock.emit("ready", { roomCode: code });
    await sleep(9000);

    const introCount = seen.filter(x => x === "intro").length;
    const distinct = [...new Set(seen)];
    check("并发 ready 只推进一次（3 个客户端各收到 1 次，共 3 条）", introCount === 3,
      `intro 事件 ${introCount} 条 / 全部事件 ${JSON.stringify(seen)}`);
    check("没有跳级（未直接进入 voting 等更后面的阶段）",
      !distinct.includes("voting") && !distinct.includes("round2"),
      `出现过 ${JSON.stringify(distinct)}`);

    const phase = await redis.hget(`game:${code}`, "phase");
    check("落库阶段是 intro", phase === "intro", `phase=${phase}`);

    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= B. 并发抢同一个角色 → 只能有一个人成功 =================
  console.log("\n【B】2 人同时抢同一个角色 → 只能有一个人成功");
  {
    const code = await newRoom();
    const a = await joinRoom(code, tokens[0]);
    const b = await joinRoom(code, tokens[1]);
    const target = a.state.allCharacters.find(x => x.roleType !== "npc").name;

    const results = [];
    const p1 = once(a.sock, "character_selected").then(() => results.push("A")).catch(() => {});
    const p2 = once(b.sock, "character_selected").then(() => results.push("B")).catch(() => {});
    const e1 = once(a.sock, "error").then(d => results.push("A-err:" + d.code)).catch(() => {});
    const e2 = once(b.sock, "error").then(d => results.push("B-err:" + d.code)).catch(() => {});
    // 同时发起
    a.sock.emit("select_character", { roomCode: code, characterName: target });
    b.sock.emit("select_character", { roomCode: code, characterName: target });
    await sleep(2500);

    const players = await redis.keys(`game:${code}:player:*`);
    const holders = [];
    for (const k of players) {
      // 注意：玩家记录是 JSON 字符串（game-manager 用 set 而非 hset），不是 hash
      const raw = await redis.get(k);
      let p = null;
      try { p = JSON.parse(raw || "{}"); } catch (e) { continue; }
      if (p.characterName === target && !p.isNPC) holders.push(p.playerName || k);
    }
    check("同一个角色只被一个真人占住", holders.length <= 1, `持有者 ${holders.length} 个；事件 ${JSON.stringify(results)}`);

    a.sock.disconnect(); b.sock.disconnect();
  }

  // ================= C. 并发搜证 → 同一条线索不能发给两个人 =================
  console.log("\n【C】3 人同时搜证 → 同一条线索不能重复发放");
  {
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
    // 推进到 round1
    const waitPhase = (d) => new Promise(res => {
      const t = setTimeout(() => res(null), 30000);
      a.sock.on("phase_changed", (x) => { if (x.phase === d) { clearTimeout(t); res(x); } });
    });
    let pr = waitPhase("reading");
    a.sock.emit("start_game", { roomCode: code });
    await pr;
    pr = waitPhase("intro");
    a.sock.emit("ready", { roomCode: code });
    b.sock.emit("ready", { roomCode: code });
    c.sock.emit("ready", { roomCode: code });
    await pr;
    pr = waitPhase("round1");
    a.sock.emit("ready", { roomCode: code });
    b.sock.emit("ready", { roomCode: code });
    c.sock.emit("ready", { roomCode: code });
    await pr;
    console.log("    （已推进到 round1）");

    // 收集线索发放事件。
    // ⚠ clue_received 是广播给全房的事件，不能用"哪个客户端收到"来归属，
    //    那会误判成同一条线索发给了所有人。必须直接查 Redis 里每条线索的 foundBy。
    for (const cl of [a, b, c]) cl.sock.on("clue_received", () => {});
    // 三人同时搜证（多轮，制造竞争）
    for (let round = 0; round < 4; round++) {
      a.sock.emit("investigate", { roomCode: code, query: "" });
      b.sock.emit("investigate", { roomCode: code, query: "" });
      c.sock.emit("investigate", { roomCode: code, query: "" });
      await sleep(1200);
    }
    await sleep(1500);

    const { getClues } = require("../../modules/game-manager");
    const finalClues = await getClues(code);
    const dupes = finalClues.filter(c => (c.foundBy || []).length > 1)
      .map(c => c.id + "→" + c.foundBy.length + "人");
    const found = finalClues.filter(c => (c.foundBy || []).length > 0);
    check("没有同一条线索被记录成多个发现者", dupes.length === 0,
      dupes.length ? `重复: ${JSON.stringify(dupes.slice(0, 3))}` : `本轮共发放 ${found.length} 条，全部只归属一人`);

    for (const cl of [a, b, c]) cl.sock.disconnect();
  }

  // ================= D. 抢线索的原子性（人类与 AI 共用同一个 claim 助手） =================
  console.log("\n【D】抢线索必须是原子的：并发 N 人抢同一条只能有一个成功");
  {
    const code = await newRoom();
    const { loadClues, getClues, assignClue, claimClue } = require("../../modules/game-manager");
    await redis.hset(`game:${code}`, { phase: "round1" });
    await loadClues(code, [{ id: "T1", content: "测试线索一", location: "书房", round: 1 }]);

    // 20 个人抢同一条线索，只能有一个拿到
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimClue(code, "T1", "p" + i))
    );
    const winners = attempts.filter(Boolean).length;
    check("20 路并发抢同一条线索，只有 1 个成功", winners === 1, `成功 ${winners} 个`);

    // 拿到的人再 assign，其他人换线索重试的语义也一并验证
    await assignClue(code, "T1", "p0");
    const after = (await getClues(code)).find(x => x.id === "T1");
    check("该线索只记录一个发现者", (after.foundBy || []).length === 1, `foundBy=${JSON.stringify(after.foundBy)}`);

    // 被抢走的线索，后来者必须拿不到
    const second = await claimClue(code, "T1", "p99");
    check("已被抢走的线索，后来者抢不到", second === false);
  }

  // ================= E. 抢占角必须原子的放与收 =================
  console.log("\n【E】角色占位：并发抢角只有一个成功，换角/离房要能释放");
  {
    const code = await newRoom();
    const { claimCharacter, releaseCharacterClaim, releaseCharacterClaims, addPlayer, getPlayers } = require("../../modules/game-manager");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimCharacter(code, "角色甲", "h" + i)));
    check("10 路并发抢同一角色，只有 1 个成功", results.filter(Boolean).length === 1, `成功 ${results.filter(Boolean).length} 个`);

    const holder = await redis.hget(`game:${code}:charclaims`, "角色甲");
    check("占位记录指向唯一的持有者", !!holder && /^h\d$/.test(holder), `holder=${holder}`);

    // 释放：只有持有者本人能释放
    const notMine = await releaseCharacterClaim(code, "角色甲", "h999");
    check("非持有者释放无效", notMine === false);
    const mine = await releaseCharacterClaim(code, "角色甲", holder);
    check("持有者可以释放", mine === true);
    const gone = await redis.hget(`game:${code}:charclaims`, "角色甲");
    check("释放后占位消失（别人可以抢）", gone === null || gone === undefined);

    // 批量释放（离房用）
    await claimCharacter(code, "角色乙", "h1");
    await claimCharacter(code, "角色丙", "h1");
    await claimCharacter(code, "角色丁", "h2");
    const released = await releaseCharacterClaims(code, "h1");
    check("批量释放只清掉该玩家占的角", released.sort().join(",") === "角色丙,角色乙", `释放了 ${JSON.stringify(released)}`);
    check("别人的占位不受影响", (await redis.hget(`game:${code}:charclaims`, "角色丁")) === "h2");
  }

  // 清理
  await cleanupRooms();
  console.log(`\n已清理 ${codes.length} 个测试房间`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("FAIL:", e.message);
  await cleanupRooms(); // 异常路径也要清理，别留下测试房间
  process.exit(1);
});
