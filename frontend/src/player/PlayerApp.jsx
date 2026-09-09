import React, { useState, useEffect, useCallback } from "react";
import { apiJson, api, getToken, getUser, clearAuth } from "../lib/api.js";
import { getSocket, onSocket } from "../lib/socket.js";
import GameView from "./GameView.jsx";

export default function PlayerApp() {
  const [scripts, setScripts] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [myRooms, setMyRooms] = useState([]);
  const [game, setGame] = useState(null);      // 房间内状态（room_state 数据）
  const [roomCode, setRoomCode] = useState("");
  const [user] = useState(() => getUser() || {});
  const savedRoom = localStorage.getItem("murder_room");

  const socket = getSocket();

  // ===== 数据加载 =====
  async function loadLobby() {
    try {
      const [s, r] = await Promise.all([
        apiJson("/api/player/scripts").catch(() => ({ scripts: [] })),
        apiJson("/api/player/rooms").catch(() => ({ rooms: [] })),
      ]);
      setScripts(s.scripts || s.list || []);
      setRooms(r.rooms || []);
    } catch (e) { /* ignore */ }
  }

  useEffect(() => {
    loadLobby();
    // 自动重连已加入房间
    if (savedRoom) {
      socket.emit("join_room", { roomCode: savedRoom, token: getToken() });
    }
    // 全局房间事件
    const offs = [
      onSocket("room_state", (d) => {
        // 后端 room_state 的房号在 d.room.roomCode
        const code = (d.room && d.room.roomCode) || d.roomCode || savedRoom || "";
        setGame(d);
        setRoomCode(code);
        if (code) localStorage.setItem("murder_room", code);
      }),
      onSocket("room_updated", (d) => { setGame((g) => (g ? { ...g, players: d.players, ownerId: d.ownerId } : g)); }),
      onSocket("game_started", (d) => { setGame((g) => ({ ...(g || {}), phase: "reading", _narrative: d.narrative || "" })); }),
      onSocket("phase_changed", (d) => { setGame((g) => ({ ...(g || {}), phase: d.phase })); }),
      onSocket("left_room", () => { localStorage.removeItem("murder_room"); setGame(null); setRoomCode(""); }),
      onSocket("game_ended", () => { localStorage.removeItem("murder_room"); setGame(null); setRoomCode(""); }),
      onSocket("error", (d) => { if (d && d.message) alert(d.message); }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // ===== 动作 =====
  async function joinRoom(code) {
    if (!code) return;
    socket.emit("join_room", { roomCode: code, token: getToken() });
  }

  async function createRoom() {
    const sid = prompt("请输入剧本 Session ID（或稍后在选择角色页选）");
    if (!sid) return;
    try {
      const d = await apiJson("/api/player/rooms", {
        method: "POST",
        body: JSON.stringify({ scriptSessionId: sid, maxPlayers: 6 }),
      });
      socket.emit("join_room", { roomCode: d.roomCode, token: getToken() });
    } catch (e) { alert("创建失败: " + e.message); }
  }

  function leave() {
    if (game?.room?.roomCode) socket.emit("leave_room", { roomCode: game.room.roomCode });
    localStorage.removeItem("murder_room");
    setGame(null);
    setRoomCode("");
  }

  function logout() {
    clearAuth();
    window.location.hash = "#/";
    window.location.reload();
  }

  // ===== 渲染 =====
  if (game) {
    return (
      <GameView game={game} socket={socket} user={user} onLeave={leave} />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header">
        <h1>剧本杀玩家端</h1>
        <span className="user-info" style={{ marginLeft: "auto", padding: "0 10px" }}>{user.username || ""}</span>
        <button className="btn btn-outline btn-sm" onClick={logout}>退出</button>
      </header>

      <div className="main-content" style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
        {/* 加入房间 */}
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="form-input"
              style={{ maxWidth: 200 }}
              placeholder="房间码（如 T98YJB）"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            />
            <button className="btn btn-primary" onClick={() => joinRoom(roomCode)}>加入房间</button>
            <button className="btn btn-outline" onClick={createRoom}>创建房间</button>
          </div>
        </div>

        {/* 剧本列表 */}
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <strong style={{ color: "var(--gold)" }}>可选剧本</strong>
          <div style={{ marginTop: 10 }}>
            {scripts.length === 0 && <div className="state-empty">暂无可用剧本</div>}
            {scripts.map((s) => (
              <div key={s.sessionId || s.id} className="card card-static" style={{ marginBottom: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{s.topic || s.title || "未命名"}</strong>
                    {s.playerCount && <span className="tag" style={{ marginLeft: 8 }}>{s.playerCount}人{s.npcCount ? "+" + s.npcCount + "NPC" : ""}</span>}
                    <div className="text-xs text-dim mt-sm">{s.storyBackground || s.summary || ""}</div>
                  </div>
                  <span className="tag tag-success">已就绪</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 活跃房间 */}
        <div className="panel" style={{ padding: 16 }}>
          <strong style={{ color: "var(--gold)" }}>活跃房间</strong>
          <div style={{ marginTop: 10 }}>
            {rooms.length === 0 && <div className="state-empty">暂无活跃房间</div>}
            {rooms.map((r) => (
              <div key={r.roomCode} className="card card-static" style={{ marginBottom: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <strong>{r.scriptTitle || "未命名"}</strong> <span className="tag">{r.roomCode}</span>
                    <div className="text-xs text-dim">{r.playerCount}人 | {r.phase || r.status}</div>
                  </div>
                  <button className="btn btn-success btn-sm" onClick={() => joinRoom(r.roomCode)}>加入</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}