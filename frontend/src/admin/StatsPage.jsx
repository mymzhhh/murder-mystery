import React, { useState, useEffect } from "react";
import { apiJson } from "../lib/api.js";

export default function StatsPage() {
  const [stats, setStats] = useState(null);
  const [sync, setSync] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    try {
      const [s, sy] = await Promise.all([
        apiJson("/api/admin/stats"),
        apiJson("/api/admin/sync-status"),
      ]);
      setStats(s);
      setSync(sy);
    } catch (e) { /* ignore */ }
  }

  function fmt(n) {
    if (n == null) return "0";
    return Number(n).toLocaleString();
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await apiJson("/api/admin/sync-now", { method: "POST", body: JSON.stringify({ reconcileAll: true }) });
      setTimeout(load, 1200);
    } catch (e) { alert("同步失败: " + e.message); }
    finally { setTimeout(() => setSyncing(false), 1400); }
  }

  const pending = sync?.pendingCount || 0;
  const failed = sync?.failedCount || 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>仪表盘</h2>
          <p>模型用量、剧本存量与 Redis → PostgreSQL 的同步对账状态。</p>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-outline btn-sm" onClick={load}>↻ 刷新</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 18 }}>
        <StatTile label="LLM 调用次数" value={fmt(stats?.llm?.calls)} />
        <StatTile label="输入 Token" value={fmt(stats?.llm?.inputTokens)} />
        <StatTile label="输出 Token" value={fmt(stats?.llm?.outputTokens)} />
        <StatTile label="剧本总数" value={fmt(stats?.scripts)} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>PG 同步状态</strong>
          <span className={`tag ${failed > 0 ? "tag-danger" : pending > 0 ? "tag-warning" : "tag-success"}`} style={{ marginLeft: 4 }}>
            {failed > 0 ? "有失败项" : pending > 0 ? "有待同步" : "已对齐"}
          </span>
          <div className="panel-actions">
            <button className="btn btn-outline btn-sm" disabled={syncing} onClick={syncNow}>
              {syncing ? "同步中…" : "立即同步对账"}
            </button>
          </div>
        </div>

        <div className="field-row"><span className="field-key">待同步</span><span className="field-val">{fmt(pending)} 项</span></div>
        <div className="field-row"><span className="field-key">失败</span><span className="field-val" style={{ color: failed > 0 ? "var(--wax-bright)" : undefined }}>{fmt(failed)} 项</span></div>

        {sync?.pending?.length > 0 && (
          <div className="text-xs text-muted" style={{ marginTop: 10, wordBreak: "break-all", lineHeight: 1.8 }}>
            队列：{sync.pending.slice(0, 8).join("、")}{sync.pending.length > 8 ? " …" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
