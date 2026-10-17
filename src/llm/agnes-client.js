// Agnes LLM 客户端封装（OpenAI 兼容网关 https://apihub.agnes-ai.com/v1）
// 供 AI 玩家智能行为使用；未配置/调用失败一律返回 null，由调用方回退规则引擎。
// 模型配置动态读取：管理端 model-manager 的 reasoning 通道优先，否则回退环境变量。
const OpenAI = require("openai");
const gate = require("./llm-gate");
const { getRedis } = require("../core/redis-client");

const AGNES_API_KEY = process.env.AGNES_API_KEY || "";
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || "https://apihub.agnes-ai.com/v1";
const AGNES_MODEL = process.env.AGNES_MODEL || "agnes-2.5-flash";

/** 自定义 user-agent：opencode.ai/zen/go 明确要求客户端用自身标识，而不是通用 SDK 名 */
const CLIENT_UA = "murder-mystery/1.0";

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
  const extraHeaders = (cfg && cfg.extraHeaders && typeof cfg.extraHeaders === "object") ? cfg.extraHeaders : {};
  // 指纹必须包含 extraHeaders：opencode.ai 这类网关要求 x-opencode-session，
  // 换了模型却沿用旧客户端就会丢掉这个头。原来这里只算 key+baseURL。
  const fingerprint = key + "|" + baseURL + "|" + JSON.stringify(extraHeaders);
  if (!client || clientKey !== fingerprint) {
    client = new OpenAI({
      apiKey: key,
      baseURL,
      timeout: 90000,          // 实际截止时间由 llm-gate 的 AbortSignal 控制，这里只作兜底
      maxRetries: 1,           // 降低为 1：配合闸门后，重试不再是掩盖慢调用的手段
      // 历史 bug：model-manager 一直存着 extraHeaders 并会返回，但这里从来没传给 SDK，
      // 所以像 opencode.ai/zen/go 这种要求自定义请求头的网关，注册了也用不了。
      defaultHeaders: { "User-Agent": CLIENT_UA, ...extraHeaders },
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

/** opencode.ai/zen/go 要求每段对话带稳定的 x-opencode-session（用于路由与提示词缓存）。
 *  只在目标网关是 opencode 时才加，避免把无关请求头塞给 DeepSeek/Agnes 这类网关。 */
function isOpencodeGateway(baseURL) {
  return /(^|\.)opencode\.ai(\/|$)/i.test(String(baseURL || ""));
}

/** 组装单次请求的 RequestOptions */
function requestOptions(cfg, signal, sessionId) {
  const opts = { signal };
  const baseURL = (cfg && cfg.baseUrl) || AGNES_BASE_URL;
  if (sessionId && isOpencodeGateway(baseURL)) {
    opts.headers = { "x-opencode-session": String(sessionId) };
  }
  return opts;
}

/**
 * 单轮对话（经 llm-gate 排队，带优先级与硬超时）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} [opts] maxTokens / temperature / priority("interactive"|"background") / timeoutMs / label / sessionId
 * @returns {Promise<string|null>} 正文内容；失败/超时/未配置一律返回 null，由调用方回退规则引擎
 */
/**
 * token 计量（只做统计，**绝不影响主流程**）。
 *
 * 为什么需要：AI 玩家这条链路此前完全没有计量 —— chat() 只返回字符串，把响应里的
 * usage 丢掉了，所以"省了多少 token"只能靠估。这里按 label 累计进 Redis：
 *   ai:usage:<sessionId>  →  { <label>.calls / .in / .out / .chars }
 * sessionId 就是房间号（ai-player-llm 传的是 k.roomCode），因此可以按房间看。
 * `.chars` 是兜底口径：有的网关不返回 usage，但"输入字符数"照样能比较改前改后。
 *
 * 三条硬约束：连不上就跳过、异常全部吞掉、不 await —— 计量绝不能拖慢或拖垮 AI 发言。
 */
/** 上一次调用的时间戳（按 label），用来诊断"缓存命中是否与调用间隔相关"：
 *  实测 ai.intro / ai.replyQuestion 有命中，而 ai.turn 命中恒为 0，
 *  三者最大的差别是间隔（turn 每 45 秒才轮到一次，另两个是连发的）。 */
const lastCallAt = new Map();

function recordUsage(sessionId, label, usage, chars) {
  try {
    const r = getRedis();
    const cached = Number(
      (usage && (usage.prompt_cache_hit_tokens ?? (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)))
    ) || 0;
    // 每次调用打一行：in/out/缓存命中了多少/本次距上次同 label 调用的间隔。
    // 这行是"省 token 到底省在哪"的现场记录，也顺带能直接看出缓存失效的规律。
    const now = Date.now();
    const gap = lastCallAt.has(label) ? now - lastCallAt.get(label) : -1;
    lastCallAt.set(label, now);
    console.log(`[ai-usage] ${sessionId || "-"} ${label} in=${(usage && usage.prompt_tokens) || 0} out=${(usage && usage.completion_tokens) || 0} cached=${cached} gap=${gap < 0 ? "首次" : Math.round(gap / 1000) + "s"}`);
    if (!r || r.status !== "ready") return;
    const key = `ai:usage:${sessionId || "global"}`;
    const p = r.pipeline();
    p.hincrby(key, `${label}.calls`, 1);
    p.hincrby(key, `${label}.in`, Number(usage && usage.prompt_tokens) || 0);
    p.hincrby(key, `${label}.out`, Number(usage && usage.completion_tokens) || 0);
    p.hincrby(key, `${label}.chars`, Number(chars) || 0);
    // 提示词缓存命中量（DeepSeek 系返回 prompt_cache_hit_tokens；其它网关可能返回 cached_tokens）
    // —— 这是"把易变内容挪出 system 段"到底有没有效的唯一硬证据：
    // 没这一项就只能看总输入，"挪位置"这个改动在总量上是看不出来的。
    if (cached) p.hincrby(key, `${label}.cacheHit`, cached);
    p.expire(key, 6 * 3600);
    p.exec().catch(() => {});
  } catch (e) { /* 计量失败不影响 AI 发言 */ }
}

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
    }, requestOptions(cfg, signal, opts.sessionId)),
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
  // 计量：成功才记。chars 口径 = system + user 的字符数（不依赖网关是否返回 usage）
  recordUsage(opts.sessionId, opts.label || "agnes.chat", res.value && res.value.usage,
    String(systemPrompt || "").length + String(userPrompt || "").length);
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
    }, requestOptions(cfg, signal, opts.sessionId)),
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

module.exports = { chat, chatMessages, AGNES_MODEL, clientInfo, isOpencodeGateway, gateSnapshot: gate.snapshot };