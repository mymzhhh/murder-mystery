// DeepSeek API 生成器模块 — 含自动重试、超时保护、双通道 fallback
// 使用原生 https 直连（不用 openai SDK）——容器内 SDK 的 keepAlive 连接被网关提前回收导致
// 频繁 Premature close/Connection error，原生 https 每次新连接实测稳定。

const https = require("https");
const http = require("http");

const apiKey = process.env.DEEPSEEK_API_KEY;
const baseURL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const defaultModel = process.env.DEFAULT_MODEL || "deepseek-v4-flash";

const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 1000;
const API_TIMEOUT_MS = 180000; // 单次调用最长3分钟（长剧本生成可能 2-3 分钟；超时即走熔断切 Agnes）

// reasoning 占满预算时的 max_tokens 升级策略
const DEFAULT_MAX_TOKENS = 4096;     // 与 callDeepSeek 的默认输出上限保持一致
const MAX_TOKEN_ESCALATION = 3;      // 最多升级 3 次
const MAX_TOKEN_CAP = 32768;         // 单次调用输出上限封顶

// LLM 用量统计（进程内累计，供管理端仪表盘展示）
const usageStats = { calls: 0, inputTokens: 0, outputTokens: 0 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 原生 HTTP(S) 请求：POST JSON，返回 {status, body}（无连接复用，规避网关回收） */
function requestJSON(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + apiKey,
      },
      timeout: timeoutMs || API_TIMEOUT_MS,
      agent: new mod.Agent({ keepAlive: false }),
    }, res => {
      // 累积原始 Buffer，流结束再统一 UTF-8 解码——
      // 禁止分块独立 toString()：多字节汉字若被 TCP 分块从中间切断会解码成 � 乱码
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", err => {
      // 归一化错误：带 code 便于熔断判定
      const e = new Error(err.message);
      e.code = err.code || "";
      e.name = err.name || "Error";
      reject(e);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// 当前生效主通道模型（动态读取，Redis 覆盖优先）
// 无长缓存：切换模型即时生效（Redis GET 毫秒级，生成阶段几十次调用开销可忽略）
let _activeCfg = null;
let _activeCfgAt = 0;
const ACTIVE_CFG_TTL = 2000; // 2s 兜底合并，避免同一瞬间并发重复查询

async function getActiveConfig() {
  const now = Date.now();
  if (_activeCfg && now - _activeCfgAt < ACTIVE_CFG_TTL) return _activeCfg;
  try {
    const { getActiveConfig: gac } = require("./model-manager");
    _activeCfg = await gac("generative");
  } catch (e) {
    _activeCfg = null;
  }
  _activeCfgAt = now;
  return _activeCfg || { apiKey, baseUrl, model: defaultModel };
}

/** 生成 opencode 网关所需的 x-opencode-session 值（8 位字母数字，同 dsh-opencode-session-id 风格） */
function opencodeSessionId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// DNS 稳定层：解析成功缓存 IP（TTL 10min），直连 IP 走 servername/Host 头，
// 避免容器 DNS 间歇性失败导致 getaddrinfo ENOTFOUND 打断生成。
const dnsCache = new Map(); // hostname -> { ip, at }

function resolveWithRetry(hostname, attempts = 3) {
  const dns = require("dns");
  return new Promise((resolve, reject) => {
    let att = 0;
    const tryOnce = () => {
      dns.lookup(hostname, { family: 4 }, (err, ip) => {
        if (!err && ip) return resolve(ip);
        if (++att >= attempts) return reject(new Error("DNS 解析失败: " + hostname + " (" + err?.code + ")"));
        setTimeout(tryOnce, 1000 * att);
      });
    };
    tryOnce();
  });
}

async function resolveStable(hostname) {
  const now = Date.now();
  const hit = dnsCache.get(hostname);
  if (hit && now - hit.at < 2 * 60 * 1000) return hit.ip;
  const ip = await resolveWithRetry(hostname);
  dnsCache.set(hostname, { ip, at: now });
  return ip;
}

/** 连接层失败（ECONNREFUSED/ECONNRESET 等）时立即失效该域名的 IP 缓存（IP 可能已变/临时拒连） */
function invalidateDns(hostname) {
  dnsCache.delete(hostname);
}

/** callDeepSeek：原生 https 调用 chat/completions（使用当前生效模型配置），返回 {content, usage, model} */
async function callDeepSeek(messages, options = {}) {
  const cfg = await getActiveConfig();
  const key = cfg.apiKey || apiKey;
  const base = (cfg.baseUrl || baseURL).replace(/\/+$/, "");
  const model = options.model || cfg.model || defaultModel;
  let extra = (cfg.extraHeaders && typeof cfg.extraHeaders === "object") ? { ...cfg.extraHeaders } : {};
  // opencode.ai 网关模型（mimo 等）需要 x-opencode-session 头；未配置时自动生成
  if ((cfg.baseUrl || "").includes("opencode.ai") && !extra["x-opencode-session"]) {
    extra["x-opencode-session"] = opencodeSessionId();
  }
  const res = await requestJSONWithKey(base + "/chat/completions", {
    model,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.7,
    messages,
  }, options.timeout || API_TIMEOUT_MS, key, extra);
  if (res.status !== 200) {
    const err = new Error("LLM API " + res.status + ": " + String(res.body || "").substring(0, 200));
    err.status = res.status;
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) { throw new Error("LLM 响应解析失败: " + String(res.body || "").substring(0, 200)); }
  const choice = parsed?.choices?.[0]?.message || {};
  const content = choice.content || "";
  // 推理型模型可能把预算吃在 reasoning 上，正文为空。
  const reasoningBudgetHit = !content && !!choice.reasoning_content;
  // 截断检测：finish_reason=length 表示输出被 max_tokens 截断（正文不完整，
  // 历史上导致线索第二轮/结局/QA 静默缺失）。交由上层决定是否升级预算或报错。
  const finishReason = parsed?.choices?.[0]?.finish_reason || "";
  const truncated = finishReason === "length" && !!content;
  return {
    content,
    reasoningBudgetHit,
    truncated,
    finishReason,
    reasoningContent: reasoningBudgetHit ? (choice.reasoning_content || "") : "",
    usage: {
      inputTokens: parsed?.usage?.prompt_tokens || 0,
      outputTokens: parsed?.usage?.completion_tokens || 0,
    },
    model: parsed?.model || model,
  };
}

/** requestJSON 的带自定义 Bearer key + 额外请求头版本（登记模型可带 extraHeaders，如 mimo 的 x-opencode-session）
 *  连接层健壮性：IP 直连失败（ECONNREFUSED/ECONNRESET/socket hang up）时
 *  ① 立即失效该域名的 IP 缓存（IP 可能已变/临时拒连）② 若该次用了缓存 IP，用 hostname 系统解析重试一次 */
async function requestJSONWithKey(url, payload, timeoutMs, bearerKey, extraHeaders, _retriedFallback) {
  const u = new URL(url);
  const mod = u.protocol === "http:" ? http : https;
  // DNS 稳定层：解析 hostname → 缓存 IP → 用 IP 直连（Host 头保持域名，规避容器 DNS 抖动）
  // 降级重试（_retriedFallback）时直接用 hostname 系统解析，不再用 IP 缓存
  let hostIp = null;
  let usedCachedIp = false;
  if (!_retriedFallback) {
    try {
      hostIp = await resolveStable(u.hostname);
      usedCachedIp = true;
    } catch (e) { /* 解析失败则走默认系统解析 */ }
  }

  return new Promise((resolveParent, rejectParent) => {
    const attempt = (connHost, headersExtra) => new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + (bearerKey || ""),
      };
      // 合并自定义请求头（如 x-opencode-session / x-session-affinity）
      if (headersExtra && typeof headersExtra === "object") {
        for (const [k, v] of Object.entries(headersExtra)) {
          if (v && typeof v === "string") headers[k] = v;
        }
      }
      const opts = {
        hostname: connHost,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "POST",
        headers,
        timeout: timeoutMs || API_TIMEOUT_MS,
        agent: new mod.Agent({ keepAlive: false }),
      };
      // 用 IP 直连时保持 Host 头为域名（虚拟主机路由需要）；https 用 servername 做 SNI
      if (connHost !== u.hostname) {
        headers["Host"] = u.hostname;
        if (mod === https) opts.servername = u.hostname;
      }
      const req = mod.request(opts, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", err => { const e = new Error(err.message); e.code = err.code || ""; e.name = err.name || "Error"; reject(e); });
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.write(body);
      req.end();
    });

    (async () => {
      try {
        // 第一次：缓存 IP（若有）直连
        const r = await attempt(hostIp || u.hostname, extraHeaders);
        resolveParent(r);
      } catch (e1) {
        // 连接层失败：失效缓存
        if (hostIp) invalidateDns(u.hostname);
        // 若这次用了缓存 IP 且还未降级过 → 用 hostname 系统解析重试一次（新 IP）
        if (usedCachedIp && !_retriedFallback) {
          try {
            const r2 = await requestJSONWithKey(url, payload, timeoutMs, bearerKey, extraHeaders, true);
            return resolveParent(r2);
          } catch (e2) {
            const e = new Error(String(e2.message || e1.message));
            e.code = e2.code || e1.code || "";
            e.name = e2.name || e1.name || "Error";
            return rejectParent(e);
          }
        }
        return rejectParent(e1);
      }
    })();
  });
}

/** 前3次无条件重试，后面只重试网络/超时/服务端错误 */
function canRetry(err, attempt) {
  if (attempt < 3) return true;
  const msg = String(err.message || "").toLowerCase();
  const code = err.status || err.code || 0;
  return /network|timeout|econn|etimedout|429|502|503|504|socket|connect|reset|abort|closed|refused/i.test(msg)
    || [429, 502, 503, 504].includes(code)
    || (err.name && /api|connection|timeout/i.test(err.name));
}

/** 是否为"网络/超时类"错误（连接失败/连接被重置/DNS/单次超时等）——通道不可用或响应过慢，应快速熔断切 Agnes */
function isNetworkFault(err) {
  const msg = String(err.message || "").toLowerCase();
  const code = err.status || err.code || 0;
  return /connection error|econn|etimedout|socket|connect|refused|network|dns|getaddrinfo|fetch failed|undici|eai_again|timeout|aborted/i.test(msg)
    || /50[23]|429/.test(String(code));
}

/** 内部通用：调用 API 并自动重试 */
async function _callWithRetry(messages, options = {}) {
  const model = options.model || defaultModel;
  let lastErr = null;

  // 网络类失败计数：连续 N 次网络故障即熔断切 Agnes，避免在不可用通道上耗尽全部重试
  let netFaults = 0;
  const NET_BREAK_AT = 2; // 连续2次连接类失败就切 Agnes（正常抖动≤1次）
  let tokenEscalations = 0; // 本次调用 max_tokens 已升级次数

  // 进程级熔断状态：已确认 DeepSeek 网络不可用 → 一段时间内直接走 Agnes（不再逐阶段重试）
  const CIRCUIT_BREAK_MS = 5 * 60 * 1000;
  if (Date.now() < (global.__genCircuitUntil || 0)) {
    const fb0 = await fallbackToAgnes(messages, options);
    if (fb0) return fb0;
    // Agnes 也不行就正常走 deepseek 重试
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 检查是否已被外部中断
    if (options.signal?.aborted) throw new Error("Aborted");
    try {
      const response = await callDeepSeek(messages, options);
      usageStats.calls++;
      usageStats.inputTokens += response.usage.inputTokens;
      usageStats.outputTokens += response.usage.outputTokens;

      // 正文为空 + reasoning 占满预算：升级预算重试（最多 MAX_TOKEN_ESCALATION 次，封顶上限）
      if (response.reasoningBudgetHit && !options.noEscalate) {
        if (tokenEscalations >= MAX_TOKEN_ESCALATION || (options.maxTokens || DEFAULT_MAX_TOKENS) >= MAX_TOKEN_CAP) {
          // 升级已用尽仍无正文：绝不把 reasoning_content(思考过程)当正文返回，
          // 否则思考会污染剧本/评测/线索等成品。直接抛错，交由上层重试或报错。
          const err = new Error(`模型仅在推理后未输出正文（reasoning 占满 ${options.maxTokens || DEFAULT_MAX_TOKENS} tokens 预算）`);
          err.code = "NO_CONTENT";
          throw err;
        }
        tokenEscalations++;
        const next = Math.min((options.maxTokens || DEFAULT_MAX_TOKENS) * 2, MAX_TOKEN_CAP);
        console.warn(`[generate] reasoning 占用预算致正文为空，升级 max_tokens ${options.maxTokens || DEFAULT_MAX_TOKENS} → ${next}`);
        options.maxTokens = next;
        // 不消耗 retry 次数，直接下一轮
        attempt--;
        continue;
      }

      // 输出被截断（finish_reason=length）：内容不完整（线索第二轮/结局/QA 会缺失），
      // 升级预算重试；已到上限则记录告警后返回（由上层校验决定是否可用）。
      if (response.truncated && !options.noEscalate) {
        if (tokenEscalations < MAX_TOKEN_ESCALATION && (options.maxTokens || DEFAULT_MAX_TOKENS) < MAX_TOKEN_CAP) {
          tokenEscalations++;
          const next = Math.min((options.maxTokens || DEFAULT_MAX_TOKENS) * 2, MAX_TOKEN_CAP);
          console.warn(`[generate] 输出被截断(finish_reason=length)，升级 max_tokens ${options.maxTokens || DEFAULT_MAX_TOKENS} → ${next}`);
          options.maxTokens = next;
          attempt--;
          continue;
        }
        console.warn(`[generate] 输出仍被截断（已达 ${options.maxTokens || DEFAULT_MAX_TOKENS} tokens 上限），返回不完整内容`);
      }
      return response;
    } catch (err) {
      lastErr = err;
      // 客户端主动中断，不重试
      if (err.name === "AbortError" || err.message === "Aborted") throw err;
      // 推理型模型升级预算后仍无正文：重试无意义，直接走 agnes 通道兜底
      if (err.code === "NO_CONTENT") {
        console.warn("[generate] 模型长时间仅输出推理、无正文，切换 Agnes 通道尝试...");
        break;
      }
      // 网络类失败熔断：连续发生即提前切 Agnes（不再耗光 8 次重试）
      if (isNetworkFault(err)) {
        netFaults++;
        console.warn(`[generate] 网络故障(${err.message}) 连续${netFaults}次`, netFaults >= NET_BREAK_AT ? "，熔断切换 Agnes 通道" : "");
        if (netFaults >= NET_BREAK_AT) {
          // 进程级熔断：一段时间内直接走 Agnes
          global.__genCircuitUntil = Date.now() + CIRCUIT_BREAK_MS;
          break;
        }
        const fd = Math.min(RETRY_DELAY_MS * Math.pow(2, attempt), 20000);
        await sleep(fd);
        continue;
      }
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

/**
 * 统一取出生成结果里的文本。
 *
 * 两条通道的返回形状不同，调用方很容易踩坑：
 *   - generate()     → { content, usage, model }（对象）
 *   - agnes.chat()   → 字符串
 * 直接对 generator 的结果做 String(x) 会得到 "[object Object]"，
 * 而且它非空、非 "null"，会被当成有效回答一路走下去（NPC 真的会对玩家说这句话）。
 * 任何"两个通道都可能被调用"的地方都应该用它取文本。
 * @param {*} result
 * @returns {string}
 */
function textOf(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") return String(result.content || "");
  return String(result);
}

module.exports = { generate, textOf, getUsageStats: () => ({ ...usageStats }) };
