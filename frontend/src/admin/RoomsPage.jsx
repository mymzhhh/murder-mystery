import React, { useState, useEffect } from "react";
import { apiJson, api } from "../lib/api.js";

const PHASE_TEXT = {
  lobby: "等待开局", reading: "阅读剧本", intro: "自我介绍",
  round1: "第一轮搜证", round2: "第二轮搜证", voting: "投票指控",
  truth_reveal: "真相复盘", finished: "已结束",
};

export default function RoomsPage() {
  const [rooms, setRooms] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [scriptSelect, setScriptSelect] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);

  async function loadRooms() {
    try { const d = await apiJson("/api/admin/rooms"); setRooms(d.rooms || []); } catch (e) { /* ignore */ }
  }
  async function loadScripts() {
    try { const d = await apiJson("/api/admin/scripts?pageSize=100"); setScripts(d.scripts || d.list || []); } catch (e) { /* ignore */ }
  }
  useEffect(() => { loadRooms(); loadScripts(); }, []);

  async function createRoom() {
    if (!scriptSelect) { alert("请选择剧本"); return; }
    setCreating(true);
    try {
      const d = await apiJson("/api/admin/rooms", {
        method: "POST", body: JSON.stringify({ scriptSessionId: scriptSelect, maxPlayers: Number(maxPlayers) }),
      });
      // 原实现用 alert 弹房号，关掉之后就再也找不回来了 —— 改成页内常驻的提示条
      setCreated({ roomCode: d.roomCode, characterCount: d.characterCount });
      setScriptSelect("");
      loadRooms();
    } catch (e) { alert("创建失败: " + e.message); }
    finally { setCreating(false); }
  }

  async function closeRoom(code) {
    if (!confirm(`确定关闭房间 ${code}？`)) return;
    try { await api(`/api/admin/rooms/${code}`, { method: "DELETE" }); loadRooms(); } catch (e) { alert(e.message); }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>房间管理</h2>
          <p>用已切分的剧本开局，把房号发给玩家即可加入。</p>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-outline btn-sm" onClick={loadRooms}>↻ 刷新</button>
        </div>
      </div>

      {created && (
        <div className="panel" style={{ borderColor: "var(--brass-line)" }}>
          <div className="panel-head">
            <strong>✓ 房间已创建</strong>
            <span className="text-xs text-dim">{created.characterCount} 个角色</span>
            <button className="btn btn-outline btn-xs" style={{ marginLeft: "auto" }} onClick={() => setCreated(null)}>关闭</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="room-code-lg" style={{ fontSize: 26, padding: "6px 20px" }}>{created.roomCode}</span>
            <button
              className="btn btn-outline btn-sm btn-auto"
              onClick={async () => { try { await navigator.clipboard.writeText(created.roomCode); } catch (e) { /* 剪贴板不可用就算了 */ } }}
            >
              复制房号
            </button>
            <span className="text-xs text-dim">把它发给玩家，他们在玩家端「加入房间」里输入即可。</span>
          </div>
        </div>
      )}

      <div className="auto-cols-narrow">
        <div className="panel">
          <div className="panel-head">
            <strong>创建房间</strong>
          </div>
          <div className="form-group">
            <label htmlFor="room-script">剧本</label>
            <select id="room-script" className="form-select" value={scriptSelect} onChange={(e) => setScriptSelect(e.target.value)}>
              <option value="">— 选择剧本 —</option>
              {scripts.map((s) => (
                <option key={s.sessionId || s.id} value={s.sessionId || s.id}>
                  {s.topic || s.title || "未命名"}{s.characterCount ? `（${s.characterCount} 角色）` : ""}
                </option>
              ))}
            </select>
            {scripts.length === 0 && (
              <div className="form-hint">还没有已切分的剧本，先去「剧本生成」跑一版。</div>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="room-max">最大玩家数</label>
            <input id="room-max" type="number" className="form-input" value={maxPlayers} min={3} max={8}
              onChange={(e) => setMaxPlayers(e.target.value)} />
            <div className="form-hint">3–8 人。不足的位置会由 AI 玩家补上。</div>
          </div>
          <button className="btn btn-primary" disabled={creating || !scriptSelect} onClick={createRoom}>
            {creating ? "创建中…" : "创建房间"}
          </button>
        </div>

        <div className="panel">
          <div className="panel-head">
            <strong>活跃房间</strong>
            {rooms.length > 0 && <span className="tag tag-success" style={{ marginLeft: 4 }}>{rooms.length} 个</span>}
          </div>
          <div className="stagger" style={{ display: "grid", gap: 8 }}>
            {rooms.length === 0 && <div className="state-empty">暂无活跃房间</div>}
            {rooms.map((r) => (
              <div key={r.roomCode} className="card card-static" style={{ padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontFamily: "var(--font-serif)", fontSize: 15 }}>{r.scriptTitle || "未命名"}</span>
                      <span className="tag" style={{ fontFamily: "var(--font-mono)", letterSpacing: ".12em" }}>{r.roomCode}</span>
                    </div>
                    <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                      {r.playerCount} 人 ｜ {PHASE_TEXT[r.phase] || r.phase || r.status}
                    </div>
                  </div>
                  <button className="btn btn-danger btn-xs" onClick={() => closeRoom(r.roomCode)}>关闭</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
