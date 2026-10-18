import React, { useState, useEffect, useRef } from "react";
import { apiJson, api, getToken } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";
import { ScriptBody } from "../components/ScriptBody.jsx";
import { SideRail } from "../components/SideRail.jsx";
import { clueBodyText } from "../lib/clue-body.mjs";

const PHASE_TEXT = {
  lobby: "等待开局", reading: "阅读剧本", intro: "自我介绍",
  round1: "第一轮搜证与讨论", round2: "第二轮搜证与讨论",
  voting: "投票指控", truth_reveal: "真相揭晓", finished: "已结束",
};

/**
 * 管理端「测试剧本」：所有玩家位由 AI 扮演，管理员只旁观。
 *
 * 目的是**发现剧本本身的问题**（线索能不能被搜到、时间线对不对得上、AI 会不会自相矛盾、
 * 凶手有没有被一眼看穿），所以界面刻意把这几样摊开：
 *   · 公屏实时流（AI 的发言、提问、回答、投票、DM 叙事、搜到线索）
 *   · 全部线索清单 + 是否已被发现（没被发现的线索 = 玩家永远看不到的信息）
 *   · 真凶 + 结算（管理员本来就知道，放这里是为了对照"AI 有没有被误导/误导得对不对"）
 * 这些数据只发给管理员：服务端的旁观通道仅限 admin 且仅限测试房（见 socket/game.js 的 spectate_room）。
 */
import PlayerTimeline from "./PlayerTimeline";
import { fmtClock, phaseSteps, phaseStep, tallyStream, voteRows, relationText, identityText, furthestPhase, PHASE_SHORT } from "../lib/test-run-widgets.mjs";

/** 侧边栏页签：八块内容里除"常驻摘要"外的六块，一次点击可达。
 *  为什么必须有页签：380px 的窄列塞不下六个部件，硬叠起来实测会落到视口之外（等于看不见）。 */
const SIDE_TABS = [["clue", "线索"], ["script", "人物"], ["roster", "关系"], ["dm", "DM"], ["timeline", "时间线"], ["stats", "统计"]];
/** 模块 key → 中文名（弹框标题用；找不到就退回 key 本身，不抛错） */
const moduleLabel = (k) => (SIDE_TABS.find(([key]) => key === k) || [k, k])[1];
/** 左侧模块栏的图标。用 emoji 而不是引图标库：本项目其它面板（玩家页情报台）已是这个做法，
 *  为零散几个入口引一整套图标依赖不值当。 */
const MODULE_ICON = { clue: "🔍", script: "📖", roster: "👥", dm: "🗝️", timeline: "🕰️", stats: "📊" };

/** 公屏 kind 的中文名（只用于统计页签里那一行对账） */
const KIND_TEXT = {
  chat: "发言/提问/投票", phase: "阶段", narrative: "DM 叙事",
  truth: "真相", error: "错误", aiError: "AI 异常", report: "报告",
};

export default function TestRunPage() {
  const [scripts, setScripts] = useState([]);
  const [scriptId, setScriptId] = useState("");
  const [phaseMinutes, setPhaseMinutes] = useState(1);
  const [run, setRun] = useState(null);          // {roomCode, aiPlayers, title}
  const [state, setState] = useState(null);      // spectate_ready 的产物
  const [stream, setStream] = useState([]);      // 实时事件流
  const [truth, setTruth] = useState(null);
  const [onlyUnfound, setOnlyUnfound] = useState(false);   // 「只看未发现」：查错时只关心没被搜到的
  // 搜证动态单独放：**不塞进公屏流**——玩家端也是把线索放进线索面板而不是聊天，
  // 搜证刷屏会把玩家发言淹没（这是这次要修的体验问题）。
  const [recentClues, setRecentClues] = useState([]);
  const [scriptPack, setScriptPack] = useState(null);      // 全部角色剧本（管理员对照用）
  const [openChar, setOpenChar] = useState("");            // 展开中的角色
  const [openClue, setOpenClue] = useState("");            // 展开中的线索（按钮式查看）
  // 六个模块（线索/人物/关系/DM/时间线/统计）改成**按钮 + 弹框**：
  // 原来它们常驻在 380px 的右侧栏里，等于永久吃掉公屏的宽度，而这六块都是"需要时看一眼"的。
  // openModule = 当前打开的模块 key（null = 都没开）；同一时刻只弹一个。
  const [openModule, setOpenModule] = useState(null);
  // GET /api/admin/test-runs 里**本房间**那一条 meta（阶段流水 phaseLog / 设定时长 phaseMs / finished）。
  // 为什么不能只用 state：阶段流水只在服务端登记里，spectate_ready 不含它；
  // 而"哪一段在拖时间"正是这一页要看的东西之一。
  const [runMeta, setRunMeta] = useState(null);
  // 一个跟轮询同频的时钟：当前阶段的"已用时"靠它推进（不单独开 1 秒定时器，没必要为了秒级跳动
  // 让整页（含几百条公屏）每秒重渲染一次）。
  const [now, setNow] = useState(() => Date.now());
  // 每个角色搜到几条线索（来自 clue_received 事件，按线索 id 去重）。
  // 为什么另开一份：state.clues 只有"有没有被发现"，没有发现者；而"某个 AI 一直没搜到东西"
  // 与"某个 AI 一直没说话"同样是剧本问题的信号。
  const [clueTally, setClueTally] = useState({});
  const clueSeenRef = useRef(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const feedRef = useRef(null);

  async function loadScripts() {
    try {
      const d = await apiJson("/api/admin/scripts?pageSize=100");
      const list = (d.scripts || d.list || []).filter((s) => s && s.sessionId);
      // 只能测**已切分**的剧本（运行时读的是切分数据）
      setScripts(list.filter((s) => s.isSplit !== false));
    } catch (e) { /* ignore */ }
  }
  useEffect(() => { loadScripts(); }, []);

  // 刷新页面不该丢掉正在看的测试：启动时回读服务端登记的测试房并自动重新旁观。
  // （测试局要看几分钟，中途刷个页面就得从头再开一局，手感很差。）
  useEffect(() => {
    (async () => {
      try {
        const d = await apiJson("/api/admin/test-runs");
        const live = (d.runs || []).filter((r) => !r.finished);
        if (!live.length) return;
        const r = live[live.length - 1];
        setRun({
          roomCode: r.roomCode, aiPlayers: [], title: r.title || "",
          phaseMinutes: Math.max(1, Math.round((r.phaseMs || 0) / 60000)),
          turnCycleSec: Math.max(1, Math.round((r.turnCycleMs || 0) / 1000)),
        });
      } catch (e) { /* 没有在跑的测试就算了 */ }
    })();
  }, []);

  // 订阅旁观事件（组件卸载时清理）
  useEffect(() => {
    if (!run) return undefined;
    const sock = getSocket();
    const push = (kind, text) => setStream((prev) => [...prev, { at: Date.now(), kind, text }]);

    const onReady = (d) => {      setState(d);
      // 刷新页面/重新旁观时要把**已经发生过的公屏**补上：否则"公屏实录 0 条"会让人以为
      // AI 一句话没说（实测截图就是这样，看着像测试没跑起来）。
      if (Array.isArray(d.chat) && d.chat.length) {
        setStream((prev) => (prev.length ? prev : d.chat.map((m) => ({
          at: m.timestamp ? Date.parse(m.timestamp) : Date.now(),
          kind: "chat",
          text: `${m.characterName || m.playerName || "?"}：${m.content}`,
        }))));
      }
    };
    const onPhase = (p) => { setState((s) => (s ? { ...s, phase: p.phase, label: p.label || PHASE_TEXT[p.phase] || p.phase } : s)); push("phase", `进入「${p.label || PHASE_TEXT[p.phase] || p.phase}」`); };
    const onStarted = (g) => push("phase", `开局（${PHASE_TEXT[g.phase] || g.phase}）`);
    const onChat = (m) => push("chat", `${m.characterName || m.playerName}：${m.content}`);
    const onNarrative = (n) => push("narrative", n.text);
    const onClue = (c) => {
      // ⚠️ 进"搜证动态"而**不是**公屏流：公屏只留玩家发言/DM/阶段/真相，否则读不清别人说了什么
      // （玩家端本来也是这个口径：clue_received 进线索面板，不进聊天）。
      setRecentClues((prev) => ([{
        at: Date.now(), who: c.foundBy || "?", id: (c.clue && c.clue.id) || "?",
        content: String((c.clue && c.clue.content) || "").slice(0, 34),
      }, ...prev]).slice(0, 8));
      // 按发现者累计（统计页签用）。**按线索 id 去重**：同一条线索被搜到两次（代码搜证 + AI 出手）
      // 会各发一次事件，不去重的话"搜到线索总数"会比线索体检里的"已发现 N/M"多出来。
      const cid = (c.clue && c.clue.id) || "?";
      if (!clueSeenRef.current.has(cid)) {
        clueSeenRef.current.add(cid);
        const who = c.foundBy || "?";
        setClueTally((prev) => ({ ...prev, [who]: (prev[who] || 0) + 1 }));
      }
      setState((s) => {
        if (!s || !s.clues) return s;
        return { ...s, clues: s.clues.map((x) => (x.id === (c.clue && c.clue.id) ? { ...x, found: true } : x)) };
      });
    };
    const onTruth = (t) => { setTruth(t); push("truth", `真相揭晓：真凶 ${t.murdererName}（${t.outcome}）`); };
    const onErr = (e) => { if (e && e.code !== "RATE_LIMITED") push("error", `[${e.code}] ${e.message || ""}`); };
    // AI 回合异常：**必须让管理员看见**。以前只进容器日志，于是一次 LLM 超时
    // 会被误读成"AI 不按剧本演 / 剧本有问题" —— 而测试的目的正是判断剧本。
    const onAiError = (e) => push("aiError", `AI 异常：${e.name || "?"}／${e.kind || "?"} —— ${e.message || ""}`);
    // 报告落库成功（由服务端在跑完时发出）
    const onReportReady = (d) => push("report", `报告已生成（${d.verdictText || d.verdict}${d.reportId ? " #" + d.reportId : "，入库失败"}）—— 见「测试报告」标签`);

    sock.on("spectate_ready", onReady);
    sock.on("phase_changed", onPhase);
    sock.on("game_started", onStarted);
    sock.on("chat_message", onChat);
    sock.on("narrative", onNarrative);
    sock.on("clue_received", onClue);
    sock.on("truth_revealed", onTruth);
    sock.on("error", onErr);
    sock.on("ai_error", onAiError);
    sock.on("test_report_ready", onReportReady);
    sock.emit("spectate_room", { roomCode: run.roomCode, token: getToken() });

    return () => {
      sock.off("spectate_ready", onReady);
      sock.off("phase_changed", onPhase);
      sock.off("game_started", onStarted);
      sock.off("chat_message", onChat);
      sock.off("narrative", onNarrative);
      sock.off("clue_received", onClue);
      sock.off("truth_revealed", onTruth);
      sock.off("error", onErr);
      sock.off("ai_error", onAiError);
      sock.off("test_report_ready", onReportReady);
    };
  }, [run]);

  // 角色剧本：测试时最需要对照的东西（AI 有没有照着剧本演、剧本之间有没有矛盾、真凶有没有被一眼看穿）。
  // 剧本在整局里不变，所以开局取一次就够。
  useEffect(() => {
    if (!run) { setScriptPack(null); return undefined; }
    let alive = true;
    (async () => {
      try {
        const d = await apiJson(`/api/admin/test-runs/${run.roomCode}/scripts`);
        if (alive) setScriptPack(d);
      } catch (e) { if (alive) setScriptPack(null); }
    })();
    return () => { alive = false; };
  }, [run]);

  // 阶段流水与设定时长：轮询测试房登记（8 秒一次，同时把 now 推进一步）。
  // 为什么轮询而不是只听 socket：phaseLog 只在服务端登记里（spectate_ready 不带它），
  // 而"各阶段实际花了多久"要看这份流水；8 秒的延迟对分钟级的阶段足够，也不会刷屏。
  useEffect(() => {
    if (!run) { setRunMeta(null); return undefined; }
    let alive = true;
    const tick = async () => {
      try {
        const d = await apiJson("/api/admin/test-runs");
        const hit = (d.runs || []).find((r) => r.roomCode === run.roomCode);
        if (alive && hit) setRunMeta(hit);
      } catch (e) { /* 轮询失败不打扰管理员，下一次再来 */ }
      if (alive) setNow(Date.now());
    };
    tick();
    const t = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [run]);

  // 新消息自动滚到底
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [stream.length]);

  async function start() {
    if (!scriptId) { setError("请先选一个剧本"); return; }
    // 夹取阶段时长（与服务端同一区间）：输入框的 min/max 只在表单提交时校验，
    // 而这里按钮不是 submit，所以必须自己夹 —— 手滑填 10000 会是一局 8 天。
    const mins = Math.max(1, Math.min(60, Math.round(Number(phaseMinutes) || 1)));
    setBusy(true); setError(""); setStream([]); setTruth(null); setState(null); setRecentClues([]); setOpenChar("");
    // 新的一局：阶段流水/搜证计数/时钟都要归零，否则摘要会显示上一局的耗时
    setRunMeta(null); setClueTally({}); clueSeenRef.current = new Set(); setNow(Date.now());
    try {
      const d = await apiJson("/api/admin/test-runs", {
        method: "POST", body: JSON.stringify({ scriptSessionId: scriptId, phaseMinutes: mins }),
      });
      setRun({ roomCode: d.roomCode, aiPlayers: d.aiPlayers || [], title: d.title, phaseMinutes: d.phaseMinutes, turnCycleSec: d.turnCycleSec });
    } catch (e) { setError("开测失败：" + e.message); }
    finally { setBusy(false); }
  }

  async function stop() {
    if (!run) return;
    if (!confirm(`结束测试并关闭房间 ${run.roomCode}？`)) return;
    try { await api(`/api/admin/test-runs/${run.roomCode}`, { method: "DELETE" }); } catch (e) { /* 房间可能已回收 */ }
    setRun(null); setState(null); setStream([]); setTruth(null); setRecentClues([]); setScriptPack(null); setOpenChar("");
    setRunMeta(null); setClueTally({}); clueSeenRef.current = new Set();
  }

  const foundCount = state && state.clues ? state.clues.filter((c) => c.found).length : 0;
  // 每一轮的线索覆盖情况。判据来自机制本身：AI 会一直搜到**本轮线索池为空**才停
  // （game/ai-player.js 里 actInvestigate 的续搜逻辑）。所以：
  //   本轮 100% → 这一轮搜证是干净的，此时仍标 ✘ 的线索只可能是"还没到的下一轮"
  //   本轮 <100% → 阶段结束得比搜证早，此时 ✘ **不能**用来判断线索有问题
  //   （实测踩过：AI 的续搜判据误读了"不限次数"，一局 50 条只翻出 6 条就停手了）
  function roundStat(round) {
    const pool = (state && state.clues ? state.clues : []).filter((c) => (c.round || 0) === round);
    const got = pool.filter((c) => c.found).length;
    return { pool: pool.length, got, swept: pool.length > 0 && got === pool.length };
  }
  const roundNums = [...new Set((state && state.clues ? state.clues : []).map((c) => c.round || 0))].filter((r) => r > 0).sort((a, b) => a - b);
  const sweptRounds = roundNums.filter((r) => roundStat(r).swept);
  // 刷新后恢复的那次旁观拿不到启动时的 aiPlayers，就用旁观数据里的角色补上
  const aiNames = (run && run.aiPlayers && run.aiPlayers.length)
    ? run.aiPlayers
    : ((state && state.players) ? state.players.filter((p) => p.isAI).map((p) => p.characterName).filter(Boolean) : []);

  // ===================== 侧边栏八个部件的数据 =====================
  // 图片渲染用的剧本 id：优先用**测试房登记里的** scriptSessionId —— 刷新页面后
  // 顶部下拉框的 scriptId 是空的，只有登记里这一份才是"这一局用的剧本"，
  // 拿它去拼 /api/scripts/:id/images/:key 才能让线索/DM 手册里的配图在刷新后仍然显示。
  const sid = (runMeta && runMeta.scriptSessionId) || scriptId;
  // 当前阶段：取"登记 / socket 事件 / 是否已收到真相"里**最靠后**的那一个。
  // 为什么不能只看登记：实测这一局真相事件先到（AI 全投完票 → vote-advance 直接推到 truth_reveal
  // 并广播 truth_revealed），而测试房自己的登记要等它的计时器才写上投票段的结束 ——
  // 只信登记就会出现"真相都出来了，进度还写着投票"。
  const metaPhase = furthestPhase([runMeta && runMeta.phase, state && state.phase, truth ? "truth_reveal" : ""]);
  const step = phaseStep(metaPhase);
  // ① 阶段进度与各阶段耗时（常驻摘要）：只按服务端真实登记的 phaseLog 画，
  //    实测有房间会跳过 truth_reveal 直接落 finished，按固定阶段表补行就会多/少一块。
  const { rows: phaseRows, elapsedMs } = phaseSteps(runMeta && runMeta.phaseLog, {
    now, phaseMs: runMeta && runMeta.phaseMs, finished: !!(runMeta && runMeta.finished), currentPhase: metaPhase,
  });
  // ③ 投票分布与结局（常驻摘要）
  const votes = voteRows(truth);
  const maxVotes = votes.rows.length ? Math.max(...votes.rows.map((r) => r.count)) : 0;
  // ② AI 行为统计（页签）：公屏按 kind 聚合，chat 再按发言人拆
  const chatStats = tallyStream(stream);
  const clueTallyReady = Object.keys(clueTally).length > 0;
  const statRows = (() => {
    const names = aiNames.slice();
    for (const s of chatStats.speakers) if (!names.includes(s.name)) names.push(s.name);
    return names.map((name) => {
      const sp = chatStats.speakers.find((s) => s.name === name);
      return {
        name, isAI: aiNames.includes(name),
        talk: sp ? sp.talk : 0, asked: sp ? sp.asked : 0, voted: sp ? sp.voted : 0,
        fallback: sp ? sp.fallback : 0,
        // 刷新后事件没了 → 按角色的搜证数不可知，显示 "—" 而不是假的 0
        clue: clueTallyReady ? (clueTally[name] || 0) : null,
      };
    }).sort((a, b) => (b.talk + b.asked + b.voted) - (a.talk + a.asked + a.voted) || a.name.localeCompare(b.name, "zh"));
  })();
  const silentAI = statRows.filter((r) => r.isAI && !r.talk && !r.asked && !r.voted);
  // ④ DM 手册各节（走 ScriptBody 渲染，配图才会显示）
  const dm = scriptPack && scriptPack.dmGuide ? scriptPack.dmGuide : null;
  const dmAll = dm ? [
    ["开场白", dm.openingMonologue],
    ["完整时间线", dm.fullTimeline],
    ["真相复盘", dm.truthReveal],
    ["真结局", dm.endings && dm.endings.trueEnding],
    ["凶手逃脱结局", dm.endings && dm.endings.escapeEnding],
    ["误判结局", dm.endings && dm.endings.wrongEnding],
  ] : [];
  // 有正文的照常渲染；空小节**不铺一堆空框**（那样最像"界面空"），改成末尾一行列出来：
  // "缺哪几节"本身就是这个剧本的问题，但它是诊断信息，不该占半屏。
  const dmSections = dmAll.filter(([, t]) => String(t || "").trim());
  const dmMissing = dmAll.filter(([, t]) => !String(t || "").trim()).map(([title]) => title);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>测试剧本</h2>
          <p>
            全部玩家由 AI 扮演，你只旁观。用来发现剧本问题：线索是否都能被搜到、时间线是否自洽、
            AI 会不会自相矛盾、真凶是否一眼被看穿。
          </p>
        </div>
        <div className="page-head-actions">
          {run ? <button className="btn btn-outline btn-sm" onClick={stop}>■ 结束测试</button> : null}
        </div>
      </div>

      {!run && (
        <div className="panel">
          <div className="panel-head"><strong>开始一局测试</strong></div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select className="form-select" style={{ minWidth: 280 }} value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
              <option value="">选择剧本…</option>
              {scripts.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {(s.topic || s.title || s.sessionId)}（{s.characterCount || "?"} 人）
                </option>
              ))}
            </select>
            <label className="text-xs text-dim">
              每阶段
              <input className="form-input" style={{ width: 64, margin: "0 6px" }} type="number" min="1" max="60"
                value={phaseMinutes} onChange={(e) => setPhaseMinutes(e.target.value)} />
              分钟（测试用压缩节奏，正式局是 10 分钟；上限 60 分钟）
            </label>
            <button className="btn btn-primary" disabled={busy} onClick={start}>{busy ? "启动中…" : "▶ 开始测试"}</button>
          </div>
          {error ? <div className="text-xs" style={{ color: "var(--danger)", marginTop: 8 }}>{error}</div> : null}
        </div>
      )}

      {run && (
        <>
          <div className="panel">
            <div className="panel-head">
              <strong>{run.title || "测试局"}</strong>
              <span className="text-xs text-dim">房间 {run.roomCode}｜AI 玩家 {aiNames.length} 个｜每阶段 {run.phaseMinutes} 分钟｜AI 出手每 {run.turnCycleSec} 秒一次</span>
              {/* 真相揭晓时阶段徽章要跟着变：autoAdvancePhase 在真相阶段**有意只广播 truth_revealed**
                  而不广播 phase_changed（避免覆盖玩家端 renderGame 的真相数据），
                  所以这里不能只依赖 phase_changed，否则真相都出来了徽章还写着"投票阶段"。 */}
              {state ? <span className="badge" style={{ marginLeft: "auto" }}>{truth ? "真相揭晓" : (state.label || PHASE_TEXT[state.phase] || state.phase)}</span> : null}
            </div>
            <div className="text-xs text-dim">
              {aiNames.join("、") || "（旁观中…）"}
              {truth ? <span style={{ color: "var(--warning)" }}>　｜ 真凶：{truth.murdererName}　｜ 结局：{truth.outcome}</span>
                : (state && state.murdererName ? <span style={{ color: "var(--warning)" }}>　｜ 真凶（仅你可见）：{state.murdererName}</span> : null)}
            </div>
          </div>

          {/* 两列布局：主列（公屏实录，宽）｜右侧常驻侧边栏（摘要 + 六个页签部件，窄）。
              为什么长这样：
              ① 原先四个面板一起 flex-wrap 平铺（420/auto/340/340），第二行只有 340+340，
                 右侧空出一大片 —— 这就是"界面有点空"的来源；
              ② 现在六个部件（阶段耗时/统计/投票/关系/DM 手册/时间线）全进侧边栏，
                 380px 一列装不下八块内容，所以拆成"常驻摘要（不占页签）+ 六个页签"；
              ③ 主列只剩公屏，它必须**自己撑满整列**（flex:1 + 内层 overflow），
                 否则时间线搬走之后主列底部会空出一大块 —— 又一次"界面有点空"。
                 行高由内容决定（谁高听谁的）：alignItems:stretch 让主列跟着侧边栏一样高，
                 所以两列的底边永远对齐。**刻意不给行加 minHeight** ——
                 实测加了 calc(100vh - 200px) 之后，切到内容较短的页签（统计）时
                 侧边栏只有 636px 而行被撑到 779px，右下角就空出 380×143 一块（正是"成片空白"）；
                 去掉之后行高 = 内容高，两列底边齐平。 */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
            {/* 左侧模块栏：与玩家对局页共用 components/SideRail.jsx（用户要求两边长得一样）。
                点一个弹一个框（面板内容在下面的 modal 里）；order 与主列同为 1 → 两者并排一行。 */}
            <SideRail
              items={SIDE_TABS.map(([k, label]) => ({ key: k, icon: MODULE_ICON[k], label, title: `打开「${label}」` }))}
              onSelect={setOpenModule}
              active={openModule || ""}
              order={1}
            />

            <div style={{ flex: "1 1 560px", minWidth: 320, display: "flex", flexDirection: "column", order: 1 }}>
            <div className="panel" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, marginBottom: 0 }}>
              <div className="panel-head"><strong>公屏实录</strong><span className="text-xs text-dim">{stream.length} 条</span></div>
              {/* 高度跟着视口走：公屏是这一页的主内容（旁观时一直在读），
                  原来固定 minHeight:360 会让下方留出一大片页面底色。
                  470px 是"顶栏 + 页头 + 剧本卡 + 实时摘要 + 间距"的大致高度；
                  max(420px, …) 是小窗口下的下限，避免压成一条。 */}
              <div ref={feedRef} style={{ flex: "1 1 0", minHeight: "max(420px, calc(100vh - 470px))", overflowY: "auto", paddingRight: 4 }}>
                {stream.map((e, i) => (
                  <div key={i} className="text-xs" style={{ marginBottom: 6, lineHeight: 1.7 }}>
                    <span className="text-dim">{new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}　</span>
                    {e.kind === "chat" ? null : (
                      <span style={{
                        color: e.kind === "truth" ? "var(--warning)"
                          : (e.kind === "error" || e.kind === "aiError") ? "var(--danger)"
                          : e.kind === "report" ? "var(--success, #6b8)"
                          : "var(--brass, var(--accent))",
                      }}>
                        【{e.kind === "phase" ? "阶段"
                          : e.kind === "narrative" ? "DM"
                          : e.kind === "truth" ? "真相"
                          : e.kind === "aiError" ? "异常"
                          : e.kind === "report" ? "报告"
                          : e.kind}】
                      </span>
                    )}
                    {e.text}
                  </div>
                ))}
                {!stream.length ? <div className="text-xs text-dim">等待 AI 行动…（第一阶段是阅读剧本，AI 在这里预备自我介绍）</div> : null}
              </div>
            </div>
            </div>

            {/* 实时摘要 + 六个模块按钮：占满整幅宽度的一段（原来是 380px 的常驻侧边栏）。
                ⚠️ 模块面板本身已经移进弹框（见下面的 modal），所以这里不再需要 sticky /
                内部滚动 —— 那两个属性当初只是为了"侧边栏比视口高时内部滚"。
                摘要仍然常驻可见：它是"随时想瞟一眼"的阶段耗时与票型。 */}
            {/* order:0 —— 摘要与模块按钮排到公屏**之前**（DOM 里仍在后面，只调显示顺序）：
                六个按钮是这一页的"入口"，落到页面底部就得先滚下去才能点。 */}
            <div style={{ flex: "1 1 100%", width: "100%", display: "flex", flexDirection: "column", order: 0 }}>
            {/* 摘要和按钮同处一段，滚走也无所谓了（它们不再需要钉住）。 */}
            <div style={{ marginBottom: 8 }}>
            {/* ① 阶段进度与各阶段耗时 + ③ 投票分布与结局：常驻、不占页签。
                理由：旁观时这两样是"随时想瞟一眼"的（哪一段在拖时间、票怎么分），
                藏进页签就等于每次都要点一下，而且页签互斥会把它顶掉。 */}
            <div className="panel" style={{ marginBottom: 8 }}>
              <div className="panel-head" style={{ marginBottom: 4 }}>
                <strong>实时摘要</strong>
                <span className="text-xs text-dim" style={{ marginLeft: "auto" }}>
                  {step ? `第 ${step.index}/${step.total} 步` : (metaPhase ? (PHASE_SHORT[metaPhase] || metaPhase) : "未登记")}
                  {phaseRows.length ? ` ｜ 已跑 ${fmtClock(elapsedMs)}` : ""}
                </span>
              </div>
              <div className="text-xs" style={{ lineHeight: 1.7 }}>
                <div>
                  <span className="text-dim">阶段耗时　</span>
                  {phaseRows.length ? phaseRows.map((r, i) => (
                    <span key={`${r.phase}-${i}`} title={`${PHASE_TEXT[r.phase] || r.phase}｜${r.stale ? "服务端登记还没写上下一段的开始时刻（实际已进入更后面的阶段），所以这一段的时间还在涨" : `实际 ${r.ms === null ? "未记结束时刻" : fmtClock(r.ms)}`}${r.over ? `｜比设定多 ${fmtClock(r.deltaMs)}` : ""}`}>
                      {i ? <span className="text-dim"> · </span> : null}
                      <span style={{ color: r.over ? "var(--amber)" : (r.running ? "var(--brass-bright)" : "var(--text-dim)") }}>
                        {PHASE_SHORT[r.phase] || r.phase} {r.ms === null ? "—" : fmtClock(r.ms)}{r.stale ? "?" : (r.running ? "…" : "")}{r.over ? "↑" : ""}
                      </span>
                    </span>
                  )) : <span className="text-dim">等待阶段登记…（服务端每推进一段就记一条）</span>}
                </div>
                <div style={{ marginTop: 2 }}>
                  <span className="text-dim">投票结局　</span>
                  {truth ? (
                    <>
                      <span style={{ color: "var(--wax-bright, #d64d50)" }}>真凶 {truth.murdererName || "?"}</span>
                      {votes.outcomeText ? <span>　{votes.outcomeText}</span> : null}
                      {votes.desc ? <span className="text-dim">｜{votes.desc}</span> : null}
                      {votes.hasVotes ? votes.rows.map((r) => (
                        <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                          <span title={r.name} style={{
                            flex: "0 0 64px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            color: r.isMurderer ? "var(--wax-bright, #d64d50)" : "var(--text)",
                          }}>{r.name}</span>
                          <span style={{ flex: "0 0 20px", textAlign: "right" }}>{r.count}</span>
                          <span style={{ flex: "1 1 auto", minWidth: 20, height: 6, background: "rgba(255,255,255,.07)", borderRadius: 3, overflow: "hidden" }}>
                            <span style={{
                              display: "block", height: "100%", borderRadius: 3,
                              width: `${maxVotes ? Math.round((r.count / maxVotes) * 100) : 0}%`,
                              background: r.isMurderer ? "var(--wax)" : "var(--brass)",
                            }} />
                          </span>
                          {r.isTop ? <span className="text-dim">最高票</span> : null}
                        </div>
                      )) : <div className="text-dim">这一局没有票（无人投票）</div>}
                    </>
                  ) : (
                    <>
                      <span className="text-dim">
                        {state && state.phase === "voting" ? "投票进行中…" : "等待投票"}
                        {state && state.murdererName
                          ? <span>　｜ 真凶（仅你可见）<span style={{ color: "var(--wax-bright, #d64d50)" }}>{state.murdererName}</span></span>
                          : null}
                      </span>
                      {/* ⚠️ 这行原来紧跟在上一段 JSX 文本里、以一个全角空格 `　` 开头做分隔，
                          结果渲染出来是「…（仅你可见）占卜师票型与结局要等…」——黏成一句。
                          原因是 JSX 文本最后会 `.trim()`，而 JS 的 trim 连 U+3000 一起删掉。
                          所以这里改成**独立成行**（不依赖任何前导空白）。 */}
                      <span className="text-dim" style={{ display: "block", marginTop: 2 }}>
                        票型与结局要等 AI DM 广播 truth_revealed（投票阶段结束后）才有数据。
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* 六个模块按钮已经搬到**左侧竖栏**（见上面的 rail），这里不再需要横排按钮。 */}
            </div>

            {/* 模块弹框：复用项目既有的 .modal-overlay / .modal-card / .modal-head / .modal-body
                （ScriptsPage 的剧本详情就是这么弹的），不另造一套样式。
                点遮罩或「关闭」收起。里面仍然原来那六个面板，只是换了容器。 */}
            {openModule ? (
            <div className="modal-overlay" onClick={() => setOpenModule(null)} role="dialog" aria-modal="true" aria-label={moduleLabel(openModule)}>
              <div
                className="modal-card"
                onClick={(e) => e.stopPropagation()}
                style={{ width: "min(1040px, 94vw)", maxWidth: 1040, maxHeight: "88vh", display: "flex", flexDirection: "column" }}
              >
                <div className="modal-head">
                  <strong>{moduleLabel(openModule)}</strong>
                  <button className="btn btn-outline btn-xs" style={{ marginLeft: "auto" }} onClick={() => setOpenModule(null)}>关闭</button>
                </div>
                <div className="modal-body">
            {openModule === "clue" ? (
            <div className="panel">
              <div className="panel-head">
                <strong>剧本体检</strong>
                {state && state.clues ? <span className="text-xs text-dim">线索 {foundCount}/{state.clues.length} 条被发现</span> : null}
                {state && state.clues && state.clues.length ? (
                  <label className="text-xs text-dim" style={{ marginLeft: "auto", cursor: "pointer" }}>
                    <input type="checkbox" checked={onlyUnfound} onChange={(e) => setOnlyUnfound(e.target.checked)} /> 只看未发现
                  </label>
                ) : null}
              </div>
              {/* 真相（真凶/结局/票型）不在这里重复一份：它已经搬到侧边栏顶部的常驻摘要里
                  （旁观时随时要瞟的就是票型，藏进页签反而看不到）。这里只留"线索"这件事。 */}
              {state && state.clues ? (
                <>
                  {roundNums.length ? (
                    <div className="text-xs" style={{ marginBottom: 8 }}>
                      {roundNums.map((r) => {
                        const s = roundStat(r);
                        return (
                          <div key={r} style={{ marginTop: 2 }}>
                            第 {r} 轮线索：{s.got}/{s.pool}{" "}
                            {s.swept
                              ? <span style={{ color: "var(--success, #6b8)" }}>已搜空 ✔</span>
                              : <span style={{ color: "var(--warning)" }}>未搜完</span>}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {recentClues.length ? (
                    <div className="text-xs" style={{ marginBottom: 8, padding: "6px 8px", border: "1px solid var(--ink-600, rgba(255,255,255,.08))", borderRadius: 6 }}>
                      <div className="text-dim" style={{ marginBottom: 3 }}>搜证动态（不进公屏，免得淹没发言）</div>
                      {recentClues.slice(0, 4).map((r, i) => (
                        <div key={i} style={{ marginTop: 2 }}>
                          <span className="text-dim">{new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}　</span>
                          {r.who} 搜到 <strong>{r.id}</strong>
                          <span className="text-dim">：{r.content}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div style={{ maxHeight: 340, overflowY: "auto" }}>
                  {(onlyUnfound ? state.clues.filter((c) => !c.found) : state.clues).map((c) => (
                    // 每条线索独立成块 + 分隔线：第一版是一行行文字，内容与下一条标题连在一起，根本扫不了
                    <div key={c.id} className="text-xs" style={{ padding: "4px 2px", borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))" }}>
                      <button
                        className="btn btn-outline btn-xs"
                        style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}
                        onClick={() => setOpenClue(openClue === c.id ? "" : c.id)}
                      >
                        <span>{openClue === c.id ? "▾" : "▸"}</span>
                        <span style={{ color: c.found ? "var(--success, #6b8)" : "var(--danger)" }}>{c.found ? "✔" : "✘"} {c.id}</span>
                        <span className="text-dim">{c.location || "?"}{c.round ? `／第${c.round}轮` : ""}</span>
                        <span className="text-dim" style={{ marginLeft: "auto" }}>{String(c.content || "").slice(0, 14)}…</span>
                      </button>
                      {/* 展开的线索正文走与玩家端同一个渲染器（components/ScriptBody.jsx）：
                          线索里带 `![说明](img:键名)` 配图时必须看到图 —— 管理员在这里判断
                          "这条线索玩家能不能靠它推出真相"，看不到图就等于漏判了关键证据。
                          scriptId 取**房间登记里的** scriptSessionId（sid）：刷新页面后顶部下拉框是空的，
                          只有登记里那一份才是这一局真正用的剧本，否则刷新后配图就全变纯文本了。
                          拿不到 scriptId 时 ScriptBody 自动退回纯文本，线索不会因此不显示。 */}
                      {openClue === c.id
                        ? (
                          <div style={{ lineHeight: 1.7, padding: "4px 6px" }}>
                            <ScriptBody text={clueBodyText(c)} scriptId={sid} />
                          </div>
                        )
                        : null}
                    </div>
                  ))}
                  {!state.clues.length ? <div className="text-xs text-dim">这个剧本没有线索数据（本身就是一个问题）。</div> : null}
                  {onlyUnfound && state.clues.length > 0 && !state.clues.filter((c) => !c.found).length ? (
                    <div className="text-xs" style={{ color: "var(--success, #6b8)" }}>全部 {state.clues.length} 条线索都被搜到了 ✔</div>
                  ) : null}
                  </div>
                </>
              ) : <div className="text-xs text-dim">等待旁观数据…</div>}
              {/* ✘ 怎么解读取决于"这一轮搜完了没有"：AI 会一直搜到本轮线索池为空才停，
                  所以"已搜空"那一轮仍标 ✘ 才是真信号；没搜完的轮次下结论会误判。 */}
              <div className="text-xs text-dim" style={{ marginTop: 10 }}>
                {sweptRounds.length
                  ? `第 ${sweptRounds.join("、")} 轮的线索已被搜空（AI 会一直搜到本轮线索为空才停）—— 这几轮里标 ✘ 的，是搜遍全场也没找到，很可能线索不可达，值得回查生成结果。`
                  : "当前还没有哪一轮被搜空：此处的 ✘ 可能只是阶段时间不够，不能据此判断线索有问题 —— 把阶段调长（或让每轮跑够）再测一次才能下结论。"}
              </div>
            </div>
            ) : null}

            {/* 角色剧本：测试时最需要对照的东西 —— AI 有没有照着剧本演、剧本之间有没有互相矛盾。
                只有管理员 + 只有测试房能拿到（真人局里这是别人的秘密）。
                DM 手册原来藏在这个面板的「看 DM 手册」按钮后面（还只 dump 前 2000 字），
                本轮把它提成独立的「DM」页签，走 ScriptBody 渲染 —— 见下面的 DM 面板。 */}
            {/* ⚠️ 必须给 overflow 约束：这个面板里的正文用了 white-space: pre-wrap，
                （不给约束时）它的 min-content 宽度很大 → 会把侧边栏撑宽。 */}
            {openModule === "script" ? (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-head">
                <strong>角色剧本</strong>
                {scriptPack ? (
                  <span className="text-xs text-dim">
                    {scriptPack.characters.length} 个角色{scriptPack.murderer && scriptPack.murderer.name ? `｜真凶 ${scriptPack.murderer.name}` : ""}
                  </span>
                ) : null}
              </div>
              {scriptPack ? (
                <>
                  <div style={{ maxHeight: 520, overflowY: "auto" }}>
                    {scriptPack.characters.map((c) => (
                      <div key={c.name} style={{ borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))" }}>
                        <div
                          className="btn btn-outline btn-xs"
                          style={{ width: "100%", textAlign: "left", padding: "6px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                          onClick={() => setOpenChar(openChar === c.name ? "" : c.name)}
                        >
                          {/* 这个 div 原本写了两遍 className（"text-xs" + "btn btn-outline btn-xs"）：
                              JSX 同名属性是硬错误（TS 17001），而 React 实际只吃最后一个，
                              所以删掉前面那个不改变任何渲染结果，只是把错误清掉。 */}
                          <span className="text-dim">{openChar === c.name ? "▾" : "▸"}</span>
                          <strong>{c.name}</strong>
                          <span className="text-dim">{c.occupation || ""}{c.roleType === "npc" ? "｜NPC" : ""}</span>
                          {c.isMurderer ? <span style={{ color: "var(--danger)" }}>凶手</span> : null}
                        </div>
                        {openChar === c.name ? (
                          <div className="text-xs" style={{ padding: "2px 2px 10px", lineHeight: 1.7 }}>
                            {c.personality ? <div className="text-dim">语气：{c.personality}</div> : null}
                            {c.goal ? <div className="text-dim">个人任务：{c.goal}</div> : null}
                            {c.secret ? <div style={{ color: "var(--warning)", marginTop: 4 }}>秘密：{c.secret}</div> : null}
                            {/* ⚠️ 角色正文必须走 ScriptBody：真实剧本的角色剧本里带配图
                                （独立成行的 `![说明](img:键名)`），此前这里是 `white-space: pre-wrap`
                                的纯文本渲染 → 玩家/管理员看到的是原始标记，图不显示。
                                实测对照：同一页的「线索」与「DM」两个页签都用了 ScriptBody，所以
                                只有「角色剧本」这一处看不到图。scriptId 拿不到时 ScriptBody
                                自动退回文本，正文不会因此消失。 */}
                            {c.script
                              ? <div style={{ marginTop: 6, maxHeight: 380, overflowY: "auto" }}><ScriptBody text={c.script} scriptId={sid} /></div>
                              : <div className="text-dim">（这个角色没有正文）</div>}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : <div className="text-xs text-dim">加载中…（只有测试房能看到全部角色剧本）</div>}
            </div>
            ) : null}

            {/* ⑥ 人物关系速览（名册）：身份/职业/是否真凶/与死者的关系，一眼能扫。
                "与死者的关系"取角色剧本里的关系小节（NPC 有「一、人物关系」、单人侦探有「二、你与死者的关系」，
                PVP 玩家把关系揉在背景故事里 → 取不到就**如实说没有**，绝不编一段关系填满这块）。 */}
            {openModule === "roster" ? (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-head">
                <strong>人物关系速览</strong>
                {scriptPack ? <span className="text-xs text-dim">{scriptPack.characters.length} 人</span> : null}
              </div>
              {scriptPack ? (
                <>
                  <div className="text-xs" style={{ marginBottom: 8, padding: "6px 8px", border: "1px solid var(--brass-line)", borderRadius: 6, lineHeight: 1.7 }}>
                    <div>
                      <span className="text-dim">死者　</span>
                      {scriptPack.victim && scriptPack.victim.name
                        ? <strong>{scriptPack.victim.name}</strong>
                        : <span className="text-dim">剧本没解析出死者信息（本身值得回查）</span>}
                    </div>
                    {scriptPack.victim ? (
                      <div className="text-dim">
                        {scriptPack.victim.causeOfDeath ? <>死因：{String(scriptPack.victim.causeOfDeath).slice(0, 40)}　</> : null}
                        {scriptPack.victim.deathTime ? <>身亡：{String(scriptPack.victim.deathTime).slice(0, 40)}　</> : null}
                        {scriptPack.victim.deathPlace ? <>地点：{String(scriptPack.victim.deathPlace).slice(0, 30)}</> : null}
                      </div>
                    ) : null}
                    {scriptPack.murderer && scriptPack.murderer.name
                      ? (
                        <div className="text-dim" style={{ marginTop: 4 }}>
                          真凶（仅你可见）<span style={{ color: "var(--wax-bright, #d64d50)" }}>{scriptPack.murderer.name}</span>
                          {scriptPack.murderer.motive ? <>　动机：{String(scriptPack.murderer.motive).replace(/\s+/g, " ").slice(0, 60)}</> : null}
                        </div>
                      ) : null}
                  </div>
                  <div style={{ maxHeight: 520, overflowY: "auto" }}>
                    {scriptPack.characters.map((c, i) => {
                      const rel = relationText(c.script);
                      const id = identityText(c);
                      return (
                        <div key={c.name} className="text-xs" style={{ borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))", padding: "5px 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span className="text-dim">{i + 1}.</span>
                            <strong>{c.name}</strong>
                            <span className="text-dim">{c.roleType === "npc" ? "NPC" : "玩家"}</span>
                            {c.isMurderer ? <span style={{ color: "var(--wax-bright, #d64d50)" }}>凶手</span> : null}
                          </div>
                          <div style={{ marginTop: 2, lineHeight: 1.7 }}>
                            <span className="text-dim">身份　</span>
                            {id.text
                              ? <span title={id.from === "script" ? "职业字段是空的，这里取剧本正文首句（自我介绍）" : ""}>{id.text}{id.from === "script" ? <span className="text-dim">（取自正文首句）</span> : null}</span>
                              : <span className="text-dim">剧本里既没有职业字段，正文首句也没给出身份</span>}
                          </div>
                          <div style={{ marginTop: 2, lineHeight: 1.7 }}>
                            <span className="text-dim">与死者　</span>
                            {rel || <span className="text-dim">剧本里没有独立的关系小节（全文见「人物」页签）</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {(!scriptPack.victim || !scriptPack.victim.name) ? (
                    <div className="text-xs" style={{ color: "var(--warning)", marginTop: 8, lineHeight: 1.7 }}>
                      这个剧本解析出来的「死者」信息是空的（玩家端同样拿不到），所以上面只能给职业/角色类型/是否真凶；
                      "与死者关系"要等剧本里有独立的关系小节才会显示 —— 这是剧本形状问题，不是这里没渲染。
                    </div>
                  ) : null}
                </>
              ) : <div className="text-xs text-dim">加载中…</div>}
            </div>
            ) : null}

            {/* ④ DM 手册（独立页签）：开场白/完整时间线/真相复盘/三种结局。
                用与玩家端同一个渲染器 ScriptBody → 手册里独立成行的 `![说明](img:键名)` 会显示成真图，
                而且是**全文**（旧实现藏在角色剧本里、只 dump 真相复盘的前 2000 字，配图与后文都看不到）。 */}
            {openModule === "dm" ? (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-head">
                <strong>DM 手册</strong>
                {scriptPack && scriptPack.murderer && scriptPack.murderer.name
                  ? <span className="text-xs text-dim">真凶 {scriptPack.murderer.name}</span> : null}
              </div>
              {scriptPack ? (dm ? (
                <>
                  {scriptPack.murderer && (scriptPack.murderer.method || scriptPack.murderer.mistakes) ? (
                    <div className="text-xs" style={{ marginBottom: 8, padding: "6px 8px", border: "1px solid var(--brass-line)", borderRadius: 6, lineHeight: 1.7 }}>
                      {scriptPack.murderer.method ? <div><span className="text-dim">手法　</span>{String(scriptPack.murderer.method).replace(/\s+/g, " ").slice(0, 120)}</div> : null}
                      {scriptPack.murderer.mistakes ? <div><span className="text-dim">破绽　</span>{String(scriptPack.murderer.mistakes).replace(/\s+/g, " ").slice(0, 120)}</div> : null}
                    </div>
                  ) : null}
                  <div style={{ maxHeight: 560, overflowY: "auto" }}>
                    {dmSections.map(([title, text]) => (
                      <div key={title} style={{ marginBottom: 10 }}>
                        <div className="text-xs text-dim" style={{ marginBottom: 2 }}>{title}</div>
                        <div className="text-xs" style={{ lineHeight: 1.7 }}>
                          <ScriptBody text={String(text)} scriptId={sid} />
                        </div>
                      </div>
                    ))}
                    {dmMissing.length ? (
                      <div className="text-xs" style={{ color: "var(--warning)", lineHeight: 1.7, marginTop: 4 }}>
                        缺失的小节（{dmMissing.length}）：{dmMissing.join("、")} —— 手册缺节会影响主持，值得回查生成结果。
                      </div>
                    ) : null}
                  </div>
                </>
              ) : <div className="text-xs text-dim">这个剧本没有 DM 手册数据（本身就是一个问题）。</div>) : <div className="text-xs text-dim">加载中…</div>}
            </div>
            ) : null}

            {/* ⑤ 全员时间线（从主列搬进侧边栏）：
                它原本是多列表格（时刻 × 角色），380px 的窄列放不下 —— 直接塞进来会被截断/挤出横向滚动条，
                所以给 PlayerTimeline 加了 compact（堆叠式：一个时刻一段，段内一行一个角色）。
                窄列怎么处理见 PlayerTimeline.jsx 的注释。 */}
            {openModule === "timeline" ? (
            scriptPack ? (
              <div className="panel" style={{ overflow: "hidden" }}>
                <PlayerTimeline scripts={scriptPack} compact />
              </div>
            ) : <div className="panel"><div className="text-xs text-dim">加载中…</div></div>
            ) : null}

            {/* ② AI 行为统计：全部从公屏流聚合（kind + 文本前缀），用来发现"某个 AI 一直没说话"。
                数字口径写在面板里，方便对着"公屏实录 N 条"自己核一遍。 */}
            {openModule === "stats" ? (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-head">
                <strong>AI 行为统计</strong>
                <span className="text-xs text-dim">公屏 {chatStats.total} 条</span>
              </div>
              <div className="text-xs" style={{ lineHeight: 1.7, marginBottom: 4 }}>
                {chatStats.kinds.length ? chatStats.kinds.map((k, i) => (
                  <span key={k.kind}>
                    {i ? <span className="text-dim"> · </span> : null}
                    <span className="text-dim">{KIND_TEXT[k.kind] || k.kind}</span> {k.n}
                  </span>
                )) : <span className="text-dim">还没有任何公屏事件</span>}
              </div>
              <div className="text-xs text-dim" style={{ lineHeight: 1.7, marginBottom: 8 }}>
                {`其中：发言 ${chatStats.chat.spoke + chatStats.chat.fallback}、提问 ${chatStats.chat.asked}、投票 ${chatStats.chat.voted}`
                  + (chatStats.chat.unnamed ? `、无名字前缀 ${chatStats.chat.unnamed}` : "")}
                {chatStats.chat.fallback
                  ? `。有 ${chatStats.chat.fallback} 条发言是模板兜底（那一次 LLM 没给出稿子 —— 属于环境问题，别当成剧本问题）`
                  : ""}
                {silentAI.length && chatStats.chat.total
                  ? <div style={{ color: "var(--danger)", marginTop: 2 }}>
                      ⚠ {silentAI.map((r) => r.name).join("、")} 一句都没说过（发言/提问/投票都是 0）—— 对照剧本看是角色设定如此，还是调度/LLM 出了问题。
                    </div>
                  : null}
                {/* 一句话都没人说过时别报"某 AI 没说话"：阅读阶段 AI 本来就不发言，那是误报。 */}
                {silentAI.length && !chatStats.chat.total
                  ? <div className="text-dim" style={{ marginTop: 2 }}>
                      公屏还没有任何发言（阅读阶段 AI 不说话），等进入搜证轮再看这一栏才有意义。
                    </div>
                  : null}
              </div>
              <div style={{ display: "flex", gap: 6, fontSize: 11, lineHeight: 1.6 }} className="text-dim">
                <span style={{ flex: "1 1 auto", minWidth: 0 }}>角色</span>
                <span style={{ flex: "0 0 40px", textAlign: "right" }}>发言</span>
                <span style={{ flex: "0 0 40px", textAlign: "right" }}>提问</span>
                <span style={{ flex: "0 0 40px", textAlign: "right" }}>投票</span>
                <span style={{ flex: "0 0 46px", textAlign: "right" }}>搜到线索</span>
              </div>
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                {statRows.map((r) => (
                  <div key={r.name} style={{ display: "flex", gap: 6, fontSize: 11, lineHeight: 1.9, borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))" }}>
                    <span title={r.name + (r.isAI ? "" : "（不在 AI 名单里：DM 或真人？）")} style={{
                      flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      color: (r.talk || r.asked || r.voted) ? "var(--text)" : "var(--danger)",
                    }}>
                      {r.name}{r.isAI ? null : <span className="text-dim">（非AI）</span>}
                    </span>
                    {[r.talk, r.asked, r.voted, r.clue === null ? "—" : r.clue].map((v, i) => (
                      <span key={i} style={{ flex: `0 0 ${i === 3 ? 46 : 40}px`, textAlign: "right", color: i === 3 && v === "—" ? "var(--text-muted)" : undefined }}>{v}</span>
                    ))}
                  </div>
                ))}
                {!statRows.length ? <div className="text-xs text-dim">还没有 AI 名单（等旁观数据）…</div> : null}
              </div>
              <div className="text-xs text-dim" style={{ marginTop: 6, lineHeight: 1.7 }}>
                发言/提问/投票按公屏里服务端写死的前缀区分（`❓ 我想问`／`🤖 我投票给`），
                被点名后的回答与 LLM 发言在公屏上无法区分，都算发言。
                {clueTallyReady
                  ? `搜到线索按 clue_received 事件按线索去重累计，合计 ${Object.values(clueTally).reduce((a, b) => a + b, 0)} 条，可与「线索」页签的「已发现 N/M」对照。`
                  : "按角色的搜证数来自实时 clue_received 事件：刷新页面后事件已经过去，这项会显示「—」（快照只带「是否被发现」、不带发现者），不影响上面的发言统计。"}
              </div>
            </div>
            ) : null}
                </div>
              </div>
            </div>
            ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
