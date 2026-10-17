import React, { useState, useRef, useEffect } from "react";
import { api, getToken } from "../lib/api.js";
import { readSSE } from "../lib/sse.js";
import OutlinePanel from "./OutlinePanel.jsx";
import TrickPanel from "./TrickPanel.jsx";

const STEPS = ["输入需求", "提示词优化", "剧本大纲", "生成剧本", "评测", "切分完成"];
// 日志配色按"这条日志属于流水线的哪一类"来分，全部落在设计令牌里，
// 不再出现改造前那种"紫一个、绿一个、橙一个"的独立色值。
const STAGE_COLORS = {
  // 核心诡计与证明链：大纲之前的第一步"思考"产物，用品牌色与大纲同色系
  trick: "var(--brass)",
  outline: "var(--brass)",
  player_script: "var(--verd-bright)",
  npc_script: "var(--verd-bright)",
  clue: "var(--amber-bright)",
  dmGuide: "var(--amber-bright)",
  review: "var(--brass)",
  crosscheck: "var(--verd-bright)",
};

export default function PipelinePage({ onNavigate }) {
  const [step, setStep] = useState(1);
  const [input, setInput] = useState("");
  const [stage, setStage] = useState("idle"); // idle | optimize | optimized | generating | done | error
  const [optimized, setOptimized] = useState(null); // { playerCount, npcCount, isPVE, advancedMode, optimized, title, era, style }
  const [optimizedText, setOptimizedText] = useState("");
  const [logs, setLogs] = useState([]);
  const [outline, setOutline] = useState(null);
  const [trick, setTrick] = useState(null);   // 核心诡计设计（推理链：机制/可行性/最弱处/证明链）
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [copied, setCopied] = useState(false);
  const abortRef = useRef(null);
  const logsRef = useRef([]);

  function appendLog(text, color) {
    logsRef.current = [...logsRef.current, { text, color }];
    setLogs(logsRef.current);
  }
  function reset() {
    logsRef.current = [];
    setLogs([]);
    setOutline(null);
    setError("");
    setSessionId("");
    setCopied(false);
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }

  // ===== 步骤1：优化提示词 =====
  async function optimize() {
    if (!input.trim()) { alert("请输入剧本需求"); return; }
    setStage("optimize");
    setStep(2);
    appendLog("Agent 正在分析和优化你的需求...（通常需要1~3分钟）", "var(--gold)");
    try {
      const d = await api("/api/admin/pipeline/optimize", {
        method: "POST",
        body: JSON.stringify({ input: input.trim() }),
      }).then((r) => r.json());
      if (!d.ok && d.error) throw new Error(d.error);
      const pc = d.playerCount || (d.extracted ? d.extracted.playerCount : 4);
      const nc = d.npcCount || 0;
      const pve = d.isPVE !== undefined ? d.isPVE : nc > 0;
      setOptimized({ ...d, playerCount: pc, npcCount: nc, isPVE: pve, gameMode: d.gameMode || (pve ? "PVE" : "PVP") });
      setOptimizedText(d.optimized || input.trim());
      setStep(3);
      setStage("optimized");
      appendLog(`✓ 优化完成：${pc}玩家 + ${nc}NPC（${d.gameMode || (pve ? "PVE" : "PVP")}）`, "var(--success)");
    } catch (e) {
      setStage("error");
      setError("优化失败: " + e.message);
      appendLog("优化失败: " + e.message, "var(--danger)");
    }
  }

  // ===== 步骤3-6：生成 → 评测 → 切分（SSE） =====
  async function generate() {
    if (!optimized) return;
    reset();
    setStep(4);
    setStage("generating");
    appendLog("开始生成剧本...", "var(--gold)");
    const config = {
      playerCount: optimized.playerCount,
      npcCount: optimized.npcCount,
      isPVE: optimized.isPVE,
      gameMode: optimized.gameMode,
      advancedMode: ["hardcore", "emotional"].includes(optimized.advancedMode) ? optimized.advancedMode : "standard",
    };
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/admin/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
        signal: ctrl.signal,
        body: JSON.stringify({ input: optimizedText, config }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `请求失败 (${res.status})`);
      }
      await readSSE(res, {
        onProgress: (st, msg) => {
          appendLog(`${st}: ${msg}`, STAGE_COLORS[st] || "inherit");
          // 进度推进。trick（核心诡计设计）属于大纲阶段的前半段，与 outline 同归第 3 步
          if (st === "outline" || st === "trick") setStep(3);
          else if (st === "framework" || st === "init" || st === "generate") setStep(4);
          else if (st === "crosscheck" || st === "dmGuide") setStep(5);
        },
        onPhase: (ph, msg) => {
          appendLog(msg, "var(--gold)");
          if (ph === "outline") setStep(3);
          else if (ph === "write") setStep(4);
          else if (ph === "review") setStep(5);
          else if (ph === "split") setStep(6);
        },
        onOutline: (d) => {
          setOutline(d);
          setStep(3);
          appendLog(`🎭 大纲已生成：${d.title}（${(d.players || []).length}玩家 + ${(d.npcs || []).length}NPC）`, "var(--gold)");
        },
        onTrick: (d) => {
          setTrick(d);
          setStep(3);
          // 如实上报是否被校验打回过：一次通过与被退回重做，对"这个诡计靠不靠得住"是两条信息
          const redo = (d.attempts || 1) > 1 ? `（第 ${d.attempts} 次通过，此前被打回：${(d.lastErrors || []).join("；") || "—"}）` : "（一次通过校验）";
          appendLog(`🃏 核心诡计：${(d.coreTrick || "").slice(0, 50)}${redo}`, "var(--brass)");
        },
        onComplete: (d) => {
          if (d.status === "done") {
            setStep(6);
            appendLog("剧本生成完成！已评测并切分", "var(--success)");
            setSessionId(d.sessionId || "");
          } else if (d.status === "review_failed") {
            appendLog("评测未通过: " + (d.message || ""), "var(--danger)");
            setError(d.message || "评测未通过");
            setStage("error");
          }
          if (d.sessionId) setSessionId(d.sessionId);
        },
        onError: (msg) => {
          setError(msg);
          setStage("error");
          appendLog("错误: " + msg, "var(--danger)");
        },
      }, ctrl.signal);
      // 仅当未发生错误时才标记完成（否则会把 onError 设置的状态覆盖成"成功"）
      if (!ctrl.signal.aborted) {
        setStage((prev) => (prev === "error" ? "error" : "done"));
      }
    } catch (e) {
      if (e.name === "AbortError" || e.message === "已取消") return;
      setError(e.message);
      setStage("error");
      appendLog("错误: " + e.message, "var(--danger)");
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
    reset();
    setStage("idle");
    setStep(1);
  }

  // ===== 渲染 =====
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>剧本生成</h2>
          <p>用一句自然语言描述需求，流水线会优化提示词、产出大纲与剧本，评测通过后自动切分成玩家剧本、线索与 DM 手册。</p>
        </div>
      </div>

      {/* 步骤条 */}
      <div className="pipeline-steps">
        {STEPS.map((label, i) => (
          <React.Fragment key={label}>
            {i > 0 && <span className="pipe-arrow" aria-hidden="true" />}
            <div className={`pipe-step ${step > i + 1 ? "done" : step === i + 1 ? "active" : ""}`}>
              <span className="pipe-num">{step > i + 1 ? "✓" : i + 1}</span>
              {label}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* 输入区 */}
      {(stage === "idle" || stage === "error") && (
        <div className="panel">
          <div className="form-group">
            <label htmlFor="pipeline-input">描述你想要的剧本</label>
            <textarea
              id="pipeline-input"
              className="form-textarea"
              rows="5"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：民国上海滩富商毒杀案，6 人参加。或者：两人 PVE 对抗本，现代都市背景…"
            />
            <div className="form-hint">人数、年代、风格、诡计类型都可以写进去，写得越具体，大纲越贴合。</div>
          </div>
          {error && <div className="alert alert-danger" style={{ marginBottom: 14 }}><span className="alert-body">{error}</span></div>}
          <div className="pipeline-buttons">
            <button className="btn btn-primary btn-auto" onClick={optimize} disabled={stage === "optimize"}>
              {stage === "optimize" ? "优化中…" : "优化提示词"}
            </button>
          </div>
        </div>
      )}

      {/* 优化结果 */}
      {optimized && stage === "optimized" && (
        <div className="panel">
          <div className="panel-head">
            <strong>需求解析结果</strong>
            <span className="text-xs text-dim">确认无误后再生成，生成过程无法中断回退</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 18 }}>
            <div className="stat-tile">
              <div className="stat-value">{optimized.playerCount}</div>
              <div className="stat-label">玩家角色</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value" style={{ color: "var(--verd-bright)" }}>{optimized.npcCount}</div>
              <div className="stat-label">{optimized.gameMode === "PVP" ? "NPC 目击者" : "NPC 嫌疑人"}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value" style={{ fontSize: "var(--fs-xl)" }}>{optimized.gameMode}</div>
              <div className="stat-label">游戏模式</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value" style={{ fontSize: "var(--fs-xl)" }}>
                {optimized.advancedMode === "hardcore" ? "硬核" : optimized.advancedMode === "emotional" ? "情感" : "标准"}
              </div>
              <div className="stat-label">创作风格</div>
            </div>
          </div>

          {optimized.title && (
            <div className="card card-static" style={{ marginBottom: 16 }}>
              <div className="text-xs text-muted">拟定剧名</div>
              <strong style={{ fontSize: 18, fontFamily: "var(--font-serif)", letterSpacing: ".06em" }}>{optimized.title}</strong>
              {(optimized.era || optimized.style) && (
                <div className="text-xs text-muted mt-sm">{[optimized.era, optimized.style].filter(Boolean).join(" ｜ ")}</div>
              )}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="pipeline-optimized">优化后的剧本需求（可修改）</label>
            <textarea id="pipeline-optimized" className="form-textarea" rows="8"
              value={optimizedText} onChange={(e) => setOptimizedText(e.target.value)} />
          </div>

          <div className="pipeline-buttons">
            <button className="btn btn-outline btn-auto" onClick={() => { setStage("idle"); reset(); }}>返回修改</button>
            <button className="btn btn-primary btn-auto" onClick={generate}>确认并生成</button>
          </div>
        </div>
      )}

      {/* 生成过程：日志 + 诡计/大纲面板（生成中/完成/生成中出错 都保留，便于看到进度到哪） */}
      {(stage === "generating" || stage === "done" || (stage === "error" && logs.length > 0)) && (
        <React.Fragment>
          {/* 诡计先于大纲定稿，所以面板也排在前面 */}
          {trick && <TrickPanel design={trick} />}
          {outline && <OutlinePanel outline={outline} />}
          <div className="panel">
            <div className="panel-head">
              <strong>生成进度</strong>
              {stage === "generating" && <span className="tag tag-warning">运行中</span>}
              {stage === "done" && <span className="tag tag-success">已完成</span>}
              {stage === "error" && <span className="tag tag-danger">已中断</span>}
              {stage === "generating" && (
                <div className="panel-actions">
                  <button className="btn btn-danger btn-sm" onClick={cancel}>取消生成</button>
                </div>
              )}
            </div>
            {stage === "error" && (
              <div className="alert alert-danger" style={{ marginBottom: 10 }}><span className="alert-body">⚠️ {error}</span></div>
            )}
            <div className="log-view">
              {logs.map((l, i) => (
                <div key={i} className="log-line" style={{ color: l.color || "inherit" }}>{l.text}</div>
              ))}
              {logs.length === 0 && <div className="text-muted">等待开始…</div>}
            </div>
          </div>
        </React.Fragment>
      )}

      {/* 生成结果：展示剧本 ID + 后续入口。
          原先 sessionId 只被 setState、界面上从不渲染，而玩家端开房正需要这个 ID，
          端到端"生成 → 开局"的交接是断的。 */}
      {stage === "done" && sessionId && (
        <div className="panel" style={{ borderColor: "var(--verd-line)" }}>
          <div className="panel-head">
            <strong style={{ color: "var(--verd-bright)" }}>✓ 剧本已就绪，可以开局了</strong>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="text-sm text-dim">剧本 ID</span>
            <code style={{ fontSize: 13 }}>{sessionId}</code>
            <button
              className="btn btn-outline btn-xs btn-auto"
              onClick={async () => {
                try { await navigator.clipboard.writeText(sessionId); setCopied(true); }
                catch (e) { setCopied(false); }
              }}
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <div className="pipeline-buttons" style={{ marginTop: 14 }}>
            {onNavigate && <button className="btn btn-outline btn-sm btn-auto" onClick={() => onNavigate("scripts")}>去剧本管理</button>}
            {onNavigate && <button className="btn btn-primary btn-sm btn-auto" onClick={() => onNavigate("rooms")}>去房间管理开房</button>}
          </div>
          <div className="text-xs text-dim" style={{ marginTop: 10 }}>
            玩家也可以直接在玩家端「可选剧本」里对同一剧本点「创建房间」。
          </div>
        </div>
      )}
    </div>
  );
}