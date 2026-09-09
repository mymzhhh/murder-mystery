import React, { useState, useEffect } from "react";
import { apiJson, api } from "../lib/api.js";

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  async function load() {
    try { const d = await apiJson("/api/admin/users"); setUsers(d.users || []); } catch (e) { alert(e.message); }
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

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 16 }}>
        <strong style={{ color: "var(--gold)" }}>用户管理</strong>
        <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--dim)", fontSize: 13, borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "8px 6px" }}>用户名</th>
              <th style={{ padding: "8px 6px" }}>角色</th>
              <th style={{ padding: "8px 6px" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "8px 6px" }}>{u.username}</td>
                <td style={{ padding: "8px 6px" }}>
                  <span className={`tag ${u.role === "admin" ? "tag-admin" : "tag-player"}`}>{u.role === "admin" ? "管理员" : "玩家"}</span>
                </td>
                <td style={{ padding: "8px 6px" }}>
                  <button className="btn btn-outline btn-xs" style={{ marginRight: 6 }}
                    onClick={() => toggleRole(u.username, u.role === "admin" ? "player" : "admin")}>
                    设为{u.role === "admin" ? "玩家" : "管理员"}
                  </button>
                  <button className="btn btn-danger btn-xs" onClick={() => del(u.username)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}