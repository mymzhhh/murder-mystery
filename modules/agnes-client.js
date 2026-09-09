// Agnes LLM 客户端封装（OpenAI 兼容网关 https://apihub.agnes-ai.com/v1）
// 供 AI 玩家智能行为使用；未配置/调用失败一律返回 null，由调用方回退规则引擎。
// 模型配置动态读取：管理端 model-manager 的 reasoning 通道优先，否则回退环境变量。
const OpenAI = require("openai");

const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1";
const AGNES_MODEL = process.env.AGNES_MODEL || "agnes-2.5-flash";

let client = null;
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
  if (!key || key === "your-agnes-api-key") return null;
  if (!client) {
    client = new OpenAI({
      apiKey: key,
      baseURL: (cfg && cfg.baseUrl) || AGNES_BASE_URL,
      timeout: 90000,          // 推理型模型单次最长等待
      maxRetries: 2,           // 网络抖动重试（Connection error 等）
    });
  }
  return client;
}

/**
 * 单轮对话
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [opts] maxTokens(默认900，注意 2.5-flash 推理 token 会占用输出预算)、temperature
 * @returns {Promise<string|null>} 正文内容；失败/未配置返回 null
 */
async function chat(systemPrompt, userPrompt, opts = {}) {
  const cfg = await getActiveConfig();
  const c = getClient(cfg);
  if (!c) return null;
  try {
    const resp = await c.chat.completions.create({
      model: (cfg && cfg.model) || AGNES_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: opts.maxTokens || 900,
      temperature: opts.temperature ?? 0.8,
    });
    const content = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || "").trim();
    return content || null;
  } catch (e) {
    console.warn("[agnes] 调用失败:", e.message);
    return null;
  }
}

/**
 * 直接以 messages 数组调用（供 generator 双通道 fallback 复用，与 deepseek 同签名）
 */
async function chatMessages(messages, opts = {}) {
  const cfg = await getActiveConfig();
  const c = getClient(cfg);
  if (!c) return null;
  try {
    const resp = await c.chat.completions.create({
      model: (cfg && cfg.model) || AGNES_MODEL,
      messages: Array.isArray(messages) ? messages : [{ role: "user", content: String(messages) }],
      max_tokens: opts.maxTokens || 900,
      temperature: opts.temperature ?? 0.8,
    });
    const content = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || "").trim();
    return content || null;
  } catch (e) {
    console.warn("[agnes] chatMessages 失败:", e.message);
    return null;
  }
}

module.exports = { chat, chatMessages, AGNES_MODEL };