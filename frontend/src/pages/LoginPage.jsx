import React, { useState } from "react";
import { apiJson, setAuth } from "../lib/api.js";

/** 登录 / 注册。
 *
 *  这是产品的门面，所以用整幅场景图（本地 ComfyUI 生成的雨夜书桌）打底 +
 *  左侧压暗，卡片压在暗部上 —— 而不是把图调亮再糊一层颜色。
 *  表单沿用全局 .form-input，不再写内联样式。 */
export default function LoginPage({ onLogin }) {
  const [mode, setMode] = useState("login"); // login | register
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const d = await apiJson(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (d && d.token) {
        // 后端返回 { token, role, username }
        setAuth(d.token, { username: d.username || username, role: d.role || "player" });
        onLogin();
      } else {
        setError(d && d.error ? d.error : "登录失败，请重试");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrapper">
      <div className="login-bg" aria-hidden="true" />

      <div className="login-card">
        <div className="login-brand">
          <div className="login-seal" aria-hidden="true">案</div>
          <h1>剧本杀</h1>
          <p className="subtitle">MURDER MYSTERY STUDIO</p>
        </div>

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={`tab ${mode === "login" ? "active" : ""}`}
            onClick={() => { setMode("login"); setError(""); }}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={`tab ${mode === "register" ? "active" : ""}`}
            onClick={() => { setMode("register"); setError(""); }}
          >
            注册
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="form-group">
            <label htmlFor="login-username">用户名</label>
            <input
              id="login-username"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoComplete="username"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              className="form-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>

          {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error}</div>}

          <button className={`btn btn-primary ${loading ? "btn-loading" : ""}`} disabled={loading}>
            {loading ? "处理中" : (mode === "login" ? "登 录" : "注 册")}
          </button>
        </form>

        <p className="login-foot">
          管理员登录后进入管理端，普通玩家自动进入玩家端
        </p>
      </div>
    </div>
  );
}
