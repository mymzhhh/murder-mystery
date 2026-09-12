// 把 opencode.ai/zen/go 的速度前四名注册进模型列表（generative 写作 + reasoning 对话）
//
// 选型依据：scripts 里那轮横评 —— 真实剧本材料 + 3 次采样，
// 这四个是 /chat/completions 协议下既快又能用的（详见提交说明）。
//
// 用法：node scripts/register-opencode-models.js [--activate=glm-5.3-flash]
// 默认只注册、不改动"当前生效模型"（避免悄悄切走线上正在用的模型）。
const { upsertModel, listModels, setActive } = require("../modules/model-manager");
const { getRedis } = require("../modules/redis-client");

const BASE_URL = "https://opencode.ai/zen/go/v1";

// 会话 ID：opencode 要求每段对话一个稳定值，用于路由与提示词缓存。
// 这里给每个模型一个固定值，保证跨调用稳定（真正的"按房间"会话由
// agnes-client 的 sessionId 选项在请求级覆盖）。
const SESSIONS = {
  "glm-5.3-flash": "mm-glm53flash-7f3a91",
  "omen-alpha": "mm-omenalpha-2c58d4",
  "deepseek-flash": "mm-dsflash-b61e07",
  "deepseek-v4.1-flash": "mm-ds41flash-4a92ce",
};

const MODELS = [
  { id: "glm-5.3-flash", note: "OpenCode Go · GLM-5.3-Flash · 实测 3.2s · $0.15/$0.50 · 月$60", in: 0.15, out: 0.50, quota: 60 },
  { id: "omen-alpha", note: "OpenCode Go · omen-alpha · 实测 1.9s（最快）· 价格/额度官方未公布", in: null, out: null, quota: null },
  { id: "deepseek-flash", note: "OpenCode Go · deepseek-flash · 实测 2.4s · 价格/额度官方未公布", in: null, out: null, quota: null },
  { id: "deepseek-v4.1-flash", note: "OpenCode Go · DeepSeek V4.1 Flash · 实测 2.5s · $0.15/$0.60 · 月$15", in: 0.15, out: 0.60, quota: 15 },
];

/** 从已有注册项里取 opencode 的密钥（不新增密钥来源，避免密钥散落多处） */
async function resolveOpencodeKey() {
  const r = await getRedis();
  for (const ch of ["reasoning", "generative"]) {
    const raw = await r.hgetall(`model:registry:${ch}`).catch(() => ({}));
    for (const [, val] of Object.entries(raw || {})) {
      try {
        const d = JSON.parse(val);
        if (d.apiKey && /opencode\.ai/i.test(d.baseUrl || "")) return { key: d.apiKey, from: `${ch}/${d.model || "?"}` };
      } catch (e) { /* 跳过坏记录 */ }
    }
  }
  return null;
}

(async () => {
  const found = await resolveOpencodeKey();
  if (!found) {
    console.error("✖ 找不到 opencode 的密钥。请先在模型列表里添加任意一个 opencode 模型（带 x-opencode-session 请求头），或设置环境变量。");
    process.exit(2);
  }
  console.log(`密钥来源：${found.from}（长度 ${found.key.length}）`);
  console.log(`Base URL：${BASE_URL}\n`);

  const args = process.argv.slice(2);
  const activateArg = args.find(a => a.startsWith("--activate="));
  const activateModel = activateArg ? activateArg.split("=")[1] : null;

  for (const ch of ["generative", "reasoning"]) {
    console.log(`=== ${ch === "generative" ? "生成通道（写作）" : "推理通道（对话）"} ===`);
    for (const m of MODELS) {
      const name = `opencode-${m.id}`;
      await upsertModel(ch, name, {
        apiKey: found.key,
        baseUrl: BASE_URL,
        model: m.id,
        note: m.note,
        extraHeaders: { "x-opencode-session": SESSIONS[m.id] },
      });
      console.log(`  ✔ ${name}  →  ${m.id}`);
    }
    console.log("");
  }

  // 校验登记结果
  console.log("=== 登记结果核对 ===");
  for (const ch of ["generative", "reasoning"]) {
    const list = await listModels(ch);
    const ours = list.filter(x => x.name.startsWith("opencode-"));
    console.log(`  ${ch}: 共 ${list.length} 个，其中 opencode-* ${ours.length} 个`);
    for (const o of ours) {
      const hdr = o.extraHeaders && Object.keys(o.extraHeaders).length ? " 请求头=" + JSON.stringify(o.extraHeaders) : " ⚠无请求头";
      console.log(`    · ${o.name.padEnd(28)} 模型=${o.model}  基址=${o.baseUrl}${hdr}`);
    }
  }

  if (activateModel) {
    for (const ch of ["generative", "reasoning"]) {
      await setActive(ch, `opencode-${activateModel}`);
      console.log(`\n已把 ${ch} 通道切换为 opencode-${activateModel}`);
    }
  } else {
    console.log("\n（未改动当前生效模型；如需切换：--activate=glm-5.3-flash）");
  }
  process.exit(0);
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
