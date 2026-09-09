import React from "react";

// 剧本大纲可视化面板：标题/核心诡计/人物卡/关系网/凶手双时间线/时间线骨架/布局
export default function OutlinePanel({ outline: o }) {
  if (!o) return null;
  const ts = o.trickSpec || {};
  const v = o.victim || {};
  const m = o.murderer || {};
  const chars = [];
  (o.players || []).forEach((p) => chars.push({
    name: p.name, tag: p.isMurderer ? "🔪凶手" : "玩家", clazz: p.isMurderer ? "tag-admin" : "tag-player", meta: p.identity || "",
  }));
  (o.npcs || []).forEach((n) => chars.push({
    name: n.name, tag: "NPC", clazz: "tag-npc", meta: (n.identity || "") + (n.isMurderer ? " 🔪" : ""),
  }));

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ color: "var(--gold)", margin: 0 }}>🎭 剧本大纲</h3>
        <span className="tag">{o.isPVE ? "PVE" : "PVP"} · {o.playerCount || "?"}玩家 + {(o.npcCount || 0)}NPC</span>
      </div>

      {/* 标题 + 核心诡计 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10, marginTop: 10 }}>
        <div className="card card-static">
          <div className="text-xs text-dim">剧本名</div>
          <strong style={{ fontSize: 18 }}>{o.title || "未命名"}</strong>
          <div className="text-xs mt-sm">{o.storyBackground || ""}</div>
        </div>
        <div className="card card-static">
          <div className="text-xs text-dim">核心诡计</div>
          <strong style={{ color: "var(--blood-light)" }}>{o.coreTrick || ""}</strong>
          <div className="text-xs mt-sm">{ts.trick ? ts.trick + "·" : ""}{ts.type || ""}{ts.mechanism ? "｜" + ts.mechanism : ""}</div>
        </div>
      </div>

      {/* 死者 + 凶手 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10, marginTop: 8 }}>
        <div className="card card-static">
          <div className="text-xs text-dim">死者</div>
          <strong>{v.name || "?"}</strong>
          <div className="text-xs mt-sm">{[v.identity, v.causeOfDeath, v.deathPlace].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="card card-static">
          <div className="text-xs text-dim">凶手</div>
          <strong style={{ color: "var(--danger)" }}>{m.name || "?"}</strong>
          <div className="text-xs mt-sm">动机：{m.motive || ""}</div>
        </div>
      </div>

      {/* 人物卡 */}
      {chars.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="text-xs text-dim mb-sm">人物</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 8 }}>
            {chars.map((c) => (
              <div key={c.name} className="card card-static" style={{ padding: "8px 10px" }}>
                <strong>{c.name}</strong> <span className={`tag ${c.clazz}`}>{c.tag}</span>
                <div className="text-xs text-dim mt-sm">{c.meta}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 关系网 */}
      {o.relations && o.relations.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="text-xs text-dim mb-sm">人物关系网</div>
          {(o.relations || []).map((r, i) => (
            <div key={i} style={{ fontSize: 12, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
              {r.a} ↔ {r.b}：<span className="text-dim">{r.link || ""}</span> <span style={{ color: "var(--warning)" }}>{r.tension || ""}</span>
            </div>
          ))}
        </div>
      )}

      {/* 凶手双时间线 */}
      {m.realLine && m.fakeLine && (
        <div style={{ marginTop: 10 }}>
          <div className="text-xs text-dim mb-sm">凶手双时间线</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 8 }}>
            <div className="card card-static" style={{ borderLeft: "3px solid var(--danger)" }}>
              <div className="text-xs" style={{ color: "var(--danger)" }}>真实时间线</div>
              <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{m.realLine}</div>
            </div>
            <div className="card card-static" style={{ borderLeft: "3px solid var(--mystic-light)" }}>
              <div className="text-xs" style={{ color: "var(--mystic-light)" }}>对外宣称</div>
              <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{m.fakeLine}</div>
            </div>
          </div>
        </div>
      )}

      {/* 时间线骨架 */}
      {o.timeline && o.timeline.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="text-xs text-dim mb-sm">时间线骨架</div>
          {(o.timeline || []).map((t, i) => (
            <div key={i} style={{ fontSize: 12, padding: "2px 0" }}>
              <strong style={{ color: "var(--gold)" }}>{t.time}</strong> {t.desc}
            </div>
          ))}
        </div>
      )}

      {/* 布局 */}
      {o.layout && o.layout.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="text-xs text-dim mb-sm">场景布局</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(o.layout || []).map((p, i) => (
              <span key={i} className="tag" style={{ padding: "4px 10px" }}>{p}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}