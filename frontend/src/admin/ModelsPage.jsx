import React, { useState, useEffect } from "react";
import { apiJson, api, getToken } from "../lib/api.js";
import { readSSE } from "../lib/sse.js";

const CHANNELS = [
  { key: "generative", label: "🖋️ 生成通道", desc: "剧本创作主生成" },
  { key: "reasoning", label: "🧠 推理通道", desc: "AI玩家/NPC/审讯" },
];

export default function ModelsPage() {
  const [data, setData] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [busy, setBusy] = useState({});

  async function load() {
    try { setData(await apiJson("/api/admin/models")); } catch (e) { alert(e.message); }
  }
  useEffect(() => { load(); }, []);

  // 添加：读表单到服务端
  async function addModel(channel) {
    const name = document.getElementById(`mdlName_${channel}`).value?.trim();
    const model = document.getElementById(`mdlModel_${channel}`).value?.trim();
    const baseUrl = document.getElementById(`mdlUrl_${channel}`).value?.trim();
    const apiKey = document.getElementById(`mdlKey_${channel}`).value?.trim();
    const headersRaw = document.getElementById(`mdlHeaders_${channel}`).value?.trim();
    if (!name || !model) { alert("请填写名称与模型名"); return; }
    // 提前校验，免得服务端报错后表单已被清空
    let extraHeaders = {};
    if (headersRaw) {
      try {
        extraHeaders = JSON.parse(headersRaw);
        if (!extraHeaders || typeof extraHeaders !== "object" || Array.isArray(extraHeaders)) throw new Error("必须是对象");
      } catch (e) {
        alert("额外请求头必须是合法 JSON 对象，例如 {\"x-opencode-session\":\"abc\"}\n\n" + e.message);
        return;
      }
    }
    setBusy((b) => ({ ...b, [channel]: "add" }));
    try {
      const d = await apiJson(`/api/admin/models/${channel}`, {
        method: "POST", body: JSON.stringify({ name, model, baseUrl, apiKey, extraHeaders }),
      });
      if (d.error) throw new Error(d.error);
      await apiJson(`/api/admin/models/${channel}/active`, { method: "POST", body: JSON.stringify({ name }) });
      // 清空表单
      ["Name", "Model", "Url", "Key", "Headers"].forEach((s) => { const el = document.getElementById(`mdl${s}_${channel}`); if (el) el.value = ""; });
      load();
    } catch (e) { alert("添加失败: " + e.message); }
    finally { setBusy((b) => ({ ...b, [channel]: "" })); }
  }

  async function setActive(channel, name) {
    if (!confirm(`将「${name}」设为${channel === "generative" ? "生成通道" : "推理通道"}当前生效？切换即时生效。`)) return;
    try {
      const d = await apiJson(`/api/admin/models/${channel}/active`, { method: "POST", body: JSON.stringify({ name }) });
      if (d.error) throw new Error(d.error);
      load();
    } catch (e) { alert("切换失败: " + e.message); }
  }

  async function delModel(channel, name) {
    if (!confirm(`删除模型「${name}」？`)) return;
    try {
      await api(`/api/admin/models/${channel}/${encodeURIComponent(name)}`, { method: "DELETE" });
      load();
    } catch (e) { alert("删除失败: " + e.message); }
  }

  async function testModel(channel) {
    const model = document.getElementById(`mdlModel_${channel}`).value?.trim();
    const baseUrl = document.getElementById(`mdlUrl_${channel}`).value?.trim();
    const apiKey = document.getElementById(`mdlKey_${channel}`).value?.trim();
    const name = document.getElementById(`mdlName_${channel}`).value?.trim();
    const headersRaw = document.getElementById(`mdlHeaders_${channel}`).value?.trim();
    if (!model) { alert("请填写模型名"); return; }
    let extraHeaders = {};
    if (headersRaw) {
      try { extraHeaders = JSON.parse(headersRaw); } catch (e) { alert("额外请求头不是合法 JSON"); return; }
    }
    setBusy((b) => ({ ...b, [channel]: "test" }));
    setTestResult((t) => ({ ...t, [channel]: "测试中..." }));
    try {
      // 改为 POST（凭据放 body，不进 URL/日志）；响应仍是 SSE 流
      const res = await fetch(`/api/admin/models/${channel}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
        body: JSON.stringify({ model, name, baseUrl, apiKey, extraHeaders }),
      });
      let done = false;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("测试超时（30s）")); } }, 30000);
        readSSE(res, {
          onComplete: (d) => { done = true; clearTimeout(timer); resolve(`✅ 连通成功（HTTP ${d.httpStatus}）${d.model}${d.reply ? "，回复: " + d.reply : ""}`); },
          onError: (msg) => { done = true; clearTimeout(timer); reject(new Error(msg)); },
          onPhase: () => {},
          onProgress: () => {},
        }).catch((e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      });
      setTestResult((t) => ({ ...t, [channel]: result }));
    } catch (e) {
      setTestResult((t) => ({ ...t, [channel]: "❌ " + e.message }));
    } finally {
      setBusy((b) => ({ ...b, [channel]: "" }));
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>模型管理</h2>
          <p>生成通道与推理通道可分别指定生效模型，切换即时生效、无需重启。留空 API Key 则回落到环境变量。</p>
        </div>
        <div className="page-head-actions">
          <button className="btn btn-outline btn-sm" onClick={load}>↻ 刷新</button>
        </div>
      </div>

      {CHANNELS.map((ch) => {
        const models = (data && data[ch.key]) || [];
        return (
          <div key={ch.key} className="panel">
            <div className="panel-head">
              <strong>{ch.label}</strong>
              <span className="text-xs text-dim">{ch.desc}</span>
              {models.some((m) => m.active) && <span className="tag tag-success" style={{ marginLeft: 4 }}>已生效</span>}
            </div>

            {models.length === 0 && (
              <div className="state-empty">未配置模型，当前使用环境变量默认值</div>
            )}

            {models.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>模型 / 地址</th>
                    <th style={{ width: 150 }}>来源</th>
                    <th style={{ width: 170 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <span style={{ fontWeight: 600 }}>{m.name}</span>
                        {m.active && <span className="tag tag-success" style={{ marginLeft: 8 }}>当前生效</span>}
                      </td>
                      <td>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>{m.model || "—"}</div>
                        <div className="text-xs text-muted" style={{ wordBreak: "break-all" }}>
                          {m.baseUrl || "默认地址"} ｜ key：{m.apiKey || "（环境变量）"}
                        </div>
                        {m.extraHeaders && Object.keys(m.extraHeaders).length > 0 && (
                          <div className="text-xs text-muted">
                            额外请求头：{Object.entries(m.extraHeaders).map(([k, v]) => `${k}=${v}`).join(", ")}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`tag ${m.source === "env" ? "" : "tag-admin"}`}>
                          {m.source === "env" ? "环境变量" : "手动添加"}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {!m.active && <button className="btn btn-outline btn-xs" onClick={() => setActive(ch.key, m.name)}>设为生效</button>}
                          {m.source !== "env" && <button className="btn btn-danger btn-xs" onClick={() => delModel(ch.key, m.name)}>删除</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {testResult[ch.key] && (
              <div className={`alert ${testResult[ch.key].startsWith("❌") ? "alert-danger" : "alert-success"}`} style={{ marginTop: 12 }}>
                <span className="alert-body">{testResult[ch.key]}</span>
              </div>
            )}

            {/* 添加表单 */}
            <div style={{ marginTop: 16, padding: 16, border: "1px dashed var(--ink-600)", borderRadius: "var(--r)" }}>
              <div className="text-xs" style={{ color: "var(--brass)", letterSpacing: ".14em", marginBottom: 12 }}>✚ 添加模型</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginBottom: 10 }}>
                <input id={`mdlName_${ch.key}`} className="form-input form-input-sm" placeholder="名称（如 deepseek-v4-flash）" aria-label="模型名称" />
                <input id={`mdlModel_${ch.key}`} className="form-input form-input-sm" placeholder="模型名（如 deepseek-v4-flash）" aria-label="模型标识" />
              </div>
              <input id={`mdlUrl_${ch.key}`} className="form-input form-input-sm" style={{ marginBottom: 10 }} placeholder="API Base URL（如 https://api.deepseek.com）" aria-label="API 地址" />
              <input id={`mdlKey_${ch.key}`} className="form-input form-input-sm" style={{ marginBottom: 10 }} type="password" placeholder="API Key（留空则用环境变量）" aria-label="API Key" />
              <input id={`mdlHeaders_${ch.key}`} className="form-input form-input-sm" style={{ marginBottom: 12 }} placeholder='额外请求头 JSON（可留空，如 {"x-opencode-session":"abc123"}）' aria-label="额外请求头" />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-primary btn-sm btn-auto" disabled={busy[ch.key] === "add"} onClick={() => addModel(ch.key)}>
                  {busy[ch.key] === "add" ? "添加中…" : "添加并生效"}
                </button>
                <button className="btn btn-outline btn-sm btn-auto" disabled={busy[ch.key] === "test"} onClick={() => testModel(ch.key)}>
                  {busy[ch.key] === "test" ? "测试中…" : "测试连通"}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}