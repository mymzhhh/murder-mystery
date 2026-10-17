import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { apiJson } from "../lib/api.js";
import { onSocket } from "../lib/socket.js";
import { createVoice } from "../lib/voice.js";
import { groupCluesByPlace, clueCategoryStats } from "../lib/clue-place.mjs";
import { clueBodyText } from "../lib/clue-body.mjs";
import { paginate, estimateBudget, classifyLine } from "../lib/paginate.mjs";
import { votablePlayers, canVoteFor } from "../lib/vote.mjs";
import { ScriptBody } from "../components/ScriptBody.jsx";
import { SceneMap } from "../components/SceneMap.jsx";
import IntelDesk from "./IntelDesk.jsx";

// 游戏主视图：lobby(选角色) → reading → intro → round1/2(搜证讨论) → voting → truth_reveal
//
// 状态来源约定：
//   - players / phase / 房主：room_state（权威快照）与增量事件共同维护，
//     并以 room_state 对账，避免断线期间漏掉事件后状态停旧。
//   - 聊天、线索：首次用 room_state 的 chatMessages / myClues 播种，之后靠增量事件追加。
export default function GameView({ game, socket, user, onLeave, online = true }) {
  // ⚠ room / ownerId 必须在**所有** hook 之前声明。
  // useCallback / useEffect / useMemo 的依赖数组是渲染时**立即求值**的，
  // 如果把它们写在 room 声明之前，求值就会命中 TDZ，抛
  // "Cannot access 'room' before initialization"，React 随即卸载整棵树 ——
  // 表现是整个页面一块黑屏。这个错误 vite build 不报、单测也测不到，只在浏览器里才暴露。
  const room = game.room || {};
  const ownerId = game.ownerId || room.ownerId;
  // 剧本 id：正文里的配图（![说明](img:键名)）要靠它拼 /api/scripts/<id>/images/<键名>。
  // 服务端在 room_state.room 里下发 scriptSessionId（房间建好时记下的那个剧本 id）。
  const scriptId = room.scriptSessionId || "";

  const [players, setPlayers] = useState(game.players || []);
  const [phase, setPhase] = useState(game.phase || "lobby");
  const [chats, setChats] = useState([]);
  const [myClues, setMyClues] = useState([]);
  // 私聊：只含与我有关的收发消息，服务端已按参与者过滤
  const [whispers, setWhispers] = useState([]);
  const [myChar, setMyChar] = useState(game.myCharacter || null);
  const [myScript, setMyScript] = useState(null);
  const [availChars, setAvailChars] = useState([]);
  const [voteState, setVoteState] = useState({ recordedTarget: null, count: 0, total: 0 });
  const [narrative, setNarrative] = useState("");
  const [readyInfo, setReadyInfo] = useState({ count: 0, total: 0, countdown: null, force: false, reason: "", mode: "", last: "" });
  const [iAmReady, setIAmReady] = useState(false);
  const [review, setReview] = useState(null);
  // 个性化复盘：只给本人看的局后点评（含"你的秘密""你哪里想错了"），按需生成
  const [myReview, setMyReview] = useState(null);
  const [myReviewState, setMyReviewState] = useState("idle"); // idle | loading | error
  // 搜证：地点列表 + 本轮剩余次数。服务端才是权威（investigate 时会重新校验），这里只是视图。
  // 必须定义在下面订阅 socket 事件的 effect 之前，否则依赖数组求值时会命中 TDZ。
  const [searchInfo, setSearchInfo] = useState(null);
  const loadSearchInfo = useCallback(() => {
    if (!room.roomCode) return;
    apiJson(`/api/player/rooms/${encodeURIComponent(room.roomCode)}/locations`)
      .then(setSearchInfo)
      .catch(() => {});
  }, [room.roomCode]);
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
  const [processingOn, setProcessingOn] = useState(true); // 回声消除/降噪是否开启
  const [notes, setNotes] = useState([]);              // 私人便签（仅本人可见）
  const [showNotes, setShowNotes] = useState(false);
  // 我的剧本抽屉。为什么需要它：剧本在挂载时就取到了（含「你的秘密」），
  // 但改造前**只有阅读阶段**把它渲染出来 —— 一进搜证阶段就再也打不开，
  // 于是别人问"你那天几点在哪、跟谁见过面"时，玩家只能凭记忆答，
  // 或者干脆被怀疑"你这本是不是没看"。做成覆盖式抽屉而不是把内容塞回主列，
  // 是为了讨论区不被挤走：一边看别人的发言，一边翻自己的本。
  const [showScript, setShowScript] = useState(false);
  const [notesSaving, setNotesSaving] = useState("");  // "" | "saving" | "saved" | "error"
  const notesTimer = useRef(null);
  const voiceRef = useRef(null);

  const isOwner = !!ownerId && ownerId === game.playerId;
  // 准备进度的人数口径必须与服务端一致：服务端 humanCount = allPlayers.filter(p => !p.isNPC && p.connected)
  // （AI 补位的角色同时带 isNPC+isAI，所以 !isNPC 正好把真人之外的都排掉）。
  // 口径不一致会出现"所有人都准备了但进度条永远差一个"。
  const readyTotal = players.filter((p) => p && !p.isNPC && p.connected).length;

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
    // 房主点「开始游戏」时，服务端把开场叙述放在 game_started 的 d.narrative 上，
    // PlayerApp 存成了 game._narrative —— 但之前**没有任何地方读它**，于是按开始的那个人
    // 进阅读阶段时看不到 DM 的开场白（其他人靠 narrative_ready 事件能收到）。
    // 这里兜底播种一次，不覆盖后续 narrative_ready 推来的完整版本。
    if (game._narrative) setNarrative((cur) => cur || game._narrative);

    if (!seededRef.current) {
      if (Array.isArray(game.chatMessages)) setChats(game.chatMessages.map(normalizeChat));
      if (Array.isArray(game.myClues)) setMyClues(game.myClues);
      if (Array.isArray(game.whispers)) setWhispers(game.whispers);
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
        setReadyInfo({ count: 0, total: 0, countdown: null, force: false, mode: "", last: "" });
      }),
      onSocket("narrative_ready", (d) => { if (d.narrative) setNarrative(d.narrative); }),
      onSocket("narrative", (d) => { if (d.text) setNarrative(d.text); }),
      onSocket("chat_message", (d) => {
        setChats((c) => [...c, normalizeChat(d)]);
        setTimeout(() => chatBoxRef.current?.scrollTo(0, 99999), 60);
      }),
      // 线索现在一搜到就由服务端自动公开，所以这个事件是**广播**的：全场都会收到。
      // 不再有"私有/公开/单独给某人"的概念，因此也去掉了 clue_revealed / clue_shared
      // 两个监听器（服务端的可见性机制仍在，只是策略固定为"发现即公开"）。
      onSocket("clue_received", (d) => {
        if (!d.clue) return;
        setMyClues((c) => (c.some((x) => x.id && x.id === d.clue.id)
          ? c
          : [...c, { ...d.clue, visibility: "public", foundByName: d.foundBy }]));
      }),
      onSocket("whisper_message", (d) => {
        setWhispers((w) => [...w, d]);
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
          reason: d.reason || "",
          mode: d.mode || "",
          last: d.playerName || r.last,
        }));
      }),
      onSocket("vote_update", (d) => setVoteState((v) => ({ ...v, count: d.count, total: d.total }))),
      onSocket("vote_recorded", (d) => setVoteState((v) => ({ ...v, recordedTarget: d.target }))),
      // 注意：这里刻意不监听 ai_answer。
      // 服务端已经把 AI 的回答写成了持久化的 chat_message，若此处再追加一次，
      // 同一个回答会显示两遍（和 intro_statement 是同一类重复）。
      // ⚠️ 这个处理器以前是 `setNarrative(d.text || JSON.stringify(d).substring(0, 500))`，
      // 两处都错：
      //   ① 服务端 truth_revealed 发的是 { murdererName, votes, outcome, description,
      //      narrative, phase } —— **没有 text 字段**，于是把整包 JSON 的前 500 字
      //      当成"叙述"显示给玩家；
      //   ② 它**不切换阶段**。真相阶段刻意不发 phase_changed（避免 renderGame 覆盖真相数据），
      //      而 phase 是本地 state，于是投完票后页面**停在投票页**，只能刷新
      //      （刷新后 room_state 带回 phase=truth_reveal 才渲染复盘）。
      //      实测症状："一次推进不生效、需刷新后重按"。
      // 修法：读正确的字段，并把 phase 置为 truth_reveal —— 下面既有的 useEffect
      // （phase === "truth_reveal" 时拉 /api/player/review/:code）本来就在，
      // 只是以前永远进不去。
      onSocket("truth_revealed", (d) => {
        if (d && typeof d.narrative === "string" && d.narrative) setNarrative(d.narrative);
        else if (d && d.text) setNarrative(d.text);   // 兼容旧字段，别删
        setPhase("truth_reveal");
      }),
      // 搜证结果：空手而归/次数用尽都要明确告诉玩家，否则"点了没反应"会被当成卡了
      onSocket("investigate_failed", (d) => {
        setNotice(d?.message || "搜证失败");
        loadSearchInfo(); // 次数已消耗，刷新剩余次数
      }),
      onSocket("investigate_ok", () => loadSearchInfo()),
      // 注意：这里刻意不监听 intro_statement。
      // 服务端已经为自我介绍写入了一条持久化的 chat_message（带 📣 前缀），
      // 若此处再把它追加进聊天列表，同一次发言会显示两遍。
      onSocket("error", (d) => {
        if (!d || !d.message) return;
        setNotice(d.message);
        // 准备按钮是"乐观更新"（点了就先显示已准备）。若服务端因限流/掉线没收下这个 ready，
        // 必须回滚本地状态，否则按钮永远停在"已准备，等待其他人…"，玩家既不能重试也看不到失败。
        if (d.code === "READY_FAILED" || d.code === "NOT_IN_ROOM" || d.code === "ROOM_NOT_FOUND") setIAmReady(false);
      }),
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

  // 进入搜证阶段时拉取地点列表与剩余次数
  useEffect(() => {
    if (phase === "round1" || phase === "round2") loadSearchInfo();
  }, [phase, loadSearchInfo]);

  // 复盘数据：后端 /api/player/review/:code 已提供凶手/真相/投票分布/线索，此前前端从未调用
  useEffect(() => {
    if (!room.roomCode) return;
    if (phase !== "truth_reveal" && phase !== "finished") return;
    if (review) return;
    apiJson(`/api/player/review/${encodeURIComponent(room.roomCode)}`)
      .then(setReview)
      .catch(() => {});
  }, [phase, room.roomCode, review]);

  // ===== 个性化复盘：按需生成 =====
  // 刻意不做"进入 truth_reveal 就自动拉取"：那一刻全桌人同时到达，
  // 一局 6 人会瞬间打出 6 个并发 LLM 调用。改成点按钮触发，生成后由 Redis 缓存复用。
  const loadMyReview = useCallback(() => {
    if (!room.roomCode) return;
    setMyReviewState("loading");
    apiJson(`/api/player/review/${encodeURIComponent(room.roomCode)}/me`)
      .then((d) => { setMyReview(d); setMyReviewState("idle"); })
      .catch(() => setMyReviewState("error"));
  }, [room.roomCode]);

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

  // 切换回声消除/降噪：外放音箱必须开，戴耳机时关掉音质更自然
  const toggleProcessing = useCallback(async () => {
    const v = voiceRef.current;
    if (!v) return true;
    setVoiceError("");
    const next = await v.setProcessing(!v.processingOn);
    setProcessingOn(!!next);
    return next;
  }, []);

  // ===== 私人便签 =====
  // 服务端存储（按登录用户名，断线重连不丢），本地先改后防抖保存，
  // 这样打字时不会每敲一个字就打一次接口。
  useEffect(() => {
    if (!room.roomCode) return;
    let cancelled = false;
    apiJson(`/api/player/rooms/${encodeURIComponent(room.roomCode)}/notes`)
      .then((d) => { if (!cancelled) setNotes(Array.isArray(d.notes) ? d.notes : []); })
      .catch(() => { /* 拉不到就当空便签，不打断游戏 */ });
    return () => { cancelled = true; };
  }, [room.roomCode]);

  const updateNotes = useCallback((next) => {
    setNotes(next);
    setNotesSaving("saving");
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => {
      if (!room.roomCode) return;
      apiJson(`/api/player/rooms/${encodeURIComponent(room.roomCode)}/notes`, {
        method: "PUT",
        body: JSON.stringify({ notes: next }),
      })
        .then(() => setNotesSaving("saved"))
        .catch(() => setNotesSaving("error"));
    }, 800);
  }, [room.roomCode]);

  // 离开时把未落盘的改动补一次，避免"刚写完就退出"丢内容
  useEffect(() => () => { if (notesTimer.current) clearTimeout(notesTimer.current); }, []);

  // ===== 动作 =====
  const emit = (ev, data) => socket.emit(ev, { roomCode: room.roomCode, ...data });
  function selectChar(name) { emit("select_character", { characterName: name }); }
  function startGame() { emit("start_game", {}); }
  function sendChat(content) {
    if (!content.trim()) return;
    emit("chat", { content });
  }
  // 搜证 = 随机翻一条。不传 location 表示"从本轮剩下的线索里随机给一条"（服务端实现）。
  // location 参数保留：AI 路径与需要按地点搜的场景仍然可用。
  function investigate(location) {
    emit("investigate", location ? { location } : {});
  }
  function askNpc(npcName, q) { emit("ask_npc", { npcName, question: q }); }
  function askAiPlayer(characterName, q) { emit("ask_ai_player", { characterName, question: q }); }
  function sendWhisper(targetPlayerId, content) { emit("whisper", { targetPlayerId, content }); }
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

    const settingText = [parsed.setting?.era, parsed.setting?.location].filter(Boolean).join(" ｜ ");
    const aiCount = players.filter((p) => p.isAI).length;
    return (
      <div>
        <header className="app-header">
          <h1><span className="brand">剧本杀 · 房间 {room.roomCode}</span></h1>
          <span className="phase-indicator phase-lobby">等待开局</span>
          {!online && <span className="tag tag-danger">连接已断开，正在重连…</span>}
          <div className="header-right">
            <VoiceBar micOn={micOn} listenOn={listenOn} peerCount={voicePeers} onMic={toggleMic} onListen={toggleListen} getDiag={getVoiceDiag} processingOn={processingOn} onToggleProcessing={toggleProcessing} />
            <span className="user-info">{user.username || ""}</span>
            <button className="btn btn-outline btn-sm" onClick={onLeave}>离开房间</button>
          </div>
        </header>

        <div className="main-content" style={{ maxWidth: 1040 }}>
          {notice && (
            <div className="alert alert-danger alert-row" style={{ marginBottom: 12 }}>
              <span className="alert-body">{notice}</span>
              <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
            </div>
          )}
          {voiceError && (
            <div className="alert alert-danger alert-row" style={{ marginBottom: 12 }}>
              <span className="alert-body">语音：{voiceError}</span>
              <button className="btn btn-outline btn-xs" onClick={() => setVoiceError("")}>关闭</button>
            </div>
          )}
          <InsecureVoiceNotice />

          {/* 房间头部：房号要最大最好找（玩家此刻最需要把它发给朋友），剧本名次之，
              场景描述再次之。改造前这三样挤在同一段小字里，房号只有 13px。 */}
          <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "26px 24px 22px", textAlign: "center", borderBottom: settingText ? "1px solid var(--ink-650)" : "none" }}>
              <div className="kicker" style={{ justifyContent: "center", marginBottom: 14 }}>
                <span style={{ flex: "0 0 auto" }}>房间号</span>
              </div>
              <div className="room-code-lg">{room.roomCode}</div>
              <h2 style={{ margin: "18px 0 0", fontFamily: "var(--font-serif)", letterSpacing: ".14em", color: "var(--text)" }}>
                {parsed.title || "剧本杀"}
              </h2>
              <div style={{ display: "flex", justifyContent: "center", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
                <span className="tag tag-admin">{humanPlayers.length}/{game.totalSlots || "?"} 人</span>
                <span className="tag">{assignedCount} 人已选角色</span>
                {aiCount > 0 && <span className="tag tag-npc">AI 补位 {aiCount} 人</span>}
              </div>
            </div>

            {settingText && (
              <div style={{ padding: "20px 24px" }}>
                <ScenarioText text={settingText} />
              </div>
            )}
          </div>

          {/* 场景地图（键名以 map- 开头的布局图）。开局前就先让人看明白"这是个什么场面"：
              这里紧挨着场景描述，就是页面上"展示场景布局"的那一块。
              没有地图时组件自己返回 null，不会留下空面板。 */}
          <SceneMap
            scriptId={scriptId}
            layoutText={parsed.layoutDescription || ""}
            altText={normalizeScript(myScript)}
          />

          <div className="auto-cols">
            {/* 玩家名册 */}
            <div className="panel">
              <div className="panel-head">
                <strong>玩家名册</strong>
                <span className="text-xs text-dim">{players.length} 人入座</span>
              </div>
              <div className="roster stagger">
                {players.map((p, i) => {
                  // 皇冠由 ownerId 计算：getPlayers() 不带 isOwner，room_updated 后原写法会丢
                  const isOwnerRow = !!p.playerId && p.playerId === ownerId;
                  return (
                    <div
                      key={p.playerId || p.playerName}
                      className={`roster-row${p.isAI ? " is-ai" : ""}${isOwnerRow ? " is-me" : ""}`}
                    >
                      <span className="roster-seat">{i + 1}</span>
                      <span className="roster-name">
                        {isOwnerRow && <span title="房主">👑 </span>}
                        {p.playerName}
                      </span>
                      {p.characterName
                        ? <span className="roster-char">→ {p.characterName}</span>
                        : <span className="text-xs text-muted">未选角色</span>}
                      <span className="roster-role">
                        {p.isAI && <span className="tag tag-npc">AI</span>}
                        {!p.isAI && !p.isNPC && <VoiceTag playerId={p.playerId} voice={remoteVoice} speaking={speaking} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 角色选择 */}
            <div className="panel">
              <div className="panel-head">
                <strong>选择你的角色</strong>
                <span className="text-xs text-dim">选完等房主开局</span>
              </div>
              {availChars.length === 0
                ? <div className="state-empty">暂无可选角色</div>
                : (
                  <div className="char-grid stagger">
                    {availChars.map((c) => (
                      <button
                        key={c}
                        className="char-pick"
                        disabled={c === myChar?.name}
                        onClick={() => selectChar(c)}
                      >
                        {c}
                        <span className="char-sub">{c === myChar?.name ? "已选择" : "点击选择"}</span>
                      </button>
                    ))}
                  </div>
                )}

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--ink-650)", textAlign: "center" }}>
                {isOwner ? (
                  <button className="btn btn-primary btn-auto" disabled={!canStart} onClick={startGame}>
                    {canStart
                      ? "开始游戏（AI DM 主持）"
                      : humanPlayers.length < 1
                        ? "等待玩家加入…"
                        : "等待所有人选择角色…"}
                  </button>
                ) : (
                  <span className="text-sm text-dim">等待房主开始游戏…</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 游戏进行中
  //
  // ⚠ voting 必须在这里面。改造前是 ["reading","intro","round1","round2"]，
  //   而 VotingView 自身没有任何推进入口 —— 服务端 socket 的 ready 处理明确允许
  //   voting 阶段（只挡 truth_reveal / finished / lobby），但前端从不渲染那个按钮，
  //   于是全场投完票之后**没有任何办法进入真相复盘**，只能干等 10 分钟的兜底超时。
  //   实测复现：投票 6/6 后卡在投票页 150 秒无变化。
  const showPhaseBar = ["reading", "intro", "round1", "round2", "voting"].includes(phase);

  return (
    <div>
      {/* 对局背景：一张极暗的场景图（本地 ComfyUI 生成），只从面板之间的缝隙里透出来。
          刻意不放在面板之下当"内容底" —— 这一页是 19 条发言 + 线索列表的高密度界面，
          背景一旦有对比度就会直接吃掉正文的可读性。 */}
      <div className="game-bg" aria-hidden="true" />
      <header className="app-header">
        {/* 标题用剧本名 —— 玩家关心的是"我在玩哪个本"，房号是邀请用的次要信息。
            房号仍保留成小号灰字（没有它就没法在对局中把房号发给朋友）。 */}
        <h1>
          <span className="brand">{game.scriptSummary?.title || "剧本杀"}</span>
          {room.roomCode ? <span className="text-dim" style={{ fontSize: 12, fontWeight: 400, letterSpacing: 0 }}>房间 {room.roomCode}</span> : null}
        </h1>
        <span className={`phase-indicator phase-${phaseClass(phase)}`}>{phaseLabel(phase)}</span>
        {!online && <span className="tag tag-danger">连接已断开，正在重连…</span>}
        <div className="header-right">
          <button
            className={`btn btn-sm ${showScript ? "btn-primary" : "btn-outline"}`}
            onClick={() => setShowScript((v) => !v)}
            title="随时翻看你自己的角色剧本（含只有你能看到的「你的秘密」）。别人问到细节时可以边看讨论边查。"
          >
            📖 我的剧本
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowNotes((v) => !v)} title="私人便签：记录线索、疑点、时间线。只有你自己能看到">
            📝 便签{notes.length > 0 ? ` ${notes.length}` : ""}
          </button>
          <VoiceBar micOn={micOn} listenOn={listenOn} peerCount={voicePeers} onMic={toggleMic} onListen={toggleListen} getDiag={getVoiceDiag} processingOn={processingOn} onToggleProcessing={toggleProcessing} />
          {myChar && <span className="tag tag-admin">{myChar.name}{myChar.isMurderer ? " 🔪" : ""}</span>}
          <button className="btn btn-outline btn-sm" onClick={onLeave}>退出</button>
        </div>
      </header>

      <div className="main-content game-surface" style={{ maxWidth: 1320 }}>
        {/* 阶段轨道：玩家在任何时刻都能一眼看到"走到哪一步、还剩几步" */}
        <PhaseRail phase={phase} />

        {/* 场景地图：搜证/讨论阶段要对着平面图找地点，所以对局期间也常驻一块。
            地图是"场景"的一部分而不是剧本正文，故放在阶段轨道下方、各阶段视图之上。 */}
        <SceneMap
          scriptId={scriptId}
          layoutText={game.scriptSummary?.layoutDescription || ""}
          altText={[myScript, game.scriptSummary?.layoutDescription].filter(Boolean).join("\n")}
        />

        {notice && (
          <div className="alert alert-danger alert-row" style={{ marginBottom: 10 }}>
            <span className="alert-body">{notice}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {voiceError && (
          <div className="alert alert-danger alert-row" style={{ marginBottom: 10 }}>
            <span className="alert-body">语音：{voiceError}</span>
            <button className="btn btn-outline btn-xs" onClick={() => setVoiceError("")}>关闭</button>
          </div>
        )}
        <InsecureVoiceNotice />

        {/* 我的剧本抽屉：整个对局期间（搜证 / 讨论 / 投票 / 复盘）都在，
            不只在阅读阶段。 */}
        {showScript && (
          <ScriptDrawer script={myScript} char={myChar} scriptId={scriptId} onClose={() => setShowScript(false)} />
        )}

        {showNotes && (
          <NotesPanel
            notes={notes}
            onChange={updateNotes}
            onClose={() => setShowNotes(false)}
            saving={notesSaving}
            myClues={myClues}
          />
        )}

        {/* 阶段推进条：原先只有 ReadingView 有"准备就绪"按钮，
            intro/round1/round2/voting 完全没有推进入口，只能干等 10 分钟超时 */}
        {showPhaseBar && (
          <PhaseBar readyInfo={readyInfo} readyTotal={readyTotal} iAmReady={iAmReady} onReady={doReady} phase={phase} />
        )}

        {/* DM 叙述。改造前这里直接把字符串塞进 div，模型输出的 **加粗** 会原样打出来
            （真相复盘里满屏 "**（详细过程）"）。统一走 ScriptBody 渲染 markdown。 */}
        {narrative && (
          <div className="panel narrative-panel" style={{ padding: "16px 18px", marginBottom: 14, borderLeft: "2px solid var(--brass)" }}>
            <div className="kicker" style={{ marginBottom: 10 }}><span style={{ flex: "0 0 auto" }}>DM 叙述</span></div>
            <div style={{ fontSize: 14, lineHeight: 1.95, fontFamily: "var(--font-serif)", color: "var(--text)" }}>
              <ScriptBody text={narrative} />
            </div>
          </div>
        )}

        {/* 自我介绍阶段已取消：玩家不会认真填那个表单，自我介绍本来就该在讨论阶段由各人自己开口。
            仍保留 intro 分支是为了兼容部署瞬间还停在旧阶段的房间 ——
            没有它这些房间会渲染成一片空白，只能干等超时。 */}
        {(phase === "reading" || phase === "intro") && (
          <ReadingView script={myScript} char={myChar} scriptId={scriptId} iAmReady={iAmReady} onReady={doReady} />
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
            searchInfo={searchInfo}
            whispers={whispers}
            onWhisper={sendWhisper}
            onAskNpc={askNpc}
            onAskAi={askAiPlayer}
            players={players}
            voice={remoteVoice}
            speaking={speaking}
            scriptId={scriptId}
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
          <TruthView
            narrative={narrative}
            review={review}
            finished={phase === "finished"}
            myReview={myReview}
            myReviewState={myReviewState}
            onLoadMyReview={loadMyReview}
            scriptId={scriptId}
          />
        )}
      </div>
    </div>
  );
}

/** 阶段 → CSS 类后缀。审问/搜证走 amber，讨论走铜绿，投票走封蜡红。 */
function phaseClass(p) {
  return {
    lobby: "lobby", reading: "reading", intro: "intro",
    round1: "investigation", round2: "investigation",
    voting: "voting", truth_reveal: "discussion", finished: "done",
  }[p] || "lobby";
}

const PHASE_STEPS = [
  { key: "reading", label: "读本" },
  { key: "round1", label: "一轮搜证" },
  { key: "round2", label: "二轮搜证" },
  { key: "voting", label: "投票" },
  { key: "truth_reveal", label: "复盘" },
];

/** 阶段轨道：当前阶段高亮，之前的置灰为"已走过"。
 *  玩家在整个对局里最常问的两个问题是"现在干嘛"和"还有多久"，这个条同时回答。 */
function PhaseRail({ phase }) {
  const norm = phase === "intro" ? "reading" : phase === "finished" ? "truth_reveal" : phase;
  const idx = PHASE_STEPS.findIndex((s) => s.key === norm);
  if (idx < 0) return null;
  return (
    <div className="phase-rail" style={{ marginBottom: 14 }}>
      {PHASE_STEPS.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && <span className="rail-sep">›</span>}
          <span className={`rail-step ${i < idx ? "done" : i === idx ? "current" : ""}`}>{s.label}</span>
        </React.Fragment>
      ))}
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
function VoiceBar({ micOn, listenOn, peerCount, onMic, onListen, getDiag, processingOn, onToggleProcessing }) {
  const supported = micSupported();
  const [showDiag, setShowDiag] = useState(false);
  const [diag, setDiag] = useState(null);
  const [processingUi, setProcessingUi] = useState(!!processingOn);

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
      {showDiag && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-outline btn-xs"
              onClick={async () => {
                const next = await onToggleProcessing();
                setProcessingUi(!!next);
              }}
              title="回声消除/降噪/自动增益。外放音箱时必须开启；戴耳机时关掉可以明显减少闷、水下感、机器人音"
            >
              音频处理（回声消除/降噪）：{processingUi ? "开" : "关"}
            </button>
            <span className="text-xs text-dim">
              {processingUi
                ? "外放音箱请保持开启，否则会听到自己的回声；戴耳机时关掉音质更自然"
                : "已关闭：音质更自然，但外放音箱会产生回声"}
            </span>
          </div>
          <VoiceDiagPanel diag={diag} />
        </div>
      )}
    </div>
  );
}

/** 诊断明细：直接展示每一步的真实状态，用于区分"没在通话"和"在通话但没声音" */
function VoiceDiagPanel({ diag }) {
  const yn = (b) => (b ? "是" : "否");
  if (!diag) return <div className="voice-diag">诊断信息读取中…</div>;
  return (
    <div className="voice-diag">
      <div className="voice-diag-head">
        <a href="/voice-check.html" target="_blank" rel="noreferrer">打开语音自检页</a>
        <span className="text-xs text-dim">（测麦克风、扬声器、WebRTC 通路是否可用）</span>
      </div>
      <div className="voice-diag-mono">
        本机：已加入={yn(diag.joined)} 麦克风={yn(diag.micOn)} 收听={yn(diag.listenOn)}
        {" | "}采集流={yn(diag.localStream)}
        {diag.localTracks.length > 0 && diag.localTracks.map((t, i) => ` [轨${i}: ${t.readyState} enabled=${yn(t.enabled)} muted=${yn(t.muted)}]`).join("")}
        {" | "}音频上下文={diag.audioCtx}
      </div>
      {diag.peers.length === 0
        ? <div className="voice-diag-empty">还没有其他玩家加入语音。</div>
        : diag.peers.map((p) => {
            // 判定这条连接是否"应该能听到声音"
            const healthy = p.connectionState === "connected" && p.gotRemoteTrack && !p.playbackMuted && !p.playbackPaused;
            return (
              <div key={p.playerId} className="voice-peer">
                <span className={`voice-peer-dot ${healthy ? "is-ok" : "is-warn"}`} aria-hidden="true">{healthy ? "●" : "○"}</span>{" "}
                <b>{p.playerName}</b>{" "}
                <span className="voice-diag-mono">
                  连接={p.connectionState} ICE={p.iceConnectionState} 信令={p.signalingState}
                  {" | "}收到远端音轨={yn(p.gotRemoteTrack)}
                  {p.gotRemoteTrack && ` (muted=${p.remoteTrackMuted} ${p.remoteTrackState})`}
                  {" | "}播放静音={yn(p.playbackMuted)} 暂停={yn(p.playbackPaused)}
                  {p.pendingIce > 0 && ` | 待处理候选=${p.pendingIce}`}
                </span>
                {p.opus && (
                  <div className="voice-diag-sub is-mono">
                    编码：{p.opus.fmtp}　发送端上限={p.opus.senderBitrate}
                  </div>
                )}
                {!healthy && (
                  <div className="voice-diag-sub">
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
    <div className="alert alert-danger alert-row voice-notice" style={{ marginBottom: 10 }}>
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

// ===== 私人便签 =====
/** 玩家自己的记录面板：记线索、疑点、时间线、谁说了什么。
 *  内容存在服务端并只按登录用户名存取，别人（包括其他玩家和 AI）看不到。
 *  设计上刻意保持简单：多条便签 + 标题 + 正文，输入即自动保存，不需要"保存"按钮。 */
function NotesPanel({ notes, onChange, onClose, saving, myClues }) {
  function addNote(title = "", content = "") {
    const id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    onChange([...notes, { id, title, content }]);
  }
  function patch(id, field, value) {
    onChange(notes.map(n => (n.id === id ? { ...n, [field]: value } : n)));
  }
  function remove(id) {
    if (!confirm("删除这条便签？")) return;
    onChange(notes.filter(n => n.id !== id));
  }
  /** 一键把已获得的线索追加成一条便签，省得手动抄 */
  function importClues() {
    if (!myClues || !myClues.length) { alert("你还没有获得线索"); return; }
    const body = myClues.map(c => {
      const id = c.id || "线索";
      const loc = c.location ? `（${c.location}）` : "";
      return `【${id}】${c.content || ""}${loc}`;
    }).join("\n");
    addNote(`线索整理（${myClues.length} 条）`, body);
  }

  const status = saving === "saving" ? "保存中…" : saving === "saved" ? "已保存" : saving === "error" ? "保存失败（内容仍在本地）" : "";

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <strong>📝 我的便签</strong>
        <span className="text-xs text-dim">只有你自己能看到</span>
        <span className="text-xs" style={{ color: saving === "error" ? "var(--wax-bright)" : "var(--text-muted)" }}>{status}</span>
        <div className="panel-actions">
          <button className="btn btn-outline btn-xs" onClick={() => addNote()}>＋ 新建</button>
          <button className="btn btn-outline btn-xs" onClick={importClues}>导入我的线索</button>
          <button className="btn btn-outline btn-xs" onClick={onClose}>收起</button>
        </div>
      </div>

      {notes.length === 0 && (
        <div className="text-xs text-muted" style={{ lineHeight: 1.9 }}>
          还没有便签。可以记：谁的时间线有矛盾、哪条线索指向谁、接下来要问谁什么。
          打字会自动保存，刷新或断线重连都不会丢。
        </div>
      )}

      <div className="notes-grid">
        {notes.map((n) => (
          <div key={n.id} className="note-card">
            <div className="note-head">
              <input
                className="form-input form-input-sm"
                placeholder="标题（如「张三的时间线」）"
                aria-label="便签标题"
                value={n.title || ""}
                onChange={(e) => patch(n.id, "title", e.target.value)}
              />
              <button className="btn btn-outline btn-xs btn-auto" onClick={() => remove(n.id)} title="删除这条便签">✕</button>
            </div>
            <textarea
              className="form-input" rows={6}
              aria-label="便签内容"
              placeholder="记录内容…（自动保存）"
              value={n.content || ""}
              onChange={(e) => patch(n.id, "content", e.target.value)}
            />
          </div>
        ))}
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

/** 场景描述。后端存的是整段散文（年代 + 地点连在一起），
 *  原来直接铺在面板里：1680px 屏宽下每行 90+ 字，一屏 8 行密集小字，非常难读。
 *  这里限制到 68ch 行宽、加首行缩进，并把"｜"分隔的两段拆成两段。 */
function ScenarioText({ text }) {
  const parts = String(text || "").split(/\s*｜\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="scenario-text">
      {parts.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}

// ===== 阶段推进条（全员共识） =====
function PhaseBar({ readyInfo, readyTotal = 0, iAmReady, onReady, phase }) {
  const counting = readyInfo.countdown !== null;
  // "只差一人"的倒计时不能锁住准备按钮：服务端支持在倒计时途中升级成 10 秒全员倒计时，
  // 若前端在这里把按钮置灰，最后一个人就只能干看着 60 秒走完。
  const partialWait = counting && readyInfo.mode === "partial";
  const canReady = !iAmReady && (!counting || partialWait);
  // 服务端只在**有人按下准备之后**才带上权威的 totalCount；
  // 在那之前 readyInfo.total 是 0，分母没得显示，界面只能退化成 "0/?"。
  // 这里用本地按同一口径（只算在线真人）算出的人数补上，让人一进来就有确定的分母。
  const total = readyInfo.total || readyTotal;
  // 投票阶段这一步之后是复盘，写"进入下一阶段"太含糊 —— 玩家在投票页最需要确认的是
  // "我投完这一票，什么时候能看到真相"。
  const readyLabel = phase === "voting" ? "提交并查看真相" : "进入下一阶段";
  return (
    <div className="panel panel-flat" style={{ padding: "10px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span className="text-sm">
        已准备 <strong style={{ color: "var(--brass)" }}>{readyInfo.count}/{total || 0}</strong>
        {readyInfo.last && !counting ? <span className="text-dim">（{readyInfo.last} 刚准备好）</span> : null}
      </span>
      {counting && (
        <span className="tag tag-success" title="到点会自动进入下一阶段，不需要所有人都在">
          {readyInfo.reason || (readyInfo.force ? "等待超时" : "全员就绪")}，{readyInfo.countdown} 秒后自动进入下一阶段…
        </span>
      )}
      {!counting && total > 0 && readyInfo.count >= total && (
        <span className="tag tag-success">全员已准备</span>
      )}
      {partialWait && !iAmReady && (
        <span className="text-xs" style={{ color: "var(--amber-bright)" }}>
          还没准备的话现在也来得及：人一齐就会换成短倒计时
        </span>
      )}
      {!counting && !partialWait && total > 1 && readyInfo.count === total - 1 && (
        <span className="text-xs" style={{ color: "var(--amber-bright)" }}>
          还差 1 人，再等一会儿会自动推进
        </span>
      )}
      <div style={{ marginLeft: "auto" }}>
        <button className="btn btn-primary btn-sm btn-auto" disabled={!canReady} onClick={onReady}>
          {iAmReady ? "已准备，等待其他人…" : counting && !partialWait ? "即将推进…" : readyLabel}
        </button>
      </div>
    </div>
  );
}

// ===== 阅读剧本（分页） =====
// 剧本正文的渲染器搬到了 components/ScriptBody.jsx：
// 管理端剧本详情页要渲染同一份正文（含 `![说明](img:键名)` 配图），
// 两处各留一份实现的话，配图这种新语法迟早只在一边生效。

/** 剧本正文归一：服务端曾经把角色 script 直接返回成对象，拼进模板串就是满屏 "[object Object]"。
 *  阅读视图和「我的剧本」抽屉共用同一道兜底，避免两处口径不一致。 */
function normalizeScript(script) {
  if (typeof script === "string") return script;
  if (script && typeof script === "object") return script.fullScript || script.story || script.playerScript || "";
  return "";
}

/** 按标题把小节切出来，供抽屉顶部的跳转条使用。
 *  一局剧本四五千字，光靠滚动找一个名字很慢 —— 别人问到某人某事时，
 *  先点小节名跳过去，比从头翻快得多。标题的判定复用 classifyLine。 */
function splitSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let cur = { title: "", lines: [] };
  for (const line of lines) {
    const c = classifyLine(line);
    if (c.kind === "heading" || c.kind === "subheading") {
      if (cur.lines.some((l) => l.trim())) out.push(cur);
      cur = { title: c.text, lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.title || cur.lines.some((l) => l.trim())) out.push(cur);
  return out.filter((s) => s.lines.some((l) => l.trim()));
}

/** 「我的剧本」抽屉。
 *  为什么是覆盖式抽屉而不是主列里的一块：讨论才是这一阶段的主场，
 *  把剧本插进主列会把发言挤走；而玩家的真实动作是"一边看别人说话、一边翻自己的本"，
 *  所以让它浮在右侧，宽度够容纳一行 35 字左右（中文的舒适行宽）。 */
function ScriptDrawer({ script, char, scriptId, onClose }) {
  const bodyRef = useRef(null);
  const raw = normalizeScript(script) || (char ? "（剧本正在生成中，请稍候…）" : "（尚未分配角色，请先在房间内选择角色）");
  const sections = useMemo(() => splitSections(raw), [raw]);

  // Esc 关闭：抽屉盖住了右侧，不给键盘出口会让人以为卡住了
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function jump(i) {
    const el = bodyRef.current && bodyRef.current.querySelector("#sec-" + i);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <React.Fragment>
      <div className="script-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="script-drawer" role="dialog" aria-modal="false" aria-label="我的剧本">
        <div className="script-drawer-head">
          <strong>📖 {char?.name ? `${char.name} 的剧本` : "我的剧本"}</strong>
          {char?.isMurderer ? <span className="tag tag-danger">凶手</span> : null}
          <span className="text-xs text-dim">只有你能看到</span>
          <button className="btn btn-outline btn-xs" style={{ marginLeft: "auto" }} onClick={onClose}>✕ 关闭（Esc）</button>
        </div>

        {sections.length > 1 && (
          <div className="script-jump">
            <span className="script-jump-label">跳到</span>
            {sections.map((s, i) => (
              s.title
                ? <button key={i} type="button" className="chip" onClick={() => jump(i)}>{s.title}</button>
                : null
            ))}
          </div>
        )}

        <div className="script-drawer-body" ref={bodyRef}>
          <div className="paper-surface">
            <div className="script-reader">
              {sections.map((s, i) => (
                <section key={i} id={"sec-" + i}>
                  <ScriptBody text={s.lines.join("\n")} scriptId={scriptId} />
                </section>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </React.Fragment>
  );
}

function ReadingView({ script, char, scriptId, iAmReady, onReady }) {
  const [page, setPage] = useState(0);
  // 默认整篇滚动：玩家反馈分页"内容太少、还会截断"，整篇滚动一次看完最省事。
  // 分页保留为可选（点右上角切换），有需要时还能用。
  const [fullScroll, setFullScroll] = useState(true);
  const [progress, setProgress] = useState(0); // 整篇模式下的阅读进度
  const boxRef = useRef(null);
  const text = normalizeScript(script) || (char ? "（等待剧本下发...）" : "（尚未分配角色，请先在房间内选择角色）");

  // 每页容量按容器实际尺寸估算（仅分页模式用）。
  // 原来固定 360 字：在 2149px 宽的窗口里一页只填约三分之一，而且 360 是硬切，
  // 句子会从中间被劈开。整篇滚动为主之后这个值只在切回分页时才生效。
  const [budget, setBudget] = useState(1200);
  useLayoutEffect(() => {
    const calc = () => {
      const el = boxRef.current;
      if (!el) return;
      const width = Math.max(280, (el.clientWidth || 900) - 34); // 减去左右 padding
      const height = Math.max(280, Math.round((window.innerHeight || 800) * 0.62));
      setBudget(estimateBudget({ width, height }));
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  const pages = useMemo(() => (fullScroll ? [text] : paginate(text, budget)), [text, budget, fullScroll]);
  const onLast = page >= pages.length - 1;

  useEffect(() => { if (page > pages.length - 1) setPage(pages.length - 1); }, [pages.length, page]);
  // 切换分页/全文时回到开头，避免停在一个不存在的页码上
  useEffect(() => { setPage(0); }, [fullScroll, budget]);
  // 切换模式时把滚动位置也归零，否则会停在中间让人以为内容丢了
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = 0;
    setProgress(0);
  }, [fullScroll, page, budget]);

  const readAll = fullScroll && progress >= 99;

  function onScroll(e) {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / max) * 100)));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>📖 {char?.name || ""} 的剧本</strong>
        <div className="panel-actions">
          <span className="text-xs" style={{ color: readAll ? "var(--verd-bright)" : "var(--text-muted)" }}>
            {fullScroll
              ? (readAll ? `已读到末尾 · 全文 ${text.length} 字` : `已读 ${progress}% · 全文 ${text.length} 字`)
              : `第 ${page + 1}/${pages.length} 页 · 每页约 ${budget} 字`}
          </span>
          <button className="btn btn-outline btn-xs" onClick={() => setFullScroll((v) => !v)}
            title="切换「整篇滚动」与「分页阅读」">
            {fullScroll ? "改为分页" : "整篇滚动"}
          </button>
        </div>
      </div>

      {/* 剧本正文是这份产品真正的"内容"，所以给它纸面 ——
          应用外壳是墨，阅读面是纸，这条分工贯穿整套设计。 */}
      <div className="paper-surface" style={{ padding: 0 }}>
        <div
          className="script-scroll"
          ref={boxRef}
          onScroll={fullScroll ? onScroll : undefined}
          style={{
            // 固定高度 + 可滚动：内容永远不会被裁掉半行 —— 这是"被截断"这个反馈的直接兜底。
            // 整篇模式下给足高度（68vh），一次能看到更多内容。
            height: fullScroll ? "68vh" : undefined,
            maxHeight: fullScroll ? undefined : "62vh",
          }}
        >
          <div className="script-reader">
            <ScriptBody text={pages[page] || ""} scriptId={scriptId} />
          </div>
        </div>
      </div>

      {fullScroll && (
        <div className="read-progress" title={`已读 ${progress}%`}>
          <i style={{ width: `${progress}%` }} />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: 16, gap: 8 }}>
        {!fullScroll && (
          <button className="btn btn-outline btn-auto" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>← 上一页</button>
        )}
        <button className="btn btn-primary btn-auto" disabled={iAmReady} onClick={onReady}>
          {iAmReady ? "已准备，等待其他人…" : "我已读完，准备就绪"}
        </button>
        {!fullScroll && (
          <button className="btn btn-outline btn-auto" disabled={onLast} onClick={() => setPage((p) => p + 1)}>下一页 →</button>
        )}
      </div>
      <div className="text-xs text-dim" style={{ textAlign: "center", marginTop: 8 }}>
        {fullScroll
          ? (readAll ? "已滚到末尾，可以点「我已读完」了" : "上下滚动即可阅读全文，滚到末尾会提示")
          : `还有 ${Math.max(0, pages.length - page - 1)} 页`}
      </div>
    </div>
  );
}

// ===== 搜证 + 讨论（合并阶段） =====
// 布局：左侧（宽）全屋讨论 + 在场玩家；右侧（窄）搜证 / 审讯 / 私聊 / 线索。
// 之所以把讨论放主列：讨论是这一阶段真正的主场，需要横向空间读长发言；
// 而线索列表是短行文本，窄列反而更易扫读。
function CombinedRoundView({ phase, myChar, chats, myClues, chatRef, onSendChat, onInvestigate, onAskNpc, onAskAi, players, voice, speaking, searchInfo, whispers, onWhisper, scriptId }) {
  const [msg, setMsg] = useState("");
  const [ask, setAsk] = useState({ npc: "", q: "" });
  // 私聊：与公屏完全分开，服务端按参与者过滤后才下发
  const [whisperTo, setWhisperTo] = useState("");
  const [whisperText, setWhisperText] = useState("");
  // 发言筛选："" = 全部；否则只显示该角色的发言。
  // 人多时逐条翻聊天很难对齐时间线，"某人到底说过什么"是最常需要的视图。
  const [speakerFilter, setSpeakerFilter] = useState("");

  // AI 补位玩家的标记是 isNPC:true + isAI:true，两个条件同时成立。
  // 原写法 npcs/ais 都包含 AI 玩家 → 下拉框重复项，且点击时被 npcs 先命中而路由到 ask_npc，
  // 而服务端 ask_npc 只认 roleType==="npc" 的角色 → 审讯 AI 必然报"未找到该NPC"。
  const ais = players.filter((p) => p.isAI && p.characterName);
  const npcs = players.filter((p) => p.isNPC && !p.isAI && p.characterName);

  const quota = (searchInfo && searchInfo.quota) || { used: 0, max: 0, remaining: 0, unlimited: true };
  const canSearch = !!(searchInfo && searchInfo.canSearch);
  // 不限次数时（默认）不显示计数、也不因次数禁用按钮
  const outOfQuota = !quota.unlimited && quota.remaining <= 0;

  const speakers = Array.from(new Set((chats || []).map((c) => c.from).filter(Boolean)));
  const shownChats = speakerFilter ? (chats || []).filter((c) => c.from === speakerFilter) : (chats || []);

  function doChat() { if (msg.trim()) { onSendChat(msg); setMsg(""); } }

  // 私聊：self 由服务端标注，据此就能算出每条消息的"对方"是谁，客户端不需要知道自己的 playerId
  const partnerOf = (m) => (m.self ? m.to : m.from);
  const thread = (whispers || []).filter((m) => partnerOf(m) === whisperTo);
  function doWhisper() {
    if (!whisperTo || !whisperText.trim()) return;
    onWhisper(whisperTo, whisperText.trim());
    setWhisperText("");
  }

  return (
    <div className="game-shell">
      {/* ============ 左列（宽）：全屋讨论 ============ */}
      {/* alignSelf:"stretch" 是「情报台」能 sticky 的前提：
          .game-shell 是 align-items:start，网格项默认只有内容那么高（实测 920px），
          子元素的 sticky 就只能在 920px 内滑动，等于不生效。撑满行高之后，
          右列线索列表有几千米，情报台就能一路钉在视口里。（视觉上完全一样：列内元素本来就靠上排。） */}
      <div style={{ minWidth: 0, alignSelf: "stretch" }}>
        <div className="panel">
          <div className="panel-head">
            <strong>全屋讨论</strong>
            <span className="text-xs text-dim">
              {chats.length} 条发言
              {speakerFilter ? ` ｜ 只看 ${speakerFilter}` : ""}
            </span>
            <select
              className="form-select"
              style={{ maxWidth: 190, marginLeft: "auto" }}
              value={speakerFilter}
              onChange={(e) => setSpeakerFilter(e.target.value)}
              title="只看某位玩家的发言"
              aria-label="按发言者筛选"
            >
              <option value="">全部发言（{chats.length}）</option>
              {speakers.map((s) => (
                <option key={s} value={s}>{s}（{chats.filter((c) => c.from === s).length}）</option>
              ))}
            </select>
          </div>

          <div className="discussion-log" ref={chatRef}>
            {shownChats.map((c, i) => (
              <div
                key={i}
                className={`msg${c.ai ? " is-ai" : ""}${!c.ai && myChar?.name && c.from === myChar.name ? " is-me" : ""}`}
              >
                <span className="msg-from">{c.from}</span>
                {c.content}
              </div>
            ))}
            {shownChats.length === 0 && (
              <div className="chat-empty">
                {speakerFilter ? `${speakerFilter} 还没有发过言` : "还没有人开口"}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              className="form-input"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doChat(); }}
              placeholder={myChar?.name ? `以 ${myChar.name} 的身份发言…` : "发言…"}
              aria-label="发言内容"
            />
            <button className="btn btn-primary btn-auto" onClick={doChat}>发送</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <strong>在场玩家</strong>
            <span className="text-xs text-dim">{players.length} 人</span>
          </div>
          <div className="roster">
            {players.map((p, i) => (
              <div key={p.playerId || p.playerName} className={`roster-row${p.isAI || p.isNPC ? " is-ai" : ""}`}>
                <span className="roster-seat">{i + 1}</span>
                <span className="roster-name">{p.characterName || p.playerName}</span>
                {p.isNPC ? <span className="tag tag-npc">NPC</span>
                  : p.isAI ? <span className="tag tag-npc">AI</span>
                    : null}
                <span className="roster-role">
                  {!p.isNPC && !p.isAI && <VoiceTag playerId={p.playerId} voice={voice} speaking={speaking} />}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 「情报台」：左列下方原本是成片空白（实测右列 5229px 时左列只有 920px，
            下方 4309px × 868px 命中 0 个元素）。这块小组件栏用 sticky 钉住，
            滚到线索列表深处时左半屏仍有线索目录 / 人物 / 进度可查。
            数据全部来自本组件已有的状态，没有新增接口。 */}
        <IntelDesk
          phase={phase}
          myChar={myChar}
          players={players}
          myClues={myClues}
          chats={chats}
          searchInfo={searchInfo}
        />
      </div>

      {/* ============ 右列（窄）：搜证 / 证物 / 审讯 / 私聊 ============ */}
      {/* 同样要 alignSelf:"stretch"，否则内层 .game-col-pin 也没法钉住。
          内层只在「本列比左列矮」时才真的钉住（例：还没搜到线索时右列 715px、左列 1859px）；
          本列比视口高时（线索多）sticky 自然失效，滚动行为与改造前逐像素一致。 */}
      <div className="game-col-side" style={{ alignSelf: "stretch" }}>
        <div className="game-col-pin">
        {/* 搜证与证物合成一块：搜到的线索马上就在下面出现，不用滚动到别处找 */}
        <div className="panel">
          <div className="panel-head">
            <strong>🔍 {phase === "round1" ? "第一轮" : "第二轮"} 搜证</strong>
            {!quota.unlimited && quota.max > 0 && (
              <span className="text-xs text-dim" style={{ marginLeft: "auto" }}>
                剩余 {quota.remaining} / {quota.max} 次
              </span>
            )}
          </div>
          {/* 随机搜证：点一次翻出一条还没被找到的线索。线索一搜到就自动公开给全场。 */}
          <p className="text-xs text-dim" style={{ marginBottom: 10, lineHeight: 1.7 }}>
            点一次搜证，随机翻出一条本轮还没被找到的线索。搜到什么由不得你 ——
            拿到之后怎么用才是博弈。
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-sm btn-auto" disabled={!canSearch || outOfQuota} onClick={() => onInvestigate()}>
              随机搜证
            </button>
            {outOfQuota && <span className="text-xs" style={{ color: "var(--wax-bright)" }}>本轮次数已用完</span>}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--ink-650)" }}>
            <div className="panel-head" style={{ marginBottom: 8 }}>
              <strong style={{ fontFamily: "var(--font-serif)", fontSize: 14 }}>已发现的线索</strong>
              {myClues.length > 0 && <span className="tag" style={{ marginLeft: "auto" }}>{myClues.length} 条</span>}
            </div>
            {myClues.length === 0
              ? (
                <div className="text-xs text-muted" style={{ lineHeight: 1.7 }}>
                  还没有线索被发现。线索一被搜到就会自动公开给全场。
                </div>
              )
              : <GroupedClues clues={myClues} scriptId={scriptId} />}
          </div>
        </div>

        {/* 审讯 + 私聊 */}
        <div className="panel">
          <div className="panel-head">
            <strong>审讯</strong>
            <span className="text-xs text-dim">NPC 与 AI 玩家</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select className="form-select" style={{ maxWidth: 200 }} value={ask.npc} onChange={(e) => setAsk({ ...ask, npc: e.target.value })} aria-label="审讯对象">
              <option value="">选择审讯对象…</option>
              {npcs.map((n) => <option key={"npc-" + n.characterName} value={n.characterName}>{n.characterName}（NPC）</option>)}
              {ais.map((n) => <option key={"ai-" + n.characterName} value={n.characterName}>{n.characterName}（AI）</option>)}
            </select>
            <input
              className="form-input"
              style={{ flex: 1, minWidth: 130 }}
              placeholder="问什么…"
              aria-label="审讯问题"
              value={ask.q}
              onChange={(e) => setAsk({ ...ask, q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (!ask.npc || !ask.q.trim()) return;
                if (ais.some((n) => n.characterName === ask.npc)) onAskAi(ask.npc, ask.q); else onAskNpc(ask.npc, ask.q);
                setAsk({ ...ask, q: "" });
              }}
            />
            <button className="btn btn-outline btn-sm btn-auto" onClick={() => {
              if (!ask.npc || !ask.q.trim()) return;
              if (ais.some((n) => n.characterName === ask.npc)) onAskAi(ask.npc, ask.q); else onAskNpc(ask.npc, ask.q);
              setAsk({ ...ask, q: "" });
            }}>询问</button>
          </div>

          {/* 私聊：只有收发双方能看到。公屏发言会进 AI 的上下文，私聊不会 —— 所以这里是真正"见不得光"的渠道 */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--ink-650)" }}>
            <div className="panel-head" style={{ marginBottom: 8 }}>
              <strong style={{ fontFamily: "var(--font-serif)", fontSize: 14 }}>私聊</strong>
              <span className="text-xs text-dim">仅你和对方可见</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <select
                className="form-select"
                style={{ maxWidth: 160 }}
                value={whisperTo}
                onChange={(e) => setWhisperTo(e.target.value)}
                aria-label="私聊对象"
              >
                <option value="">选择对象…</option>
                {(players || [])
                  .filter((p) => (p.characterName || p.playerName) && p.characterName !== myChar?.name)
                  .map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.characterName || p.playerName}{p.isAI ? "（AI）" : ""}
                    </option>
                  ))}
              </select>
              <input
                className="form-input"
                style={{ flex: 1, minWidth: 120 }}
                placeholder="悄悄说一句…"
                aria-label="私聊内容"
                value={whisperText}
                onChange={(e) => setWhisperText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doWhisper(); }}
              />
              <button className="btn btn-outline btn-sm btn-auto" disabled={!whisperTo || !whisperText.trim()} onClick={doWhisper}>发送</button>
            </div>
            <div style={{ maxHeight: 150, overflowY: "auto", fontSize: 12, lineHeight: 1.8 }}>
              {!whisperTo && <div className="text-muted">先选一个私聊对象</div>}
              {whisperTo && thread.length === 0 && <div className="text-muted">还没有私聊记录</div>}
              {thread.map((m, i) => (
                <div key={i} style={{ padding: "3px 0" }}>
                  <span className="text-dim">{m.self ? "你" : m.fromName}：</span>{m.content}
                </div>
              ))}
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

// ===== 线索正文（列表与复盘共用） =====
//
// 线索正文也要过 ScriptBody：线索里可能带配图（`![说明](img:键名)` 独立成行），
// 例如《吉普赛女郎之死》的 B1/B2/B7 —— 那两张伤口形状图是"内脏镜像分布"核心诡计的唯一证据，
// 按纯文本渲染的话玩家只会看到一行裸的 `![线索·图片1](img:cluedoc-1)`，诡计就推不出来了。
// scriptId 拿不到时 ScriptBody 自动退回文本渲染，线索本身仍然完整显示（绝不允许整条消失）；
// 取正文用哪几个字段由 lib/clue-body.mjs 统一口径（玩家端两处 + 管理端一处共用）。
function ClueBody({ clue, scriptId }) {
  const text = clueBodyText(clue);
  return (
    <div className="clue-body">
      {text ? <ScriptBody text={text} scriptId={scriptId} /> : null}
    </div>
  );
}

// ===== 线索列表（按大地点分组 + 类别筛选） =====
//
// 归组逻辑抽到了 lib/clue-place.mjs（纯 ESM，可被单测覆盖）——
// 旧实现依赖写死的房间名词表，动态生成的房间匹配不到就各自成组，
// 界面上看着"有分组"但实际等于没分。详见那个文件里的说明。
//
// 筛选控件这里踩过两次坑，值得记一笔：
//   1) 一开始没有筛选，几十条线索平铺，找一条要滚很久；
//   2) 改成"按大地点筛选"的下拉框之后，一局 29 条线索拆出 21 个大地点，
//      下拉框里 22 个选项，比不筛还累 —— 因为筛选粒度比线索粒度还细。
// 所以现在只按"类别"（地点 / 人物证词 / 搜身物品）筛选，一共 4 个按钮；
// 想定位到具体某个地点，靠分组头本身 —— 每个分组头都能点开/收起，
// 全收起时就等于一份地点目录。
function GroupedClues({ clues, scriptId }) {
  const [cat, setCat] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

  const groups = groupCluesByPlace(clues);
  if (groups.length === 0) return null;

  const stats = clueCategoryStats(clues);
  const total = (clues || []).length;
  const shown = cat ? groups.filter((g) => g.cat === cat) : groups;
  const allCollapsed = shown.length > 0 && shown.every((g) => collapsed.has(g.key));

  const toggle = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      {groups.length > 1 && (
        <div className="chip-row" style={{ marginBottom: 8 }}>
          <button
            type="button"
            className={"chip" + (cat === "" ? " active" : "")}
            onClick={() => setCat("")}
            title={`全部线索：${total} 条 / ${groups.length} 个大地点`}
          >
            全部 {total}
          </button>
          {stats.map((s) => (
            <button
              key={s.cat}
              type="button"
              className={"chip" + (cat === s.cat ? " active" : "")}
              onClick={() => setCat(cat === s.cat ? "" : s.cat)}
              title={`${s.cat}：${s.clues} 条线索 / ${s.groups} 个大地点`}
            >
              {s.cat} {s.clues}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(shown.map((g) => g.key)))}
            title={allCollapsed ? "展开每个地点下的线索" : "只留地点目录，收起来快速扫"}
          >
            {allCollapsed ? "展开" : "收起"}
          </button>
        </div>
      )}
      <div className="evidence-panel">
        {shown.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div key={g.key} className="clue-group">
              <button
                type="button"
                className="clue-group-head"
                onClick={() => toggle(g.key)}
                title={isCollapsed ? "展开该地点的线索" : "收起该地点的线索"}
                aria-expanded={!isCollapsed}
              >
                <span style={{ opacity: 0.65, width: 10, flexShrink: 0 }}>{isCollapsed ? "▸" : "▾"}</span>
                {/* 生成阶段偶尔会把发现地点落成"未知"（当前示例剧本 42 条线索全是这个值）。
                    这不是前端能修的 —— 与其顶着一个地点图钉写"未知"，不如老实说没记录。 */}
                <span>{g.label === "未知" ? "地点未记录" : `📍 ${g.label}`}</span>
                {g.cat !== "地点" ? <span className="text-muted" style={{ fontWeight: 400 }}>（{g.cat}）</span> : null}
                <span className="badge clue-count">{g.items.length}</span>
              </button>
              {!isCollapsed && (
                <div className="clue-group-body">
                  {g.items.map(({ clue: c, sub, place }, i) => (
                    <div key={i} className="clue-item">
                      <div className="clue-head">
                        <span className="clue-id">{c.clueId || c.id || c.title || c.label || "?"}</span>
                        {/* 细分位置（地面/栏杆/内壁…）和被前缀归并掉的原始地点都留在条目上，否则归组会丢信息 */}
                        {sub ? <span className="text-muted text-xs">（{sub}）</span> : null}
                        {place && place !== g.label ? <span className="tag">{place}</span> : null}
                        {c.foundByName ? <span className="text-xs text-muted" style={{ marginLeft: "auto" }}>{c.foundByName} 发现</span> : null}
                      </div>
                      <ClueBody clue={c} scriptId={scriptId} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== 投票 =====
function VotingView({ players, myChar, recordedTarget, voteCount, voteTotal, gameMode, onVote }) {
  // 可投对象的口径统一在 lib/vote.mjs（与服务端 cast_vote 的校验逐条对齐）。
  // ⚠️ 历史缺陷（实测房间 BM4AFM 整局卡死）：这里原本写的是
  //     players.filter((p) => p.characterName && !(gameMode === "PVP" && p.isNPC))
  //   而 **AI 补位的也是 isNPC: true**，于是 PVP 下 5 个 AI 补位角色全被滤掉，
  //   只剩自己那张卡、自己又不可自投 → 一个可点项都没有，玩家一票都投不出。
  const targets = votablePlayers(players, gameMode);
  // 分母兜底：服务端只在**有人投过票之后**才通过 vote_update 带上 total，
  // 在那之前 voteTotal 是 0，界面会显示 "投票指控（0/0）" —— 看起来像坏了。
  // 这里按同一口径（有角色且可投的玩家）本地算一个下限。
  const total = voteTotal || targets.length;
  return (
    <div className="panel">
      <div className="panel-head">
        <strong>🗳️ 投票指控</strong>
        <span className="tag tag-danger" style={{ marginLeft: 4 }}>{voteCount}/{total} 已投</span>
      </div>

      {recordedTarget ? (
        <div className="alert alert-success">
          <span className="alert-body">你已投票指控：<strong>{recordedTarget}</strong>（不可更改）</span>
        </div>
      ) : (
        <div>
          <p className="text-sm text-dim" style={{ marginBottom: 14 }}>
            你认为谁是凶手？投票后不可更改。全员投完后点上方「提交并查看真相」揭晓。
          </p>
          {targets.length === 0
            ? <div className="state-empty">暂无可投票对象</div>
            : (
              <div className="vote-grid stagger">
                {targets.map((p) => {
                  const isSelf = !canVoteFor(p.characterName, myChar?.name);
                  return (
                    <button
                      key={p.characterName}
                      className="vote-card"
                      disabled={isSelf}
                      onClick={() => onVote(p.characterName)}
                    >
                      <span className="vote-name">{p.characterName}</span>
                      <span className="vote-hint">{isSelf ? "你自己" : "指控为凶手"}</span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// ===== 真相复盘 =====
function TruthView({ narrative, review, finished, myReview, myReviewState, onLoadMyReview, scriptId }) {
  const murderer = review?.murderer || {};
  return (
    <div>
      {/* 结案卷宗的抬头：凶手名字是这一屏唯一的主角，
          所以给它整块深红横幅 + 大字，而不是塞在一行 alert 里。 */}
      <div className="verdict-band">
        <div className="verdict-label">{finished ? "已结案" : "真相"}</div>
        <div className="verdict-name">{murderer.name || "？"}</div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>{finished ? "🏁 游戏结束" : "🔦 案件真相"}</strong>
          <span className="text-xs text-dim">完整卷宗</span>
        </div>
        {/* 长文一律上纸面 —— 手法、动机、真相都是"读的材料"，
            压在红色横幅上既难读、又让横幅失去"一句话结论"的作用。
            注意三者都可能带 markdown（模型写的 `**（详细过程）` 之类），
            所以统统走 ScriptBody，不能直接当纯文本塞进 JSX。 */}
        <div className="paper-surface">
          <div className="script-reader" style={{ maxWidth: "72ch" }}>
            {murderer.method && (
              <>
                <h3 style={{ marginTop: 0 }}>作案手法</h3>
                <ScriptBody text={murderer.method} />
              </>
            )}
            {murderer.motive && (
              <>
                <hr />
                <h3>动机</h3>
                <ScriptBody text={murderer.motive} />
              </>
            )}
            <hr />
            {/* 真相复盘正文里也有配图（实测 344 号剧本的 img:truth-1，"子弹弹道"那张示意图
                就在这一节里）。这里以前漏传 scriptId → ScriptBody 只能退回文本，
                玩家在复盘里看到的是裸的图片语法。顺手补上：不传 scriptId 时行为不变。 */}
            <ScriptBody text={review?.truthReveal || narrative || "复盘内容生成中…"} scriptId={scriptId} />
          </div>
        </div>
      </div>

      {review && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, alignItems: "start" }}>
          <div className="panel">
            <div className="panel-head"><strong>投票分布</strong></div>
            {(review.votes || []).length === 0
              ? <div className="text-xs text-muted">无投票记录</div>
              : (review.votes || []).map((v, i) => (
                <div key={i} className="field-row">
                  <span className="field-key">{v.voter}</span>
                  <span className="field-val" style={{ color: v.target ? "var(--wax-bright)" : "var(--text-muted)" }}>
                    {v.target || "未投"}
                  </span>
                </div>
              ))}
          </div>

          <div className="panel">
            <div className="panel-head">
              <strong>线索发现</strong>
              {(review.clues || []).length > 0 && <span className="tag" style={{ marginLeft: "auto" }}>{review.clues.length} 条</span>}
            </div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {(review.clues || []).length === 0
                ? <div className="text-xs text-muted">无线索记录</div>
                : (review.clues || []).map((c, i) => (
                  <div key={i} className="clue-item">
                    <div className="clue-head">
                      <span className="tag">第 {c.round} 轮</span>
                      <span className="text-xs text-muted">{c.location || "未知"}</span>
                      {c.foundBy ? <span className="text-xs" style={{ color: "var(--verd-bright)", marginLeft: "auto" }}>{c.foundBy}</span> : null}
                    </div>
                    <ClueBody clue={c} scriptId={scriptId} />
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== 结算榜 ===== */}
      {/* 分数由投票/阵营/线索/发言算出，不含 LLM 判断 —— 同样的局永远同样的分 */}
      {review?.scoreboard?.board?.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <strong>🏆 本局结算</strong>
            <span className={`tag ${review.scoreboard.winner === "murderer" ? "tag-danger" : "tag-success"}`} style={{ marginLeft: 4 }}>
              {review.scoreboard.winner === "murderer" ? "凶手成功脱身" : "玩家阵营获胜"}
            </span>
          </div>
          <p className="text-xs text-muted" style={{ marginBottom: 10 }}>
            指认真凶 +30 ｜ 凶手脱身 +40 ｜ 每条线索 +5（上限 20）｜ 每次发言 +2（上限 10）
          </p>
          {review.scoreboard.board.map((row, i) => (
            <div key={row.playerId || i} className={`score-row${i === 0 ? " is-winner" : ""}`}>
              <span className="score-rank">{i + 1}</span>
              <span className="score-name">
                {row.name}
                {row.isAI ? <span className="text-muted text-xs"> AI</span> : null}
                {row.isMurderer ? <span className="tag tag-danger" style={{ marginLeft: 6 }}>凶手</span> : null}
              </span>
              <span className="score-detail">{row.verdict} ｜ 线索 {row.clueCount} ｜ 发言 {row.speechCount}</span>
              <span className="score-total">{row.total}</span>
            </div>
          ))}
        </div>
      )}

      {/* ===== 我的专属复盘 ===== */}
      {/* 与上面的全局复盘分开：这份只在本人浏览器里生成与展示，含自己的秘密与推理失误 */}
      <div className="panel">
        <div className="panel-head">
          <strong>🧠 我的专属复盘</strong>
          <span className="text-xs text-dim">只有你能看到</span>
        </div>

        {!myReview && myReviewState !== "loading" && (
          <div>
            <p className="text-xs text-muted" style={{ marginBottom: 12, maxWidth: "62ch", lineHeight: 1.8 }}>
              基于你自己的发言、搜到的线索和最终投票，复盘你这局的推理路径 ——
              只在你的页面上生成，不会展示给其他人。
            </p>
            {myReviewState === "error" ? (
              <div className="alert alert-danger" style={{ marginBottom: 10 }}>
                <span className="alert-body">生成失败（模型服务可能正忙），可以再试一次。</span>
              </div>
            ) : null}
            <button className="btn btn-primary btn-auto" onClick={onLoadMyReview}>
              {myReviewState === "error" ? "重试" : "生成我的复盘"}
            </button>
          </div>
        )}

        {myReviewState === "loading" && (
          <div className="state-loading" style={{ padding: "24px 0" }}>正在分析你这局的推理路径…（约 10~20 秒）</div>
        )}

        {myReview && (
          <div className="paper-surface">
            <div className="script-reader" style={{ maxWidth: "72ch" }}>
              <ScriptBody text={myReview.text} />
            </div>
            {myReview.source === "fallback" && (
              <div className="text-xs paper-dim" style={{ marginTop: 12, textAlign: "center" }}>
                （模型服务暂不可用，以上为本局事实摘要）
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
