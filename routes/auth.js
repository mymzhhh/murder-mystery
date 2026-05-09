// Auth routes + middleware

const { register, login, verifyToken, logout } = require("../modules/auth");

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "未登录" });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: "登录已过期" });
  req.user = user;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "需要管理员权限" });
  next();
}

function setupAuthRoutes(app) {
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "用户名和密码不能为空" });
      if (username.length < 2 || password.length < 4) return res.status(400).json({ error: "用户名至少2位，密码至少4位" });
      const result = await register(username, password);
      if (!result.ok) return res.status(400).json({ error: result.message });
      res.json({ token: result.token, role: result.role, username: result.username });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "请输入用户名和密码" });
      const result = await login(username, password);
      if (!result.ok) return res.status(401).json({ error: result.message });
      res.json({ token: result.token, role: result.role, username: result.username });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/auth/me", authMiddleware, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  app.post("/api/auth/logout", authMiddleware, (req, res) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    logout(token);
    res.json({ success: true });
  });
}

module.exports = { setupAuthRoutes, authMiddleware, adminMiddleware };
