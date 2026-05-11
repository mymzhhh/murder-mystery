// DeepSeek API 生成器模块 — 封装 LLM 调用逻辑（含自动重试）
// DeepSeek 兼容 OpenAI API 格式

const OpenAI = require("openai");
require("dotenv").config();

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultModel = process.env.DEFAULT_MODEL || "deepseek-chat";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000; // 初始重试间隔

let client = null;

function getClient() {
  if (!client) {
    if (!apiKey || apiKey === "your-deepseek-api-key") {
      throw new Error(
        "未配置 DEEPSEEK_API_KEY。请在 .env 文件中设置你的 API Key，或设置环境变量 DEEPSEEK_API_KEY。"
      );
    }
    client = new OpenAI({ apiKey, baseURL });
  }
  return client;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断是否为可重试的错误
 */
function isRetryableError(err) {
  const msg = (err.message || "").toLowerCase();
  const code = err.code || err.status || 0;
  // 网络/超时/服务端错误均可重试
  return /network|timeout|econnrefused|econnreset|etimedout|429|502|503|504|socket|connect|reset|abort|closed/i.test(msg)
    || [429, 502, 503, 504].includes(code)
    || (err.type === 'request' && !err.status); // 无响应的请求错误（很可能是超时）
}

/**
 * 生成文本（含自动重试）
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userPrompt  - 用户的具体需求
 * @param {object} options     - 可选参数 { model, maxTokens, temperature }
 * @returns {Promise<{content: string, usage: object}>}
 */
async function generate(systemPrompt, userPrompt, options = {}) {
  const openai = getClient();
  const model = options.model || defaultModel;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const choice = response.choices[0];
      const content = choice.message?.content || "";

      return {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
        model: response.model,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt); // 指数退避: 2s, 4s, 8s
        console.warn(`DeepSeek API 调用失败（第${attempt + 1}次），${delay / 1000}s 后重试：${err.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/**
 * 多轮优化生成 — 携带历史上下文
 * @param {Array} history  - 对话历史 [{role, content}, ...]
 * @param {string} feedback - 用户的修改意见
 * @param {string} systemPrompt - System prompt
 * @returns {Promise<{content: string, usage: object}>}
 */
async function refine(systemPrompt, history, feedback) {
  const openai = getClient();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: defaultModel,
        max_tokens: 4096,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: `请根据以下反馈修改上面的文案：\n${feedback}` },
        ],
      });

      const choice = response.choices[0];
      const content = choice.message?.content || "";

      return {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        },
      };
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(`DeepSeek API 调用失败（第${attempt + 1}次），${delay / 1000}s 后重试：${err.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { generate, refine };
