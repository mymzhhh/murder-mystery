// 剧本杀平台 — 入口文件
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { initAdmin } = require("./modules/auth");
const { initDB } = require("./modules/db");
const { setupAuthRoutes, authMiddleware, adminMiddleware } = require("./routes/auth");
const { setupAdminRoutes } = require("./routes/admin");
const { setupPlayerRoutes } = require("./routes/player");
const { setupGameSocket } = require("./socket/game");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,       // 1MB 上限，防止大 payload 攻击
  connectTimeout: 10000,
});
const PORT = process.env.PORT || 3000;

// ===== 全局中间件 =====

// 请求日志（含耗时）
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = ms > 3000 ? "warn" : ms > 1000 ? "info" : "debug";
    if (level !== "debug") {
      console.log(`[${level}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  // 全局请求超时 30s
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: "请求超时" });
    }
  });
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => { res.set("Cache-Control", "no-cache, no-store, must-revalidate"); }
}));

// 全局限流
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 分钟窗口
  max: 200,                       // 每 IP 每分钟最多 200 请求
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "请求过于频繁，请稍后再试" },
});
app.use("/api/", globalLimiter);

// 认证接口限流（防暴力破解）
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,  // 成功后不计数
  message: { error: "登录/注册尝试过于频繁，请1分钟后再试" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

// 生成类 API 严格限流（消耗 LLM 配额）
const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "剧本生成请求过于频繁，请1分钟后再试" },
});
app.use("/api/admin/scripts/generate", generationLimiter);
app.use("/api/admin/pipeline/run", generationLimiter);
app.use("/api/admin/scripts/:id/review-revise", generationLimiter);

app.get("/", (req, res) => res.redirect("/login.html"));

// 健康检查
app.get("/api/health", (req, res) => {
  const redis = require("./modules/redis-client");
  res.json({
    status: "ok",
    redisUrl: process.env.REDIS_URL ? process.env.REDIS_URL.replace(/\/\/.*@/, "//***@") : "NOT SET",
    railwayEnv: !!process.env.RAILWAY_ENVIRONMENT,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pid: process.pid,
  });
});

// 挂载路由
setupAuthRoutes(app);
setupAdminRoutes(app, authMiddleware, adminMiddleware, io);
setupPlayerRoutes(app, authMiddleware);

// 挂载 WebSocket
setupGameSocket(io);

// ===== 错误处理 =====

// SSE/长连接超时静默处理
process.on("unhandledRejection", (err) => {
  if (err && err.message) {
    const msg = err.message;
    if (msg.includes("Redis") || msg.includes("ECONNREFUSED") || msg.includes("CLOSED")) return;
    if (msg.includes("aborted") || msg.includes("socket") || msg.includes("write after end")) return;
  }
  console.error("[unhandled]", err);
});

// 未捕获异常：记录后优雅退出
process.on("uncaughtException", (err) => {
  console.error("[fatal]", err);
  // Socket.io 偶尔会抛出这些无害异常
  if (err.message && (err.message.includes("Invalid WebSocket frame") || err.message.includes("parser error"))) {
    return;
  }
  gracefulShutdown(1);
});

// ===== 优雅关闭 =====
let shuttingDown = false;
async function gracefulShutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[shutdown] 正在关闭服务...");

  // 停止接受新连接
  server.close(() => console.log("[shutdown] HTTP 服务已关闭"));
  io.close(() => console.log("[shutdown] WebSocket 服务已关闭"));

  // 关闭 Redis 连接
  try {
    const { getRedis } = require("./modules/redis-client");
    const r = getRedis();
    if (r) await r.quit();
  } catch (e) { /* ignore */ }

  setTimeout(() => process.exit(code), 3000);
}

process.on("SIGTERM", () => gracefulShutdown(0));
process.on("SIGINT", () => gracefulShutdown(0));

// ===== 启动 =====
(async () => {
  try { await initDB(); } catch (e) { console.log("[warn] PostgreSQL 初始化失败:", e.message); }
  try { await initAdmin(); } catch (e) { console.log("[warn] Redis不可用，使用内存模式"); }
  server.listen(PORT, () => {
    console.log(`\n  剧本杀平台已启动: http://localhost:${PORT}`);
    console.log(`  管理员账号: admin（密码由 ADMIN_PASSWORD 环境变量或默认值配置）`);
    console.log(`  限流: 200 req/min 全局 | 20 req/min 认证\n`);
  });
})();
