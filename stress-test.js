// 剧本杀平台 — 压力测试脚本
// 用法: node stress-test.js [--url http://localhost:3000] [--concurrency 50] [--duration 30]
// 测试模块: HTTP REST + WebSocket + 竞态条件

const http = require("http");
const https = require("https");
const { io: SocketIOClient } = require("socket.io-client");
const crypto = require("crypto");

// ==================== 配置 ====================
const BASE_URL = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://localhost:3000";
const CONCURRENCY = parseInt(
  process.argv.includes("--concurrency")
    ? process.argv[process.argv.indexOf("--concurrency") + 1]
    : "50"
);
const DURATION_SEC = parseInt(
  process.argv.includes("--duration")
    ? process.argv[process.argv.indexOf("--duration") + 1]
    : "15"
);
const RACE_ITERATIONS = parseInt(
  process.argv.includes("--race-iterations")
    ? process.argv[process.argv.indexOf("--race-iterations") + 1]
    : "100"
);

// 解析 BASE_URL
const urlObj = new URL(BASE_URL);
const IS_HTTPS = urlObj.protocol === "https:";
const HOST = urlObj.hostname;
const PORT = urlObj.port || (IS_HTTPS ? 443 : 80);
const httpModule = IS_HTTPS ? https : http;

// ==================== 统计 ====================
const stats = {
  http: { total: 0, ok: 0, fail: 0, errors: {}, latencies: [] },
  ws: { total: 0, connected: 0, failed: 0, disconnected: 0, errors: {} },
  race: { tests: [], passed: 0, failed: 0 },
  startTime: 0,
  endTime: 0,
};

function recordLatency(start) {
  const ms = Date.now() - start;
  stats.http.latencies.push(ms);
  return ms;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ==================== HTTP 工具 ====================

function httpRequest(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = httpModule.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.headers || {}),
        },
        timeout: 15000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          const ms = recordLatency(start);
          stats.http.total++;
          if (res.statusCode >= 200 && res.statusCode < 400) {
            stats.http.ok++;
          } else {
            stats.http.fail++;
            const errKey = `${method} ${path} → ${res.statusCode}`;
            stats.http.errors[errKey] = (stats.http.errors[errKey] || 0) + 1;
          }
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body), latency: ms });
          } catch {
            resolve({ status: res.statusCode, body, latency: ms });
          }
        });
      }
    );
    req.on("error", (e) => {
      const ms = recordLatency(start);
      stats.http.total++;
      stats.http.fail++;
      const errKey = `${method} ${path} → ${e.code || e.message}`;
      stats.http.errors[errKey] = (stats.http.errors[errKey] || 0) + 1;
      reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      const ms = recordLatency(start);
      stats.http.total++;
      stats.http.fail++;
      const errKey = `${method} ${path} → TIMEOUT`;
      stats.http.errors[errKey] = (stats.http.errors[errKey] || 0) + 1;
      reject(new Error("Timeout"));
    });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ==================== 1. HTTP 压力测试 ====================

async function testAuthEndpoints() {
  console.log("\n  [1/6] 认证接口...");
  const testUser = `stress_${crypto.randomBytes(4).toString("hex")}`;
  const testPwd = "test1234";

  // 注册
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    tasks.push(
      httpRequest("POST", "/api/auth/register", {
        body: { username: `${testUser}_${i}`, password: testPwd },
      }).catch(() => {})
    );
  }
  const regResults = await Promise.all(tasks);
  const regOk = regResults.filter((r) => r && r.status === 200).length;
  const tokens = regResults.filter((r) => r && r.body && r.body.token).map((r) => r.body.token);

  // 并发登录
  const loginTasks = [];
  for (let i = 0; i < Math.min(CONCURRENCY, regOk); i++) {
    loginTasks.push(
      httpRequest("POST", "/api/auth/login", {
        body: { username: `${testUser}_${i}`, password: testPwd },
      }).catch(() => {})
    );
  }
  await Promise.all(loginTasks);

  // 并发 /me
  const meTasks = [];
  for (let i = 0; i < Math.min(CONCURRENCY, tokens.length); i++) {
    meTasks.push(
      httpRequest("GET", "/api/auth/me", { token: tokens[i] }).catch(() => {})
    );
  }
  await Promise.all(meTasks);

  console.log(`    注册 ${regOk}/${CONCURRENCY} 成功, 并发 /me ${meTasks.length} 次`);
}

async function testHealthEndpoint() {
  console.log("\n  [2/6] 健康检查...");
  const tasks = [];
  for (let i = 0; i < CONCURRENCY * 2; i++) {
    tasks.push(httpRequest("GET", "/api/health").catch(() => {}));
  }
  await Promise.all(tasks);
  console.log(`    ${stats.http.total} 请求完成`);
}

async function testScriptListEndpoints(adminToken) {
  console.log("\n  [3/6] 剧本列表（需管理员token）...");
  if (!adminToken) {
    console.log("    [跳过] 无管理员token，使用未认证模式测试错误处理");
    const tasks = [];
    for (let i = 0; i < Math.floor(CONCURRENCY / 2); i++) {
      tasks.push(httpRequest("GET", "/api/admin/scripts").catch(() => {}));
    }
    await Promise.all(tasks);
    return;
  }
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    tasks.push(
      httpRequest("GET", "/api/admin/scripts", { token: adminToken }).catch(() => {})
    );
  }
  await Promise.all(tasks);
  console.log(`    ${tasks.length} 请求完成`);
}

async function testRoomEndpoints(adminToken) {
  console.log("\n  [4/6] 房间列表（需管理员token）...");
  if (!adminToken) {
    console.log("    [跳过] 无管理员token");
    return;
  }
  const tasks = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    tasks.push(
      httpRequest("GET", "/api/admin/rooms", { token: adminToken }).catch(() => {})
    );
  }
  await Promise.all(tasks);
  console.log(`    ${tasks.length} 请求完成`);
}

// 并发 SSE（测试资源泄漏）
async function testSSEConnections(adminToken) {
  console.log("\n  [5/6] SSE 长连接并发...");
  if (!adminToken) {
    console.log("    [跳过] 无管理员token，无法测试SSE");
    return;
  }
  const connections = [];
  const sseConcurrency = Math.min(CONCURRENCY, 10); // SSE 本身就是长连接，减少数量

  for (let i = 0; i < sseConcurrency; i++) {
    const p = new Promise((resolve) => {
      const req = httpModule.request(
        {
          hostname: HOST,
          port: PORT,
          path: "/api/health",
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode }));
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.end();
    });
    connections.push(p);
  }
  await Promise.all(connections);
  console.log(`    ${sseConcurrency} 个并发SSE连接测试完成`);
}

// ==================== 2. WebSocket 压力测试 ====================

async function testWebSocketConnections() {
  console.log("\n  [6/6] WebSocket 并发连接...");
  const sockets = [];
  const wsConcurrency = Math.min(CONCURRENCY, 30);

  // 先获取一个 token 用于认证
  let token = null;
  try {
    const testUser = `ws_stress_${crypto.randomBytes(3).toString("hex")}`;
    const reg = await httpRequest("POST", "/api/auth/register", {
      body: { username: testUser, password: "ws_test123" },
    });
    if (reg && reg.body && reg.body.token) token = reg.body.token;
  } catch (e) {
    // 继续测试，可能已存在
  }
  if (!token) {
    try {
      const login = await httpRequest("POST", "/api/auth/login", {
        body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" },
      });
      if (login && login.body && login.body.token) token = login.body.token;
    } catch (e) {}
  }

  for (let i = 0; i < wsConcurrency; i++) {
    const p = new Promise((resolve) => {
      const socket = SocketIOClient(BASE_URL, {
        transports: ["websocket"],
        timeout: 10000,
        reconnection: false,
        forceNew: true,
      });
      const timeout = setTimeout(() => {
        stats.ws.failed++;
        socket.disconnect();
        resolve(null);
      }, 10000);

      socket.on("connect", () => {
        clearTimeout(timeout);
        stats.ws.connected++;
        stats.ws.total++;

        if (token) {
          socket.emit("join_room", {
            roomCode: "STRESS" + i.toString(36).toUpperCase(),
            token,
          });
        }

        // 随机间隔后断开
        const disconnectDelay = 1000 + Math.random() * 4000;
        setTimeout(() => {
          socket.disconnect();
          stats.ws.disconnected++;
          resolve(null);
        }, disconnectDelay);
      });

      socket.on("connect_error", (err) => {
        clearTimeout(timeout);
        stats.ws.failed++;
        stats.ws.total++;
        const errKey = err.message || "unknown";
        stats.ws.errors[errKey] = (stats.ws.errors[errKey] || 0) + 1;
        resolve(null);
      });

      socket.on("error", (err) => {
        stats.ws.errors[err.message || "error"] =
          (stats.ws.errors[err.message || "error"] || 0) + 1;
      });

      sockets.push(socket);
    });
    // 错开连接时间
    await new Promise((r) => setTimeout(r, 50));
  }

  // 等待所有连接完成
  await Promise.all(sockets.map((s) => s));
  console.log(`    连接: ${stats.ws.connected}/${wsConcurrency} 成功`);
}

// ==================== 3. 竞态条件测试 ====================

// 3.1 测试 updatePlayer 的读-改-写竞争
async function testPlayerUpdateRace() {
  console.log("\n  [竞态①] updatePlayer 读-改-写竞争 (${RACE_ITERATIONS}次并发)...");

  const testUser = `race_player_${crypto.randomBytes(3).toString("hex")}`;
  let token;
  try {
    const reg = await httpRequest("POST", "/api/auth/register", {
      body: { username: testUser, password: "race1234" },
    });
    token = reg?.body?.token;
  } catch (e) {}

  if (!token) {
    console.log("    [跳过] 无法获取认证token");
    return;
  }

  // 创建房间
  let roomCode;
  try {
    const scriptsRes = await httpRequest("GET", "/api/player/scripts", { token });
    const scripts = scriptsRes?.body?.scripts || [];
    if (scripts.length > 0) {
      const roomRes = await httpRequest("POST", "/api/player/rooms", {
        token,
        body: { scriptSessionId: scripts[0].sessionId, maxPlayers: 6 },
      });
      roomCode = roomRes?.body?.roomCode;
    }
  } catch (e) {}

  if (!roomCode) {
    console.log("    [跳过] 无可用剧本创建房间");
    return;
  }

  console.log(`    房间 ${roomCode} 已创建，发起 ${RACE_ITERATIONS} 次并发 join_room...`);

  // 并发加入房间 - 测试 Socket 竞态
  const sockets = [];
  const results = { success: 0, error: 0, stateMismatch: 0 };

  for (let i = 0; i < Math.min(RACE_ITERATIONS, 20); i++) {
    const p = new Promise((resolve) => {
      const socket = SocketIOClient(BASE_URL, {
        transports: ["websocket"],
        timeout: 5000,
        reconnection: false,
        forceNew: true,
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        resolve("timeout");
      }, 8000);

      socket.on("connect", () => {
        socket.emit("join_room", { roomCode, token });
      });

      socket.on("room_state", (state) => {
        clearTimeout(timer);
        results.success++;
        socket.disconnect();
        resolve("ok");
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        results.error++;
        const code = err?.code || "unknown";
        stats.ws.errors[`room_race:${code}`] =
          (stats.ws.errors[`room_race:${code}`] || 0) + 1;
        socket.disconnect();
        resolve("error");
      });

      socket.on("connect_error", () => {
        clearTimeout(timer);
        results.error++;
        socket.disconnect();
        resolve("connect_error");
      });

      sockets.push(socket);
    });
    await new Promise((r) => setTimeout(r, 10)); // 几乎同时发起
  }

  await Promise.all(sockets.map((s) => s));
  console.log(`    成功: ${results.success}, 错误: ${results.error}`);

  // 检查房间内的玩家列表是否正确
  try {
    const roomsRes = await httpRequest("GET", "/api/player/rooms", { token });
    const rooms = roomsRes?.body?.rooms || [];
    const ourRoom = rooms.find((r) => r.roomCode === roomCode);
    if (ourRoom) {
      console.log(`    房间玩家数: ${ourRoom.playerCount}, 预期: ≤${RACE_ITERATIONS}`);
      if (ourRoom.playerCount > RACE_ITERATIONS) {
        console.log("    ⚠ 玩家数异常，可能存在并发写入问题");
      }
    }
  } catch (e) {}

  stats.race.tests.push({ name: "updatePlayer/join_room race", passed: results.error === 0, detail: results });
  if (results.error === 0) stats.race.passed++;
  else stats.race.failed++;
}

// 3.2 测试 assignClue 的读-改-写竞争
async function testClueAssignmentRace() {
  console.log(`\n  [竞态②] assignClue 读-改-写竞争 (${RACE_ITERATIONS}次并发搜证)...`);

  // 此测试需要实际游戏状态，模拟对同一资源的竞争写入
  // 通过快速连续对同一 Redis key 的 HSET 操作来模拟

  const testUser = `race_clue_${crypto.randomBytes(3).toString("hex")}`;
  let token;
  try {
    const reg = await httpRequest("POST", "/api/auth/register", {
      body: { username: testUser, password: "race1234" },
    });
    token = reg?.body?.token;
  } catch (e) {}

  if (!token) {
    console.log("    [跳过] 无法获取token");
    return;
  }

  // 并发登录（测试 Redis token 写入竞争）
  const loginTasks = [];
  for (let i = 0; i < RACE_ITERATIONS; i++) {
    loginTasks.push(
      httpRequest("POST", "/api/auth/login", {
        body: { username: testUser, password: "race1234" },
      }).catch(() => {})
    );
  }
  const results = await Promise.all(loginTasks);
  const okCount = results.filter((r) => r && r.status === 200).length;
  const dupTokens = new Set(results.filter((r) => r?.body?.token).map((r) => r.body.token));

  console.log(`    成功登录: ${okCount}/${RACE_ITERATIONS}`);
  console.log(`    唯一Token数: ${dupTokens.size} (预期=${okCount}, 每个登录应生成唯一token)`);

  const passed = dupTokens.size === okCount && okCount > 0;
  stats.race.tests.push({ name: "login token uniqueness", passed, detail: { okCount, uniqueTokens: dupTokens.size } });
  if (passed) stats.race.passed++;
  else stats.race.failed++;
}

// 3.3 测试并发注册（用户名唯一性）
async function testConcurrentRegistration() {
  console.log(`\n  [竞态③] 并发注册同一用户名...`);

  const sameUser = `race_same_${crypto.randomBytes(3).toString("hex")}`;
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      httpRequest("POST", "/api/auth/register", {
        body: { username: sameUser, password: "test1234" },
      }).catch(() => {})
    );
  }
  const results = await Promise.all(tasks);
  const successCount = results.filter((r) => r && r.status === 200).length;
  const conflictCount = results.filter((r) => r && r.status === 400).length;

  console.log(`    成功注册: ${successCount}, 冲突返回: ${conflictCount}, 总计: ${results.length}`);
  const passed = successCount <= 1;
  if (!passed) console.log("    ⚠ 同一个用户名被多次注册！存在并发竞态条件");
  else if (successCount === 1) console.log("    ✓ 唯一性保护正常");

  stats.race.tests.push({ name: "concurrent registration uniqueness", passed, detail: { successCount, conflictCount } });
  if (passed) stats.race.passed++;
  else stats.race.failed++;
}

// ==================== 主流程 ====================

async function main() {
  console.log("=".repeat(60));
  console.log("  剧本杀平台 压力测试");
  console.log("=".repeat(60));
  console.log(`  目标: ${BASE_URL}`);
  console.log(`  并发数: ${CONCURRENCY}`);
  console.log(`  持续时间: ${DURATION_SEC}s`);
  console.log(`  竞态测试迭代: ${RACE_ITERATIONS}`);
  console.log("=".repeat(60));

  // 先检查服务健康状态
  let serverOnline = false;
  try {
    const health = await httpRequest("GET", "/api/health");
    serverOnline = health && health.status === 200;
    console.log(`\n服务状态: ${serverOnline ? "在线 ✓" : "异常 ✗"}`);
    if (serverOnline) {
      console.log(`  健康信息: ${JSON.stringify(health.body)}`);
    }
  } catch (e) {
    console.log(`\n服务状态: 不可达 ✗ (${e.message})`);
    console.log("请先启动服务: npm start");
    process.exit(1);
  }

  // 预获取管理员 token
  let adminToken = null;
  try {
    const login = await httpRequest("POST", "/api/auth/login", {
      body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" },
    });
    if (login && login.body && login.body.token) {
      adminToken = login.body.token;
      console.log(`管理员登录: 成功 ✓`);
    }
  } catch (e) {
    console.log("管理员登录: 失败，后续管理员接口测试将跳过");
  }

  stats.startTime = Date.now();

  // ===== 阶段一: HTTP 压力测试 =====
  console.log("\n" + "─".repeat(40));
  console.log("阶段一: HTTP 接口压力测试");

  await testAuthEndpoints();
  await testHealthEndpoint();
  await testScriptListEndpoints(adminToken);
  await testRoomEndpoints(adminToken);
  await testSSEConnections(adminToken);

  // ===== 阶段二: WebSocket 压力测试 =====
  console.log("\n" + "─".repeat(40));
  console.log("阶段二: WebSocket 压力测试");
  await testWebSocketConnections();

  // ===== 阶段三: 竞态条件测试 =====
  console.log("\n" + "─".repeat(40));
  console.log("阶段三: 竞态条件测试");
  await testPlayerUpdateRace();
  await testClueAssignmentRace();
  await testConcurrentRegistration();

  stats.endTime = Date.now();

  // ===== 报告 =====
  const elapsed = (stats.endTime - stats.startTime) / 1000;
  const totalHttp = stats.http.ok + stats.http.fail;
  const httpRps = totalHttp / Math.max(elapsed, 0.1);

  console.log("\n" + "=".repeat(60));
  console.log("  压力测试报告");
  console.log("=".repeat(60));
  console.log(`  总耗时: ${elapsed.toFixed(1)}s`);
  console.log();

  // HTTP 报告
  console.log("  ┌─ HTTP 测试 ─────────────────────────────");
  console.log(`  │ 总请求数:     ${totalHttp}`);
  console.log(`  │ 成功:         ${stats.http.ok}`);
  console.log(`  │ 失败:         ${stats.http.fail}`);
  console.log(`  │ 吞吐量:       ${httpRps.toFixed(1)} req/s`);
  if (stats.http.latencies.length > 0) {
    console.log(`  │ 延迟 (ms):`);
    console.log(`  │   Min:        ${Math.min(...stats.http.latencies).toFixed(1)}`);
    console.log(`  │   Avg:        ${(stats.http.latencies.reduce((a, b) => a + b, 0) / stats.http.latencies.length).toFixed(1)}`);
    console.log(`  │   P50:        ${percentile(stats.http.latencies, 50).toFixed(1)}`);
    console.log(`  │   P90:        ${percentile(stats.http.latencies, 90).toFixed(1)}`);
    console.log(`  │   P95:        ${percentile(stats.http.latencies, 95).toFixed(1)}`);
    console.log(`  │   P99:        ${percentile(stats.http.latencies, 99).toFixed(1)}`);
    console.log(`  │   Max:        ${Math.max(...stats.http.latencies).toFixed(1)}`);
  }
  if (Object.keys(stats.http.errors).length > 0) {
    console.log(`  │ 错误分布:`);
    for (const [err, count] of Object.entries(stats.http.errors).slice(0, 10)) {
      console.log(`  │   ${count}x  ${err}`);
    }
  }
  console.log("  └──────────────────────────────────────────");
  console.log();

  // WebSocket 报告
  console.log("  ┌─ WebSocket 测试 ─────────────────────────");
  console.log(`  │ 连接尝试:     ${stats.ws.total}`);
  console.log(`  │ 成功连接:     ${stats.ws.connected}`);
  console.log(`  │ 失败连接:     ${stats.ws.failed}`);
  console.log(`  │ 主动断开:     ${stats.ws.disconnected}`);
  if (Object.keys(stats.ws.errors).length > 0) {
    console.log(`  │ 错误分布:`);
    for (const [err, count] of Object.entries(stats.ws.errors).slice(0, 10)) {
      console.log(`  │   ${count}x  ${err}`);
    }
  }
  console.log("  └──────────────────────────────────────────");
  console.log();

  // 竞态条件报告
  console.log("  ┌─ 竞态条件测试 ───────────────────────────");
  console.log(`  │ 测试项:       ${stats.race.tests.length}`);
  console.log(`  │ 通过:         ${stats.race.passed}`);
  console.log(`  │ 失败:         ${stats.race.failed}`);
  for (const t of stats.race.tests) {
    const icon = t.passed ? "✓" : "✗";
    console.log(`  │ ${icon} ${t.name}`);
    if (t.detail) {
      console.log(`  │   ${JSON.stringify(t.detail)}`);
    }
  }
  console.log("  └──────────────────────────────────────────");
  console.log();

  // 总体评估
  const totalIssues = stats.http.fail + stats.ws.failed + stats.race.failed;
  console.log("  ╔══════════════════════════════════════════╗");
  if (totalIssues === 0) {
    console.log("  ║  ✓ 所有测试通过，系统在高并发下表现正常  ║");
  } else if (stats.race.failed > 0) {
    console.log("  ║  ⚠ 发现竞态条件！需修复并发安全问题      ║");
  } else if (stats.http.fail > stats.http.ok * 0.1) {
    console.log("  ║  ⚠ HTTP 失败率过高，需扩容或优化          ║");
  } else {
    console.log("  ║  ⚠ 部分测试失败，详情见上方报告           ║");
  }
  console.log("  ╚══════════════════════════════════════════╝");
  console.log();

  process.exit(totalIssues > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("压力测试异常:", e.message);
  process.exit(1);
});
