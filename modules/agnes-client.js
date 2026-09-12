// Agnes LLM 客户端封装（OpenAI 兼容网关 https://apihub.agnes-ai.com/v1）
// 供 AI 玩家智能行为使用；未配置/调用失败一律返回 null，由调用方回退规则引擎。
// 模型配置动态读取：管理端 model-manager 的 reasoning 通道优先，否则回退环境变量。
const OpenAI = require("openai");
const gate = require("./llm-gate");

const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1";
const AGNES_MODEL = process.env.AGNES_MODEL || "agnes-2.5-flash";

// 客户端按 apiKey+baseURL 缓存。
// 历史 bug：原来用单个模块级 client 且只在首次构造，于是管理端改 apiKey/baseUrl
// 根本不生效——界面显示切换成功，实际还在打旧网关，必须重启进程才行
// （model 名每次请求单独传，所以只有"换模型名"是生效的）。
let client = null;
let clientKey = "";
let _cfg = null;
let _cfgAt = 0;
const CFG_TTL = 2000; // 2s 兜底合并，切换模型即时生效

async function getActiveConfig() {
  const now = Date.now();
  if (_cfg && now - _cfgAt < CFG_TTL) return _cfg;
  try {
    const { getActiveConfig: gac } = require("./model-manager");
    _cfg = await gac("reasoning");
  } catch (e) {
    _cfg = null;
  }
  _cfgAt = now;
  return _cfg || { apiKey: AGNES_API_KEY, baseUrl: AGNES_BASE_URL, model: AGNES_MODEL };
}

function getClient(cfg) {
  const key = (cfg && cfg.apiKey) || AGNES_API_KEY;
  const baseURL = (cfg && cfg.baseUrl) || AGNES_BASE_URL;
  if (!key || key === "your-agnes-api-key") return null;
  const fingerprint = key + "|" + baseURL;
  if (!client || clientKey !== fingerprint) {
    client = new OpenAI({
      apiKey: key,
      baseURL,
      timeout: 90000,          // 实际截止时间由 llm-gate 的 AbortSignal 控制，这里只作兜底
      maxRetries: 1,           // 降低为 1：配合闸门后，重试不再是掩盖慢调用的手段
    });
    clientKey = fingerprint;
  }
  return client;
}

/** 供诊断：当前客户端指向哪个网关（不泄露密钥） */
function clientInfo() {
  const cfg = _cfg || {};
  const key = cfg.apiKey || AGNES_API_KEY;
  return {
    baseUrl: cfg.baseUrl || AGNES_BASE_URL,
    model: cfg.model || AGNES_MODEL,
    keyLength: String(key || "").length,
    built: !!client,
  };
}

/**
 * 单轮对话（经 llm-gate 排队，带优先级与硬超时）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [opts] maxTokens / temperature / priority("interactive"|"background") / timeoutMs / label
 * @returns {Promise<string|null>} 正文内容；失败/超时/未配置一律返回 null，由调用方回退规则引擎
 */
async function chat(systemPrompt, userPrompt, opts = {}) {
  const cfg = await getActiveConfig();
  const c = getClient(cfg);
  if (!c) return null;
  const res = await gate.run(
    (signal) => c.chat.completions.create({
      model: (cfg && cfg.model) || AGNES_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: opts.maxTokens || 900,
      temperature: opts.temperature ?? 0.8,
    }, { signal }),
    { priority: opts.priority, timeoutMs: opts.timeoutMs, label: opts.label || "agnes.chat" }
  );
  if (!res.ok) {
    if (res.reason === "timeout") {
      console.warn(`[agnes] 超时丢弃（排队${res.waitMs}ms + 执行${res.durMs}ms）：${opts.label || ""}`);
    } else if (res.reason === "error") {
      console.warn("[agnes] 调用失败:", res.error && res.error.message);
    }
    return null;
  }
  const content = (res.value && res.value.choices && res.value.choices[0]
    && res.value.choices[0].message && res.value.choices[0].message.content || "").trim();
  return content || null;
}

/**
 * 直接以 messages 数组调用（供 generator 双通道 fallback 复用，与 deepseek 同签名）
 */
async function chatMessages(messages, opts = {}) {
  const cfg = await getActiveConfig();
  const c = getClient(cfg);
  if (!c) return null;
  const res = await gate.run(
    (signal) => c.chat.completions.create({
      model: (cfg && cfg.model) || AGNES_MODEL,
      messages: Array.isArray(messages) ? messages : [{ role: "user", content: String(messages) }],
      max_tokens: opts.maxTokens || 900,
      temperature: opts.temperature ?? 0.8,
    }, { signal }),
    { priority: opts.priority, timeoutMs: opts.timeoutMs, label: opts.label || "agnes.chatMessages" }
  );
  if (!res.ok) {
    if (res.reason === "error") console.warn("[agnes] chatMessages 失败:", res.error && res.error.message);
    return null;
  }
  const content = (res.value && res.value.choices && res.value.choices[0]
    && res.value.choices[0].message && res.value.choices[0].message.content || "").trim();
  return content || null;
}

module.exports = { chat, chatMessages, AGNES_MODEL, clientInfo, gateSnapshot: gate.snapshot };