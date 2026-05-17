// DeepSeek API 生成器模块 — 含自动重试、超时保护
// DeepSeek 兼容 OpenAI API 格式

const OpenAI = require("openai");

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultModel = process.env.DEFAULT_MODEL || "deepseek-chat";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;
const API_TIMEOUT_MS = 120000; // 单次调用最长等待2分钟

let client = null;

function getClient() {
  if (!client) {
    if (!apiKey || apiKey === "your-deepseek-api-key") {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }
    client = new OpenAI({ apiKey, baseURL, timeout: API_TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 前3次无条件重试，后面只重试网络/超时/服务端错误 */
function canRetry(err, attempt) {
  if (attempt < 3) return true;
  const msg = String(err.message || "").toLowerCase();
  const code = err.status || err.code || 0;
  return /network|timeout|econn|etimedout|429|502|503|504|socket|connect|reset|abort|closed|refused/i.test(msg)
    || [429, 502, 503, 504].includes(code)
    || (err.name && /api|connection|timeout/i.test(err.name));
}

/** 内部通用：调用 API 并自动重试 */
async function _callWithRetry(messages, options = {}) {
  const openai = getClient();
  const model = options.model || defaultModel;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 检查是否已被外部中断
    if (options.signal?.aborted) throw new Error("Aborted");
    try {
      const response = await openai.chat.completions.create({
        model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
        messages,
      }, options.signal ? { signal: options.signal } : {});
      return {
        content: response.choices[0]?.message?.content || "",
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        model: response.model,
      };
    } catch (err) {
      lastErr = err;
      // 客户端主动中断，不重试
      if (err.name === "AbortError" || err.message === "Aborted") throw err;
      if (attempt < MAX_RETRIES && canRetry(err, attempt)) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[generate] 第${attempt + 1}次失败(${err.message})，${delay / 1000}s后重试...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("API调用失败");
}

async function generate(systemPrompt, userPrompt, options = {}) {
  return _callWithRetry([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], options);
}

module.exports = { generate };
