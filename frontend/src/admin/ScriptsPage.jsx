import React, { useState, useEffect } from "react";
import { api, apiJson } from "../lib/api.js";
import { readSSE } from "../lib/sse.js";
import { getToken } from "../lib/api.js";
import TrickPanel from "./TrickPanel.jsx";
import { ScriptBody } from "../components/ScriptBody.jsx";

// 体检结论的人话映射。
// 尤其要处理 na：它的含义是"判据证据不足，这一项**没把关**"——
// 实测出现过（1996 长沙）交叉校验第一条就是"六个角色五套日期"，而体检只能给 na。
// 直接显示 "na" 会让人以为它是个正常状态。
const VERDICT_TEXT = {
  ok: "ok",
  bad: "不通过",
  na: "无法判定（证据不足，没把关）",
  unknown: "算不出来",
};
const verdictText = (v) => VERDICT_TEXT[v] ?? String(v ?? "-");

export default function ScriptsPage() {
  const [scripts, setScripts] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState(null); // { title, markdown }
  const [splitView, setSplitView] = useState(null);
  const [job, setJob] = useState(null);   // { label, logs, running, done, error }

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

  // 上架/下架：下架后玩家大厅看不到、也不能凭 id 建房（管理端一切照旧）
  async function doTogglePublic(s) {
    const id = s.sessionId || s.id;
    const next = s.isPublic === false;   // 当前是下架 → 点了就是上架
    try {
      await api(`/api/admin/scripts/${id}/visibility`, { method: "PATCH", body: { isPublic: next } });
      load();
    } catch (e) { alert(e.message); }
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

  // 评测+切分（SSE 进度）——原先用 window.open 弹小窗承载进度，
  // 被浏览器拦截时任务照跑但界面上毫无反馈，且完成后不刷新列表。
  function doReviewSplit(id) { runJob(`/api/admin/scripts/${id}/review-split`, "评测并切分"); }
  function doSplit(id) { runJob(`/api/admin/scripts/${id}/split`, "切分"); }

  function pushLog(text) {
    setJob((j) => (j ? { ...j, logs: [...j.logs, text] } : j));
  }

  function runJob(url, label) {
    if (job?.running) return;
    setJob({ label, logs: [], running: true, done: false, error: "" });
    (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
          body: "{}",
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `失败 ${res.status}`);
        }
        await readSSE(res, {
          onProgress: (st, msg) => pushLog(`${st}: ${msg}`),
          onPhase: (ph, msg) => pushLog(msg),
          onComplete: (d) => pushLog(d.status === "done" ? "✓ 完成" : JSON.stringify(d).substring(0, 120)),
          onError: (msg) => {
            pushLog("❌ " + msg);
            setJob((j) => (j ? { ...j, error: msg } : j));
          },
        });
        setJob((j) => (j ? { ...j, running: false, done: true } : j));
        load(); // 完成后刷新列表，让状态可见
      } catch (e) {
        pushLog("❌ " + e.message);
        setJob((j) => (j ? { ...j, running: false, error: e.message } : j));
      }
    })();
  }

  const busy = !!job?.running;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>剧本管理</h2>
          <p>共 {scripts.length} 个剧本。切分之后才能在玩家端开局；「切分预览」可以直接看到切出来的角色、线索与 DM 手册。</p>
        </div>
        <div className="page-head-actions">
          <input
            className="form-input form-input-sm"
            style={{ width: 240 }}
            placeholder="搜索剧本标题或 ID…"
            aria-label="搜索剧本"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-outline btn-sm" onClick={load}>↻ 刷新</button>
        </div>
      </div>

      {/* 任务进度（页内展示，不依赖弹窗） */}
      {job && (
        <div className="panel" style={{ borderLeft: `2px solid ${job.error ? "var(--wax)" : job.running ? "var(--brass)" : "var(--verd)"}` }}>
          <div className="panel-head">
            <strong style={{ color: job.error ? "var(--wax-bright)" : job.done ? "var(--verd-bright)" : "var(--brass)" }}>
              {job.label} {job.running ? "进行中…" : job.error ? "失败" : "已完成"}
            </strong>
            {job.running
              ? <span className="text-xs text-dim">请勿关闭页面</span>
              : <button className="btn btn-outline btn-xs" style={{ marginLeft: "auto" }} onClick={() => setJob(null)}>关闭</button>}
          </div>
          <div className="log-view">
            {job.logs.map((l, i) => <div key={i} className="log-line">{l}</div>)}
            {job.logs.length === 0 && <div className="text-muted">等待开始…</div>}
          </div>
        </div>
      )}

      <div className="panel">
        {loading && <div className="state-loading">加载中…</div>}
        {!loading && scripts.length === 0 && (
          <div className="state-empty">{q ? `没有匹配「${q}」的剧本` : "暂无剧本，先去「剧本生成」跑一版"}</div>
        )}
        <div className="stagger" style={{ display: "grid", gap: 8 }}>
          {scripts.map((s) => (
            <div key={s.sessionId || s.id} className="card card-static" style={{ padding: "12px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: 16, letterSpacing: ".05em" }}>
                      {s.title || s.topic || "未命名"}
                    </span>
                    {/* 后端 /api/admin/scripts 返回的是 characterCount，不是 playerCount */}
                    {s.characterCount ? <span className="tag tag-admin">{s.characterCount} 角色</span> : null}
                    {s.isSplit
                      ? <span className="tag tag-success">已切分</span>
                      : <span className="tag tag-warning">未切分</span>}
                    {/* 下架状态必须显眼：否则管理端看不出"玩家为什么看不到这本" */}
                    {s.isPublic === false ? <span className="tag tag-danger">仅管理端</span> : null}
                  </div>
                  <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                    {new Date(s.createdAt || Date.now()).toLocaleString()}
                    {s.messageCount ? ` ｜ ${s.messageCount} 条线索` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="btn btn-outline btn-xs" onClick={() => doView(s.sessionId || s.id)}>查看</button>
                  <button className="btn btn-outline btn-xs" onClick={() => doSplitView(s.sessionId || s.id)}>切分预览</button>
                  <button className="btn btn-success btn-xs" disabled={busy} onClick={() => doReviewSplit(s.sessionId || s.id)}>评测并切分</button>
                  <button className="btn btn-outline btn-xs" onClick={() => doSplit(s.sessionId || s.id)}>仅切分</button>
                  <button className="btn btn-outline btn-xs" onClick={() => doTogglePublic(s)}>
                    {s.isPublic === false ? "上架（玩家可见）" : "下架（仅管理端）"}
                  </button>
                  <button className="btn btn-danger btn-xs" onClick={() => doDelete(s.sessionId || s.id)}>删除</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 查看剧本弹窗 */}
      {view && (
        <Modal title={view.title || "剧本"} onClose={() => setView(null)}>
          {/* 用与玩家端同一份正文渲染器（components/ScriptBody.jsx），不再是一坨 <pre>：
              正文里的 `![说明](img:键名)` 配图在管理端也要能看到，
              否则"这稿的地图有没有出问题"就只能去玩家端开局才知道。
              传 scriptId 才能拼出取图地址（view.id 就是剧本 id / sessionId）。 */}
          <div className="script-reader">
            <ScriptBody text={view.markdown} scriptId={view.id} />
          </div>
        </Modal>
      )}

      {/* 切分预览 */}
      {splitView && (
        <Modal title="切分数据" onClose={() => setSplitView(null)}>
          {/* 推理链 + 交叉校验问题：这稿的诡计怎么设计的、弱在哪。
              此前它们只在生成进程的内存里——刷新即失，事后无从复核（见"改动 4 的另一半"）。 */}
          {splitView.artifacts?.trickDesign && (
            <div style={{ marginBottom: 16 }}>
              {splitView.artifacts.trickDesign.proofChainOmitted ? (
                <div className="alert alert-warning" style={{ marginBottom: 10 }}>
                  <span className="alert-body">
                    该剧本的中间产物体积超限，逐条证明链已省略（原有 {splitView.artifacts.trickDesign.proofChainOmitted} 条）。
                  </span>
                </div>
              ) : null}
              <TrickPanel design={splitView.artifacts.trickDesign} />
            </div>
          )}
          {splitView.artifacts?.crossCheck?.issues?.length ? (
            <section className="outline-sec" style={{ marginBottom: 16 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                <span style={{ flex: "0 0 auto" }}>交叉校验问题（生成时检出）</span>
                <span className="tag tag-warning">{splitView.artifacts.crossCheck.count} 个</span>
              </div>
              {splitView.artifacts.crossCheck.issues.map((t, i) => (
                <div key={i} className="outline-row"><span className="text-dim">{t}</span></div>
              ))}
            </section>
          ) : null}
          {splitView.artifacts?.revision?.length ? (
            <section className="outline-sec" style={{ marginBottom: 16 }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                <span style={{ flex: "0 0 auto" }}>自动改写留档（照着问题清单把哪几段换成了什么）</span>
                <span className="tag tag-admin">{splitView.artifacts.revision.length} 轮</span>
              </div>
              {/* 驱动修订的问题清单是 LLM 产的、有噪声，而它照着清单自动改稿。
                  留档就是为了让人能逐条核对"它改对了吗"，而不是只能看到一个"已应用 N 条"。 */}
              {splitView.artifacts.revision.map((r, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div className="text-xs text-muted" style={{ marginBottom: 4 }}>
                    第 {r.round} 轮：问题 {r.issueCount ?? "?"} 个 ｜ 应用 {r.applied ?? "?"} 条 ｜ 无法定位 {r.skipped ?? "?"} 条
                    {r.note ? <span style={{ color: "var(--warning)" }}> ｜ {r.note}</span> : null}
                    {r.reverted ? <span style={{ color: "var(--danger)" }}> ｜ 已整体撤销</span> : null}
                    {r.recheckFailed ? <span style={{ color: "var(--warning)" }}> ｜ 复检没有结论（输出无法解析，沿用原清单）</span> : null}
                    {r.salvaged ? <span style={{ color: "var(--warning)" }}> ｜ 补丁是从截断输出里抢救来的（{r.salvaged} 条）</span> : null}
                    {r.verdict ? (
                      <span className="text-dim">
                        {" ｜ 体检：日期一致="}{verdictText(r.verdict.dateAgreement)}
                        {"、轮次解锁="}{verdictText(r.verdict.roundUnlock)}
                        {"、死亡后活动="}{r.verdict.deathViolations ?? 0}处
                      </span>
                    ) : null}
                  </div>
                  {(r.patches || []).slice(0, 6).map((p, j) => (
                    <div key={j} className="card card-static" style={{ marginBottom: 6, padding: "8px 10px" }}>
                      <div className="text-xs" style={{ lineHeight: 1.7 }}>
                        <span style={{ color: "var(--danger)" }}>− </span>{p.oldText.slice(0, 160)}
                      </div>
                      <div className="text-xs" style={{ lineHeight: 1.7 }}>
                        <span style={{ color: "var(--success)" }}>＋ </span>{p.newText.slice(0, 160)}
                      </div>
                    </div>
                  ))}
                  {(r.patches || []).length > 6
                    ? <div className="text-xs text-dim">…另有 {r.patches.length - 6} 条，见下方 JSON</div>
                    : null}
                </div>
              ))}
              {/* 复检结论：说明"改完又读了一遍"，但**不能**把问题数当成好坏判据——
                  实测同一份文本连读两遍，两批问题只有约 2/10 能对应上（校验器自身不可复现）。
                  所以这里如实标注它是抽样结果、只供人工复核参考。 */}
              {splitView.artifacts.revisionRecheck ? (
                <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                  {splitView.artifacts.revisionRecheck.failed ? (
                    <span style={{ color: "var(--warning)" }}>
                      复检没有结论：改写后重新交叉校验，但模型输出无法解析——这不等于"没有问题"，
                      本轮修订是沿用原清单走完的，建议人工复核。
                    </span>
                  ) : (
                    <>
                      复检抽样：改写后重新交叉校验，报出 {splitView.artifacts.revisionRecheck.count} 个问题。
                      <span className="text-dim">
                        （注意：交叉校验是 LLM 抽样，实测同一份文本连读多遍也只有极少数能对应上，
                        因此这个数字不能当作「改好了没有」的判据，仅供人工复核参考。）
                      </span>
                    </>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
          {splitView.artifacts ? null : (
            <div className="text-xs text-muted" style={{ marginBottom: 10 }}>
              该剧本没有中间产物（在本次改动之前生成的剧本不会记录推理链）。
            </div>
          )}
          <pre style={{ fontSize: 12 }}>{JSON.stringify(splitView, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      {/* 点遮罩关闭，点内容不关 —— 内容区需要能选中文字 */}
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button className="btn btn-outline btn-xs" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
