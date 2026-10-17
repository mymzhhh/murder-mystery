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
    <div className="panel">
      <div className="panel-head">
        <strong>🎭 剧本大纲</strong>
        <span className="tag tag-admin">{o.isPVE ? "PVE" : "PVP"}</span>
        <span className="tag">{o.playerCount || "?"} 玩家</span>
        <span className="tag tag-npc">{o.npcCount || 0} NPC</span>
      </div>

      {/* 标题 + 核心诡计 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12 }}>
        <div className="card card-static">
          <div className="text-xs text-muted">剧本名</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, letterSpacing: ".06em", margin: "2px 0 8px" }}>
            {o.title || "未命名"}
          </div>
          <div className="text-xs text-dim" style={{ lineHeight: 1.8 }}>{o.storyBackground || ""}</div>
        </div>
        <div className="card card-static">
          <div className="text-xs text-muted">核心诡计</div>
          {/* 诡计是这份剧本最关键的一句话，给封蜡红 */}
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--wax-bright)", margin: "2px 0 8px", letterSpacing: ".04em" }}>
            {o.coreTrick || "—"}
          </div>
          <div className="text-xs text-dim">
            {ts.trick ? ts.trick + "·" : ""}{ts.type || ""}{ts.mechanism ? "｜" + ts.mechanism : ""}
          </div>
        </div>
      </div>

      {/* 死者 + 凶手 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12, marginTop: 12 }}>
        <div className="card card-static">
          <div className="text-xs text-muted">死者</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, margin: "2px 0 6px" }}>{v.name || "?"}</div>
          <div className="text-xs text-dim">{[v.identity, v.causeOfDeath, v.deathPlace].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="card card-static">
          <div className="text-xs text-muted">凶手</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--wax-bright)", margin: "2px 0 6px" }}>
            {m.name || "?"}
          </div>
          <div className="text-xs text-dim" style={{ lineHeight: 1.8 }}>动机：{m.motive || "—"}</div>
        </div>
      </div>

      {/* 人物卡 */}
      {chars.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 10 }}><span style={{ flex: "0 0 auto" }}>人物</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(184px,1fr))", gap: 8 }}>
            {chars.map((c) => (
              <div key={c.name} className="card card-static" style={{ padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <strong style={{ fontFamily: "var(--font-serif)", letterSpacing: ".06em" }}>{c.name}</strong>
                  <span className={`tag ${c.clazz}`}>{c.tag}</span>
                </div>
                <div className="text-xs text-muted mt-sm" style={{ lineHeight: 1.7 }}>{c.meta}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 关系网 */}
      {o.relations && o.relations.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 8 }}><span style={{ flex: "0 0 auto" }}>人物关系网</span></div>
          {(o.relations || []).map((r, i) => (
            <div key={i} className="outline-row">
              <strong>{r.a}</strong> <span className="text-muted">↔</span> <strong>{r.b}</strong>
              <span className="text-dim">：{r.link || ""}</span>
              {r.tension ? <span className="tag tag-warning" style={{ marginLeft: 8 }}>{r.tension}</span> : null}
            </div>
          ))}
        </section>
      )}

      {/* 凶手双时间线 */}
      {m.realLine && m.fakeLine && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 10 }}><span style={{ flex: "0 0 auto" }}>凶手双时间线</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10 }}>
            <div className="card card-static timeline-card is-real">
              <div className="timeline-label">真实时间线</div>
              <div className="timeline-body">{m.realLine}</div>
            </div>
            <div className="card card-static timeline-card is-fake">
              <div className="timeline-label">对外宣称</div>
              <div className="timeline-body">{m.fakeLine}</div>
            </div>
          </div>
        </section>
      )}

      {/* 时间线骨架 */}
      {o.timeline && o.timeline.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 8 }}><span style={{ flex: "0 0 auto" }}>时间线骨架</span></div>
          {(o.timeline || []).map((t, i) => (
            <div key={i} className="outline-row">
              <strong style={{ color: "var(--brass)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.time}</strong>
              <span style={{ marginLeft: 8 }}>{t.desc}</span>
            </div>
          ))}
        </section>
      )}

      {/* 布局 */}
      {o.layout && o.layout.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 10 }}><span style={{ flex: "0 0 auto" }}>场景布局</span></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(o.layout || []).map((p, i) => (
              <span key={i} className="tag" style={{ padding: "3px 10px", fontFamily: "var(--font-serif)" }}>{p}</span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
