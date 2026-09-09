import React, { useState, useEffect } from "react";
import { apiJson } from "../lib/api.js";

export default function StatsPage() {
  const [stats, setStats] = useState(null);
  const [sync, setSync] = useState(null);

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

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div className="grid-4 mb-lg" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
        <StatCard label="LLM 调用次数" value={fmt(stats?.llm?.calls)} />
        <StatCard label="输入 Token" value={fmt(stats?.llm?.inputTokens)} />
        <StatCard label="输出 Token" value={fmt(stats?.llm?.outputTokens)} />
        <StatCard label="剧本总数" value={fmt(stats?.scripts)} />
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <strong style={{ color: "var(--gold)" }}>PG 同步状态</strong>
        <div style={{ fontSize: 13, marginTop: 8, color: "var(--dim)" }}>
          待同步: {fmt(sync?.pendingCount)} | 失败: {fmt(sync?.failedCount)}
        </div>
        {sync?.pending?.length > 0 && (
          <div className="text-xs text-dim mt-sm" style={{ wordBreak: "break-all" }}>
            队列: {sync.pending.slice(0, 8).join("、")}{sync.pending.length > 8 ? " …" : ""}
          </div>
        )}
        <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={async () => {
          try {
            await apiJson("/api/admin/sync-now", {
              method: "POST",
              body: JSON.stringify({ reconcileAll: true }),
            });
            setTimeout(load, 1200);
          } catch (e) { alert("同步失败: " + e.message); }
        }}>立即同步对账</button>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="card card-static text-center" style={{ padding: 20 }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: "var(--gold)" }}>{value}</div>
      <div className="text-xs text-dim">{label}</div>
    </div>
  );
}