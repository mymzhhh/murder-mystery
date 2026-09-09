import React, { useState, useEffect } from "react";
import { apiJson, api } from "../lib/api.js";

export default function RoomsPage() {
  const [rooms, setRooms] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [scriptSelect, setScriptSelect] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(6);

  async function loadRooms() {
    try { const d = await apiJson("/api/admin/rooms"); setRooms(d.rooms || []); } catch (e) { /* ignore */ }
  }
  async function loadScripts() {
    try { const d = await apiJson("/api/admin/scripts?pageSize=100"); setScripts(d.scripts || d.list || []); } catch (e) { /* ignore */ }
  }
  useEffect(() => { loadRooms(); loadScripts(); }, []);

  async function createRoom() {
    if (!scriptSelect) { alert("请选择剧本"); return; }
    try {
      const d = await apiJson("/api/admin/rooms", {
        method: "POST", body: JSON.stringify({ scriptSessionId: scriptSelect, maxPlayers: Number(maxPlayers) }),
      });
      alert(`房间已创建：${d.roomCode}（${d.characterCount}个角色）`);
      setScriptSelect("");
      loadRooms();
    } catch (e) { alert("创建失败: " + e.message); }
  }

  async function closeRoom(code) {
    if (!confirm(`确定关闭房间 ${code}？`)) return;
    try { await api(`/api/admin/rooms/${code}`, { method: "DELETE" }); loadRooms(); } catch (e) { alert(e.message); }
  }

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
        <div className="panel" style={{ padding: 16 }}>
          <strong style={{ color: "var(--gold)" }}>创建房间</strong>
          <div className="form-group" style={{ marginTop: 10 }}>
            <label>选择剧本</label>
            <select className="form-select" value={scriptSelect} onChange={(e) => setScriptSelect(e.target.value)}>
              <option value="">-- 选择剧本 --</option>
              {scripts.map((s) => (
                <option key={s.sessionId || s.id} value={s.sessionId || s.id}>{s.topic || s.title || "未命名"}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>最大玩家数</label>
            <input type="number" className="form-input" value={maxPlayers} min={3} max={8} onChange={(e) => setMaxPlayers(e.target.value)} />
          </div>
          <button className="btn btn-success" onClick={createRoom}>创建房间</button>
        </div>

        <div className="panel" style={{ padding: 16 }}>
          <strong style={{ color: "var(--gold)" }}>活跃房间</strong>
          <div style={{ marginTop: 10 }}>
            {rooms.length === 0 && <div className="state-empty">暂无活跃房间</div>}
            {rooms.map((r) => (
              <div key={r.roomCode} className="card card-static" style={{ marginBottom: 8, padding: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{r.scriptTitle || "未命名"}</strong> <span className="tag">{r.roomCode}</span>
                    <div className="text-xs text-dim">{r.playerCount}人 | {r.phase || r.status}</div>
                  </div>
                  <button className="btn btn-outline btn-xs" onClick={() => closeRoom(r.roomCode)}>关闭</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}