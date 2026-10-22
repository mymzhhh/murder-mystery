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

  // 人数兜底：历史产物里的 outline 不一定带 playerCount/npcCount 字段（实测《临河客栈桐油案》
  // 的 artifacts.outline 里这两个字段是 undefined，面板只能显示"?"）。
  // 数组是有的，从数组长度兜底，免得排查时看到一个无意义的问号。
  const playerCount = o.playerCount != null ? o.playerCount : ((o.players || []).length || "?");
  const npcCount = o.npcCount != null ? o.npcCount : ((o.npcs || []).length || 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>🎭 剧本大纲</strong>
        <span className="tag tag-admin">{o.isPVE ? "PVE" : "PVP"}</span>
        <span className="tag">{playerCount} 玩家</span>
        <span className="tag tag-npc">{npcCount} NPC</span>
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

      {/* 关系网 —— 每条要有"关系"和"具体冲突事实"，光写"旧识"没有用。
          用户反馈：关系那块要写清楚，越清楚下游越不容易编。 */}
      {o.relations && o.relations.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 8 }}>
            <span style={{ flex: "0 0 auto" }}>人物关系网（关系 + 具体冲突）</span>
            <span className="tag">{o.relations.length} 条</span>
          </div>
          {(o.relations || []).map((r, i) => (
            <div key={i} className="outline-row" style={{ display: "block", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{r.a}</strong>
                <span className="text-muted">↔</span>
                <strong>{r.b}</strong>
                <span className="text-dim" style={{ fontSize: 12 }}>{r.link || ""}</span>
              </div>
              <div className="text-xs" style={{ marginTop: 3, color: r.tension ? "var(--warning)" : "var(--text-dim)" }}>
                冲突/杀机：{r.tension || "（未写明——下游只能自己编）"}
              </div>
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

      {/* 时间线骨架 —— 同一时刻合并成一组，时刻只出现一次。
          2026-10-20 用户反馈两轮：
            ① 面板只渲染 time + desc，把 actor 丢了 → 看到的是没有主语的句子；
            ② 同一时刻（19:30）被拆成好几行重复写同一时刻 → 要合并。
          现在：时刻作为组头，组内每个角色一行（主语 · 📍地点 · 动作）。 */}
      {o.timeline && o.timeline.length > 0 && (() => {
        const groups = new Map();
        for (const t of o.timeline) {
          const k = String(t.time || "").trim();
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(t);
        }
        const times = [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)));
        return (
          <section className="outline-sec">
            <div className="kicker" style={{ marginBottom: 8 }}>
              <span style={{ flex: "0 0 auto" }}>时间线骨架（谁·几点·在哪·做什么）</span>
              <span className="tag">{o.timeline.length} 条 · {times.length} 个时刻</span>
            </div>
            {times.map((time) => {
              const rows = groups.get(time) || [];
              return (
                <div
                  key={time}
                  className="outline-row"
                  style={{
                    display: "flex", gap: 10, alignItems: "flex-start",
                    padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.06)",
                  }}
                >
                  <strong style={{
                    color: "var(--brass)", fontFamily: "var(--font-mono)", fontSize: 12,
                    flex: "0 0 44px", paddingTop: 1,
                  }}>{time || "—"}</strong>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {rows.map((t, i) => (
                      <div key={i} style={{ marginBottom: i === rows.length - 1 ? 0 : 2, lineHeight: 1.7 }}>
                        <strong style={{ display: "inline-block", minWidth: 56 }}>{t.actor || "（缺主语）"}</strong>
                        {t.place ? <span className="text-muted" style={{ fontSize: 11, marginRight: 6 }}>📍{t.place}</span> : null}
                        <span>{t.desc || t.doing || ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })()}

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
