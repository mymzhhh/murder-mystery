// 剧本杀平台 — 入口文件
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { initAdmin } = require("./core/auth");
const { initDB } = require("./core/db");
const { setupAuthRoutes, authMiddleware, adminMiddleware } = require("./routes/auth");
const { setupAdminRoutes } = require("./routes/admin");
const { setupPlayerRoutes } = require("./routes/player");
const { setupScriptImageRoutes } = require("./routes/script-images");
const { setupGameSocket } = require("./socket/game");

const app = express();
const server = http.createServer(app);
// CORS 可通过环境变量配置（逗号分隔多来源），默认 "*"（同源部署无需改动）
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CORS_ORIGINS = CORS_ORIGIN === "*" ? null : CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS || "*",
    methods: ["GET", "POST"],
  },
  // 纯 WebSocket 握手不受 CORS 约束（浏览器不会拦），所以只配 cors.origin 挡不住它 ——
  // 必须自己看 Origin。默认 "*" 时保持宽松（本机/内网部署），一旦显式配了 CORS_ORIGIN 就严格按它校验。
  allowRequest: (req, callback) => {
    if (!CORS_ORIGINS) return callback(null, true);
    const origin = req.headers.origin || "";
    // 无 Origin 的是非浏览器客户端（脚本），它们本来就不受 CORS 保护，鉴权靠事件里的 token
    callback(null, !origin || CORS_ORIGINS.includes(origin));
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,       // 1MB 上限，防止大 payload 攻击
  connectTimeout: 10000,
});
const PORT = process.env.PORT || 3000;

// ===== 全局中间件 =====

// 安全响应头。
// 不引 helmet：CSP 一旦写错会直接打断语音（blob: 音频、ws: 长连接），而这里没法用真实浏览器回归，
// 所以显式列出本应用确实需要的策略，宁可精确也不留"配了但没验证过"的东西。
// 已确认前端不引用任何外部资源（无 CDN 字体/脚本/图片），因此 default-src 'self' 是安全的。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // React 内联 style 属性
  "img-src 'self' data:",
  "media-src 'self' blob:",             // 自检页的提示音走 blob: URL
  "connect-src 'self' ws: wss:",        // socket.io
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",             // 防点击劫持（等价于 X-Frame-Options）
].join("; ");
app.use((req, res, next) => {
  res.set("Content-Security-Policy", CSP);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "no-referrer");
  res.removeHeader("X-Powered-By");     // 不必告诉别人我们是 Express
  next();
});

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
  // 全局请求超时 30s；SSE 长连接（剧本生成流水线等）除外——
  // 生成期间每次 LLM 调用有 30-90s 无输出，空闲超时会把连接杀掉（前端会报 network error）
  if (!String(req.headers.accept || "").includes("text/event-stream")) {
    res.setTimeout(30000, () => {
      if (!res.headersSent) {
        res.status(504).json({ error: "请求超时" });
      }
    });
  }
  next();
});

app.use(express.json({ limit: "5mb" }));
// 静态资源目录（React 构建产物由下方 /assets 提供；public/ 现仅作占位，旧前端已下线）
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res) => { res.set("Cache-Control", "no-cache, no-store, must-revalidate"); }
}));

// 旧版入口兼容：旧书签/外链重定向到 React 版
app.get("/admin.html", (req, res) => res.redirect(301, "/admin"));
app.get("/player.html", (req, res) => res.redirect(301, "/player"));
app.get("/login.html", (req, res) => res.redirect(301, "/"));

// ===== React 前端（Vite 构建产物） =====
// 构建：npm run build:web → frontend/dist/ → 部署时拷贝到容器
// 兼容两种布局：/app/frontend/dist（标准）或 /app/frontend（直接含 index.html）
// 旧版页面保留在 /admin.html /player.html /login.html（public/），
// 新版入口：/admin（管理端）、/player（玩家端）
const fs = require("fs");
const distPath = path.join(__dirname, "..", "frontend", "dist");
const distPathAlt = path.join(__dirname, "..", "frontend");
const reactDist = fs.existsSync(path.join(distPath, "index.html"))
  ? distPath
  : (fs.existsSync(path.join(distPathAlt, "index.html")) ? distPathAlt : null);
if (reactDist) {
  // 带内容哈希的构建产物可以放心长缓存
  app.use("/assets", express.static(path.join(reactDist, "assets"), {
    setHeaders: (res) => { res.set("Cache-Control", "public, max-age=31536000, immutable"); }
  }));

  // 入口 HTML 必须**绝不缓存**。
  //
  // 踩过的坑：这里原来是裸的 res.sendFile()，Express 默认发 `public, max-age=0`。
  // 正常导航时浏览器会回源校验，但 Chrome **恢复标签页**时是直接吃磁盘缓存的 HTML、
  // 不回源 —— 于是它拿着旧 HTML 去请求一个已被新构建替换掉的
  // /assets/index-<旧哈希>.js，拿到 404，React 从不执行，页面就是一块纯黑。
  //
  // 这个现象很有误导性：CSS 文件的哈希长期不变（改的只是 JS），所以它仍能加载，
  // 结果是"有深色背景、但没有任何内容"，看起来像前端崩了，其实是入口 HTML 过期。
  //
  // no-store 让入口 HTML 永远新鲜，静态产物靠内容哈希长缓存 —— 两者配合才是对的。
  const sendAppHtml = (res) =>
    res.sendFile(path.join(reactDist, "index.html"), {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });

  // React 入口页（SPA）
  app.get("/admin", (req, res) => sendAppHtml(res));
  app.get("/player", (req, res) => sendAppHtml(res));
}

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
app.use("/api/admin/scripts/:id/review-split", generationLimiter);

app.get("/", (req, res) => res.redirect("/admin"));

// 健康检查
// 健康检查：仅返回最小必要信息（不暴露 pid/内存细节/连接串，减少信息泄漏面）
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    updatedAt: new Date().toISOString(),
  });
});

// 挂载路由
setupAuthRoutes(app);
setupAdminRoutes(app, authMiddleware, adminMiddleware, io);
setupScriptImageRoutes(app);   // 剧本配图：GET /api/scripts/:id/images(/[:key])，刻意匿名（见文件头注释）
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
    const { getRedis } = require("./core/redis-client");
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
  // PG 异步同步对账：Redis 已切分但 PG 缺失/挂起的剧本重新入队（不阻塞启动）
  try {
    const { reconcileOnStart } = require("./core/pg-sync");
    reconcileOnStart();
  } catch (e) { console.warn("[warn] PG 同步对账失败:", e.message); }
  // 房间生命周期：启动自愈（清掉上次运行残留的"幽灵连接"）+ 定期回收过期/无人房间。
  // 不 await，避免 Redis 慢时拖住启动；扫描器自身有 try/catch。
  try {
    const { startRoomSweeper } = require("./game/room-lifecycle");
    startRoomSweeper().catch((e) => console.warn("[rooms] 启动扫描失败:", e.message));
  } catch (e) { console.warn("[rooms] 生命周期模块加载失败:", e.message); }
  // 测试剧本：把重启前还在跑的测试局接上。
  // 计时器是进程内的，重启后全丢；登记在 Redis 里还在 —— 不恢复的话，
  // 管理员看到的是"房间还在、但永远不推进"的一局，只能手工收拾。
  try {
    const { resumeTestRuns } = require("./socket/test-run");
    resumeTestRuns(io).catch((e) => console.warn("[test-run] 恢复失败:", e.message));
  } catch (e) { console.warn("[test-run] 恢复模块加载失败:", e.message); }
  server.listen(PORT, () => {
    console.log(`\n  剧本杀平台已启动: http://localhost:${PORT}`);
    console.log(`  管理员账号: admin（密码由 ADMIN_PASSWORD 环境变量或默认值配置）`);
    console.log(`  限流: 200 req/min 全局 | 20 req/min 认证\n`);
  });
})();
