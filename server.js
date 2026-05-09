// 剧本杀平台 — 入口文件

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
require("dotenv").config();

const { initAdmin } = require("./modules/auth");
const { setupAuthRoutes, authMiddleware, adminMiddleware } = require("./routes/auth");
const { setupAdminRoutes } = require("./routes/admin");
const { setupPlayerRoutes } = require("./routes/player");
const { setupGameSocket } = require("./socket/game");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, pingTimeout: 60000, pingInterval: 25000 });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => { res.set("Cache-Control", "no-cache, no-store, must-revalidate"); }
}));
app.get("/", (req, res) => res.redirect("/login.html"));

// 挂载路由
setupAuthRoutes(app);
setupAdminRoutes(app, authMiddleware, adminMiddleware, io);
setupPlayerRoutes(app, authMiddleware);

// 挂载 WebSocket
setupGameSocket(io);

// 全局未处理拒接静默（Redis 不可用时避免崩溃）
process.on("unhandledRejection", (err) => {
  if (err && err.message && (err.message.includes("Redis") || err.message.includes("ECONNREFUSED") || err.message.includes("CLOSED"))) return;
  console.error("[unhandled]", err);
});

// 启动
(async () => {
  try { await initAdmin(); } catch (e) { console.log("[warn] Redis不可用，使用内存模式"); }
  server.listen(PORT, () => {
    console.log(`\n  剧本杀平台已启动: http://localhost:${PORT}`);
    console.log(`  默认管理员: admin / admin123\n`);
  });
})();
