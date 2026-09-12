import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { apiJson } from "../lib/api.js";
import { onSocket } from "../lib/socket.js";
import { createVoice } from "../lib/voice.js";

// 游戏主视图：lobby(选角色) → reading → intro → round1/2(搜证讨论) → voting → truth_reveal
//
// 状态来源约定：
//   - players / phase / 房主：room_state（权威快照）与增量事件共同维护，
//     并以 room_state 对账，避免断线期间漏掉事件后状态停旧。
//   - 聊天、线索：首次用 room_state 的 chatMessages / myClues 播种，之后靠增量事件追加。
export default function GameView({ game, socket, user, onLeave, online = true }) {
  const [players, setPlayers] = useState(game.players || []);
  const [phase, setPhase] = useState(game.phase || "lobby");
  const [chats, setChats] = useState([]);
  const [myClues, setMyClues] = useState([]);
  const [myChar, setMyChar] = useState(game.myCharacter || null);
  const [myScript, setMyScript] = useState(null);
  const [availChars, setAvailChars] = useState([]);
  const [voteState, setVoteState] = useState({ recordedTarget: null, count: 0, total: 0 });
  const [narrative, setNarrative] = useState("");
  const [readyInfo, setReadyInfo] = useState({ count: 0, total: 0, countdown: null, force: false, last: "" });
  const [iAmReady, setIAmReady] = useState(false);
  const [review, setReview] = useState(null);
  const [notice, setNotice] = useState("");
  const [sidebarTab, setSidebarTab] = useState("clues");
  const chatBoxRef = useRef(null);
  const seededRef = useRef(false);
  // ---- 语音聊天（WebRTC 网状连接）两个开关 ----
  const [micOn, setMicOn] = useState(false);        // 向其他人说话
  const [listenOn, setListenOn] = useState(false);  // 接收其他人说话
  const [voicePeers, setVoicePeers] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const [speaking, setSpeaking] = useState({});     // socketId → 是否正在说话
  const [remoteVoice, setRemoteVoice] = useState({}); // socketId → { micOn, listenOn }
  const voiceRef = useRef(null);

  const room = game.room || {};
  const ownerId = game.ownerId || room.ownerId;
  const isOwner = !!ownerId && ownerId === game.playerId;

  function normalizeChat(m) {
    return {
      from: m.characterName || m.playerName || m.from || "?",
      content: m.content || m.text || "",
      ts: m.ts || Date.now(),
      ai: !!m.ai,
    };
  }

  // ===== room_state 对账 + 一次性播种 =====
  useEffect(() => {
    if (!game) return;
    // 全量快照字段：每次都同步（这些在 room_state / room_updated 里都是完整列表）
    if (Array.isArray(game.players)) setPlayers(game.players);
    if (game.phase) setPhase(game.phase);
    // myCharacter 只做兜底填充：一旦拿到含 isMurderer 的更完整版本就不再被覆盖
    if (game.myCharacter) setMyChar((cur) => cur || game.myCharacter);

    if (!seededRef.current) {
      if (Array.isArray(game.chatMessages)) setChats(game.chatMessages.map(normalizeChat));
      if (Array.isArray(game.myClues)) setMyClues(game.myClues);
      seededRef.current = true;
    }
  }, [game]);

  // ===== Socket 订阅 =====
  useEffect(() => {
    const offs = [
      onSocket("room_updated", (d) => {
        setPlayers(d.players || []);
        // 其他玩家选走/释放角色后同步可选列表，避免点到已被选的角色
        refreshAvailChars();
      }),
      onSocket("phase_changed", (d) => {
        setPhase(d.phase);
        // 阶段推进后重置准备状态
        setIAmReady(false);
        setReadyInfo({ count: 0, total: 0, countdown: null, force: false, last: "" });
      }),
      onSocket("narrative_ready", (d) => { if (d.narrative) setNarrative(d.narrative); }),
      onSocket("narrative", (d) => { if (d.text) setNarrative(d.text); }),
      onSocket("chat_message", (d) => {
        setChats((c) => [...c, normalizeChat(d)]);
        setTimeout(() => chatBoxRef.current?.scrollTo(0, 99999), 60);
      }),
      onSocket("clue_received", (d) => {
        if (d.clue) setMyClues((c) => (c.some((x) => x.id && x.id === d.clue.id) ? c : [...c, d.clue]));
      }),
      onSocket("character_selected", (d) => {
        if (d.character) setMyChar({ ...d.character, isMurderer: !!d.isMurderer });
        if (d.players) setPlayers(d.players);
        // 别人选走角色后刷新可选列表，避免点到已被选的角色
        refreshAvailChars();
      }),
      onSocket("character_assigned", (d) => {
        if (d.character) setMyChar({ ...d.character, isMurderer: !!d.isMurderer });
        refreshAvailChars();
      }),
      onSocket("ready_update", (d) => {
        setReadyInfo((r) => ({
          count: d.readyCount !== undefined ? d.readyCount : r.count,
          total: d.totalCount !== undefined ? d.totalCount : r.total,
          countdown: typeof d.countdown === "number" ? d.countdown : null,
          force: !!d.forceAdvance,
          last: d.playerName || r.last,
        }));
      }),
      onSocket("vote_update", (d) => setVoteState((v) => ({ ...v, count: d.count, total: d.total }))),
      onSocket("vote_recorded", (d) => setVoteState((v) => ({ ...v, recordedTarget: d.target }))),
      onSocket("ai_answer", (d) => {
        setChats((c) => [...c, { from: d.from || "AI", content: d.answer || "", ts: Date.now(), ai: true }]);
      }),
      onSocket("truth_revealed", (d) => setNarrative(d.text || JSON.stringify(d).substring(0, 500))),
      onSocket("intro_statement", (d) => {
        setChats((c) => [...c, { from: d.characterName || "?", content: d.content || "", ts: Date.now() }]);
      }),
      onSocket("error", (d) => { if (d && d.message) setNotice(d.message); }),
      onSocket("voice_state", (d) => {
        if (!d || !d.playerId) return;
        setRemoteVoice((m) => ({ ...m, [d.playerId]: { micOn: !!d.micOn, listenOn: !!d.listenOn } }));
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // 可选角色：原先只在 roomCode 变化时拉一次，别人选完角色后列表就旧了
  function refreshAvailChars() {
    if (!room.roomCode) return;
    apiJson("/api/player/rooms")
      .then((d) => {
        const r = (d.rooms || []).find((x) => x.roomCode === room.roomCode);
        if (r) setAvailChars(r.availableCharacters || []);
      })
      .catch(() => {});
  }
  useEffect(() => { refreshAvailChars(); }, [room.roomCode]);

  // 我的角色剧本（含秘密，仅本人可见）
  useEffect(() => {
    if (!room.roomCode) return;
    let cancelled = false;
    apiJson(`/api/player/rooms/${encodeURIComponent(room.roomCode)}/my-script`)
      .then((d) => {
        if (cancelled || !d) return;
        if (d.isMurderer && d.characterName) {
          setMyChar((c) => ({ ...(c || {}), name: d.characterName, isMurderer: true }));
        }
        if (d.script) {
          setMyScript(d.script + (d.secret ? "\n\n【你的秘密】\n" + d.secret : ""));
        } else if (d.characterName) {
          setMyScript(`（${d.characterName} 的剧本正在生成中，请稍候…）`);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [myChar?.name, room.roomCode]);

  // 复盘数据：后端 /api/player/review/:code 已提供凶手/真相/投票分布/线索，此前前端从未调用
  useEffect(() => {
    if (!room.roomCode) return;
    if (phase !== "truth_reveal" && phase !== "finished") return;
    if (review) return;
    apiJson(`/api/player/review/${encodeURIComponent(room.roomCode)}`)
      .then(setReview)
      .catch(() => {});
  }, [phase, room.roomCode, review]);

  // ===== 语音聊天生命周期 =====
  useEffect(() => {
    if (!room.roomCode) return;
    const v = createVoice({
      socket,
      roomCode: room.roomCode,
      onPeers: (list) => setVoicePeers(list.length),
      onSpeaking: setSpeaking,
      onError: (m) => setVoiceError(m),
    });
    voiceRef.current = v;
    return () => {
      v.detach();
      voiceRef.current = null;
      setVoicePeers(0);
      setSpeaking({});
      setMicOn(false);
      setListenOn(false);
    };
  }, [room.roomCode]);

  async function toggleMic() {
    const v = voiceRef.current;
    if (!v) return;
    setVoiceError("");
    if (!v.micOn && !v.listenOn) v.join(); // 首次开启任一开关时才加入语音（避免无谓占用）
    await v.setMic(!v.micOn);
    setMicOn(v.micOn);
    setListenOn(v.listenOn);
    if (!v.micOn && !v.listenOn) v.leave();
  }

  function toggleListen() {
    const v = voiceRef.current;
    if (!v) return;
    setVoiceError("");
    if (!v.listenOn && !v.micOn) v.join();
    v.setListen(!v.listenOn);
    setMicOn(v.micOn);
    setListenOn(v.listenOn);
    if (!v.micOn && !v.listenOn) v.leave();
  }

  // useCallback 保持引用稳定：VoiceDiagPanel 的轮询 useEffect 依赖它，
  // 每次渲染都换新函数会导致定时器被反复重建，诊断面板永远刷不出中间状态。
  const getVoiceDiag = useCallback(
    () => (voiceRef.current ? voiceRef.current.diagnostics() : null), []);

  // ===== 动作 =====
  const emit = (ev, data) => socket.emit(ev, { roomCode: room.roomCode, ...data });
  function selectChar(name) { emit("select_character", { characterName: name }); }
  function startGame() { emit("start_game", {}); }
  function sendChat(content) {
    if (!content.trim()) return;
    emit("chat", { content });
  }
  function investigate(query) { emit("investigate", { query }); }
  function askNpc(npcName, q) { emit("ask_npc", { npcName, question: q }); }
  function askAiPlayer(characterName, q) { emit("ask_ai_player", { characterName, question: q }); }
  function submitIntro(text) { emit("intro_statement", { content: text }); }
  function vote(target) { emit("vote", { targetCharacterName: target }); }
  function doReady() {
    if (iAmReady) return;
    setIAmReady(true);
    emit("ready", {});
  }

  // ===== 阶段渲染 =====
  if (phase === "lobby") {
    const humanPlayers = players.filter((p) => !p.isNPC && !p.isAI);
    const assignedCount = humanPlayers.filter((p) => p.characterName).length;
    const canStart = humanPlayers.length >= 1 && assignedCount >= humanPlayers.length;
    const parsed = game.scriptSummary || {};

    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        <header className="app-header">
          <h1>房间 {room.roomCode}</h1>
          {!online && <span className="tag tag-danger" style={{ marginLeft: 10 }}>连接已断开，正在重连…</span>}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <VoiceBar micOn={micOn} listenOn={listenOn} peerCount={voicePeers} onMic={toggleMic} onListen={toggleListen} getDiag={getVoiceDiag} />
            <span className="user-info">{user.username || ""}</span>
            <button className="btn btn-outline btn-sm" onClick={onLeave}>离开房间</button>
          </div>
        </header>
        <div className="main-content" style={{ padding: 20, maxWidth: 900, margin: "0 auto" }}>
          {notice && (
            <div className="alert alert-danger" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span>{notice}</span>
              <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
            </div>
          )}
          {voiceError && (
            <div className="alert alert-danger" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span>语音：{voiceError}</span>
              <button className="btn btn-outline btn-xs" onClick={() => setVoiceError("")}>关闭</button>
            </div>
          )}
          <InsecureVoiceNotice />
          <div className="panel" style={{ padding: 16 }}>
            <div className="text-center" style={{ margin: "10px 0 20px" }}>
              <h3 style={{ margin: 0 }}>{parsed.title || "剧本杀"}</h3>
              <p className="text-sm text-dim">{parsed.setting?.era || ""} | {parsed.setting?.location || ""}</p>
              <p className="text-xs" style={{ color: "var(--gold)" }}>
                {humanPlayers.length}/{game.totalSlots || "?"}人 | {assignedCount}人已选角色
                {players.filter((p) => p.isAI).length > 0 ? ` | 🤖 AI补位 ${players.filter((p) => p.isAI).length}人` : ""}
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
              <div>
                <h4>玩家列表</h4>
                {players.map((p) => (
                  <div key={p.playerId || p.playerName} className="card card-static" style={{ marginBottom: 4, padding: 10 }}>
                    {/* 皇冠由 ownerId 计算：getPlayers() 不带 isOwner，room_updated 后原写法会丢 */
                    }{p.isAI ? "🤖 " : (p.playerId && p.playerId === ownerId) ? "👑 " : ""}{p.playerName}
                    {p.characterName ? ` → ${p.characterName}` : " (未选角色)"}
                    {!p.isAI && !p.isNPC && <VoiceTag playerId={p.playerId} voice={remoteVoice} speaking={speaking} />}
                  </div>
                ))}
              </div>
              <div>
                <h4>选择你的角色</h4>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {availChars.map((c) => (
                    <button key={c} className="btn btn-outline btn-auto" style={{ margin: 2 }} onClick={() => selectChar(c)}>
                      {c}
                    </button>
                  ))}
                  {availChars.length === 0 && <span className="text-dim">暂无可选角色</span>}
                </div>
              </div>
            </div>

            <div className="text-center" style={{ marginTop: 20 }}>
              {isOwner ? (
                <button className="btn btn-success btn-auto" disabled={!canStart} onClick={startGame}
                  style={canStart ? {} : { opacity: 0.5 }}>
                  {canStart ? "开始游戏（AI DM主持）" : humanPlayers.length < 1 ? "等待玩家加入..." : "等待所有人选择角色..."}
                </button>
              ) : (
                <span className="text-sm text-dim">等待房主开始游戏...</span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 游戏进行中
  const showPhaseBar = ["reading", "intro", "round1", "round2"].includes(phase);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header" style={{ flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18 }}>{room.roomCode} · {phaseLabel(phase)}</h1>
        {!online && <span className="tag tag-danger" style={{ marginLeft: 10 }}>连接已断开，正在重连…</span>}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
          <VoiceBar micOn={micOn} listenOn={listenOn} peerCount={voicePeers} onMic={toggleMic} onListen={toggleListen} getDiag={getVoiceDiag} />
          {myChar && <span className="tag" style={{ color: "var(--gold)" }}>{myChar.name}{myChar.isMurderer ? " 🔪" : ""}</span>}
          <button className="btn btn-outline btn-sm" onClick={onLeave}>退出</button>
        </div>
      </header>

      <div className="main-content" style={{ padding: 14, maxWidth: 1200, margin: "0 auto" }}>
        {notice && (
          <div className="alert alert-danger" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span>{notice}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {voiceError && (
          <div className="alert alert-danger" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", gap: 10 }}>
            <span>语音：{voiceError}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setVoiceError("")}>关闭</button>
          </div>
        )}
        <InsecureVoiceNotice />

        {/* 阶段推进条：原先只有 ReadingView 有"准备就绪"按钮，
            intro/round1/round2 完全没有推进入口，只能干等 10 分钟超时 */}
        {showPhaseBar && (
          <PhaseBar readyInfo={readyInfo} iAmReady={iAmReady} onReady={doReady} />
        )}

        {narrative && (
          <div className="panel" style={{ padding: 12, marginBottom: 10, borderLeft: "3px solid var(--gold)" }}>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>{narrative}</div>
          </div>
        )}

        {phase === "reading" && (
          <ReadingView script={myScript} char={myChar} iAmReady={iAmReady} onReady={doReady} />
        )}
        {phase === "intro" && (
          <IntroView onSubmit={submitIntro} />
        )}
        {(phase === "round1" || phase === "round2") && (
          <CombinedRoundView
            phase={phase}
            myChar={myChar}
            chats={chats}
            myClues={myClues}
            chatRef={chatBoxRef}
            onSendChat={sendChat}
            onInvestigate={investigate}
            onAskNpc={askNpc}
            onAskAi={askAiPlayer}
            players={players}
            voice={remoteVoice}
            speaking={speaking}
          />
        )}
        {phase === "voting" && (
          <VotingView
            phase={phase}
            players={players}
            myChar={myChar}
            recordedTarget={voteState.recordedTarget}
            voteCount={voteState.count}
            voteTotal={voteState.total}
            gameMode={game.scriptSummary?.setting?.gameMode}
            onVote={vote}
          />
        )}
        {(phase === "truth_reveal" || phase === "finished") && (
          <TruthView narrative={narrative} review={review} finished={phase === "finished"} />
        )}
      </div>
    </div>
  );
}

// ===== 语音聊天控件 =====
/** 浏览器只在"安全上下文"里允许用麦克风：http://localhost 可以，
 *  但 http://192.168.x.x 这种局域网 IP 不行。提前告知，别等玩家点了按钮才发现。 */
export function micSupported() {
  return typeof navigator !== "undefined"
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && (typeof window === "undefined" || window.isSecureContext !== false);
}

/** 两个按钮：左=是否向其他人说话，右=是否接收其他人说话。
 *  "语音 N 人"可点开诊断面板：真机上"没声音"的原因很多（没授权 / 没收到远端音轨 /
 *  ICE 没连通 / 播放被浏览器拦），只靠现象分不清，这里直接把每步状态摊开。 */
function VoiceBar({ micOn, listenOn, peerCount, onMic, onListen, getDiag }) {
  const supported = micSupported();
  const [showDiag, setShowDiag] = useState(false);
  const [diag, setDiag] = useState(null);

  useEffect(() => {
    if (!showDiag) return;
    const tick = () => setDiag(getDiag ? getDiag() : null);
    tick();
    const t = setInterval(tick, 800);
    return () => clearInterval(t);
  }, [showDiag, getDiag]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <button
          className={`btn btn-sm ${micOn ? "btn-success" : "btn-outline"}`}
          onClick={onMic}
          disabled={!supported}
          title={supported
            ? "向其他人说话：关闭后其他人听不到你"
            : "当前页面不是安全上下文，浏览器禁止使用麦克风（详见下方提示）"}
        >
          {micOn ? "🎤 说话中" : "🎤 说话：关"}
        </button>
        <button
          className={`btn btn-sm ${listenOn ? "btn-success" : "btn-outline"}`}
          onClick={onListen}
          title="接收其他人说话：关闭后你听不到别人"
        >
          {listenOn ? "🔊 收听中" : "🔇 收听：关"}
        </button>
        <button
          className="btn btn-outline btn-xs"
          onClick={() => setShowDiag((v) => !v)}
          title="查看语音连接诊断信息（排查听不到声音时用）"
        >
          🔧 语音 {peerCount} 人
        </button>
        {!supported && <span className="text-xs text-dim">（此页面无法用麦克风）</span>}
      </div>
      {showDiag && <VoiceDiagPanel diag={diag} />}
    </div>
  );
}

/** 诊断明细：直接展示每一步的真实状态，用于区分"没在通话"和"在通话但没声音" */
function VoiceDiagPanel({ diag }) {
  const box = { fontSize: 11, lineHeight: 1.7, background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 6, padding: "8px 10px", maxWidth: 640 };
  const mono = { fontFamily: "ui-monospace, Consolas, monospace" };
  const yn = (b) => (b ? "是" : "否");
  if (!diag) return <div style={box}>诊断信息读取中…</div>;
  return (
    <div style={box}>
      <div style={{ marginBottom: 4 }}>
        <a href="/voice-check.html" target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
          打开语音自检页
        </a>
        <span className="text-xs text-dim">（测麦克风、扬声器、WebRTC 通路是否可用）</span>
      </div>
      <div style={mono}>
        本机：已加入={yn(diag.joined)} 麦克风={yn(diag.micOn)} 收听={yn(diag.listenOn)}
        {" | "}采集流={yn(diag.localStream)}
        {diag.localTracks.length > 0 && diag.localTracks.map((t, i) => ` [轨${i}: ${t.readyState} enabled=${yn(t.enabled)} muted=${yn(t.muted)}]`).join("")}
        {" | "}音频上下文={diag.audioCtx}
      </div>
      {diag.peers.length === 0
        ? <div style={{ marginTop: 4 }}>还没有其他玩家加入语音。</div>
        : diag.peers.map((p) => {
            // 判定这条连接是否"应该能听到声音"
            const healthy = p.connectionState === "connected" && p.gotRemoteTrack && !p.playbackMuted && !p.playbackPaused;
            return (
              <div key={p.playerId} style={{ marginTop: 4 }}>
                <span style={{ color: healthy ? "#4caf50" : "#ffb300" }}>{healthy ? "●" : "○"}</span>{" "}
                <b>{p.playerName}</b>{" "}
                <span style={mono}>
                  连接={p.connectionState} ICE={p.iceConnectionState} 信令={p.signalingState}
                  {" | "}收到远端音轨={yn(p.gotRemoteTrack)}
                  {p.gotRemoteTrack && ` (muted=${p.remoteTrackMuted} ${p.remoteTrackState})`}
                  {" | "}播放静音={yn(p.playbackMuted)} 暂停={yn(p.playbackPaused)}
                  {p.pendingIce > 0 && ` | 待处理候选=${p.pendingIce}`}
                </span>
                {!healthy && (
                  <div className="text-xs text-dim" style={{ paddingLeft: 14 }}>
                    {p.connectionState !== "connected" && "→ 连接没建立：等几秒，或让对方也点一次语音按钮重新协商。 "}
                    {p.connectionState === "connected" && !p.gotRemoteTrack && "→ 连上了但没收到音轨：对方可能还没开麦克风。 "}
                    {p.gotRemoteTrack && p.playbackMuted && "→ 你已经收到对方的音轨，但本地播放被自己关掉了（检查「收听」开关）。 "}
                    {p.gotRemoteTrack && p.playbackPaused && "→ 浏览器拦截了自动播放：点一下页面任意位置即可解锁。 "}
                  </div>
                )}
              </div>
            );
          })}
    </div>
  );
}

/** 非安全上下文提示条。
 *  浏览器只在安全上下文（https / localhost）里提供 navigator.mediaDevices，
 *  而局域网访问用的是 http://192.168.x.x —— 这时麦克风按钮会失效，
 *  必须明确告诉玩家"为什么"以及"怎么办"，否则只会以为功能坏了。 */
function InsecureVoiceNotice() {
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed || micSupported()) return null;
  return (
    <div className="alert alert-danger" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
      <span className="text-xs" style={{ lineHeight: 1.6 }}>
        <b>当前页面无法使用麦克风。</b>
        浏览器只允许在安全页面（HTTPS 或 <code>http://localhost</code>）申请麦克风权限，
        而你现在是通过 <code>{typeof window !== "undefined" ? window.location.origin : ""}</code> 访问的，属于非安全页面。
        解决办法：① 在本机用 <code>http://localhost:3000</code> 打开（同一台电脑开多个窗口可正常语音）；
        ② 或让服务端启用 HTTPS 后再用局域网地址访问。
        听别人说话不受影响。
        {" "}
        <a href="/voice-check.html" target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          打开语音自检页
        </a>
      </span>
      <button className="btn btn-outline btn-xs" onClick={() => setDismissed(true)}>知道了</button>
    </div>
  );
}

/** 玩家列表里的语音状态小标（🔊=正在说话 🎤=麦克风开 🚫=未在收听） */
function VoiceTag({ playerId, voice, speaking }) {
  const v = voice ? voice[playerId] : null;
  const isSpeaking = !!(speaking && speaking[playerId]);
  if (!v && !isSpeaking) return null;
  const title = isSpeaking ? "正在说话" : (v && v.listenOn === false ? "未在收听" : "麦克风已开");
  return (
    <span style={{ marginLeft: 4 }} title={title}>
      {isSpeaking ? "🔊" : (v && v.micOn ? "🎤" : "")}
      {v && v.listenOn === false ? "🚫" : ""}
    </span>
  );
}

function phaseLabel(p) {
  return {
    reading: "阅读剧本", intro: "自我介绍", round1: "第一轮搜证与讨论",
    round2: "第二轮搜证与讨论", voting: "投票指控", truth_reveal: "真相复盘", finished: "游戏结束",
  }[p] || p;
}

// ===== 阶段推进条（全员共识） =====
function PhaseBar({ readyInfo, iAmReady, onReady }) {
  const counting = readyInfo.countdown !== null;
  const canReady = !iAmReady && !counting;
  return (
    <div className="panel" style={{ padding: "10px 14px", marginBottom: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span className="text-sm">
        已准备 <strong style={{ color: "var(--gold)" }}>{readyInfo.count}/{readyInfo.total || "?"}</strong>
        {readyInfo.last && !counting ? <span className="text-dim">（{readyInfo.last} 刚准备好）</span> : null}
      </span>
      {counting && (
        <span className="tag tag-success">
          {readyInfo.force ? "等待超时，" : "全员就绪，"} {readyInfo.countdown} 秒后进入下一阶段…
        </span>
      )}
      {!counting && readyInfo.total > 0 && readyInfo.count >= readyInfo.total && (
        <span className="tag tag-success">全员已准备</span>
      )}
      <div style={{ marginLeft: "auto" }}>
        <button className="btn btn-success btn-sm" disabled={!canReady} onClick={onReady} style={canReady ? {} : { opacity: 0.55 }}>
          {iAmReady ? "已准备，等待其他人…" : counting ? "即将推进…" : "进入下一阶段"}
        </button>
      </div>
    </div>
  );
}

// ===== 阅读剧本（分页） =====
function ReadingView({ script, char, iAmReady, onReady }) {
  const [page, setPage] = useState(0);
  const text = script || (char ? "（等待剧本下发...）" : "（尚未分配角色，请先在房间内选择角色）");
  const pages = useMemo(() => {
    const arr = [];
    for (let i = 0; i < text.length; i += 360) arr.push(text.slice(i, i + 360));
    return arr.length ? arr : [""];
  }, [text]);
  const onLast = page >= pages.length - 1;

  useEffect(() => { if (page > pages.length - 1) setPage(pages.length - 1); }, [pages.length, page]);

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ color: "var(--gold)" }}>📖 {char?.name || ""} 的剧本</strong>
        <span className="text-xs text-dim">第 {page + 1}/{pages.length} 页</span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.8, minHeight: 260, background: "rgba(255,255,255,.04)", padding: 16, borderRadius: 8 }}>
        {pages[page] || ""}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
        <button className="btn btn-outline" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>← 上一页</button>
        <button className="btn btn-success" disabled={iAmReady} onClick={onReady} style={iAmReady ? { opacity: 0.55 } : {}}>
          {iAmReady ? "已准备，等待其他人…" : onLast ? "我已读完，准备就绪" : "我已读完，准备就绪（还有下一页）"}
        </button>
        <button className="btn btn-outline" disabled={onLast} onClick={() => setPage((p) => p + 1)}>下一页 →</button>
      </div>
    </div>
  );
}

// ===== 自我介绍 =====
function IntroView({ onSubmit }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <div className="panel" style={{ padding: 16 }}>
      <h4 style={{ color: "var(--gold)" }}>自我介绍</h4>
      <p className="text-sm text-dim">向众人介绍你的角色（背景、来此目的、你对死者/其他人的了解）。提交后本阶段用上方「进入下一阶段」推进。</p>
      <textarea className="form-textarea" rows="4" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="大家好，我是..." />
      <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => { onSubmit(text); setSent(true); }}>
        {sent ? "再次提交" : "提交介绍"}
      </button>
      {sent && <span className="text-xs text-dim" style={{ marginLeft: 10 }}>已提交，可继续补充</span>}
    </div>
  );
}

// ===== 搜证 + 讨论（合并阶段） =====
function CombinedRoundView({ phase, myChar, chats, myClues, chatRef, onSendChat, onInvestigate, onAskNpc, onAskAi, players, voice, speaking }) {
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState({ npc: "", q: "" });
  // AI 补位玩家的标记是 isNPC:true + isAI:true，两个条件同时成立。
  // 原写法 npcs/ais 都包含 AI 玩家 → 下拉框重复项，且点击时被 npcs 先命中而路由到 ask_npc，
  // 而服务端 ask_npc 只认 roleType==="npc" 的角色 → 审讯 AI 必然报"未找到该NPC"。
  const ais = players.filter((p) => p.isAI && p.characterName);
  const npcs = players.filter((p) => p.isNPC && !p.isAI && p.characterName);

  function doChat() { if (msg.trim()) { onSendChat(msg); setMsg(""); } }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12 }} className="combined-round">
      {/* 左侧：线索 + 搜证 + 审讯 */}
      <div>
        <div className="panel" style={{ padding: 14, marginBottom: 10 }}>
          <h4 style={{ color: "var(--gold)", margin: "0 0 10px" }}>🔍 {phase === "round1" ? "第一轮" : "第二轮"} 搜证</h4>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input className="form-input" placeholder="搜索线索：例如 搜索书房 / 查看尸体 / 调查毒药..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { onInvestigate(query); setQuery(""); } }} />
            <button className="btn btn-primary btn-sm" onClick={() => { onInvestigate(query); setQuery(""); }}>搜证</button>
          </div>
          {/* 审讯 NPC / AI */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <select className="form-select" style={{ maxWidth: 180 }} value={ask.npc} onChange={(e) => setAsk({ ...ask, npc: e.target.value })}>
              <option value="">审讯对象...</option>
              {npcs.map((n) => <option key={"npc-" + n.characterName} value={n.characterName}>{n.characterName} (NPC)</option>)}
              {ais.map((n) => <option key={"ai-" + n.characterName} value={n.characterName}>{n.characterName} (AI)</option>)}
            </select>
            <input className="form-input" style={{ flex: 1 }} placeholder="问什么..." value={ask.q} onChange={(e) => setAsk({ ...ask, q: e.target.value })} onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (!ask.npc || !ask.q.trim()) return;
              if (ais.some((n) => n.characterName === ask.npc)) onAskAi(ask.npc, ask.q); else onAskNpc(ask.npc, ask.q);
              setAsk({ ...ask, q: "" });
            }} />
            <button className="btn btn-outline btn-sm" onClick={() => {
              if (!ask.npc || !ask.q.trim()) return;
              if (ais.some((n) => n.characterName === ask.npc)) onAskAi(ask.npc, ask.q); else onAskNpc(ask.npc, ask.q);
              setAsk({ ...ask, q: "" });
            }}>询问</button>
          </div>

          {/* 我的线索（三分类） */}
          <div>
            <div className="text-xs text-dim mb-sm">我的线索</div>
            {myClues.length === 0 && <div className="text-dim" style={{ fontSize: 12 }}>尚未获得线索（线索会按地点/证词/搜身物自动分组显示）</div>}
            <GroupedClues clues={myClues} />
          </div>
        </div>
      </div>

      {/* 右侧：聊天 + 玩家列表 */}
      <div>
        <div className="panel" style={{ padding: 12 }}>
          <strong style={{ color: "var(--gold)" }}>全屋讨论</strong>
          <div ref={chatRef} style={{ height: 300, overflowY: "auto", margin: "8px 0", fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            {chats.map((c, i) => (
              <div key={i} style={{ padding: "4px 8px", background: c.ai ? "rgba(147,112,219,.15)" : "rgba(255,255,255,.06)", borderRadius: 6 }}>
                <strong style={{ color: c.ai ? "var(--mystic-light)" : "inherit" }}>{c.from}:</strong> {c.content}
              </div>
            ))}
            {chats.length === 0 && <div className="text-dim" style={{ fontSize: 12 }}>暂无消息</div>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="form-input" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doChat(); }} placeholder="发言..." />
            <button className="btn btn-primary btn-sm" onClick={doChat}>发送</button>
          </div>
        </div>
        <div className="panel" style={{ padding: 12, marginTop: 10 }}>
          <strong className="text-sm">在场玩家</strong>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {players.map((p) => (
              <div key={p.playerId || p.playerName} style={{ padding: "3px 0" }}>
                {p.isNPC ? "🤖NPC" : p.isAI ? "🤖AI" : ""} {p.characterName || p.playerName}
                {!p.isNPC && !p.isAI && <VoiceTag playerId={p.playerId} voice={voice} speaking={speaking} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// 线索按三分类分组（地点 → 人物证词 → 搜身物品）
function GroupedClues({ clues }) {
  function normalizeLocation(loc) {
    const s = String(loc || "");
    // 常见房间优先
    const places = ["书房", "卧室", "厨房", "大厅", "走廊", "仓库", "药铺", "客厅", "庭院", "阁楼", "地下室", "浴室", "门房", "账房", "闺房", "楼梯"];
    const hit = places.find((p) => s.includes(p));
    if (hit) return { cat: "地点", label: hit };
    // 物品型
    if (/衣|裤|鞋|帽|包|袋|身上|口袋|首饰|手|怀表|戒指|发簪/.test(s)) return { cat: "搜身物品", label: s };
    // 人
    if (/[姓].*(说|称|证词)|目击|看到|听到/.test(s)) return { cat: "人物证词", label: s };
    return { cat: "地点", label: s || "未知" };
  }
  const groups = {};
  (clues || []).forEach((c) => {
    const loc = c.discoveryLocation || c.location || c.discoveredAt || "";
    const { cat, label } = normalizeLocation(loc);
    const key = cat + "|" + label;
    if (!groups[key]) groups[key] = { cat, label, items: [] };
    groups[key].items.push(c);
  });
  const order = ["地点", "人物证词", "搜身物品"];
  const keys = Object.keys(groups).sort((a, b) => order.indexOf(groups[a].cat) - order.indexOf(groups[b].cat));
  if (keys.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {keys.map((k) => (
        <div key={k} className="clue-group" style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "6px 10px", background: "rgba(255,255,255,.05)", fontSize: 13, fontWeight: 600, color: "var(--gold-light)" }}>
            📍 {groups[k].label}（{groups[k].cat}）· {groups[k].items.length}条
          </div>
          <div style={{ padding: 8, fontSize: 12, lineHeight: 1.6 }}>
            {groups[k].items.map((c, i) => (
              <div key={i} style={{ padding: "4px 0", borderBottom: "1px dashed var(--border)" }}>
                <strong>{c.clueId || c.title || c.label || ""}</strong>
                <div className="text-sm">{c.description || c.content || c.text || ""}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ===== 投票 =====
function VotingView({ players, myChar, recordedTarget, voteCount, voteTotal, gameMode, onVote }) {
  // 只能投给有角色的玩家：原写法 p.characterName || p.playerName 在无角色时会发玩家名，
  // 服务端 allCharNames 校验必然失败并返回"投票目标不存在"
  const targets = players.filter((p) => p.characterName && !(gameMode === "PVP" && p.isNPC));
  return (
    <div className="panel" style={{ padding: 16 }}>
      <h4 style={{ color: "var(--gold)" }}>🗳️ 投票指控（{voteCount}/{voteTotal}）</h4>
      {recordedTarget ? (
        <div className="alert alert-success">你已投票指控：{recordedTarget}（不可更改）</div>
      ) : (
        <div>
          <p className="text-sm text-dim">你认为谁是凶手？投票后不可更改。</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 8 }}>
            {targets.map((p) => (
              <button
                key={p.characterName}
                className="btn btn-outline"
                disabled={p.characterName === myChar?.name}
                onClick={() => onVote(p.characterName)}
              >
                {p.characterName}
                {p.characterName === myChar?.name ? "（你自己）" : ""}
              </button>
            ))}
          </div>
          {targets.length === 0 && <div className="state-empty">暂无可投票对象</div>}
        </div>
      )}
    </div>
  );
}

// ===== 真相复盘 =====
function TruthView({ narrative, review, finished }) {
  const murderer = review?.murderer || {};
  return (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ color: "var(--gold)", textAlign: "center" }}>{finished ? "🏁 游戏结束" : "🔦 真相复盘"}</h3>

      {murderer.name && (
        <div className="alert alert-success" style={{ marginTop: 10 }}>
          凶手是 <strong>{murderer.name}</strong>
          {murderer.method ? ` ｜ 手法：${murderer.method}` : ""}
        </div>
      )}
      {murderer.motive && (
        <div className="text-sm" style={{ marginTop: 6, lineHeight: 1.7 }}>动机：{murderer.motive}</div>
      )}

      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, fontSize: 14, marginTop: 12 }}>
        {review?.truthReveal || narrative || "复盘内容生成中..."}
      </div>

      {review && (
        <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
          <div>
            <strong className="text-sm" style={{ color: "var(--gold)" }}>投票分布</strong>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {(review.votes || []).length === 0 && <div className="text-dim text-xs">无投票记录</div>}
              {(review.votes || []).map((v, i) => (
                <div key={i} style={{ padding: "3px 0" }}>{v.voter} → {v.target || "未投"}</div>
              ))}
            </div>
          </div>
          <div>
            <strong className="text-sm" style={{ color: "var(--gold)" }}>线索发现</strong>
            <div style={{ marginTop: 6, fontSize: 13, maxHeight: 220, overflowY: "auto" }}>
              {(review.clues || []).length === 0 && <div className="text-dim text-xs">无线索记录</div>}
              {(review.clues || []).map((c, i) => (
                <div key={i} style={{ padding: "3px 0", borderBottom: "1px dashed var(--border)" }}>
                  <span className="text-dim text-xs">[第{c.round}轮 · {c.location || "未知"}]</span> {c.content}
                  {c.foundBy ? <span className="text-xs" style={{ color: "var(--mystic-light)" }}> — {c.foundBy}</span> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
