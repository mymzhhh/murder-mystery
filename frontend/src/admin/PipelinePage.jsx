import React, { useState, useRef, useEffect } from "react";
import { api, getToken } from "../lib/api.js";
import { readSSE } from "../lib/sse.js";
import OutlinePanel from "./OutlinePanel.jsx";

const STEPS = ["输入需求", "提示词优化", "剧本大纲", "生成剧本", "评测", "切分完成"];
const STAGE_COLORS = {
  outline: "var(--gold)",
  player_script: "var(--mystic-light)",
  npc_script: "var(--mystic-light)",
  clue: "var(--success)",
  dmGuide: "var(--warning)",
  review: "var(--gold)",
  crosscheck: "var(--mystic-light)",
};

export default function PipelinePage({ onNavigate }) {
  const [step, setStep] = useState(1);
  const [input, setInput] = useState("");
  const [stage, setStage] = useState("idle"); // idle | optimize | optimized | generating | done | error
  const [optimized, setOptimized] = useState(null); // { playerCount, npcCount, isPVE, advancedMode, optimized, title, era, style }
  const [optimizedText, setOptimizedText] = useState("");
  const [logs, setLogs] = useState([]);
  const [outline, setOutline] = useState(null);
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
          // 进度推进
          if (st === "outline") setStep(3);
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
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* 步骤条 */}
      <div className="pipeline-steps" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {STEPS.map((label, i) => (
          <React.Fragment key={label}>
            {i > 0 && <span className="pipeline-arrow" style={{ color: "var(--dim)" }}>→</span>}
            <div
              className={`pipe-step ${step > i + 1 ? "done" : step === i + 1 ? "active" : ""}`}
              style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13 }}
            >
              <span className="pipe-num" style={{ marginRight: 6 }}>{i + 1}</span>
              {label}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* 输入区 */}
      {stage === "idle" || stage === "error" ? (
        <div className="panel" style={{ padding: 20 }}>
          <div className="form-group">
            <label>描述你想要的剧本</label>
            <textarea
              className="form-textarea"
              rows="4"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：民国上海滩富商毒杀案，6人参加。或者：两人PVE对抗本，现代都市背景..."
            />
          </div>
          {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="pipeline-buttons">
            <button className="btn btn-primary btn-auto" onClick={optimize} disabled={stage === "optimize"}>
              优化提示词
            </button>
          </div>
        </div>
      ) : null}

      {/* 优化结果 */}
      {optimized && stage === "optimized" ? (
        <div className="panel" style={{ padding: 20 }}>
          <div className="grid-4 mb-lg" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
            <div className="card card-static text-center"><div style={{ fontSize: 32, color: "var(--gold)", fontWeight: 800 }}>{optimized.playerCount}</div><div className="text-xs text-dim">玩家角色</div></div>
            <div className="card card-static text-center"><div style={{ fontSize: 32, color: "var(--mystic-light)", fontWeight: 800 }}>{optimized.npcCount}</div><div className="text-xs text-dim">{optimized.gameMode === "PVP" ? "NPC目击者" : "NPC嫌疑人"}</div></div>
            <div className="card card-static text-center"><div style={{ fontSize: 18, color: "var(--gold)", fontWeight: 800 }}>{optimized.gameMode}</div><div className="text-xs text-dim">游戏模式</div></div>
            <div className="card card-static text-center"><div style={{ fontSize: 14, color: "var(--success)", fontWeight: 700 }}>{optimized.advancedMode === "hardcore" ? "硬核" : optimized.advancedMode === "emotional" ? "情感" : "标准"}</div><div className="text-xs text-dim">创作风格</div></div>
          </div>
          {optimized.title && <div className="card card-static" style={{ marginBottom: 12 }}><strong style={{ color: "var(--gold)" }}>{optimized.title}</strong><div className="text-xs text-dim mt-sm">{optimized.era || ""} | {optimized.style || ""}</div></div>}
          <div className="form-group">
            <label>优化后的剧本需求（可修改）</label>
            <textarea className="form-textarea" rows="6" value={optimizedText} onChange={(e) => setOptimizedText(e.target.value)} />
          </div>
          <div className="pipeline-buttons" style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-outline btn-auto" onClick={() => { setStage("idle"); reset(); }}>返回修改</button>
            <button className="btn btn-primary btn-auto" onClick={generate}>确认并生成</button>
          </div>
        </div>
      ) : null}

      {/* 生成过程：日志 + 大纲面板（生成中/完成/生成中出错 都保留，便于看到进度到哪） */}
      {(stage === "generating" || stage === "done" || (stage === "error" && logs.length > 0)) && (
        <React.Fragment>
          {outline && <OutlinePanel outline={outline} />}
          <div className="panel" style={{ padding: 16, marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <strong style={{ color: "var(--gold)" }}>生成进度</strong>
              {stage === "generating" && <button className="btn btn-danger btn-sm" onClick={cancel}>取消生成</button>}
            </div>
            {stage === "error" && (
              <div className="alert alert-danger" style={{ marginBottom: 8 }}>⚠️ {error}</div>
            )}
            <div className="progress-steps" style={{ maxHeight: 300, overflowY: "auto", fontSize: 13 }}>
              {logs.map((l, i) => (
                <div key={i} style={{ color: l.color || "inherit", padding: "2px 0", fontFamily: "monospace" }}>{l.text}</div>
              ))}
              {logs.length === 0 && <div className="text-dim">等待开始...</div>}
            </div>
          </div>
        </React.Fragment>
      )}

      {/* 生成结果：展示剧本 ID + 后续入口。
          原先 sessionId 只被 setState、界面上从不渲染，而玩家端开房正需要这个 ID，
          端到端"生成 → 开局"的交接是断的。 */}
      {stage === "done" && sessionId && (
        <div className="panel" style={{ padding: 16, marginTop: 12, borderLeft: "3px solid var(--success)" }}>
          <strong style={{ color: "var(--success)" }}>✓ 剧本已就绪，可以开局了</strong>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="text-sm text-dim">剧本 ID</span>
            <code style={{ background: "rgba(255,255,255,.08)", padding: "4px 10px", borderRadius: 6, fontSize: 13 }}>{sessionId}</code>
            <button
              className="btn btn-outline btn-xs"
              onClick={async () => {
                try { await navigator.clipboard.writeText(sessionId); setCopied(true); }
                catch (e) { setCopied(false); }
              }}
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {onNavigate && <button className="btn btn-outline btn-sm" onClick={() => onNavigate("scripts")}>去剧本管理</button>}
            {onNavigate && <button className="btn btn-success btn-sm" onClick={() => onNavigate("rooms")}>去房间管理开房</button>}
          </div>
          <div className="text-xs text-dim" style={{ marginTop: 8 }}>
            玩家也可以直接在玩家端「可选剧本」里对同一剧本点「创建房间」。
          </div>
        </div>
      )}
    </div>
  );
}