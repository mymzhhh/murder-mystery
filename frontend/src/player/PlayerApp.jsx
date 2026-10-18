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
    <div>
      <header className="app-header">
        <h1><span className="brand">剧本杀 · 玩家端</span></h1>
        {!online && <span className="tag tag-danger">连接已断开，正在重连…</span>}
        <div className="header-right">
          <span className="user-info">{user.username || ""}</span>
          <button className="btn btn-outline btn-sm" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="main-content">
        {notice && (
          <div className="alert alert-danger alert-row" style={{ marginBottom: 14 }}>
            <span className="alert-body">{notice}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {lobbyError && (
          <div className="alert alert-danger alert-row" style={{ marginBottom: 14 }}>
            <span className="alert-body">{lobbyError}</span>
            <button className="btn btn-outline btn-xs" onClick={loadLobby}>重试</button>
          </div>
        )}

        {/* 首屏横幅：先说清"这是什么"，再给入口。
            改造前这里直接就是一排表单控件，没有任何产品说明。 */}
        <div className="hero-band">
          <div className="hero-bg" aria-hidden="true" />
          <div className="hero-inner">
            <h2>输入一句话，开一局谋杀悬疑</h2>
            <p className="hero-sub">
              AI 负责写本、切线索、扮演 NPC 与补位玩家，你只需要坐下来推理。
            </p>
          </div>
        </div>

        {/* 加入房间 —— 最高频的动作，所以放在最上面且只有一个输入框 */}
        <div className="panel">
          <div className="panel-head">
            <strong>加入房间</strong>
            <span className="text-xs text-dim">拿到房号就能进，无需等房主操作</span>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="form-input form-input-code"
              style={{ maxWidth: 220 }}
              placeholder="T98YJB"
              aria-label="房间码"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") joinRoom(joinCode); }}
            />
            <button className="btn btn-primary btn-auto" onClick={() => joinRoom(joinCode)}>加入房间</button>
            <button className="btn btn-outline btn-auto" onClick={loadLobby}>刷新列表</button>
            <span className="text-xs text-dim">想自己开局？在下方「可选剧本」里点「创建房间」</span>
          </div>
        </div>

        {/* 用 .auto-cols-wide 而不是内联 repeat(auto-fit, minmax(400px,1fr))：
            内联那个下限写死 400px，在 390px 宽的手机上会把整页撑出横向滚动条。
            类里的写法是 minmax(min(400px, 100%), 1fr)，窄屏时轨道自动缩到 100%。 */}
        <div className="auto-cols-wide">
          {/* 剧本列表 */}
          <div className="panel">
            <div className="panel-head">
              <strong>可选剧本</strong>
              {scripts.length > 0 && <span className="tag">{scripts.length} 个</span>}
            </div>
            <div className="stagger" style={{ display: "grid", gap: 8 }}>
              {scripts.length === 0 && (
                <div className="state-empty">
                  暂无可用剧本
                  <div className="text-xs" style={{ marginTop: 6, letterSpacing: 0 }}>
                    需要先在管理端生成并切分剧本
                  </div>
                </div>
              )}
              {scripts.map((s) => {
                const sid = s.sessionId || s.id;
                return (
                  <div key={sid} className="card card-static" style={{ padding: 0, display: "flex", alignItems: "stretch", overflow: "hidden" }}>
                    {/* 封面图取自剧本图片表的 `cover` 键。没有图时整块不渲染 ——
                        卡片退回原来的纯文字形态；onError 也是隐藏而不是留个破图图标，
                        这样"图挂了"和"本来没图"在页面上不会混淆。 */}
                    <ScriptCover scriptId={sid} />
                    <div style={{ flex: "1 1 auto", minWidth: 0, padding: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, letterSpacing: ".06em" }}>
                          {s.title || s.topic || "未命名"}
                        </div>
                        <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          {s.characterCount ? <span className="tag">{s.characterCount} 名玩家角色</span> : null}
                          {s.npcCount ? <span className="tag tag-npc">{s.npcCount} NPC</span> : null}
                          {/* era/location 后端存的是整段场景描述，这里只截取短预览，完整内容放 title 提示 */}
                          {s.era ? (
                            <span className="text-xs text-dim truncate" style={{ maxWidth: 260 }} title={s.era}>
                              {String(s.era).slice(0, 28)}{String(s.era).length > 28 ? "…" : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <button className="btn btn-success btn-sm" disabled={busy} onClick={() => createRoom(s)}>创建房间</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 活跃房间 */}
          <div className="panel">
            <div className="panel-head">
              <strong>活跃房间</strong>
              {rooms.length > 0 && <span className="tag tag-success">{rooms.length} 个可加入</span>}
            </div>
            <div className="stagger" style={{ display: "grid", gap: 8 }}>
              {rooms.length === 0 && (
                <div className="state-empty">
                  暂无活跃房间
                  {/* 与「可选剧本」的空态保持同一种写法：空状态要给下一步动作，不能只说"没有" */}
                  <div className="text-xs" style={{ marginTop: 6, letterSpacing: 0 }}>
                    把房号发给朋友一起去，或在左边点「创建房间」自己开局
                  </div>
                </div>
              )}
              {rooms.map((r) => (
                <div key={r.roomCode} className="card card-static" style={{ padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0 }}>
                      {/* 后端 /api/player/rooms 返回的是 title，不是 scriptTitle */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, letterSpacing: ".06em" }}>{r.title || "未命名"}</span>
                        <span className="tag" style={{ fontFamily: "var(--font-mono)", letterSpacing: ".14em" }}>{r.roomCode}</span>
                      </div>
                      <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                        {r.playerCount || 0}/{r.maxPlayers || "?"} 人 ｜ {phaseText(r.phase || r.status)}
                        {Array.isArray(r.availableCharacters) ? ` ｜ 余 ${r.availableCharacters.length} 个角色` : ""}
                      </div>
                    </div>
                    <button className="btn btn-success btn-sm" onClick={() => joinRoom(r.roomCode)}>加入</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 一局会经历什么：大厅内容少，1500×1000 下 y≈610 以下原本是整片空白
            （实测约 390×1450px 的纯背景）。这里补一条流程说明，既填版面，
            也让第一次进来的人知道每局要做什么，不用先问房主。 */}
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">
            <strong>一局会经历什么</strong>
            <span className="text-xs text-dim">AI 负责推进，你只负责推理</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {GAME_STEPS.map(([n, title, desc]) => (
              <div key={n} className="card card-static" style={{ padding: 12, display: "flex", gap: 10 }}>
                <span style={{
                  flex: "0 0 22px", height: 22, borderRadius: 999, display: "grid", placeItems: "center",
                  fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--brass, #c9a45f)",
                  border: "1px solid var(--brass-line, rgba(201,164,95,.35))",
                }}>{n}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "var(--text)" }}>{title}</div>
                  <div className="text-xs text-dim" style={{ marginTop: 3, lineHeight: 1.7 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 剧本封面缩略图。
 *  键名固定为 `cover`，字节存在 PG 的 script_images 表里（与线索配图同一套管道，
 *  所以不需要静态目录、也不会因为镜像重建丢图）。取不到就整块不渲染，卡片退回纯文字。 */
function ScriptCover({ scriptId }) {
  const [failed, setFailed] = useState(false);
  if (!scriptId || failed) return null;
  return (
    <img
      src={`/api/scripts/${encodeURIComponent(scriptId)}/images/cover`}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
      style={{
        flex: "0 0 132px", width: 132, alignSelf: "stretch", objectFit: "cover", display: "block",
        borderRight: "1px solid var(--ink-600, rgba(255,255,255,.08))",
      }}
    />
  );
}

/** 大厅底部的流程说明（三步）。写成常量而不是内联，避免每次渲染重建数组。 */
const GAME_STEPS = [
  ["1", "拿到剧本", "你会拿到身份、秘密和一份时间线 —— 先弄清「我是谁、我隐瞒什么」。"],
  ["2", "搜证与审问", "去地点搜线索，再拿线索去对质别人的时间线；AI 玩家会说谎，也会抓你的漏洞。"],
  ["3", "投票与复盘", "指认真凶，然后看完整真相：谁在隐瞒、哪句是谎话、真凶是怎么做到的。"],
];

const PHASE_TEXT = {
  lobby: "等待开局", reading: "阅读剧本", intro: "自我介绍",
  round1: "第一轮搜证", round2: "第二轮搜证", voting: "投票指控",
  truth_reveal: "真相复盘", finished: "已结束",
};
function phaseText(p) { return PHASE_TEXT[p] || p || ""; }
