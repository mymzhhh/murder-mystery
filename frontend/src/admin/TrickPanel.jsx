import React from "react";

// 核心诡计设计可视化面板（"推理链"的可见面）。
//
// 为什么单独做一块：诡计定稿器产出的不只是"一句话诡计"，而是一条**可校验的推理链**——
//   机制 → 物理可行性 → 目击条件 → 最弱处 → 证明链（每条线索各自能推出什么）
// 此前管理端只能看到一行进度文字（"核心诡计已定稿并通过校验：…"），
// 三锁覆盖、物理可行性、最弱处这些**判断依据**全都看不到，也就无从复核"这个诡计靠不靠得住"。

/** 与后端 splitSupports 同一套拆分规则（支持 identity-motive / motive、means 这类复合写法） */
function splitSupports(v) {
  return String(v || "").split(/[-–—/／、,，|+]/).map((s) => s.trim()).filter(Boolean);
}

const KIND_LABEL = {
  physical: "物证痕迹",
  "physical-trace": "物证痕迹",
  testimony: "证词",
  record: "书面记录",
  "document": "书面记录",
};

// 三锁：玩家要能推出"为什么是他/他怎么做到/他凭什么有机会"，三者缺一不可
const LOCKS = [
  { key: "motive", label: "动机", hint: "为什么是他" },
  { key: "means", label: "手法", hint: "他怎么做到的" },
  { key: "opportunity", label: "机会", hint: "他凭什么能下手" },
];

export default function TrickPanel({ design: d }) {
  if (!d) return null;
  const chain = Array.isArray(d.proofChain) ? d.proofChain : [];
  const feas = d.feasibility || {};
  const isClock = !!d.dependsOnClock || d.type === "时间诡计";
  const isIdentity = d.type === "身份错位";

  // 三锁（+ 时间线 / 身份这两个条件性维度）各自被哪些线索支撑
  const extra = [];
  if (isClock) extra.push({ key: "timeline", label: "时间线", hint: "钟被动过的证明" });
  if (isIdentity) extra.push({ key: "identity", label: "身份", hint: "谁是谁的证明" });
  const rows = [...LOCKS, ...extra].map((lock) => ({
    ...lock,
    clues: chain.map((c, i) => ({ ...c, _i: i })).filter((c) => splitSupports(c.supports).includes(lock.key)),
  }));
  const missing = rows.filter((r) => r.clues.length === 0);
  const redo = (d.attempts || 1) > 1;

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>🃏 核心诡计（推理链）</strong>
        {d.type ? <span className="tag tag-admin">{d.type}</span> : null}
        {d.genre ? <span className="tag">{d.genre}</span> : null}
        {isClock ? <span className="tag tag-warning">涉公共时钟</span> : null}
        <span className="tag tag-npc">{chain.length} 条证明链</span>
        {/* 一次通过 vs 被打回重做，对"这个诡计靠不靠得住"是两条不同的信息 */}
        {redo
          ? <span className="tag tag-warning">第 {d.attempts} 次通过</span>
          : <span className="tag tag-success">一次通过校验</span>}
      </div>

      {/* 核心诡计一句话 */}
      <div className="card card-static">
        <div className="text-xs text-muted">核心诡计</div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, color: "var(--wax-bright)", margin: "3px 0 8px", letterSpacing: ".04em", lineHeight: 1.6 }}>
          {d.coreTrick || "—"}
        </div>
        <div className="text-xs text-dim" style={{ lineHeight: 1.9 }}>
          {d.mechanism ? <div><strong>运作原理：</strong>{d.mechanism}</div> : null}
          {d.conceal ? <div><strong>隐藏方式：</strong>{d.conceal}</div> : null}
          {d.breakPoint ? <div><strong>破绽方向：</strong>{d.breakPoint}</div> : null}
        </div>
      </div>

      {redo && (d.lastErrors || []).length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 8 }}><span style={{ flex: "0 0 auto" }}>被打回的原因（校验器判定）</span></div>
          {(d.lastErrors || []).map((e, i) => (
            <div key={i} className="outline-row"><span className="text-dim">{e}</span></div>
          ))}
        </section>
      )}

      {/* 三锁覆盖：这是"这个诡计能不能被推出来"的核心判据 */}
      <section className="outline-sec">
        <div className="kicker" style={{ marginBottom: 10 }}>
          <span style={{ flex: "0 0 auto" }}>三锁覆盖</span>
          {missing.length === 0
            ? <span className="tag tag-success">齐备</span>
            : <span className="tag tag-danger">缺 {missing.map((m) => m.label).join("、")}</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
          {rows.map((r) => (
            <div key={r.key} className="card card-static" style={{ padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong style={{ fontFamily: "var(--font-serif)", letterSpacing: ".06em" }}>{r.label}</strong>
                <span className="text-xs text-muted">{r.hint}</span>
                {r.clues.length > 0
                  ? <span className="tag tag-success">{r.clues.length} 条</span>
                  : <span className="tag tag-danger">无线索</span>}
              </div>
              <div className="text-xs text-dim mt-sm" style={{ lineHeight: 1.7 }}>
                {r.clues.length > 0
                  ? r.clues.map((c) => `#${c._i + 1}`).join("、")
                  : "没有任何线索支撑这一维——玩家推不出来"}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 物理可行性：为什么做得到、会不会被看到、最容易被识破在哪 */}
      {(feas.physics || feas.witness || feas.weakest) && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 10 }}><span style={{ flex: "0 0 auto" }}>物理可行性</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 10 }}>
            {feas.physics ? (
              <div className="card card-static">
                <div className="text-xs text-muted">为什么物理/时空上做得到</div>
                <div className="text-xs text-dim mt-sm" style={{ lineHeight: 1.8 }}>{feas.physics}</div>
              </div>
            ) : null}
            {feas.witness ? (
              <div className="card card-static">
                <div className="text-xs text-muted">目击条件</div>
                <div className="text-xs text-dim mt-sm" style={{ lineHeight: 1.8 }}>{feas.witness}</div>
              </div>
            ) : null}
            {feas.weakest ? (
              <div className="card card-static" style={{ borderColor: "var(--wax)" }}>
                <div className="text-xs text-muted">最容易被识破的地方</div>
                <div className="text-xs text-dim mt-sm" style={{ lineHeight: 1.8 }}>{feas.weakest}</div>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* 证明链：每条线索是什么、支撑哪一维、能推出什么 */}
      {chain.length > 0 && (
        <section className="outline-sec">
          <div className="kicker" style={{ marginBottom: 8 }}><span style={{ flex: "0 0 auto" }}>证明链（玩家要靠这几条线索一步步推出真相）</span></div>
          {chain.map((c, i) => (
            <div key={i} className="outline-row" style={{ alignItems: "flex-start" }}>
              <strong style={{ color: "var(--brass)", fontFamily: "var(--font-mono)", fontSize: 12, flex: "0 0 auto" }}>#{i + 1}</strong>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                  {c.kind ? <span className="tag">{KIND_LABEL[c.kind] || c.kind}</span> : null}
                  {splitSupports(c.supports).map((s) => <span key={s} className="tag tag-admin">{s}</span>)}
                </div>
                <div className="text-xs" style={{ lineHeight: 1.8 }}>{c.clue || "—"}</div>
                {c.proves ? <div className="text-xs text-dim" style={{ lineHeight: 1.8, marginTop: 2 }}>→ 能推出：{c.proves}</div> : null}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
