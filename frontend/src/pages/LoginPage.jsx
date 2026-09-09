import React, { useState } from "react";
import { api, apiJson, setAuth } from "../lib/api.js";

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
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: 20 }}>
      <div className="card card-static" style={{ width: 360, padding: 28 }}>
        <h2 style={{ margin: "0 0 20px", color: "var(--gold)", textAlign: "center" }}>🎭 剧本杀平台</h2>

        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          <button
            className={`btn ${mode === "login" ? "btn-primary" : "btn-outline"}`}
            style={{ flex: 1 }}
            onClick={() => { setMode("login"); setError(""); }}
          >
            登录
          </button>
          <button
            className={`btn ${mode === "register" ? "btn-primary" : "btn-outline"}`}
            style={{ flex: 1 }}
            onClick={() => { setMode("register"); setError(""); }}
          >
            注册
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>密码</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
            />
          </div>
          {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>
            {loading ? "处理中..." : (mode === "login" ? "登 录" : "注 册")}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: "center", fontSize: 12, color: "var(--dim)" }}>
          仍在使用旧版界面？<a href="/admin.html" style={{ color: "var(--gold-light)" }}>旧版管理端</a> · <a href="/player.html" style={{ color: "var(--gold-light)" }}>旧版玩家端</a>
        </div>
      </div>
    </div>
  );
}