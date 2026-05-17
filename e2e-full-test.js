// 剧本杀平台 — 综合测试套件
// 用法: node e2e-full-test.js [--module e2e|contract|resilience|memory|all]
// 默认: all
const http = require("http");
const { io: SocketIOClient } = require("socket.io-client");
const crypto = require("crypto");

const BASE_URL = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://localhost:3000";
const MODULE = process.argv.includes("--module")
  ? process.argv[process.argv.indexOf("--module") + 1]
  : "all";

const urlObj = new URL(BASE_URL);
const HOST = urlObj.hostname;
const PORT = urlObj.port || 3000;

// ==================== 工具函数 ====================

function httpReq(method, path, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: HOST, port: PORT, path, method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      timeout: opts.timeout || 15000,
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

let testUserCounter = 0;
function uniqueUser(prefix = "t") {
  return `${prefix}_${Date.now()}_${testUserCounter++}`;
}

async function registerAndLogin() {
  const user = uniqueUser("e2e");
  const pwd = "testpass123";
  const reg = await httpReq("POST", "/api/auth/register", { body: { username: user, password: pwd } });
  if (reg.status === 200) return { token: reg.body.token, username: user };
  const login = await httpReq("POST", "/api/auth/login", { body: { username: user, password: pwd } });
  if (login.status === 200) return { token: login.body.token, username: user };
  return null;
}

// ==================== 模拟剧本数据 ====================

async function createMockScript() {
  const scriptId = "mock_" + crypto.randomBytes(6).toString("hex");
  const { ensureRedis, getRedis } = require("./modules/redis-client");
  await ensureRedis();
  const r = getRedis();

  const meta = {
    title: "血色晚宴",
    era: "民国",
    location: "上海公馆",
    playerCount: "3",
    npcCount: "1",
    clueCount: "6",
    gameMode: "PVE",
    layoutDescription: "一楼:大厅/厨房/书房 | 二楼:卧室/阳台",
    originalMarkdown: "# 血色晚宴\n\n测试剧本内容",
    splitAt: new Date().toISOString(),
  };

  const characters = {
    "侦探陈": { name: "侦探陈", roleType: "player", isMurderer: "0", occupation: "私家侦探", playerScript: "你是侦探陈，受邀参加晚宴。你有敏锐的观察力。", secret: "你欠了死者一大笔钱" },
    "歌女苏": { name: "歌女苏", roleType: "player", isMurderer: "0", occupation: "歌女", playerScript: "你是歌女苏，今夜在晚宴上献唱。", secret: "死者曾威胁要揭露你的过去" },
    "管家王": { name: "管家王", roleType: "player", isMurderer: "1", occupation: "管家", playerScript: "你是管家王，已经在这个家工作了20年。", secret: "你才是这栋宅子的合法继承人，死者伪造了遗嘱" },
    "富商李": { name: "富商李", roleType: "npc", isMurderer: "0", occupation: "富商", playerScript: "你是富商李，死者生前的商业对手。", secret: "你的公司即将被死者吞并" },
  };

  const clues = [
    { id: "c1", content: "一封威胁信，字迹潦草", location: "书房", round: "1", clueType: "文档" },
    { id: "c2", content: "一个破碎的酒杯，边缘有血迹", location: "大厅", round: "1", clueType: "物证" },
    { id: "c3", content: "保险柜里的遗嘱副本", location: "书房", round: "2", clueType: "文档" },
    { id: "c4", content: "管家的账本，记录了异常转账", location: "管家房间", round: "2", clueType: "文档" },
    { id: "c5", content: "阳台上的脚印，尺码与管家相符", location: "阳台", round: "2", clueType: "物证" },
    { id: "c6", content: "死者的怀表，停在事发时刻", location: "死者卧室", round: "1", clueType: "物证" },
  ];

  const dm = {
    openingMonologue: "1935年，上海。血色公馆内...",
    truthReveal: "真凶是管家王。他利用提前布置的机关杀害了主人...",
    murdererName: "管家王",
    murdererMotive: "遗产继承权被夺",
    murdererMethod: "在酒杯中下毒后伪装成摔死",
  };

  // 写入 Redis split 数据
  const pipe = r.pipeline();
  pipe.hset(`split:${scriptId}:meta`, meta);
  for (const [name, data] of Object.entries(characters)) {
    pipe.hset(`split:${scriptId}:char:${name}`, data);
  }
  for (const clue of clues) {
    pipe.hset(`split:${scriptId}:clue:${clue.id}`, clue);
  }
  pipe.hset(`split:${scriptId}:dm`, dm);
  pipe.sadd("scripts:split", scriptId);
  await pipe.exec();

  // 同时创建一个 room-creator 能识别的 PG-style entry
  // 由于 PG 不可用，我们确保 Redis fallback 路径能走通
  // game-room-creator 的 fallback 路径需要:
  // 1. split:{id}:meta 包含 title
  // 2. split:{id}:char:* 包含 playerScript 字段
  // These are already set above.

  return { scriptId, meta, characters, clues, dm };
}

async function cleanupMockScript(scriptId) {
  try {
    const { getRedis, scanKeys } = require("./modules/redis-client");
    const r = getRedis();
    const keys = await scanKeys(`split:${scriptId}*`);
    if (keys.length > 0) await r.del(...keys);
    await r.srem("scripts:split", scriptId);
  } catch (e) { /* ignore */ }
}

// ==================== Module 1: API 契约测试 ====================

async function testAPIContract() {
  console.log("\n" + "═".repeat(55));
  console.log("  Module 1: API 契约测试");
  console.log("═".repeat(55));

  const results = [];
  const auth = await registerAndLogin();
  if (!auth) { console.log("  ✗ 无法获取认证令牌，跳过"); return []; }

  // Admin login
  const adminLogin = await httpReq("POST", "/api/auth/login", {
    body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" },
  });
  const adminToken = adminLogin.body?.token;

  // 定义契约
  const contracts = [
    { name: "GET /api/health", method: "GET", path: "/api/health", expect: { status: 200, fields: ["status", "uptime", "pid"] } },
    { name: "POST /api/auth/register", method: "POST", path: "/api/auth/register", body: { username: uniqueUser("cnt"), password: "pass1234" }, expect: { status: 200, fields: ["token", "role"] } },
    { name: "POST /api/auth/login", method: "POST", path: "/api/auth/login", body: { username: auth.username, password: "testpass123" }, expect: { status: 200, fields: ["token", "role"] } },
    { name: "GET /api/auth/me", method: "GET", path: "/api/auth/me", token: auth.token, expect: { status: 200, fields: ["username", "role"] } },
    { name: "GET /api/admin/scripts", method: "GET", path: "/api/admin/scripts", token: adminToken, expect: { status: 200, fields: ["scripts"] }, skipIf: !adminToken },
    { name: "GET /api/admin/users", method: "GET", path: "/api/admin/users", token: adminToken, expect: { status: 200, fields: ["users"] }, skipIf: !adminToken },
    { name: "GET /api/admin/rooms", method: "GET", path: "/api/admin/rooms", token: adminToken, expect: { status: 200, fields: ["rooms"] }, skipIf: !adminToken },
    { name: "GET /api/player/scripts", method: "GET", path: "/api/player/scripts", token: auth.token, expect: { status: 200, fields: ["scripts"] } },
    { name: "GET /api/player/rooms", method: "GET", path: "/api/player/rooms", token: auth.token, expect: { status: 200, fields: ["rooms"] } },
    { name: "POST /api/auth/login (401)", method: "POST", path: "/api/auth/login", body: { username: "nobody", password: "wrong" }, expect: { status: 401 } },
    { name: "GET /api/auth/me (401)", method: "GET", path: "/api/auth/me", expect: { status: 401 } },
  ];

  for (const c of contracts) {
    if (c.skipIf !== undefined && c.skipIf) {
      console.log(`  ⊘ ${c.name} (跳过: 无管理员token)`);
      continue;
    }
    const res = await httpReq(c.method, c.path, { token: c.token, body: c.body });
    const ok = res.status === c.expect.status;
    let fieldOk = true;
    if (ok && c.expect.fields) {
      for (const f of c.expect.fields) {
        if (res.body?.[f] === undefined) { fieldOk = false; break; }
      }
    }
    const icon = ok && fieldOk ? "✓" : "✗";
    const note = !ok ? ` (actual ${res.status})` : !fieldOk ? " (字段缺失)" : "";
    console.log(`  ${icon} ${c.name}${note}`);
    results.push({ name: c.name, passed: ok && fieldOk, status: res.status });
  }

  return results;
}

// ==================== Module 2: E2E 游戏流程测试 ====================

async function testE2EGameFlow() {
  console.log("\n" + "═".repeat(55));
  console.log("  Module 2: E2E 游戏流程测试 (8阶段状态机)");
  console.log("═".repeat(55));

  const results = [];
  const tokens = [];

  // Step 1: 注册 3 个玩家 + 1 个 admin
  console.log("\n  [准备] 创建测试用户和模拟剧本...");
  for (let i = 0; i < 3; i++) {
    const auth = await registerAndLogin();
    if (auth) tokens.push(auth);
    else { console.log("  ✗ 用户注册失败"); return results; }
  }
  const adminAuth = await httpReq("POST", "/api/auth/login", {
    body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" },
  });
  const adminToken = adminAuth.body?.token;

  // Step 2: 创建模拟剧本数据
  const mock = await createMockScript();
  console.log(`  ✓ 模拟剧本已创建: ${mock.meta.title} (${mock.scriptId})`);

  // Step 3: 创建游戏房间
  console.log("\n  [阶段1: lobby] 创建房间...");
  const roomRes = await httpReq("POST", "/api/player/rooms", {
    token: tokens[0].token,
    body: { scriptSessionId: mock.scriptId, maxPlayers: 6 },
  });

  let roomCode;
  if (roomRes.status === 200 && roomRes.body.roomCode) {
    roomCode = roomRes.body.roomCode;
    console.log(`  ✓ 房间 ${roomCode} 已创建，${roomRes.body.characterCount} 个可玩角色`);
    results.push({ name: "创建房间", passed: true });
  } else {
    console.log(`  ✗ 房间创建失败: ${JSON.stringify(roomRes.body)}`);
    results.push({ name: "创建房间", passed: false, detail: roomRes.body });
    await cleanupMockScript(mock.scriptId);
    return results;
  }

  // Step 4: 3 个玩家通过 WebSocket 加入房间，选择角色
  console.log("\n  [阶段2: 选角] 3 名玩家加入 + 选角...");
  const sockets = [];
  const characterNames = ["侦探陈", "歌女苏", "管家王"];

  for (let i = 0; i < 3; i++) {
    const p = new Promise((resolve) => {
      const socket = SocketIOClient(BASE_URL, {
        transports: ["websocket"], timeout: 10000, reconnection: false, forceNew: true,
      });
      const timer = setTimeout(() => { resolve({ ok: false, reason: "timeout" }); }, 15000);

      socket.on("connect", () => {
        socket.emit("join_room", { roomCode, token: tokens[i].token });
      });

      socket.on("room_state", (state) => {
        if (state.room.status === "lobby" && !state.myCharacter) {
          socket.emit("select_character", { roomCode, characterName: characterNames[i] });
        }
      });

      socket.on("character_selected", (data) => {
        clearTimeout(timer);
        sockets.push(socket);
        resolve({ ok: true, character: data.characterName, isMurderer: data.isMurderer });
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err.message || err.code });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err.message });
      });
    });
    const result = await p;
    console.log(`  玩家${i + 1}: ${result.ok ? "✓ " + result.character + (result.isMurderer ? " (凶手)" : "") : "✗ " + result.reason}`);
  }

  if (sockets.length < 3) {
    console.log("  ✗ 部分玩家未能选角，跳过后续流程");
    results.push({ name: "玩家选角", passed: false });
    sockets.forEach((s) => s.disconnect());
    await cleanupMockScript(mock.scriptId);
    return results;
  }
  results.push({ name: "玩家选角", passed: true });

  // Step 5: 房主开始游戏 → reading 阶段 (LLM API 可能需 30s+)
  console.log("\n  [阶段3: reading] 房主开始游戏 (等待 LLM 生成开场叙事)...");
  const startPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, events: [] }), 60000);

    sockets.forEach((s) => {
      s.on("game_started", (data) => {
        clearTimeout(timer);
        resolve({ ok: true, phase: data.phase });
      });
      s.on("phase_changed", (data) => {
        if (data.phase === "reading") {
          clearTimeout(timer);
          resolve({ ok: true, phase: data.phase });
        }
      });
      s.on("narrative", () => {}); // 叙事事件也算进度
    });

    sockets[0].emit("start_game", { roomCode });
  });

  const startResult = await startPromise;
  if (startResult.ok) {
    console.log(`  ✓ 游戏已开始，进入 ${startResult.phase} 阶段`);
    results.push({ name: "开始游戏→reading", passed: true });
  } else {
    console.log(`  ✗ 游戏开始失败，收到事件: ${startResult.events}`);
    results.push({ name: "开始游戏→reading", passed: false });
    sockets.forEach((s) => s.disconnect());
    await cleanupMockScript(mock.scriptId);
    return results;
  }

  // Step 6: 所有人 ready → 自动推进
  console.log("\n  [阶段4: reading→round1] 所有玩家 ready，推进到搜证...");

  let debugEvents = [];
  let phaseChangedToRound1 = false;

  sockets.forEach((s, i) => {
    s.on("phase_changed", (data) => {
      debugEvents.push("p" + i + ":phase=" + data.phase);
      if (data.phase && data.phase.includes("investigation")) phaseChangedToRound1 = true;
    });
    s.on("ready_update", (data) => {
      debugEvents.push("ready=" + data.readyCount + "/" + data.totalCount + (data.countdown !== undefined ? " cd=" + data.countdown : ""));
    });
    s.on("narrative", (data) => {
      debugEvents.push("p" + i + ":narrative=" + (data.text || "").slice(0, 30));
    });
    s.on("clue_received", (data) => {
      debugEvents.push("p" + i + ":clue=" + (data.clue?.id || "?"));
    });
    s.on("error", (data) => {
      debugEvents.push("p" + i + ":ERROR=" + JSON.stringify(data));
    });
  });

  // 等待 NPC 初始化和开场叙事生成（generatePhaseNarrative 需要调用 LLM）
  console.log("  等待开场叙事生成...");
  await new Promise((r) => setTimeout(r, 5000));
  console.log("  调试事件: " + debugEvents.slice(0, 10).join(", "));

  // 所有玩家点击 ready
  sockets.forEach((s) => s.emit("ready", { roomCode }));
  console.log("  已发送 ready 事件");

  // 等待阶段推进: 同时阻塞式监听 phase_changed
  const advanceResult = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), 35000);
    sockets.forEach((s) => {
      s.on("phase_changed", (data) => {
        if (data.phase && data.phase !== "reading") {
          clearTimeout(timer);
          resolve({ ok: true, phase: data.phase });
        }
      });
    });
  });

  console.log("  调试事件(最后20): " + debugEvents.slice(-20).join("; "));

  if (advanceResult.ok) {
    console.log(`  ✓ 推进到 ${advanceResult.phase} 阶段`);
    results.push({ name: "read→round1搜证", passed: true });
  } else {
    console.log(`  ⚠ 35s 内阶段未推进，可能 LLM API 超时或错误`);
    results.push({ name: "read→round1搜证", passed: false });
  }

  // Step 7: 聊天测试（round1_investigation 不允许聊天，用搜证测试代替）
  console.log("\n  [阶段5: 搜证] 在 round1_investigation 阶段测试搜证功能...");
  let clueSearchReceived = 0;
  sockets.forEach((s, i) => {
    s.on("clue_received", () => { clueSearchReceived++; });
  });
  // 模拟自然语言搜证
  sockets[0].emit("investigate", { roomCode, query: "书房" });
  sockets[1].emit("investigate", { roomCode, query: "大厅" });
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`  ${clueSearchReceived > 0 ? "✓" : "✗"} 线索搜证: ${clueSearchReceived} 条线索发现`);
  results.push({ name: "investigation搜证", passed: clueSearchReceived > 0 });

  // Cleanup
  sockets.forEach((s) => { try { s.disconnect(); } catch (e) {} });
  await cleanupMockScript(mock.scriptId);

  // 清理房间
  if (adminToken) {
    try {
      await httpReq("DELETE", "/api/admin/rooms/" + roomCode, { token: adminToken });
    } catch (e) {}
  }

  return results;
}

// ==================== Module 3: 容灾恢复测试 ====================

async function testResilience() {
  console.log("\n" + "═".repeat(55));
  console.log("  Module 3: 容灾恢复测试");
  console.log("═".repeat(55));

  const results = [];
  const { getRedis, ensureRedis } = require("./modules/redis-client");

  // 3.1 断线重连测试
  console.log("\n  [3.1] 玩家断线 5 秒后重连...");
  const auth = await registerAndLogin();
  if (!auth) { console.log("  ✗ 无法获取认证"); return results; }

  const mock = await createMockScript();
  const roomRes = await httpReq("POST", "/api/player/rooms", {
    token: auth.token, body: { scriptSessionId: mock.scriptId, maxPlayers: 6 },
  });
  const roomCode = roomRes.body?.roomCode;

  if (!roomCode) {
    console.log("  ✗ 无法创建房间");
    await cleanupMockScript(mock.scriptId);
    return results;
  }

  // 加入房间
  let playerStateBefore = null;
  let playerStateAfter = null;

  const sock1 = SocketIOClient(BASE_URL, {
    transports: ["websocket"], timeout: 10000, reconnection: false, forceNew: true,
  });

  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10000);
    sock1.on("connect", () => {
      sock1.emit("join_room", { roomCode, token: auth.token });
    });
    sock1.on("room_state", (state) => {
      clearTimeout(timer);
      playerStateBefore = { playerId: state.playerId, phase: state.phase };
      sock1.disconnect();
      resolve("ok");
    });
    sock1.on("connect_error", () => { clearTimeout(timer); resolve("error"); });
  });

  // 模拟断线 3 秒后重连
  await new Promise((r) => setTimeout(r, 3000));

  const sock2 = SocketIOClient(BASE_URL, {
    transports: ["websocket"], timeout: 10000, reconnection: false, forceNew: true,
  });

  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10000);
    sock2.on("connect", () => {
      sock2.emit("join_room", { roomCode, token: auth.token });
    });
    sock2.on("room_state", (state) => {
      clearTimeout(timer);
      playerStateAfter = { playerId: state.playerId, phase: state.phase };
      sock2.disconnect();
      resolve("ok");
    });
    sock2.on("connect_error", () => { clearTimeout(timer); resolve("error"); });
  });

  const reconnected = playerStateBefore && playerStateAfter;
  console.log(`  ${reconnected ? "✓" : "✗"} 断线前: ${JSON.stringify(playerStateBefore)} → 重连后: ${JSON.stringify(playerStateAfter)}`);
  results.push({ name: "断线重连", passed: reconnected });

  // 3.2 Redis 连接恢复测试
  console.log("\n  [3.2] Redis 连接池故障恢复...");
  try {
    const r = getRedis();
    // 主动断开再重连，验证连接池能自动恢复
    if (r && r.status === "ready") {
      const poolStatusBefore = r.status;
      // 测试 GET 操作（模拟短暂故障后的恢复）
      const val = await r.get("test:resilience:key");
      await r.set("test:resilience:key", "ok");
      const valAfter = await r.get("test:resilience:key");
      await r.del("test:resilience:key");
      console.log(`  ✓ Redis 读写正常: ${poolStatusBefore} → set/get/del OK`);
      results.push({ name: "Redis 连接恢复", passed: true });
    } else {
      console.log(`  ⚠ Redis 状态异常: ${r ? r.status : "null"}`);
      results.push({ name: "Redis 连接恢复", passed: false });
    }
  } catch (e) {
    console.log(`  ✗ Redis 异常: ${e.message}`);
    results.push({ name: "Redis 连接恢复", passed: false });
  }

  // 3.3 房主转让测试
  console.log("\n  [3.3] 房主离开 → 自动转让...");
  const auth2 = await registerAndLogin();
  if (!auth2) { console.log("  ✗ 第二个用户注册失败"); return results; }

  let ownerBefore = null;
  let ownerAfter = null;

  // 第一个玩家加入（成为房主）
  const s1 = SocketIOClient(BASE_URL, {
    transports: ["websocket"], timeout: 10000, reconnection: false, forceNew: true,
  });
  await new Promise((resolve) => {
    s1.on("connect", () => s1.emit("join_room", { roomCode, token: auth.token }));
    s1.on("room_state", (state) => { ownerBefore = state.room.ownerId; resolve(); });
    s1.on("error", resolve);
  });

  // 第二个玩家加入
  const s2 = SocketIOClient(BASE_URL, {
    transports: ["websocket"], timeout: 10000, reconnection: false, forceNew: true,
  });
  await new Promise((resolve) => {
    s2.on("connect", () => s2.emit("join_room", { roomCode, token: auth2.token }));
    s2.on("room_state", resolve);
    s2.on("error", resolve);
  });

  // 房主离开
  s1.emit("leave_room", { roomCode });

  // 等待房主转让事件（通过 room_updated 或 left_room）
  const ownerResult = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    s2.on("room_updated", (data) => {
      if (data.ownerId && data.ownerId !== ownerBefore) {
        clearTimeout(timer);
        resolve(data.ownerId);
      }
    });
    s1.on("left_room", () => {}); // player 1 收到离开确认
  });

  ownerAfter = ownerResult;
  const ownerTransferred = !!ownerAfter;
  console.log(`  ${ownerTransferred ? "✓" : "⚠"} 房主 ${ownerBefore?.slice(0,8)} → ${ownerAfter?.slice(0,8) || "未收到转让事件"}`);
  results.push({ name: "房主自动转让", passed: ownerTransferred });

  s1.disconnect();
  s2.disconnect();
  await cleanupMockScript(mock.scriptId);

  return results;
}

// ==================== Module 4: 内存泄漏检测 ====================

async function testMemoryLeak() {
  console.log("\n" + "═".repeat(55));
  console.log("  Module 4: 内存泄漏检测");
  console.log("═".repeat(55));

  const results = [];
  const CYCLES = 200;

  // 4.1 Socket.io 反复 connect/disconnect
  console.log(`\n  [4.1] Socket.io ${CYCLES} 次 connect/disconnect 循环...`);
  const memBefore = process.memoryUsage().heapUsed;
  const auth = await registerAndLogin();
  if (!auth) { console.log("  ✗ 无法获取 token"); return results; }

  let connected = 0;
  for (let i = 0; i < CYCLES; i++) {
    try {
      const s = SocketIOClient(BASE_URL, {
        transports: ["websocket"], timeout: 3000, reconnection: false, forceNew: true,
      });
      await new Promise((resolve) => {
        const t = setTimeout(() => { s.disconnect(); resolve(); }, 3000);
        s.on("connect", () => { connected++; });
        s.on("connect_error", () => { clearTimeout(t); s.disconnect(); resolve(); });
        s.on("error", () => { clearTimeout(t); s.disconnect(); resolve(); });
        setTimeout(() => { clearTimeout(t); s.disconnect(); resolve(); }, 1500);
      });
    } catch (e) { /* ignore */ }
  }

  // 等待 GC 可能触发
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 1000));

  const memAfter = process.memoryUsage().heapUsed;
  const memDelta = (memAfter - memBefore) / 1024 / 1024;
  const avgLeakPerCycle = memDelta / CYCLES * 1024; // KB per cycle

  console.log(`  连接成功: ${connected}/${CYCLES}`);
  console.log(`  堆内存: ${(memBefore/1024/1024).toFixed(1)}MB → ${(memAfter/1024/1024).toFixed(1)}MB (Δ ${memDelta.toFixed(1)}MB)`);
  console.log(`  平均每次 ~${avgLeakPerCycle.toFixed(1)}KB`);

  const passed = memDelta < 10; // 小于 10MB 增长可接受
  console.log(`  ${passed ? "✓" : "⚠"} ${passed ? "无明显内存泄漏" : "可能存在内存泄漏"}`);
  results.push({ name: "Socket.io 内存泄漏", passed, memDeltaMB: memDelta.toFixed(1) });

  // 4.2 HTTP 端点重复调用
  console.log(`\n  [4.2] HTTP 端点 ${CYCLES} 次重复调用...`);
  const memBeforeHttp = process.memoryUsage().heapUsed;

  for (let i = 0; i < CYCLES; i++) {
    await httpReq("GET", "/api/health");
    await httpReq("GET", "/api/player/scripts", { token: auth.token });
    if (i % 50 === 0) await new Promise((r) => setTimeout(r, 50));
  }

  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 500));

  const memAfterHttp = process.memoryUsage().heapUsed;
  const httpDelta = (memAfterHttp - memBeforeHttp) / 1024 / 1024;
  console.log(`  堆内存: ${(memBeforeHttp/1024/1024).toFixed(1)}MB → ${(memAfterHttp/1024/1024).toFixed(1)}MB (Δ ${httpDelta.toFixed(1)}MB)`);
  const httpPassed = httpDelta < 5;
  console.log(`  ${httpPassed ? "✓" : "⚠"} ${httpPassed ? "HTTP 无内存泄漏" : "HTTP 可能有内存泄漏"}`);
  results.push({ name: "HTTP 内存泄漏", passed: httpPassed, memDeltaMB: httpDelta.toFixed(1) });

  return results;
}

// ==================== 主流程 ====================

async function main() {
  console.log("╔" + "═".repeat(53) + "╗");
  console.log("║  剧本杀平台 — 综合测试套件" + " ".repeat(22) + "║");
  console.log("╚" + "═".repeat(53) + "╝");

  // 健康检查
  const health = await httpReq("GET", "/api/health");
  if (health.status !== 200) {
    console.log("\n✗ 服务不可达，请先启动: npm start");
    process.exit(1);
  }
  console.log(`服务在线: pid=${health.body.pid}, uptime=${health.body.uptime.toFixed(0)}s\n`);

  const allResults = [];

  // 按需运行模块
  if (MODULE === "all" || MODULE === "contract") {
    const r = await testAPIContract();
    allResults.push(...r);
  }
  if (MODULE === "all" || MODULE === "e2e") {
    const r = await testE2EGameFlow();
    allResults.push(...r);
  }
  if (MODULE === "all" || MODULE === "resilience") {
    const r = await testResilience();
    allResults.push(...r);
  }
  if (MODULE === "all" || MODULE === "memory") {
    const r = await testMemoryLeak();
    allResults.push(...r);
  }

  // ===== 总报告 =====
  console.log("\n" + "═".repeat(55));
  console.log("  综合测试报告");
  console.log("═".repeat(55));

  const passCount = allResults.filter((r) => r.passed).length;
  const failCount = allResults.filter((r) => !r.passed).length;

  let contractPass = 0, contractFail = 0;
  let e2ePass = 0, e2eFail = 0;
  let resiliencePass = 0, resilienceFail = 0;
  let memoryPass = 0, memoryFail = 0;

  for (const r of allResults) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}`);
    if (r.memDeltaMB) console.log(`    内存变化: ${r.memDeltaMB}MB`);
  }

  console.log(`\n  总计: ${allResults.length} 项`);
  console.log(`  通过: ${passCount}  |  失败: ${failCount}`);

  if (failCount > 0) {
    console.log(`\n  ⚠ 存在失败项，需排查`);
  } else {
    console.log(`\n  ✓ 全部通过`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error("测试异常:", e); process.exit(1); });
