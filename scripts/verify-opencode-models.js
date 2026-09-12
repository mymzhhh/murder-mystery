// 端到端验证：4 个新注册的 opencode 模型在【两个通道】的真实代码路径上都能调通
// 做法：逐个设为生效 → 走真实调用路径打一次 → 最后恢复原来的生效模型
const { setActive, getActiveConfig, listModels } = require("../modules/model-manager");
const { getRedis } = require("../modules/redis-client");
const agnes = require("../modules/agnes-client");
const { generate } = require("../modules/generator");

const MODELS = ["opencode-glm-5.3-flash", "opencode-omen-alpha", "opencode-deepseek-flash", "opencode-deepseek-v4.1-flash"];

(async () => {
  // 记录"生效标记"本身（可能是 "env" 或某个注册名），而不是解析后的配置 ——
  // 只记 model 名的话，回填时会把 env 默认误写成注册项，等于悄悄改掉线上生效模型。
  const r = await getRedis();
  const beforeActive = {
    generative: (await r.get("model:active:generative")) || "env",
    reasoning: (await r.get("model:active:reasoning")) || "env",
  };
  const before = {
    generative: await getActiveConfig("generative"),
    reasoning: await getActiveConfig("reasoning"),
  };
  console.log("原生效标记：generative=" + beforeActive.generative + "（" + before.generative.model + "）  " +
    "reasoning=" + beforeActive.reasoning + "（" + before.reasoning.model + "）\n");

  const rows = [];
  try {
    for (const name of MODELS) {
      // ---- 推理通道（对话）：AI 玩家/NPC 走的路径 ----
      await setActive("reasoning", name);
      let r = { ms: -1, out: "", err: "" };
      try {
        const t0 = Date.now();
        const out = await agnes.chat("你是一个助手。", "回复OK两个字母。", { maxTokens: 300, timeoutMs: 40000, label: "verify.reasoning" });
        r = { ms: Date.now() - t0, out: out || "", err: out ? "" : "返回空（超时或失败）" };
      } catch (e) { r.err = e.message; }
      rows.push({ name, ch: "推理/对话", ...r });

      // ---- 生成通道（写作）：剧本生成走的路径 ----
      // 注意 generate() 返回的是 {content, usage, ...} 对象，不是字符串，
      // 直接 String(out) 会得到 "[object Object]"（这里踩过一次）。
      await setActive("generative", name);
      let g = { ms: -1, out: "", err: "" };
      try {
        const t0 = Date.now();
        const res = await generate("你是一个助手。", "回复OK两个字母。", { maxTokens: 300, timeout: 40000 });
        const text = typeof res === "string" ? res : String((res && res.content) || "");
        g = { ms: Date.now() - t0, out: text, err: text ? "" : "返回空（超时或失败）" };
      } catch (e) { g.err = e.message; }
      rows.push({ name, ch: "生成/写作", ...g });
    }
  } finally {
    // 无论如何都要恢复成"原来的生效标记"，避免悄悄改掉线上生效模型
    await setActive("generative", beforeActive.generative);
    await setActive("reasoning", beforeActive.reasoning);
    const gAfter = await getActiveConfig("generative");
    const rAfter = await getActiveConfig("reasoning");
    console.log("\n已恢复生效标记：generative=" + beforeActive.generative + "（" + gAfter.model + "）  " +
      "reasoning=" + beforeActive.reasoning + "（" + rAfter.model + "）");
  }

  console.log("\n" + "=".repeat(76));
  console.log("通道            模型                            结果        耗时");
  console.log("-".repeat(76));
  let ok = 0, bad = 0;
  for (const x of rows) {
    const pass = !x.err;
    if (pass) ok++; else bad++;
    console.log(
      x.ch.padEnd(14) + x.name.padEnd(32) +
      (pass ? "✔ " + x.out.slice(0, 12).replace(/\n/g, " ") : "✖ " + x.err.slice(0, 26)).padEnd(14) +
      (x.ms >= 0 ? x.ms + " ms" : "")
    );
  }
  console.log("-".repeat(76));
  console.log(`通过 ${ok} / 失败 ${bad}（共 ${rows.length} 项：4 模型 × 2 通道）`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error("验证失败:", e.message); process.exit(1); });
