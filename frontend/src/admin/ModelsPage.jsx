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
    if (!name || !model) { alert("请填写名称与模型名"); return; }
    setBusy((b) => ({ ...b, [channel]: "add" }));
    try {
      const d = await apiJson(`/api/admin/models/${channel}`, {
        method: "POST", body: JSON.stringify({ name, model, baseUrl, apiKey }),
      });
      if (d.error) throw new Error(d.error);
      await apiJson(`/api/admin/models/${channel}/active`, { method: "POST", body: JSON.stringify({ name }) });
      // 清空表单
      ["Name", "Model", "Url", "Key"].forEach((s) => { const el = document.getElementById(`mdl${s}_${channel}`); if (el) el.value = ""; });
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
    if (!model) { alert("请填写模型名"); return; }
    setBusy((b) => ({ ...b, [channel]: "test" }));
    setTestResult((t) => ({ ...t, [channel]: "测试中..." }));
    try {
      // 改为 POST（凭据放 body，不进 URL/日志）；响应仍是 SSE 流
      const res = await fetch(`/api/admin/models/${channel}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
        body: JSON.stringify({ model, name, baseUrl, apiKey }),
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
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong style={{ color: "var(--gold)" }}>模型管理</strong>
          <button className="btn btn-outline btn-sm" onClick={load}>↻ 刷新</button>
        </div>
        <p className="text-sm text-dim" style={{ marginTop: 0 }}>
          配置剧本生成使用的大模型。生成通道与推理通道可分别选择生效模型，切换即时生效，无需重启。
        </p>

        {CHANNELS.map((ch) => {
          const models = (data && data[ch.key]) || [];
          return (
            <div key={ch.key} className="card card-static" style={{ marginBottom: 12, padding: 14 }}>
              <h4 style={{ margin: "0 0 10px", color: "var(--gold)" }}>{ch.label} <span className="text-xs text-dim">{ch.desc}</span></h4>

              {models.length === 0 && <p className="text-xs text-dim">（未配置模型，使用环境变量默认值）</p>}
              {models.map((m) => (
                <div key={m.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)", gap: 8 }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>
                      {m.name}
                    </span>{" "}
                    {m.active && <span className="tag tag-success">当前生效</span>}
                    <div className="text-xs text-dim">
                      模型: {m.model || ""}{m.baseUrl ? " | " + m.baseUrl : ""}
                      {m.apiKey ? " | key: " + m.apiKey : " | key: (环境)"}
                      {m.source === "env" ? " | 来源: 环境变量" : " | 来源: 手动添加"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!m.active && <button className="btn btn-outline btn-xs" onClick={() => setActive(ch.key, m.name)}>设为生效</button>}
                    {m.source !== "env" && <button className="btn btn-outline btn-xs" onClick={() => delModel(ch.key, m.name)}>删除</button>}
                  </div>
                </div>
              ))}

              {testResult[ch.key] && (
                <div className="alert alert-success" style={{ marginTop: 10 }}>{testResult[ch.key]}</div>
              )}

              {/* 添加表单 */}
              <div style={{ marginTop: 12, padding: 10, border: "1px dashed var(--border)", borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: "var(--gold-light)", marginBottom: 8 }}>✚ 添加模型</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8, marginBottom: 8 }}>
                  <input id={`mdlName_${ch.key}`} className="form-input" placeholder="名称（如 deepseek-v4-flash）" />
                  <input id={`mdlModel_${ch.key}`} className="form-input" placeholder="模型名（如 deepseek-v4-flash）" />
                </div>
                <input id={`mdlUrl_${ch.key}`} className="form-input" style={{ marginBottom: 8 }} placeholder="API Base URL（如 https://api.deepseek.com）" />
                <input id={`mdlKey_${ch.key}`} className="form-input" style={{ marginBottom: 8 }} type="password" placeholder="API Key（留空则用环境变量）" />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-primary btn-sm" disabled={busy[ch.key] === "add"} onClick={() => addModel(ch.key)}>
                    {busy[ch.key] === "add" ? "添加中..." : "添加并生效"}
                  </button>
                  <button className="btn btn-outline btn-sm" disabled={busy[ch.key] === "test"} onClick={() => testModel(ch.key)}>
                    {busy[ch.key] === "test" ? "测试中..." : "测试连通"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}