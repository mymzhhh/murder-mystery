// 剧本配图：用本机 ComfyUI（Qwen-Image 2.1）给生成的剧本出封面 / 角色立绘 / 线索卡。
//
// 为什么需要（2026-10-18 对标结果）：真本《吉普赛女郎之死》带 **24 张图**
// （角色立绘 char-*、线索文档 cluedoc-*、真相时间线 manual-*），
// 而我们生成的本是 **0 张** —— 这是"看起来不像真本"最直观的一块。
//
// 现实约束（本机 RTX 4060 Laptop 8GB + Qwen-Image int8）：
//   · 必然走 CPU offload，**每张图都要重新把十几 GB 权重读进显存**，单张几分钟；
//   · 所以默认只出 **封面 1 张**，角色立绘/线索图按需开启（`images.characters` / `images.clues`）。
//   · ComfyUI 没起来时**绝不阻塞生成**：直接跳过并如实打日志（图是加分项，不是交付前提）。
//
// 驱动方式与 `D:\dsh\dsh-comfyui.ps1` 一致：直连 ComfyUI HTTP API（/prompt → /history → /view），
// 不依赖任何第三方插件。
const fs = require("fs");
const path = require("path");
const http = require("http");

// ⚠️ 必须用**挂了 8step 加速 LoRA** 的工作流（2026-10-18 实测）：
// 本机原始工作流 steps=8 但没有加速 LoRA，而 Qwen-Image 2.1 不是蒸馏模型 ——
// 8 步等于几乎没有引导，出来的图和提示词完全无关（要"夜晚钟表铺"，出的是湖边枯树与鸟）。
// qwen-image-2.1-8step.json = 原工作流 + LoraLoaderModelOnly(p_qwen_image_2.1_8step_v0.1) + cfg 3.0。
const DEFAULT_HOST = process.env.COMFYUI_HOST || "";
const DEFAULT_PORT = Number(process.env.COMFYUI_PORT || 8188);
const WORKFLOW = process.env.COMFYUI_WORKFLOW || path.join(__dirname, "workflows", "qwen-image-2.1-8step.json");

// ComfyUI 跑在**宿主机**上，而应用跑在 Docker 容器里 —— 容器内的 127.0.0.1 是容器自己，
// 连不到宿主机的 8188（实测：容器里连 127.0.0.1 报"无响应"，连 host.docker.internal 48ms 通）。
// 所以这里按顺序探测，谁通用谁；两边都能跑（本地直跑时 127.0.0.1 通，容器里 host.docker.internal 通）。
const HOST_CANDIDATES = DEFAULT_HOST
  ? [DEFAULT_HOST]
  : ["host.docker.internal", "127.0.0.1"];

/** 探测可用主机（结果缓存，避免每张图都探一遍） */
let _resolvedHost = null;
async function resolveHost(port) {
  if (_resolvedHost) return _resolvedHost;
  for (const h of HOST_CANDIDATES) {
    try {
      await httpJSON({ host: h, port: port || DEFAULT_PORT, path: "/system_stats", method: "GET" });
      _resolvedHost = h;
      return h;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 读工作流模板（API 格式）。找不到就返回 null —— 调用方据此跳过。 */
function loadWorkflow(file) {
  try {
    const raw = fs.readFileSync(file || WORKFLOW, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 按 class_type 定位节点，不依赖固定节点号（工作流改结构也不会错位） */
function findByClass(wf, cls) {
  for (const id of Object.keys(wf)) {
    if (wf[id] && wf[id].class_type === cls) return id;
  }
  return null;
}

function inject(wf, { prompt, negative, width, height, seed, steps }) {
  const copy = JSON.parse(JSON.stringify(wf));
  const pos = findByClass(copy, "CLIPTextEncode");
  const negs = Object.keys(copy).filter((id) => copy[id].class_type === "CLIPTextEncode" && id !== pos);
  const lat = findByClass(copy, "EmptySD3LatentImage") || findByClass(copy, "EmptyLatentImage");
  const ksampler = findByClass(copy, "KSampler");
  if (pos && prompt) copy[pos].inputs.text = prompt;
  if (negs.length && negative !== undefined) copy[negs[0]].inputs.text = negative;
  if (lat) {
    if (width) copy[lat].inputs.width = width;
    if (height) copy[lat].inputs.height = height;
  }
  if (ksampler) {
    if (Number.isFinite(seed)) copy[ksampler].inputs.seed = seed;
    if (Number.isFinite(steps)) copy[ksampler].inputs.steps = steps;
  }
  return copy;
}

function httpJSON(opts, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      ...opts,
      headers: {
        "content-type": "application/json",
        ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(new Error("返回不是 JSON: " + buf.slice(0, 120))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("连接 ComfyUI 超时")));
    if (data) req.write(data);
    req.end();
  });
}

function httpBuffer(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("下载图片超时")));
    req.end();
  });
}

/** ComfyUI 是否在线（逐个候选主机探测；都连不上返回 false） */
async function isOnline(host, port) {
  if (host) {
    try {
      await httpJSON({ host, port: port || DEFAULT_PORT, path: "/system_stats", method: "GET" });
      return true;
    } catch (e) { return false; }
  }
  return (await resolveHost(port)) !== null;
}

/**
 * 出一张图，返回 { buffer, filename }。
 * @param {{prompt:string, negative?:string, width?:number, height?:number, seed?:number, steps?:number,
 *          workflow?:object, host?:string, port?:number, timeoutMs?:number}} opts
 */
async function generateImage(opts) {
  const o = opts || {};
  const port = o.port || DEFAULT_PORT;
  const host = o.host || (await resolveHost(port));
  if (!host) throw new Error("找不到可用的 ComfyUI 主机（试过 " + HOST_CANDIDATES.join("、") + "）");
  const wf = o.workflow || loadWorkflow();
  if (!wf) throw new Error("找不到 ComfyUI 工作流模板：" + WORKFLOW);
  const promptGraph = inject(wf, o);
  const clientId = "dsh-script-" + Math.random().toString(36).slice(2, 10);
  const submit = await httpJSON({ host, port, path: "/prompt", method: "POST" }, { prompt: promptGraph, client_id: clientId });
  const promptId = submit.prompt_id;
  if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");
  const deadline = Date.now() + (o.timeoutMs || 15 * 60 * 1000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const hist = await httpJSON({ host, port, path: `/history/${promptId}`, method: "GET" });
    const entry = hist[promptId];
    if (!entry) continue;
    const outputs = entry.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const imgs = outputs[nodeId].images || [];
      if (!imgs.length) continue;
      const img = imgs[0];
      const q = `filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type || "output"}`;
      const buffer = await httpBuffer({ host, port, path: `/view?${q}`, method: "GET" });
      return { buffer, filename: img.filename };
    }
  }
  throw new Error(`出图超时（${Math.round((o.timeoutMs || 900000) / 1000)}s 内未完成）`);
}

/** 由大纲拼封面提示词（中英混合对 Qwen-Image 友好；明确要求"无文字"，避免乱码标题） */
function buildCoverPrompt(outline, meta) {
  const o = outline || {};
  const era = String(o.era || o.setting?.era || "").trim();
  const place = String(meta?.location || o.location || o.setting?.location || "").trim();
  const trick = String(o.coreTrick || o.trickSpec?.trick || "").trim();
  const victim = String(o.victim?.name || "").trim();
  const bits = [
    "悬疑推理剧本杀封面插画，静物特写",
    // ⚠️ 构图规则是**四次实测**换来的，别改回去：
    //   ① 建筑门脸／街景 → 招牌乱码（"黌滙菁 畴…""手光光腈 金松 鋸"）；
    //   ② 室内近景但画面里有门/墙 → 民国本贴了副**春联**，红纸上照样乱码；
    //   ③ 写"犯罪现场道具特写构图"这类**抽象构图指令** → 模型不鸟，还是拍门厅；
    //   ④ 换成**点名具体物件**（桌面 + 显影盘 + 镊子 + 照片）→ 画面里一个错字都没有
    //      （2026-10-18 钟表铺那张同理：吊灯/挂钟/齿轮/工作台，一个错字都没有）。
    // 结论：必须把物件一个个写出来，构图指令只是辅助。
    "画面主体：旧木桌上摊开着几件与小物件——一只白瓷显影盘、一把金属镊子、几张边缘卷曲的黑白照片、一只停摆的旧怀表",
    "桌面特写，俯拍略低角度，浅景深",
    era ? `${era}风格` : "",
    // 背景必须**彻底隐入黑暗**：写"虚化"不够，模型照样画出门、春联、招牌（实测两版都这样）。
    place ? `背景完全隐入黑暗，只有${place}的一点点模糊轮廓，不要出现任何门、窗、墙面、家具` : "背景完全隐入黑暗",
    trick ? `氛围线索：${trick}` : "",
    victim ? `（不要画出具体人物面部）` : "",
    "暗调写实，电影感侧光，高细节，冷峻压抑的气氛",
    "画面中不得出现门、窗、墙面、牌匾、街景、建筑外立面",
    "画面中不得出现招牌、店招、标牌、春联、对联、门联、标语、海报、日历、报纸、书刊等任何带字的物件",
    "无文字，无标题，无字幕，无水印，无logo",
  ].filter(Boolean);
  return bits.join("，");
}

/** 角色立绘提示词 */
function buildCharacterPrompt(name, ch, meta) {
  const occupation = String(ch?.occupation || "").trim();
  return [
    "剧本杀角色立绘，半身像",
    name ? `角色：${name}` : "",
    occupation ? `身份：${occupation}` : "",
    String(meta?.era || "").trim() ? `${meta.era}时代服饰` : "",
    "写实厚涂，暗调，侧光，背景虚化，情绪克制",
    "无文字，无水印",
  ].filter(Boolean).join("，");
}

/**
 * 给一个剧本出图并落库（通过注入的 save 回调，避免本模块依赖 db）。
 * @param {{scriptId:string, outline?:object, meta?:object, characters?:Array<{name:string}>,
 *          options?:{cover?:boolean, characters?:boolean, clues?:number, width?:number, height?:number, steps?:number},
 *          save:Function, onProgress?:Function, host?:string, port?:number}} args
 * @returns {{generated:Array<{key:string,alt:string,bytes:number}>, skipped:Array<{key:string,reason:string}>}}
 */
/**
 * 键名是否合法（与 script_images 的约束一致：只允许 [A-Za-z0-9_-]）。
 * **出图前**先校验：实测踩过「用中文当键名 → 图出完了才在保存时被拒」，
 * 白烧 4 次 GPU 生成（每次几十秒）。宁可在排队前就拦下来。
 */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isValidKey(k) { return KEY_RE.test(String(k || "")); }

/**
 * 从成稿里收集"正文引用的配图"：`![说明](img:键名)` 独立成行的那些。
 *
 * 为什么必须按引用来出图（2026-10-19）：真本的线索正文里就写着
 * `![线索·图片3](img:cluedoc-3)`，前端 ScriptBody 会把它渲染成真图；
 * 而我们是"先随便出几张图再挂上去"—— 正文一个引用都没有，图只是附加展示，
 * 玩家推不出"弹道示意""账本笔迹"这类信息。所以出图必须**跟着引用走**，
 * 否则要么引用指向不存在的图（碎图），要么图与线索无关。
 *
 * 同时把引用**所在的线索块正文**一起带回来 —— 出图提示词要从线索内容推，
 * 不能用一句通用的"线索道具照片"（那样出来的图和线索毫无关系）。
 * @returns {Array<{key:string, alt:string, context:string}>}
 */
function collectImageRefs(markdown) {
  const text = String(markdown || "");
  const out = [];
  const seen = new Set();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*!\[([^\]]*)\]\(\s*img:([A-Za-z0-9_-]{1,64})\s*\)\s*$/);
    if (!m) continue;
    const key = m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    // 回取上下文：向上找最近的 ### 标题，向下取到空行/下一个 ### 为止
    let start = i;
    for (let j = i; j >= 0 && i - j < 12; j--) {
      if (/^#{3,4}\s+\S/.test(lines[j])) { start = j; break; }
    }
    let end = i + 1;
    for (let j = i + 1; j < lines.length && j - i < 12; j++) {
      if (!lines[j].trim() || /^#{1,4}\s+\S/.test(lines[j])) break;
      end = j + 1;
    }
    const ctx = lines.slice(start, end).join(" ").replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
    out.push({ key, alt: (m[1] || "").trim(), context: ctx.slice(0, 400) });
  }
  return out;
}

/**
 * 由线索上下文拼出图提示词。
 *
 * ⚠️ 这里是**第五次**实测踩出来的（2026-10-19）：
 * 第一版把「图名：线索·图片1」和「线索内容：<整段线索正文>」直接写进提示词，
 * 模型就把这些字**逐个画在了纸面上** —— 出来的是一张写着乱码汉字的"文档"。
 * Qwen-Image 这类模型对"纸上写字"的倾向极强，唯一可靠的办法是：
 *   · **不把线索正文交给它当"要写的内容"**；
 *   · 只描述**物件类型**（一张泛黄纸页 / 一张黑白照片 / 一件金属工具 / 一块衣料…）；
 *   · 并明确要求"纸面上笔迹模糊不可辨认"。
 * 图的作用是"看到有这么个东西"，具体内容由线索文字承担 —— 这也正是真本的做法
 * （真本的图片编号只承载弹道/笔迹这类**图形信息**，文字说明仍在线索正文里）。
 */
function buildClueImagePrompt(ref) {
  const r = ref || {};
  const ctx = String(r.context || "").replace(/\s+/g, " ").trim();
  // 只从上下文里认**物件类型**，不把正文当内容喂进去。
  // ⚠️ 关键词要够具体：第一版用 /布/ 判断布料，结果"子弹分**布**如图"被判成"一小块布料"
  //    （实测：一张转轮手枪的线索图被画成布料），必须写成 布料/帆布/棉布 这类词。
  const kind =
    /照片|底片|相片/.test(ctx) ? "几张边缘卷曲的黑白照片"
      : /账页|账本|账册|收据|对账单|字据|票据/.test(ctx) ? "一张泛黄的旧纸页（账页/收据）"
        : /信纸|书信|契约|协议|遗书|手札|笔记/.test(ctx) ? "一张折痕很深的旧信纸"
          : /衣料|旗袍|布料|帆布|棉布|粗布|衣服|旧鞋|帽子/.test(ctx) ? "一小块旧布料与一只旧鞋"
            : /药瓶|毒药|粉末|药粉|液体|试剂/.test(ctx) ? "一只旧玻璃药瓶与少量粉末"
              : /手枪|转轮|子弹|弹匣|刀|锤子|钳|镊子|工具|凶器|发条|齿轮/.test(ctx) ? "一件旧金属工具或凶器"
                : /血迹|伤口|尸体|指甲|颈部|后脑|勒痕/.test(ctx) ? "一处细微痕迹的特写（暗红痕迹）"
                  : "一件不起眼的旧物件";
  const bits = [
    "剧本杀线索证物照片，现场勘查风格",
    `画面主体：${kind}，放在旧木桌面上`,
    "桌面俯拍特写，暗调侧光，浅景深，颗粒感",
    // 关键：明确纸面/表面上的字迹不可辨，避免模型去"写字"
    "纸面与表面上的笔迹全部模糊、褪色、不可辨认，不要出现任何可读的文字",
    "画面内不得出现清晰的文字、标牌、书刊封面",
  ].filter(Boolean);
  return bits.join("，");
}

/**
 * 把「线索／DM／封面」提示词拼成一组待出图任务。
 * @param {{scriptText?:string, outline?:object, meta?:object, characters?:Array, options?:object}} args
 */
function planImageJobs(args) {
  const a = args || {};
  const opt = a.options || {};
  const jobs = [];
  if (opt.cover !== false) {
    jobs.push({ key: "cover", alt: "剧本封面", prompt: buildCoverPrompt(a.outline, a.meta) });
  }
  // 正文引用的图**优先**：宁可少出立绘，也不能让正文里的引用指向不存在的图
  if (opt.clueRefs !== false && a.scriptText) {
    const refs = collectImageRefs(a.scriptText).slice(0, opt.maxClueRefs || 6);
    for (const r of refs) {
      jobs.push({ key: r.key, alt: r.alt || `线索配图 ${r.key}`, prompt: buildClueImagePrompt(r) });
    }
  }
  if (opt.characters) {
    (a.characters || []).slice(0, opt.maxCharacters || 6).forEach((c, i) => {
      jobs.push({ key: `char-${i + 1}-1`, alt: `${c.name} 立绘`, prompt: buildCharacterPrompt(c.name, c, a.meta) });
    });
  }
  for (let i = 0; i < (opt.clues || 0); i++) {
    const key = `cluedoc-${i + 1}`;
    if (jobs.some((j) => j.key === key)) continue;   // 正文已经引用过这个键，别重复出图
    jobs.push({ key, alt: `线索图 ${i + 1}`, prompt: `剧本杀线索道具照片，第${i + 1}号证物特写，桌面俯拍，暗调，细节清晰，无文字` });
  }
  return jobs;
}

async function attachScriptImages(args) {
  const a = args || {};
  const opt = a.options || {};
  const out = { generated: [], skipped: [] };
  const online = await isOnline(a.host, a.port);
  if (!online) {
    out.skipped.push({ key: "*", reason: "ComfyUI 未启动（8188 端口在候选主机上都无响应），跳过配图" });
    return out;
  }
  const wf = loadWorkflow();
  if (!wf) {
    out.skipped.push({ key: "*", reason: "找不到工作流模板 " + WORKFLOW });
    return out;
  }
  const base = {
    workflow: wf, host: a.host, port: a.port,
    width: opt.width || 768, height: opt.height || 768, steps: opt.steps || 8,
  };
  // 任务清单统一由 planImageJobs 产出：封面 → **正文引用的图（优先）** → 立绘 → 追加线索图。
  // 正文引用的图排在最前，是因为"引用指向不存在的图"会直接碎图，比少几张立绘严重。
  const jobs = planImageJobs(a);

  // 负向词里必须显式点名"招牌/汉字/标牌"：实测只写"文字"挡不住模型在店招上写乱码汉字
  const negative = "文字,汉字,招牌,店招,标牌,门头字,春联,对联,门联,标语,海报,日历,报纸,乱码,字幕,水印,logo,签名,低质量,模糊,畸形,多余肢体,恐怖,血腥";
  for (const j of jobs) {
    // 出图前先校验键名：不合法的当场跳过，不浪费一次 GPU 生成
    if (!isValidKey(j.key)) {
      out.skipped.push({ key: j.key, reason: "键名不合法（只允许 A-Za-z0-9_-），已在出图前拦下" });
      if (a.onProgress) a.onProgress(`配图跳过：${j.alt}（键名 ${j.key} 不合法）`);
      continue;
    }
    try {
      if (a.onProgress) a.onProgress(`正在出图：${j.alt}…`);
      const { buffer } = await generateImage({ ...base, prompt: j.prompt, negative, seed: Math.floor(Math.random() * 1e9) });
      await a.save(a.scriptId, j.key, "image/png", buffer, j.alt);
      out.generated.push({ key: j.key, alt: j.alt, bytes: buffer.length });
      if (a.onProgress) a.onProgress(`配图完成：${j.alt}（${Math.round(buffer.length / 1024)}KB）`);
    } catch (e) {
      out.skipped.push({ key: j.key, reason: e.message });
      if (a.onProgress) a.onProgress(`配图失败：${j.alt} —— ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  loadWorkflow, findByClass, inject, isOnline, generateImage,
  buildCoverPrompt, buildCharacterPrompt, buildClueImagePrompt, collectImageRefs, planImageJobs, attachScriptImages, isValidKey,
  DEFAULT_HOST, DEFAULT_PORT, WORKFLOW, HOST_CANDIDATES, resolveHost,
};
