import React, { useState, useEffect } from "react";
import { api, apiJson } from "../lib/api.js";
import { readSSE } from "../lib/sse.js";
import { getToken } from "../lib/api.js";

export default function ScriptsPage() {
  const [scripts, setScripts] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState(null); // { title, markdown }
  const [splitView, setSplitView] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (q) params.set("q", q);
      const d = await apiJson(`/api/admin/scripts?${params}`);
      setScripts(d.scripts || d.list || []);
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(load, 400); return () => clearTimeout(t); }, [q]);

  async function doDelete(id) {
    if (!confirm("确定删除该剧本？")) return;
    try { await api(`/api/admin/scripts/${id}`, { method: "DELETE" }); load(); } catch (e) { alert(e.message); }
  }

  async function doView(id) {
    try {
      const d = await apiJson(`/api/admin/scripts/${id}`);
      setView({ id, title: d.title || "", markdown: d.markdown || d.fullScript || "" });
    } catch (e) { alert(e.message); }
  }
  async function doSplitView(id) {
    try {
      const d = await apiJson(`/api/admin/scripts/${id}/split-view`);
      setSplitView(d);
    } catch (e) { alert(e.message); }
  }

  // 评测+切分（SSE 进度）
  function doReviewSplit(id) {
    openProgress(`/api/admin/scripts/${id}/review-split`, id, "评测并切分");
  }
  function doSplit(id) {
    openProgress(`/api/admin/scripts/${id}/split`, id, "切分");
  }

  function openProgress(url, id, label) {
    const win = window.open("", "_blank", "width=520,height=480");
    if (win) {
      win.document.write(`<html><body style="font-family:monospace;font-size:12px;background:#1a1a2e;color:#eee;padding:12px"><h4>${label}中...</h4><div id="log"></div></body></html>`);
      runJob(url, (msg) => {
        if (win && !win.closed) win.document.getElementById("log").innerHTML += `<div>${String(msg).replace(/</g, "&lt;")}</div>`;
      }).then(() => { if (win && !win.closed) { win.document.getElementById("log").innerHTML += "<div style='color:#4ade80'>✓ 完成</div>"; setTimeout(() => win.close(), 2000); } });
    }
  }

  async function runJob(url, onLog) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
        body: "{}",
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `失败 ${res.status}`); }
      await readSSE(res, {
        onProgress: (st, msg) => onLog(`${st}: ${msg}`),
        onPhase: (ph, msg) => onLog(msg),
        onComplete: (d) => onLog(d.status === "done" ? "完成" : JSON.stringify(d).substring(0, 100)),
        onError: (msg) => onLog("❌ " + msg),
      });
    } catch (e) { onLog("❌ " + e.message); }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, gap: 10 }}>
        <input className="form-input" style={{ maxWidth: 300 }} placeholder="搜索剧本标题..." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-outline btn-sm" onClick={load}>刷新</button>
      </div>

      <div className="panel" style={{ padding: 16 }}>
        {loading && <div className="state-loading">加载中...</div>}
        {!loading && scripts.length === 0 && <div className="state-empty">暂无剧本</div>}
        {scripts.map((s) => (
          <div key={s.sessionId || s.id} className="card card-static" style={{ marginBottom: 8, padding: "10px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div>
                <strong>{s.topic || s.title || "未命名"}</strong>
                {s.playerCount && <span className="tag" style={{ marginLeft: 8 }}>{s.playerCount}玩家{s.npcCount ? "+" + s.npcCount + "NPC" : ""}</span>}
                <span className="text-xs text-dim" style={{ marginLeft: 8 }}>{new Date(s.createdAt || Date.now()).toLocaleString()}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn btn-outline btn-xs" onClick={() => doView(s.sessionId || s.id)}>查看</button>
                <button className="btn btn-outline btn-xs" onClick={() => doSplitView(s.sessionId || s.id)}>切分预览</button>
                <button className="btn btn-success btn-xs" onClick={() => doReviewSplit(s.sessionId || s.id)}>评测并切分</button>
                <button className="btn btn-outline btn-xs" onClick={() => doSplit(s.sessionId || s.id)}>仅切分</button>
                <button className="btn btn-danger btn-xs" onClick={() => doDelete(s.sessionId || s.id)}>删除</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 查看剧本弹窗 */}
      {view && (
        <Modal title={view.title || "剧本"} onClose={() => setView(null)}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, maxHeight: "65vh", overflowY: "auto" }}>
            {view.markdown}
          </pre>
        </Modal>
      )}

      {/* 切分预览 */}
      {splitView && (
        <Modal title="切分数据" onClose={() => setSplitView(null)}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "65vh", overflowY: "auto" }}>
            {JSON.stringify(splitView, null, 2)}
          </pre>
        </Modal>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="card card-static" style={{ maxWidth: 900, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <strong>{title}</strong>
          <button className="btn btn-outline btn-xs" onClick={onClose}>✕ 关闭</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}