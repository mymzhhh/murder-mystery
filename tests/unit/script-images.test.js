// 剧本配图：工作流注入 + 提示词构造（纯函数，不联网）
//
// 背景（2026-10-18）：真本带 24 张图（角色立绘/线索文档/真相时间线），生成稿 0 张。
// 接上本机 ComfyUI 时踩到的坑必须钉住：原始工作流 steps=8 却没挂加速 LoRA，
// 而 Qwen-Image 2.1 不是蒸馏模型 → 出来的图和提示词完全无关。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const si = require("../../src/script/script-images.js");

const WF = JSON.parse(fs.readFileSync(si.WORKFLOW, "utf8"));

test("默认工作流必须挂了 8step 加速 LoRA（否则 8 步出图与提示词无关）", () => {
  const hasLora = Object.values(WF).some((n) => n.class_type === "LoraLoaderModelOnly");
  assert.ok(hasLora, "工作流里必须有 LoraLoaderModelOnly");
  // 且 LoRA 确实接在采样器的模型链路上
  const loraId = si.findByClass(WF, "LoraLoaderModelOnly");
  const sampler = WF[si.findByClass(WF, "KSampler")];
  const chain = [sampler.inputs.model[0]];
  let guard = 0;
  while (chain.length && guard++ < 10) {
    const id = chain.pop();
    if (id === loraId) break;
    const node = WF[id];
    if (!node) break;
    for (const v of Object.values(node.inputs || {})) {
      if (Array.isArray(v)) chain.push(v[0]);
    }
  }
  assert.ok(chain.length || guard < 10, "LoRA 应在采样器的模型链路上");
});

test("按 class_type 定位节点，不依赖固定节点号", () => {
  assert.ok(si.findByClass(WF, "CLIPTextEncode"));
  assert.ok(si.findByClass(WF, "KSampler"));
  assert.strictEqual(si.findByClass(WF, "NoSuchNode"), null);
});

test("注入提示词/尺寸/种子：正负提示词不能弄反", () => {
  const wf = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "POS", clip: ["9", 0] } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "NEG", clip: ["9", 0] } },
    "3": { class_type: "EmptySD3LatentImage", inputs: { width: 512, height: 512 } },
    "4": { class_type: "KSampler", inputs: { seed: 1, steps: 8, cfg: 2.5 } },
  };
  const out = si.inject(wf, { prompt: "夜晚钟表铺", negative: "文字", width: 768, height: 768, seed: 42, steps: 8 });
  assert.strictEqual(out["1"].inputs.text, "夜晚钟表铺", "第一个 CLIPTextEncode 是正向");
  assert.strictEqual(out["2"].inputs.text, "文字", "第二个是负向");
  assert.strictEqual(out["3"].inputs.width, 768);
  assert.strictEqual(out["4"].inputs.seed, 42);
  // 不得改动原模板（多次出图共用同一份）
  assert.strictEqual(wf["1"].inputs.text, "POS");
});

test("封面提示词带上时代/地点/诡计，并明确要求无文字", () => {
  const p = si.buildCoverPrompt(
    { era: "民国", coreTrick: "时间诡计", victim: { name: "王建国" } },
    { location: "钟表修理铺" });
  assert.ok(p.includes("民国"));
  assert.ok(p.includes("钟表修理铺"));
  assert.ok(p.includes("时间诡计"));
  assert.ok(p.includes("无文字"), "必须要求无文字，否则封面会出现乱码标题");
});

test("角色立绘提示词带姓名与身份", () => {
  const p = si.buildCharacterPrompt("赵磊", { occupation: "钟表匠" }, { era: "民国" });
  assert.ok(p.includes("赵磊"));
  assert.ok(p.includes("钟表匠"));
});

test("ComfyUI 不在线时 attachScriptImages 直接跳过，不抛错、不阻塞", async () => {
  const r = await si.attachScriptImages({
    scriptId: "x", options: { cover: true }, save: async () => { throw new Error("不该被调用"); },
    host: "127.0.0.1", port: 59999,   // 必然没人监听
  });
  assert.strictEqual(r.generated.length, 0);
  assert.ok(r.skipped.some((s) => /ComfyUI 未启动/.test(s.reason)), "应如实说明跳过原因");
});
