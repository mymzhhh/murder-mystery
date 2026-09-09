import React, { useState, useEffect, useRef } from "react";
import { apiJson } from "../lib/api.js";
import { onSocket } from "../lib/socket.js";

// 游戏主视图：lobby(选角色) → reading → intro → round1/2(搜证讨论) → voting → truth_reveal
export default function GameView({ game, socket, user, onLeave }) {
  const [players, setPlayers] = useState(game.players || []);
  const [phase, setPhase] = useState(game.phase || "lobby");
  const [chats, setChats] = useState([]);
  const [myClues, setMyClues] = useState([]);
  const [myChar, setMyChar] = useState(null);
  const [myScript, setMyScript] = useState(null);
  const [availChars, setAvailChars] = useState([]);
  const [voteState, setVoteState] = useState({ recordedTarget: null, count: 0, total: 0 });
  const [narrative, setNarrative] = useState("");
  const [sidebarTab, setSidebarTab] = useState("clues");
  const chatBoxRef = useRef(null);
  const room = game.room || {};

  const isOwner = room.ownerId === game.playerId;

  // ===== Socket 订阅 =====
  useEffect(() => {
    const offs = [
      onSocket("room_updated", (d) => setPlayers(d.players || [])),
      onSocket("phase_changed", (d) => setPhase(d.phase)),
      onSocket("narrative_ready", (d) => { if (d.narrative) setNarrative(d.narrative); }),
      onSocket("narrative", (d) => { if (d.text) setNarrative(d.text); }),
      onSocket("chat_message", (d) => {
        setChats((c) => [...c, { from: d.characterName || d.playerName || "?", content: d.content || d.text || "", ts: Date.now() }]);
        setTimeout(() => chatBoxRef.current?.scrollTo(0, 99999), 60);
      }),
      onSocket("clue_received", (d) => {
        if (d.clue) { setMyClues((c) => [...c, d.clue]); }
      }),
      onSocket("character_selected", (d) => {
        if (d.character) { setMyChar(d.character); if (d.isMurderer) setMyChar((c) => ({ ...c, isMurderer: true })); }
      }),
      onSocket("character_assigned", (d) => {
        if (d.character) setMyChar(d.character);
      }),
      onSocket("vote_update", (d) => setVoteState((v) => ({ ...v, count: d.count, total: d.total }))),
      onSocket("vote_recorded", (d) => setVoteState((v) => ({ ...v, recordedTarget: d.target }))),
      onSocket("ai_answer", (d) => {
        setChats((c) => [...c, { from: d.from || "AI", content: d.answer || "", ts: Date.now(), ai: true }]);
      }),
      onSocket("truth_revealed", (d) => setNarrative(d.text || JSON.stringify(d).substring(0, 500))),
      onSocket("ready_update", () => {}),
      onSocket("intro_statement", (d) => {
        setChats((c) => [...c, { from: d.characterName || "?", content: d.content || "", ts: Date.now() }]);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // 获取可选角色 + 我的剧本
  useEffect(() => {
    apiJson("/api/player/rooms").then((d) => {
      const r = (d.rooms || []).find((x) => x.roomCode === room.roomCode);
      if (r) setAvailChars(r.availableCharacters || []);
    }).catch(() => {});
  }, [room.roomCode]);

  useEffect(() => {
    if (room.roomCode) {
      // 通过专用接口读取"我自己的角色剧本"（含秘密，仅本人可见）
      apiJson(`/api/player/rooms/${encodeURIComponent(room.roomCode)}/my-script`)
        .then((d) => {
          if (d && d.script) {
            setMyScript(d.script + (d.secret ? "\n\n【你的秘密】\n" + d.secret : ""));
          } else if (d && d.characterName) {
            setMyScript(`（${d.characterName} 的剧本正在生成中，请稍候…）`);
          }
        })
        .catch(() => {});
    }
  }, [myChar, room.roomCode]);

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
  function doReady() { emit("ready", {}); }

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
          <span className="user-info" style={{ marginLeft: "auto", padding: "0 10px" }}>{user.username || ""}</span>
          <button className="btn btn-outline btn-sm" onClick={onLeave}>离开房间</button>
        </header>
        <div className="main-content" style={{ padding: 20, maxWidth: 900, margin: "0 auto" }}>
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
                    {p.isAI ? "🤖 " : p.isOwner ? "👑 " : ""}{p.playerName}
                    {p.characterName ? ` → ${p.characterName}` : " (未选角色)"}
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
                  {availChars.length === 0 && <span className="text-dim">加载中...</span>}
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
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header" style={{ flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18 }}>{room.roomCode} · {phaseLabel(phase)}</h1>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center" }}>
          {myChar && <span className="tag" style={{ color: "var(--gold)" }}>{myChar.name}{myChar.isMurderer ? " 🔪" : ""}</span>}
          <button className="btn btn-outline btn-sm" onClick={onLeave}>退出</button>
        </div>
      </header>

      <div className="main-content" style={{ padding: 14, maxWidth: 1200, margin: "0 auto" }}>
        {narrative && (
          <div className="panel" style={{ padding: 12, marginBottom: 10, borderLeft: "3px solid var(--gold)" }}>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>{narrative}</div>
          </div>
        )}

        {phase === "reading" && (
          <ReadingView script={myScript} char={myChar} onReady={doReady} />
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
        {phase === "truth_reveal" && (
          <TruthView narrative={narrative} />
        )}
        {phase === "finished" && <TruthView narrative={narrative} finished />}
      </div>
    </div>
  );
}

function phaseLabel(p) {
  return {
    reading: "阅读剧本", intro: "自我介绍", round1: "第一轮搜证与讨论",
    round2: "第二轮搜证与讨论", voting: "投票指控", truth_reveal: "真相复盘", finished: "游戏结束",
  }[p] || p;
}

// ===== 阅读剧本（分页） =====
function ReadingView({ script, char, onReady }) {
  const [page, setPage] = useState(0);
  const charsPerPage = 360;
  const pages = useMemoPage(script || (char ? "（等待剧本下发...）" : ""));
  function useMemoPage(text) {
    const [pages, setPages] = useState([]);
    useEffect(() => {
      const arr = [];
      for (let i = 0; i < text.length; i += charsPerPage) arr.push(text.slice(i, i + charsPerPage));
      setPages(arr);
    }, [text]);
    return pages;
  }
  if (pages.length === 0) return <div className="state-loading">加载剧本...</div>;
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ color: "var(--gold)" }}>📖 {char?.name || ""} 的剧本</strong>
        <span className="text-xs text-dim">第 {page + 1}/{pages.length} 页</span>
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.8, minHeight: 260, background: "rgba(255,255,255,.04)", padding: 16, borderRadius: 8 }}>
        {pages[page] || ""}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
        <button className="btn btn-outline" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>← 上一页</button>
        <button className="btn btn-success" onClick={onReady}>我已读完，准备就绪</button>
        <button className="btn btn-outline" disabled={page >= pages.length - 1} onClick={() => setPage((p) => p + 1)}>下一页 →</button>
      </div>
    </div>
  );
}

// ===== 自我介绍 =====
function IntroView({ onSubmit }) {
  const [text, setText] = useState("");
  return (
    <div className="panel" style={{ padding: 16 }}>
      <h4 style={{ color: "var(--gold)" }}>自我介绍</h4>
      <p className="text-sm text-dim">向众人介绍你的角色（背景、来此目的、你对死者/其他人的了解）</p>
      <textarea className="form-textarea" rows="4" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="大家好，我是..." />
      <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => onSubmit(text)}>提交介绍</button>
    </div>
  );
}

// ===== 搜证 + 讨论（合并阶段） =====
function CombinedRoundView({ phase, myChar, chats, myClues, chatRef, onSendChat, onInvestigate, onAskNpc, onAskAi, players }) {
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [ask, setAsk] = useState({ npc: "", q: "" });
  const npcs = players.filter((p) => p.isNPC);
  const ais = players.filter((p) => p.isAI);

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
              {npcs.map((n) => <option key={n.characterName} value={n.characterName}>{n.characterName} (NPC)</option>)}
              {ais.map((n) => <option key={n.characterName} value={n.characterName}>{n.characterName} (AI)</option>)}
            </select>
            <input className="form-input" style={{ flex: 1 }} placeholder="问什么..." value={ask.q} onChange={(e) => setAsk({ ...ask, q: e.target.value })} />
            <button className="btn btn-outline btn-sm" onClick={() => {
              if (!ask.npc || !ask.q.trim()) return;
              const isNpc = npcs.some((n) => n.characterName === ask.npc);
              if (isNpc) onAskNpc(ask.npc, ask.q); else onAskAi(ask.npc, ask.q);
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
        {myChar && <ChatView chats={chats} chatRef={chatRef} />}
      </div>

      {/* 右侧：聊天 + 玩家列表 */}
      <div>
        <div className="panel" style={{ padding: 12 }}>
          <strong style={{ color: "var(--gold)" }}>讨论</strong>
          <div ref={chatRef} style={{ height: 260, overflowY: "auto", margin: "8px 0", fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
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
              <div key={p.playerName} style={{ padding: "3px 0" }}>
                {p.isNPC ? "🤖NPC" : p.isAI ? "🤖AI" : p.isOwner ? "👑" : ""} {p.characterName || p.playerName}
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
          <div style={{ padding: "6px 10px", background: "rgba(255,255,255,.05)", fontSize: 13, cursor: "pointer", fontWeight: 600, color: "var(--gold-light)" }}>
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

function ChatView({ chats, chatRef }) {
  return (
    <div className="panel" style={{ padding: 12 }}>
      <strong style={{ color: "var(--gold)" }}>全屋讨论</strong>
      <div ref={chatRef} style={{ height: 220, overflowY: "auto", marginTop: 8, fontSize: 13 }}>
        {chats.map((c, i) => (
          <div key={i} style={{ padding: "3px 0" }}><strong>{c.from}:</strong> {c.content}</div>
        ))}
        {chats.length === 0 && <div className="text-dim" style={{ fontSize: 12 }}>暂无消息</div>}
      </div>
    </div>
  );
}

// ===== 投票 =====
function VotingView({ players, myChar, recordedTarget, voteCount, voteTotal, gameMode, onVote }) {
  const targets = players.filter((p) => !(gameMode === "PVP" && p.isNPC));
  return (
    <div className="panel" style={{ padding: 16 }}>
      <h4 style={{ color: "var(--gold)" }}>🗳️ 投票指控（{voteCount}/{voteTotal}）</h4>
      {recordedTarget ? (
        <div className="alert alert-success">你已投票指控：{recordedTarget}</div>
      ) : (
        <div>
          <p className="text-sm text-dim">你认为谁是凶手？</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 8 }}>
            {targets.map((p) => (
              <button key={p.characterName || p.playerName} className="btn btn-outline" disabled={p.characterName === myChar?.name}
                onClick={() => onVote(p.characterName || p.playerName)}>
                {p.characterName || p.playerName}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 真相复盘 =====
function TruthView({ narrative, finished }) {
  return (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ color: "var(--gold)", textAlign: "center" }}>{finished ? "🏁 游戏结束" : "🔦 真相复盘"}</h3>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, fontSize: 14, marginTop: 10 }}>{narrative || "复盘内容生成中..."}</div>
    </div>
  );
}