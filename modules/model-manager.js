// 模型管理 — Redis 持久化模型注册表
// 两个通道：
//   generative：剧本生成主通道（原生 https 直连，OpenAI 兼容 /chat/completions）
//   reasoning：AI 玩家/NPC 等推理辅助通道（openai SDK）
// 每个通道可登记多个模型，切换"当前生效模型"即时生效（无需重建容器）；
// 未登记时回退环境变量（DEEPSEEK_API_KEY/DEFAULT_MODEL、AGNES_*）。

const { getRedis } = require("./redis-client");

const CHANNELS = ["generative", "reasoning"];

const keyFor = (ch) => `model:registry:${ch}`;   // hash: name -> JSON {apiKey, baseUrl, model, note, updatedAt}
const activeKey = (ch) => `model:active:${ch}`;  // string: 当前生效模型名

function envDefaults(ch) {
  if (ch === "generative") {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      model: process.env.DEFAULT_MODEL || "deepseek-v4-flash",
    };
  }
  return {
    apiKey: process.env.AGNES_API_KEY || "",
    baseUrl: process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1",
    model: process.env.AGNES_MODEL || "agnes-2.5-flash",
  };
}

/** 列出某通道全部模型（含环境默认项，标记来源 env/registered/active） */
async function listModels(channel = "generative") {
  const r = await getRedis();
  const raw = await r.hgetall(keyFor(channel)).catch(() => ({}));
  const active = await r.get(activeKey(channel)).catch(() => null);
  const env = envDefaults(channel);

  const out = [];
  // 环境默认项（内置，始终展示）
  if (env.apiKey) {
    out.push({
      name: "(环境默认)", model: env.model, apiKey: mask(env.apiKey),
      baseUrl: env.baseUrl, source: "env", active: active === "env" || (!active && out.length === 0),
    });
  }
  for (const [name, val] of Object.entries(raw || {})) {
    let d = {};
    try { d = JSON.parse(val); } catch (e) { continue; }
    out.push({
      name, model: d.model || name, apiKey: mask(d.apiKey || ""),
      baseUrl: d.baseUrl || "", source: "registered",
      extraHeaders: d.extraHeaders && typeof d.extraHeaders === "object" ? d.extraHeaders : {},
      active: active === name,
    });
  }
  return out;
}

function mask(k) {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "****" + k.slice(-4);
}

/** 添加/更新一个模型（extraHeaders: 可选对象，如 { "x-opencode-session": "0RpJJnxJ" }） */
async function upsertModel(channel, name, { apiKey, baseUrl, model, note, extraHeaders }) {
  if (!CHANNELS.includes(channel)) throw new Error("未知通道: " + channel);
  const n = String(name || "").trim();
  if (!n) throw new Error("模型名称不能为空");
  if (!model) throw new Error("请输入模型名（如 deepseek-v4-flash）");
  const r = await getRedis();
  const record = {
    apiKey: String(apiKey || "").trim(),
    baseUrl: String(baseUrl || "").trim(),
    model: String(model).trim(),
    note: String(note || "").trim(),
    extraHeaders: extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {},
    updatedAt: Date.now(),
  };
  await r.hset(keyFor(channel), n, JSON.stringify(record));
  return { ok: true, name: n };
}

/** 删除某模型 */
async function removeModel(channel, name) {
  const r = await getRedis();
  const active = await r.get(activeKey(channel)).catch(() => null);
  if (active === name) await r.del(activeKey(channel));
  await r.hdel(keyFor(channel), String(name || ""));
  return { ok: true };
}

/** 设置当前生效模型（name 可指向注册模型或 "env" 表示环境默认） */
async function setActive(channel, name) {
  if (!CHANNELS.includes(channel)) throw new Error("未知通道: " + channel);
  const r = await getRedis();
  const target = String(name || "");
  if (target === "env") {
    await r.set(activeKey(channel), "env");
    return { ok: true, active: "env" };
  }
  const exists = await r.hexists(keyFor(channel), target);
  if (!exists) throw new Error("该模型未登记: " + target);
  await r.set(activeKey(channel), target);
  return { ok: true, active: target };
}

/** 读取某通道当前生效的模型连接配置（Redis 覆盖优先，否则环境变量） */
async function getActiveConfig(channel = "generative") {
  const r = await getRedis();
  const active = await r.get(activeKey(channel)).catch(() => null);
  const env = envDefaults(channel);
  if (!active || active === "env" || active === "undefined" || active === "null") return env;
  const raw = await r.hget(keyFor(channel), active).catch(() => null);
  if (!raw) return env;
  try {
    const d = JSON.parse(raw);
    return {
      apiKey: d.apiKey || env.apiKey,
      baseUrl: d.baseUrl || env.baseUrl,
      model: d.model || active,
      extraHeaders: d.extraHeaders && typeof d.extraHeaders === "object" ? d.extraHeaders : {},
    };
  } catch (e) { return env; }
}

/** 全量模型配置（供管理端仪表盘展示） */
async function getAllModels() {
  const generative = await listModels("generative");
  const reasoning = await listModels("reasoning");
  return { generative, reasoning };
}

module.exports = { CHANNELS, listModels, upsertModel, removeModel, setActive, getActiveConfig, getAllModels, envDefaults };