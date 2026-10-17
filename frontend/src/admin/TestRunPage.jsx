import React, { useState, useEffect, useRef } from "react";
import { apiJson, api, getToken } from "../lib/api.js";
import { getSocket } from "../lib/socket.js";
import { ScriptBody } from "../components/ScriptBody.jsx";
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
  const [showDm, setShowDm] = useState(false);
  // 侧边栏页签：剧本体检 / 角色剧本 两块互斥显示。
  // 为什么必须互斥：并排（或上下叠放）时下面那块会落到折叠线以下 ——
  // 实测侧边栏改成常驻列之后，「角色剧本」的 y=859 而视口只有 872，等于看不见。
  // 页签让两块都只隔一次点击，且各自能占满侧边栏高度。
  const [sideTab, setSideTab] = useState("clue");
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

          {/* 两列布局：主列（公屏 + 全员时间线，宽）｜右侧常驻侧边栏（剧本体检 + 角色剧本，窄）。
              为什么改（原先是四个面板一起 flex-wrap 平铺，420/auto/340/340）：
              第二行只有 340+340，右侧空出一大片 —— 这就是"界面有点空"的来源；
              改成两列后侧边栏把那一列占满，且 sticky 常驻，看公屏时不用滚动就能对照线索与角色剧本。
              另：原注释说"全员时间线单独占一整行"，但它没有 flex-basis:100%，
              实际被挤在右上角；放进主列后它才真正占满主列宽度（它是多列表格，窄了会被截断）。 */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 560px", minWidth: 320, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="panel">
              <div className="panel-head"><strong>公屏实录</strong><span className="text-xs text-dim">{stream.length} 条</span></div>
              <div ref={feedRef} style={{ maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
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

            {/* 全员时间线：它是多列表格，必须占满**主列**宽度（窄了会被截断）。 */}
            {scriptPack ? (
              <div className="panel">
                <PlayerTimeline scripts={scriptPack} />
              </div>
            ) : null}
            </div>

            {/* 右侧常驻侧边栏：把原先平铺在第二行、右侧留白的那两块收进来。
                sticky + 自身可滚动：侧边栏比视口高时内部滚，不会把主列推下去。 */}
            <div style={{
              flex: "0 0 380px", minWidth: 300, display: "flex", flexDirection: "column", gap: 12,
              position: "sticky", top: 12, alignSelf: "flex-start",
              maxHeight: "calc(100vh - 24px)", overflowY: "auto",
            }}>
            {/* 侧边栏页签：两块互斥，避免下面那块落到折叠线以下（见 sideTab 的注释）。 */}
            <div style={{ display: "flex", gap: 6 }}>
              {[["clue", "剧本体检"], ["script", "角色剧本"]].map(([k, label]) => (
                <button
                  key={k}
                  className={"btn btn-sm" + (sideTab === k ? "" : " btn-outline")}
                  style={{ flex: 1 }}
                  onClick={() => setSideTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>

            {sideTab === "clue" ? (
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
              {truth ? (
                <div className="text-xs" style={{ marginBottom: 10, padding: 8, border: "1px solid var(--brass-line)", borderRadius: 6 }}>
                  <div><strong>真凶：{truth.murdererName}</strong>　结局：{truth.outcome}</div>
                  <div className="text-dim" style={{ marginTop: 4 }}>{truth.description}</div>
                  {truth.votes ? <div className="text-dim" style={{ marginTop: 4 }}>票型：{JSON.stringify(truth.votes)}</div> : null}
                </div>
              ) : null}
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
                          scriptId 是本次测试选中的剧本 id（房间的 scriptSessionId），
                          拿不到时 ScriptBody 自动退回纯文本，线索不会因此不显示。 */}
                      {openClue === c.id
                        ? (
                          <div style={{ lineHeight: 1.7, padding: "4px 6px" }}>
                            <ScriptBody text={clueBodyText(c)} scriptId={scriptId} />
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
                只有管理员 + 只有测试房能拿到（真人局里这是别人的秘密）。 */}
            {/* ⚠️ 必须给 overflow 约束：这个面板里的 DM 正文用了 white-space: pre-wrap，
                （不给约束时）它的 min-content 宽度很大 → 会把侧边栏撑宽。 */}
            {sideTab === "script" ? (
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="panel-head">
                <strong>角色剧本</strong>
                {scriptPack ? (
                  <span className="text-xs text-dim">
                    {scriptPack.characters.length} 个角色{scriptPack.murderer && scriptPack.murderer.name ? `｜真凶 ${scriptPack.murderer.name}` : ""}
                  </span>
                ) : null}
                {scriptPack && scriptPack.dmGuide ? (
                  <button className="btn btn-outline btn-xs" style={{ marginLeft: "auto" }} onClick={() => setShowDm((v) => !v)}>
                    {showDm ? "收起 DM 手册" : "看 DM 手册"}
                  </button>
                ) : null}
              </div>
              {scriptPack ? (
                <>
                  {showDm && scriptPack.dmGuide ? (
                    <div className="text-xs" style={{ marginBottom: 8, padding: 8, border: "1px solid var(--brass-line)", borderRadius: 6, maxHeight: 220, overflowY: "auto" }}>
                      {scriptPack.murderer && scriptPack.murderer.name ? (
                        <div style={{ marginBottom: 4 }}>
                          <strong>真凶：{scriptPack.murderer.name}</strong>
                          {scriptPack.murderer.motive ? <span className="text-dim">　动机：{String(scriptPack.murderer.motive).slice(0, 60)}</span> : null}
                          {scriptPack.murderer.method ? <span className="text-dim">　手法：{String(scriptPack.murderer.method).slice(0, 60)}</span> : null}
                        </div>
                      ) : null}
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                        {String(scriptPack.dmGuide.truthReveal || "（DM 手册没有真相复盘文本）").slice(0, 2000)}
                      </div>
                    </div>
                  ) : null}
                  <div style={{ maxHeight: 300, overflowY: "auto" }}>
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
                            <div style={{ whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 260, overflowY: "auto" }}>{c.script || "（这个角色没有正文）"}</div>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : <div className="text-xs text-dim">加载中…（只有测试房能看到全部角色剧本）</div>}
            </div>
            ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
