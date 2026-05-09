// DeepSeek API 生成器模块 — 封装 LLM 调用逻辑
// DeepSeek 兼容 OpenAI API 格式

const OpenAI = require("openai");
require("dotenv").config();

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultModel = process.env.DEFAULT_MODEL || "deepseek-chat";

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

/**
 * 生成文本
 * @param {string} systemPrompt - 系统提示词（模板定义的角色和规则）
 * @param {string} userPrompt  - 用户的具体需求
 * @param {object} options     - 可选参数 { model, maxTokens, temperature }
 * @returns {Promise<{content: string, usage: object}>}
 */
async function generate(systemPrompt, userPrompt, options = {}) {
  const openai = getClient();
  const model = options.model || defaultModel;

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
}

module.exports = { generate, refine };
