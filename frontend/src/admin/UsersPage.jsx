import React, { useState, useEffect } from "react";
import { apiJson, api } from "../lib/api.js";

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  async function load() {
    setLoading(true);
    try { const d = await apiJson("/api/admin/users"); setUsers(d.users || []); }
    catch (e) { alert(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function toggleRole(name, role) {
    if (!confirm(`将用户「${name}」角色改为 ${role}？`)) return;
    try { await api(`/api/admin/users/${encodeURIComponent(name)}/role`, { method: "PUT", body: JSON.stringify({ role }) }); load(); } catch (e) { alert(e.message); }
  }
  async function del(name) {
    if (!confirm(`删除用户「${name}」？`)) return;
    try { await api(`/api/admin/users/${encodeURIComponent(name)}`, { method: "DELETE" }); load(); } catch (e) { alert(e.message); }
  }

  const kw = q.trim().toLowerCase();
  const shown = kw ? users.filter((u) => String(u.username || "").toLowerCase().includes(kw)) : users;
  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>用户管理</h2>
          <p>共 {users.length} 个账号，其中 {adminCount} 个管理员。角色切换立即生效，被删账号的登录令牌会一并撤销。</p>
        </div>
        <div className="page-head-actions">
          <input
            className="form-input form-input-sm"
            style={{ width: 220 }}
            placeholder="搜索用户名…"
            aria-label="搜索用户名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-outline btn-sm" onClick={load}>↻ 刷新</button>
        </div>
      </div>

      <div className="panel">
        {loading && <div className="state-loading">加载中…</div>}
        {!loading && shown.length === 0 && (
          <div className="state-empty">{kw ? `没有匹配「${q}」的用户` : "还没有任何用户"}</div>
        )}
        {!loading && shown.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>用户名</th>
                <th style={{ width: 110 }}>角色</th>
                <th style={{ width: 220 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u, i) => (
                <tr key={u.username}>
                  <td className="text-muted" style={{ fontFamily: "var(--font-mono)" }}>{i + 1}</td>
                  <td>{u.username}</td>
                  <td>
                    <span className={`tag ${u.role === "admin" ? "tag-admin" : "tag-player"}`}>
                      {u.role === "admin" ? "管理员" : "玩家"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-outline btn-xs" onClick={() => toggleRole(u.username, u.role === "admin" ? "player" : "admin")}>
                        设为{u.role === "admin" ? "玩家" : "管理员"}
                      </button>
                      <button className="btn btn-danger btn-xs" onClick={() => del(u.username)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
