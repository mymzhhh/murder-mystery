import React, { useState, useEffect, useCallback } from "react";
import { apiJson, getToken, getUser, clearAuth } from "../lib/api.js";
import { getSocket, onSocket } from "../lib/socket.js";
import GameView from "./GameView.jsx";

export default function PlayerApp() {
  const [scripts, setScripts] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [game, setGame] = useState(null);      // 房间内状态（room_state 数据）
  const [joinCode, setJoinCode] = useState(""); // 仅用于"加入房间"输入框
  const [roomCode, setRoomCode] = useState(""); // 当前所在房间号
  const [notice, setNotice] = useState("");     // 操作反馈（替代 alert）
  const [lobbyError, setLobbyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => !!getSocket().connected);
  const [user] = useState(() => getUser() || {});
  const savedRoom = localStorage.getItem("murder_room");

  const socket = getSocket();

  // ===== 数据加载 =====
  const loadLobby = useCallback(async () => {
    setLobbyError("");
    try {
      const [s, r] = await Promise.all([
        apiJson("/api/player/scripts"),
        apiJson("/api/player/rooms"),
      ]);
      setScripts(s.scripts || s.list || []);
      setRooms(r.rooms || []);
    } catch (e) {
      // 原先这里被静默吞掉，接口故障时会误显示"暂无可用剧本"
      setLobbyError("大厅数据加载失败：" + e.message);
      setScripts([]);
      setRooms([]);
    }
  }, []);

  useEffect(() => {
    loadLobby();
    // 自动重连已加入房间
    if (savedRoom) {
      socket.emit("join_room", { roomCode: savedRoom, token: getToken() });
    }
    // 全局房间事件
    const offs = [
      onSocket("connect", () => { setOnline(true); loadLobby(); }),
      onSocket("disconnect", () => setOnline(false)),
      onSocket("connect_error", () => setOnline(false)),
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
      onSocket("game_ended", () => { localStorage.removeItem("murder_room"); setGame(null); setRoomCode(""); loadLobby(); }),
      onSocket("error", (d) => { if (d && d.message) setNotice(d.message); }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // ===== 动作 =====
  function joinRoom(code) {
    const c = String(code || "").trim().toUpperCase();
    if (!c) { setNotice("请输入房间码"); return; }
    setNotice("");
    socket.emit("join_room", { roomCode: c, token: getToken() });
  }

  /** 用指定剧本创建房间。原先这里用 prompt() 让用户手输 Session ID，
   *  而剧本卡片又不暴露该 ID —— 玩家实际无法完成创建。 */
  async function createRoom(script) {
    if (busy) return;
    setNotice("");
    setBusy(true);
    try {
      const d = await apiJson("/api/player/rooms", {
        method: "POST",
        body: JSON.stringify({
          scriptSessionId: script.sessionId || script.id,
          maxPlayers: Number(script.characterCount) || 6,
        }),
      });
      socket.emit("join_room", { roomCode: d.roomCode, token: getToken() });
    } catch (e) {
      setNotice("创建房间失败：" + e.message);
    } finally {
      setBusy(false);
    }
  }

  function leave() {
    if (game?.room?.roomCode) socket.emit("leave_room", { roomCode: game.room.roomCode });
    localStorage.removeItem("murder_room");
    setGame(null);
    setRoomCode("");
    setNotice("");
    loadLobby();
  }

  function logout() {
    clearAuth();
    window.location.hash = "#/";
    window.location.reload();
  }

  // ===== 渲染 =====
  if (game) {
    return (
      <GameView game={game} socket={socket} user={user} onLeave={leave} online={online} />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header">
        <h1>剧本杀玩家端</h1>
        {!online && <span className="tag tag-danger" style={{ marginLeft: 10 }}>连接已断开，正在重连…</span>}
        <span className="user-info" style={{ marginLeft: "auto", padding: "0 10px" }}>{user.username || ""}</span>
        <button className="btn btn-outline btn-sm" onClick={logout}>退出</button>
      </header>

      <div className="main-content" style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
        {notice && (
          <div className="alert alert-danger" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span>{notice}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {lobbyError && (
          <div className="alert alert-danger" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span>{lobbyError}</span>
            <button className="btn btn-outline btn-xs" onClick={loadLobby}>重试</button>
          </div>
        )}

        {/* 加入房间 */}
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="form-input"
              style={{ maxWidth: 200 }}
              placeholder="房间码（如 T98YJB）"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") joinRoom(joinCode); }}
            />
            <button className="btn btn-primary" onClick={() => joinRoom(joinCode)}>加入房间</button>
            <button className="btn btn-outline" onClick={loadLobby}>刷新列表</button>
            <span className="text-xs text-dim">想自己开局？在下方「可选剧本」里点「创建房间」</span>
          </div>
        </div>

        {/* 剧本列表 */}
        <div className="panel" style={{ padding: 16, marginBottom: 14 }}>
          <strong style={{ color: "var(--gold)" }}>可选剧本</strong>
          <div style={{ marginTop: 10 }}>
            {scripts.length === 0 && <div className="state-empty">暂无可用剧本，请先在管理端生成并切分剧本</div>}
            {scripts.map((s) => {
              const sid = s.sessionId || s.id;
              return (
                <div key={sid} className="card card-static" style={{ marginBottom: 8, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{s.title || s.topic || "未命名"}</strong>
                      {s.characterCount ? <span className="tag" style={{ marginLeft: 8 }}>{s.characterCount}名玩家角色{s.npcCount ? ` + ${s.npcCount} NPC` : ""}</span> : null}
                      {/* era/location 后端存的是整段场景描述，这里只截取短预览，完整内容放 title 提示 */}
                      {s.era ? (
                        <span className="text-xs text-dim" style={{ marginLeft: 8 }} title={s.era}>
                          {String(s.era).slice(0, 28)}{String(s.era).length > 28 ? "…" : ""}
                        </span>
                      ) : null}
                    </div>
                    <button className="btn btn-success btn-sm" disabled={busy} onClick={() => createRoom(s)}>创建房间</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 活跃房间 */}
        <div className="panel" style={{ padding: 16 }}>
          <strong style={{ color: "var(--gold)" }}>活跃房间</strong>
          <div style={{ marginTop: 10 }}>
            {rooms.length === 0 && <div className="state-empty">暂无活跃房间</div>}
            {rooms.map((r) => (
              <div key={r.roomCode} className="card card-static" style={{ marginBottom: 8, padding: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    {/* 后端 /api/player/rooms 返回的是 title，不是 scriptTitle */}
                    <strong>{r.title || "未命名"}</strong> <span className="tag">{r.roomCode}</span>
                    <div className="text-xs text-dim">
                      {r.playerCount || 0}/{r.maxPlayers || "?"}人 | {r.phase || r.status}
                      {Array.isArray(r.availableCharacters) ? ` | 余 ${r.availableCharacters.length} 个角色` : ""}
                    </div>
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
