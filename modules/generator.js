// DeepSeek API 生成器模块 — 含自动重试、超时保护
// DeepSeek 兼容 OpenAI API 格式

const OpenAI = require("openai");

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultModel = process.env.DEFAULT_MODEL || "deepseek-v4-flash";

const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 1000;
const API_TIMEOUT_MS = 300000; // 单次调用最长5分钟（长剧本生成可能 2-4 分钟）

// LLM 用量统计（进程内累计，供管理端仪表盘展示）
const usageStats = { calls: 0, inputTokens: 0, outputTokens: 0 };

let client = null;

function getClient() {
  if (!client) {
    if (!apiKey || apiKey === "your-deepseek-api-key") {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }
    // keepAlive:false — 每次请求独立连接，规避 Docker/代理对空闲复用连接的
    // 回收导致的 Premature close（nginx/网关常见行为）
    const http = require("http");
    const https = require("https");
    client = new OpenAI({
      apiKey,
      baseURL,
      timeout: API_TIMEOUT_MS,
      maxRetries: 0,
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false }),
    });
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
      const inTokens = response.usage?.prompt_tokens || 0;
      const outTokens = response.usage?.completion_tokens || 0;
      usageStats.calls++;
      usageStats.inputTokens += inTokens;
      usageStats.outputTokens += outTokens;
      return {
        content: response.choices[0]?.message?.content || "",
        usage: {
          inputTokens: inTokens,
          outputTokens: outTokens,
        },
        model: response.model,
      };
    } catch (err) {
      lastErr = err;
      // 客户端主动中断，不重试
      if (err.name === "AbortError" || err.message === "Aborted") throw err;
      if (attempt < MAX_RETRIES && canRetry(err, attempt)) {
        const delay = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt), 30000); // 退避封顶30s
        console.warn(`[generate] 第${attempt + 1}次失败(${err.message})，${delay / 1000}s后重试...`);
        await sleep(delay);
        continue;
      }
      break; // 重试耗尽，进入双通道 fallback
    }
  }
  // deepseek 全部重试失败 → 尝试 agnes 通道补齐（双线路同时抖动概率极低）
  const fb = await fallbackToAgnes(messages, options);
  if (fb) return fb;
  throw lastErr || new Error("API调用失败");
}

/**
 * deepseek 全部重试失败后的双通道 fallback：切 agnes 再试一次
 * （两个供应商线路同时抖动的概率远低于单个通道持续抖动）
 */
async function fallbackToAgnes(messages, options = {}) {
  try {
    const { chatMessages } = require("./agnes-client");
    const content = await chatMessages(messages, {
      maxTokens: options.maxTokens || 4096,
      temperature: options.temperature ?? 0.7,
    });
    if (content) {
      console.warn("[generate] deepseek 重试失败，已通过 agnes 通道补齐本次调用");
      return {
        content,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "agnes-2.5-flash(fallback)",
      };
    }
  } catch (e) {
    console.warn("[generate] agnes fallback 失败:", e.message);
  }
  return null;
}

async function generate(systemPrompt, userPrompt, options = {}) {
  return _callWithRetry([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], options);
}

module.exports = { generate, getUsageStats: () => ({ ...usageStats }) };
