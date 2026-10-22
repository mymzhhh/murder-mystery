import React, { useEffect, useState } from "react";
import { api, apiJson } from "../lib/api.js";

/** 测试报告：一局跑完后的**结论**（不是原始流水），落库在 PostgreSQL。
 *
 *  列表页只拉摘要（不含完整 JSON），点开某一条再取详情 —— 报告可能很大。
 *  列表页最重要的是"能不能一眼看出哪几局有问题"，所以判定结论做成徽章放最前。 */
const VERDICT_STYLE = {
  issue: { bg: "rgba(220,80,80,.18)", color: "var(--danger)", text: "发现疑似问题" },
  inconclusive: { bg: "rgba(220,170,60,.18)", color: "var(--warning)", text: "结论不确定" },
  clean: { bg: "rgba(90,180,120,.18)", color: "var(--success, #6b8)", text: "未发现问题" },
};

function fmtTime(v) {
  if (!v) return "-";
  try { return new Date(v).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return String(v); }
}
const fmtDur = (ms) => {
  const s = Math.round((Number(ms) || 0) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
};

export default function TestReportsPage() {
  const [list, setList] = useState([]);
  const [detail, setDetail] = useState(null);   // 展开的那一条（含完整 report）
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const d = await apiJson("/api/admin/test-reports?limit=100");
      setList(d.reports || []);
    } catch (e) { setError("读取报告失败：" + e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function open(id) {
    if (detail && detail.id === id) { setDetail(null); return; }
    try {
      const d = await apiJson(`/api/admin/test-reports/${id}`);
      setDetail(d.report);
    } catch (e) { setError("读取详情失败：" + e.message); }
  }

  async function remove(id) {
    if (!confirm(`删除报告 #${id}？`)) return;
    try { await api(`/api/admin/test-reports/${id}`, { method: "DELETE" }); setDetail(null); await load(); }
    catch (e) { setError("删除失败：" + e.message); }
  }

  const rep = detail && detail.report ? detail.report : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>测试报告</h2>
          <p className="text-dim">每跑完一局测试就落一份结论（线索有没有搜空、谁一次手都没出、AI 有没有异常、真凶有没有被指认）。</p>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>{loading ? "读取中…" : "↻ 刷新"}</button>
        </div>
      </div>

      {error ? <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div> : null}
      {!list.length && !loading ? (
        <div className="panel"><div className="text-xs text-dim">还没有报告。去「测试剧本」跑一局，结束后就会出现在这里。</div></div>
      ) : null}

      {list.map((r) => {
        const st = VERDICT_STYLE[r.verdict] || VERDICT_STYLE.inconclusive;
        const open_ = detail && detail.id === r.id;
        return (
          <div className="panel" key={r.id} style={{ marginBottom: 10 }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flexWrap: "wrap" }}
              onClick={() => open(r.id)}
            >
              <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 10, background: st.bg, color: st.color, whiteSpace: "nowrap" }}>
                {r.verdict_text || st.text}
              </span>
              <strong>{r.script_title || "（无标题）"}</strong>
              <span className="text-xs text-dim">房间 {r.room_code}　{fmtTime(r.created_at)}</span>
              <span className="text-xs text-dim" style={{ marginLeft: "auto" }}>
                线索 {r.clue_found}/{r.clue_total}
                {r.unreachable_count > 0 ? <span style={{ color: "var(--danger)" }}>　不可达 {r.unreachable_count}</span> : null}
                {r.silent_ai_count > 0 ? <span style={{ color: "var(--danger)" }}>　零出手 {r.silent_ai_count}</span> : null}
                {r.error_count > 0 ? <span style={{ color: "var(--warning)" }}>　异常 {r.error_count}</span> : null}
                {/* 显式写成字符串表达式：JSX 里裸写的全角空格在换行处会被吃掉（实测"异常 1耗时 13 分"） */}
                {"　耗时 "}{fmtDur(r.duration_ms)}
              </span>
              <span className="text-dim">{open_ ? "▾" : "▸"}</span>
            </div>

            {open_ && rep ? (
              <div className="text-xs" style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))", lineHeight: 1.8 }}>
                <div className="text-dim">
                  阶段时长 {rep.phaseMinutes} 分钟／阶段　·　起 {fmtTime(rep.startedAt)}　·　止 {fmtTime(rep.endedAt)}
                  　·　{rep.reason === "completed" ? "跑完" : rep.reason === "stopped" ? "被提前结束" : "重启后收尾"}
                </div>

                <div style={{ marginTop: 8 }}>
                  <strong>判定明细</strong>
                  {rep.findings && rep.findings.length ? rep.findings.map((f, i) => (
                    <div key={i} style={{ marginTop: 3 }}>
                      <span style={{ color: f.level === "error" ? "var(--danger)" : f.level === "warn" ? "var(--warning)" : "var(--text-dim)" }}>
                        {f.level === "error" ? "✘" : f.level === "warn" ? "⚠" : "·"}
                      </span>{" "}
                      {f.text}
                    </div>
                  )) : <div className="text-dim">无</div>}
                </div>

                <div style={{ marginTop: 8 }}>
                  <strong>每轮搜证</strong>
                  {(rep.rounds || []).map((r) => (
                    <div key={r.round} style={{ marginTop: 3 }}>
                      第 {r.round} 轮：{r.found}/{r.pool}{" "}
                      {r.swept ? <span style={{ color: "var(--success, #6b8)" }}>已搜空 ✔</span> : <span style={{ color: "var(--warning)" }}>没搜完</span>}
                    </div>
                  ))}
                  {!(rep.rounds || []).length ? <div className="text-dim">没有线索数据（本身就是一个问题）</div> : null}
                </div>

                <div style={{ marginTop: 8 }}>
                  <strong>AI 出手</strong>
                  <div className="text-dim">（自我介绍 / 发言 / 提问 / 投票 / 搜证）</div>
                  {(rep.ai || []).map((a) => (
                    <div key={a.name} style={{ marginTop: 3 }}>
                      {a.name}：{a.intro} / {a.speak} / {a.ask} / {a.vote}
                      {a.total === 0 ? <span style={{ color: "var(--danger)" }}>　一次都没出手</span> : null}
                    </div>
                  ))}
                </div>

                {rep.errorCount > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    <strong>AI 异常 {rep.errorCount} 次</strong>
                    {(rep.errors || []).map((e, i) => (
                      <div key={i} className="text-dim" style={{ marginTop: 3 }}>
                        {fmtTime(e.at)}　{e.name}／{e.kind}：{e.message}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div style={{ marginTop: 8 }}>
                  <strong>投票与结局</strong>
                  <div style={{ marginTop: 3 }}>{rep.voting && rep.voting.outcomeText}</div>
                  <div style={{ marginTop: 3 }}>
                    真凶：<strong>{rep.voting && rep.voting.murdererName}</strong>
                    {rep.voting && rep.voting.tally
                      ? <span className="text-dim">　票型：{Object.entries(rep.voting.tally).map(([n, c]) => `${n} ${c} 票`).join("、")}</span>
                      : null}
                  </div>
                  {rep.voting && rep.voting.byVoter && rep.voting.byVoter.length ? (
                    <div style={{ marginTop: 4 }}>
                      <div className="text-dim">谁投了谁：{rep.voting.byVoter.map((v) => `${v.voter}→${v.target}`).join("、")}</div>
                      {/* 逐票理由（2026-10-22 用户要求）：报告要能回答"每个 AI 为什么投给这个人"。
                          没有理由的票也列出来并标注原因（真人玩家 / 规则兜底 / 早期局未记录）。 */}
                      <details style={{ marginTop: 4 }}>
                        <summary className="text-xs" style={{ cursor: "pointer" }}>
                          投票理由（{rep.voting.byVoter.length} 票）
                        </summary>
                        <div style={{ marginTop: 3 }}>
                          {rep.voting.byVoter.map((v, i) => (
                            <div key={i} style={{ marginBottom: 6, lineHeight: 1.55 }}>
                              <span>{v.voter}</span>
                              <span className="text-dim"> → 投 </span>
                              <strong style={{ color: v.target === (rep.voting.murdererName || "") ? "var(--wax-bright, #d64d50)" : "var(--text)" }}>{v.target}</strong>
                              <div className="text-xs" style={{ color: "var(--text-dim)", marginLeft: 12 }}>
                                {v.reason || "（没有记录理由 —— 可能是真人玩家，或这一局早于「记录理由」功能上线）"}
                              </div>
                              {/* 依据线索编号（2026-10-22）：理由像模像样不算数，编号对不对才是硬判据 */}
                              {(v.basis && v.basis.length) || (v.invalidBasis && v.invalidBasis.length) ? (
                                <div className="text-xs" style={{ marginLeft: 12, marginTop: 1 }}>
                                  {v.basis && v.basis.length ? <span className="text-dim">依据：{v.basis.join("、")}</span> : null}
                                  {v.invalidBasis && v.invalidBasis.length ? (
                                    <span style={{ color: "var(--danger)" }}>
                                      {v.basis && v.basis.length ? "　" : ""}⚠ 编造编号：{v.invalidBasis.join("、")}（不存在）
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  ) : null}
                </div>

                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-outline btn-xs" onClick={() => remove(r.id)}>删除这份报告</button>
                  <a className="btn btn-outline btn-xs" style={{ marginLeft: 8 }} href={`/api/admin/test-reports/${r.id}`} target="_blank" rel="noreferrer">看原始 JSON</a>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
