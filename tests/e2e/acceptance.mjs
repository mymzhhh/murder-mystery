// 管理端验收脚本（真浏览器）：把"今天修过的、以及新增的关键交互"钉成可复跑的检查。
//
// 为什么需要它：这一轮里出现的两个 bug（登录失败没有提示、搜证刷满公屏）都是**前端交互**问题，
// 单测抓不到（`lib/api.js` 是 CJS/ESM 混合，`.mjs` 测试导不进来），而每次靠人肉点一遍
// 既不可复跑、也容易漏。dsh-verify CLI 与内置浏览器 provider 在这台机器上都不可用，
// 所以这里直接走 CDP —— 只用 Node 内置能力 + 一个已装好的 Chrome。
//
// 用法：
//   node tests/e2e/acceptance.mjs                 # 需要应用已在 3000 端口跑着
//   BASE=http://127.0.0.1:3000 node tests/e2e/acceptance.mjs
//   ADMIN_PASSWORD=xxx node tests/e2e/acceptance.mjs     # 不给则从 .env 读
//
// 退出码：全部通过 0；有失败 1（可直接用于 CI/本地把关）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const PORT = Number(process.env.CDP_PORT || 9222);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

/** 管理端口令：优先环境变量，其次项目 .env（只读取，不回显） */
function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const m = env.match(/^\s*ADMIN_PASSWORD\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim();
  } catch (e) { /* 没有 .env 就只能靠环境变量 */ }
  return "";
}

// ---------------- 最小 CDP 客户端 ----------------
const WS = globalThis.WebSocket || (await import("ws")).default;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(cdpHttp) {
    const list = await (await fetch(`${cdpHttp}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("没有可用的 page target（Chrome 起了吗？）");
    const ws = new WS(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP 连接失败")); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时: ${method}`)); } }, 30000);
    });
  }
  async evaluate(script) {
    const r = await this.send("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("页面内异常: " + (r.exceptionDetails.text || ""));
    return r.result?.value;
  }
  async goto(url) { await this.send("Page.navigate", { url }); await sleep(1200); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 检查框架 ----------------
const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || "" });
    console.log(`  ✔ ${name}${note ? "　— " + note : ""}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
    console.log(`  ✘ ${name}　— ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------- 主流程 ----------------
const password = resolveAdminPassword();
const chromePath = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!chromePath) { console.error("找不到 Chrome，用 CHROME_PATH 指定"); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "murder-accept-"));
const child = spawn(chromePath, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1680,1000", "about:blank",
], { stdio: "ignore" });

try {
  // 等 CDP 就绪
  let cdp = null;
  for (let i = 0; i < 30 && !cdp; i++) {
    await sleep(500);
    try { cdp = await Cdp.attach(`http://127.0.0.1:${PORT}`); } catch (e) { /* 继续等 */ }
  }
  if (!cdp) throw new Error("Chrome CDP 未就绪");

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log(`\n管理端验收（${BASE}）\n`);

  // ① 登录失败必须有提示，且**页面不能重载**
  //    回归的是这个 bug：登录接口密码错误返回 401，被全局 401 处理当成"会话过期"→ 跳页，
  //    于是登录页的错误提示根本没机会渲染，用户看到的就是"刷新一下，没提示"。
  await check("登录失败要原地提示（不是刷新一下什么都不说）", async () => {
    await cdp.goto(`${BASE}/`);
    await sleep(1500);
    const r = await cdp.evaluate(`(() => {
      window.__alive = "yes";                                  // 页面若被重载，这个标记会消失
      const setV = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      setV(document.querySelector("#login-username"), "admin");
      setV(document.querySelector("#login-password"), "definitely-wrong-password");
      document.querySelector(".btn.btn-primary").click();
      return "submitted";
    })()`);
    assert(r === "submitted", "登录表单没找到");
    await sleep(2500);
    const st = await cdp.evaluate(`(() => {
      const a = document.querySelector(".alert-danger");
      return JSON.stringify({ alert: a ? a.innerText : null, alive: window.__alive === "yes", user: (document.querySelector("#login-username")||{}).value });
    })()`);
    const d = JSON.parse(st);
    assert(d.alert, "没有出现错误提示（用户又会看到『刷新一下没提示』）");
    assert(d.alive, "页面被重载了（全局 401 处理把『密码错误』当成了『会话过期』）");
    return `提示「${d.alert}」且未重载`;
  });

  // ② 正确口令能进管理端
  await check("正确口令进入管理端", async () => {
    const pw = password;
    assert(pw, "没有可用口令（设 ADMIN_PASSWORD 或检查 .env）");
    await cdp.evaluate(`(() => {
      const setV = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
      setV(document.querySelector("#login-username"), "admin");
      setV(document.querySelector("#login-password"), ${JSON.stringify(pw)});
      document.querySelector(".btn.btn-primary").click();
      return "ok";
    })()`);
    await sleep(3000);
    const t = await cdp.evaluate("document.body.innerText");
    assert(t.includes("剧本生成"), "没进入管理端（页面没有管理端标签）");
    return "已进入";
  });

  // ③ 三列布局：公屏 / 剧本体检 / 角色剧本 必须同排（宽屏）
  await check("测试剧本页：三列同排（宽屏三样同时可见）", async () => {
    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('.nav-tab,[role=tab]')].find(x=>x.innerText.trim()==='测试剧本'); if(t) t.click(); return 'ok'; })()`);
    await sleep(2000);
    const st = await cdp.evaluate(`(() => {
      const find = (title) => { const p=[...document.querySelectorAll('.panel')].find(x=>{const h=x.querySelector('.panel-head strong'); return h && h.innerText.trim()===title;});
        if(!p) return null; const r=p.getBoundingClientRect(); return { w: Math.round(r.width), y: Math.round(r.y) }; };
      return JSON.stringify({ 公屏: find('公屏实录'), 体检: find('剧本体检'), 剧本: find('角色剧本'), vw: window.innerWidth });
    })()`);
    const d = JSON.parse(st);
    // 没在跑测试局时这几个面板不渲染 —— 跳过而不是误判
    if (!d.公屏 && !d.体检 && !d.剧本) return "当前没有在跑的测试局，跳过";
    const ys = [d.公屏, d.体检, d.剧本].filter(Boolean).map((p) => p.y);
    assert(new Set(ys).size === 1, `面板不在同一行：${JSON.stringify(d)}`);
    return `三列 y=${ys[0]}（宽 ${d.vw}）`;
  });

  // ④ 测试报告页能打开并列出报告（没有报告则如实跳过）
  await check("测试报告页可打开（有报告时能展开详情）", async () => {
    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('.nav-tab,[role=tab]')].find(x=>x.innerText.trim()==='测试报告'); if(t) t.click(); return 'ok'; })()`);
    await sleep(2500);
    const t = await cdp.evaluate("document.body.innerText");
    assert(t.includes("测试报告"), "报告页没打开");
    assert(/每跑完一局测试就落一份结论/.test(t), "报告页说明文案缺失（可能页面报错了）");
    const rows = await cdp.evaluate(`(() => {
      const rows=[...document.querySelectorAll('div')].filter(d=>/房间 [A-Z0-9]{6}/.test(d.innerText||'') && d.innerText.length<400 && d.style && d.style.cursor==='pointer');
      if(!rows.length) return '0';
      rows[0].click(); return String(rows.length);
    })()`);
    if (rows === "0") return "还没有报告（先去测试剧本跑一局）";
    await sleep(1200);
    const detail = await cdp.evaluate("document.body.innerText");
    assert(detail.includes("每轮搜证") && detail.includes("AI 出手"), "报告详情没展开（缺『每轮搜证』/『AI 出手』）");
    return `${rows} 份报告，详情可展开`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("\n验收脚本异常：", e.message);
  process.exitCode = 2;
} finally {
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
