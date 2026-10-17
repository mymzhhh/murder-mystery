// generator 关键逻辑单测：源码结构断言（不真调 LLM，避免网络依赖）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const gen = require("../../src/llm/generator");
const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "llm", "generator.js"), "utf8");

test("generator 导出 generate/getUsageStats", () => {
  assert.equal(typeof gen.generate, "function");
  assert.equal(typeof gen.getUsageStats, "function");
});

test("getUsageStats 返回累计结构", () => {
  const s = gen.getUsageStats();
  assert.equal(typeof s.calls, "number");
  assert.equal(typeof s.inputTokens, "number");
  assert.equal(typeof s.outputTokens, "number");
});

test("检测输出截断（finish_reason=length）", () => {
  assert.ok(src.includes("finish_reason"), "应读取 finish_reason");
  assert.ok(src.includes("truncated"), "应有截断标记");
  assert.ok(/truncated\s*&&\s*!options\.noEscalate/.test(src), "截断应触发预算升级");
});

test("网络故障判定与 DNS 缓存失效", () => {
  assert.ok(src.includes("isNetworkFault"), "应有网络故障判定");
  assert.ok(src.includes("invalidateDns"), "应有 DNS 缓存失效");
  assert.ok(src.includes("resolveStable"), "应有 DNS 稳定层");
  assert.ok(/getaddrinfo|enotfound/i.test(src), "应识别 DNS 解析失败");
});

test("reasoning 占满预算时抛 NO_CONTENT 而非污染正文", () => {
  assert.ok(src.includes("NO_CONTENT"), "应标记 NO_CONTENT");
  assert.ok(!/content\s*=\s*choice\.reasoning_content\s*;/.test(src), "不得把 reasoning 直接当正文");
});

test("原生 https 通道（不使用 openai SDK 做生成）", () => {
  assert.ok(src.includes('require("https")'), "应使用原生 https");
  assert.ok(!/new OpenAI\(/.test(src), "生成通道不应使用 openai SDK 客户端");
});

// ===== textOf：统一两条通道的返回形状 =====

test("textOf：generate 返回对象时取 content", () => {
  assert.strictEqual(gen.textOf({ content: "正文", usage: {}, model: "m" }), "正文");
});

test("textOf：agnes 直接返回字符串时原样透传", () => {
  assert.strictEqual(gen.textOf("正文"), "正文");
});

test("textOf：空值返回空串，不产生 'null'/'undefined' 文本", () => {
  assert.strictEqual(gen.textOf(null), "");
  assert.strictEqual(gen.textOf(undefined), "");
  assert.strictEqual(gen.textOf({}), "");
});

test("textOf：绝不把对象字符串化成 '[object Object]'", () => {
  const out = gen.textOf({ content: "真正的回答" });
  assert.ok(!out.includes("[object Object]"), "对象必须取字段，不能整体 String()");
});

test("textOf 已导出（调用方必须能拿到它）", () => {
  assert.strictEqual(typeof gen.textOf, "function");
});