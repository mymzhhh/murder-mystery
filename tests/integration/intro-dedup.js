// 端到端回归：一次"自我介绍"只能显示一条
//
// 为什么必须做集成测试：这个 bug 是"服务端为同一个动作发了两个都会被前端渲染成聊天记录的事件"
// （intro_statement 原文 + 带 📣 前缀的 chat_message），
// 单测怎么测字符串都拦不住，只有真的走一遍 socket 流程、数一数收到几条才能验证。
//
// 跑法：npm run test:intro（需要服务端 + Redis + PG 都在跑）
const { io } = require("socket.io-client");
const Redis = require("ioredis");

const BASE = process.env.VOICE_TEST_BASE || "http://127.0.0.1:3000";
const REDIS_URL = process.env.VOICE_TEST_REDIS || "redis://127.0.0.1:6380";

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const r = require("http").request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    }, (res) => {
      let b = ""; res.on("data", c => b += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function auth(name) {
  const body = { username: name, password: "voicetest123" };
  let r = await req("POST", "/api/auth/register", body);
  if (r.status !== 200 || !r.body.token) r = await req("POST", "/api/auth/login", body);
  if (!r.body.token) throw new Error("认证失败: " + JSON.stringify(r.body));
  return r.body.token;
}

const once = (sock, ev, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待 " + ev + " 超时")), ms);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

const waitPhase = (sock, phase, ms = 30000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("等待阶段 " + phase + " 超时")), ms);
  const on = (d) => { if (d && d.phase === phase) { clearTimeout(t); sock.off("phase_changed", on); resolve(d); } };
  sock.on("phase_changed", on);
});

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✔ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ✖ " + name + (extra ? "  " + extra : "")); }
}

(async () => {
  const token = await auth("voicetest_a");
  const scripts = await req("GET", "/api/player/scripts", null, token);
  const sid = scripts.body.scripts[0].sessionId;
  const room = await req("POST", "/api/player/rooms", { scriptSessionId: sid, maxPlayers: 2 }, token);
  const code = room.body.roomCode;
  console.log(`测试房间 ${code}`);

  const S = io(BASE, { transports: ["websocket"] });
  await once(S, "connect");
  S.emit("join_room", { roomCode: code, token });
  const st = await once(S, "room_state");
  const pick = (st.allCharacters || []).find(c => c.roleType !== "npc");

  const sel = once(S, "character_selected");
  S.emit("select_character", { roomCode: code, characterName: pick.name });
  await sel;

  // 开局 → reading
  const pReading = waitPhase(S, "reading");
  S.emit("start_game", { roomCode: code });
  await pReading;
  console.log("阶段：reading");

  // 所有真人 ready → 5 秒倒计时后进入 intro
  const pIntro = waitPhase(S, "intro", 40000);
  S.emit("ready", { roomCode: code });
  await pIntro;
  console.log("阶段：intro\n");

  // 收集所有"会被前端渲染成聊天记录"的事件
  const chatMessages = [];
  const introEvents = [];
  const aiAnswers = [];
  S.on("chat_message", (d) => chatMessages.push(d));
  S.on("intro_statement", (d) => introEvents.push(d));
  S.on("ai_answer", (d) => aiAnswers.push(d));

  const TEXT = "这是用于回归测试的自我介绍内容，标志串 INTRO-DEDUP-7F3A。";
  S.emit("intro_statement", { roomCode: code, content: TEXT });
  await new Promise(r => setTimeout(r, 1500));

  console.log("【服务端在提交自我介绍后发出的事件】");
  console.log(`  · chat_message 命中 ${chatMessages.filter(m => (m.content || "").includes("INTRO-DEDUP-7F3A")).length} 条`);
  console.log(`  · intro_statement 命中 ${introEvents.filter(m => (m.content || "").includes("INTRO-DEDUP-7F3A")).length} 条`);

  // 前端把 chat_message 和 intro_statement 都追加进聊天列表，
  // 所以"用户会看到几条"= 两者中带这段文字的事件总数
  const visible = [
    ...chatMessages.filter(m => (m.content || "").includes("INTRO-DEDUP-7F3A")),
    ...introEvents.filter(m => (m.content || "").includes("INTRO-DEDUP-7F3A")),
  ];
  check("一次自我介绍只产生一条可见消息", visible.length === 1, `实际 ${visible.length} 条`);
  if (visible.length > 1) {
    visible.forEach((v, i) => console.log(`      第${i + 1}条: ${String(v.content).slice(0, 40)}...`));
  }
  check("可见的那条被打上【自我介绍】标记",
    visible.length === 1 && String(visible[0].content).includes("【自我介绍】"),
    visible.length === 1 ? String(visible[0].content).slice(0, 30) + "..." : "");

  // 重新拉一次 room_state 也不能重复（历史记录路径）
  const st2 = await new Promise((resolve) => {
    S.once("room_state", resolve);
    S.emit("join_room", { roomCode: code, token });
  });
  const inHistory = (st2.chatMessages || []).filter(m => (m.content || "").includes("INTRO-DEDUP-7F3A"));
  check("历史记录里也只有一条", inHistory.length === 1, `实际 ${inHistory.length} 条`);

  // ---------- 同类检查：向 AI 玩家提问的答案也不能重复下发 ----------
  // ask_ai_player 曾经既把答案写进 chat_message（持久化），又发一个 ai_answer 事件，
  // 而前端两条都追加进聊天列表 —— 与自我介绍是同一类 bug。
  const aiTarget = (st.players || []).find(p => p.isAI && p.characterName);
  if (!aiTarget) {
    console.log("\n（本局没有 AI 玩家，跳过 AI 提问检查）");
  } else {
    console.log(`\n【向 AI 玩家 ${aiTarget.characterName} 提问】`);
    const beforeChat = chatMessages.length;
    const beforeAi = aiAnswers.length;
    S.emit("ask_ai_player", { roomCode: code, characterName: aiTarget.characterName, question: "案发时你在哪里？标志串 ASK-DEDUP-9C21" });
    // 答案走 LLM，给足时间；即便 LLM 失败也会用兜底答案，同样会产生这两条事件
    await new Promise(r => setTimeout(r, 45000));

    const newAnswers = aiAnswers.slice(beforeAi);
    const newChats = chatMessages.slice(beforeChat);
    console.log(`  · 新增 chat_message ${newChats.length} 条，ai_answer ${newAnswers.length} 条`);
    // 同一个答案文本既出现在 chat_message 里、又通过 ai_answer 下发 = 用户会看到两遍
    const dup = newAnswers.filter(a => newChats.some(m => (m.content || "") === (a && a.answer)));
    check("AI 回答不同时以聊天消息和事件重复下发", dup.length === 0,
      dup.length ? `重复 ${dup.length} 条：${String(dup[0].answer).slice(0, 40)}...` : "");
  }

  S.disconnect();
  const redis = new Redis(REDIS_URL);
  const keys = await redis.keys(`game:${code}*`);
  if (keys.length) await redis.del(...keys);
  await redis.srem("rooms:open", code);
  await redis.zrem("games:index", code); // 别漏：只删房间键会留下死索引（线上曾积到 59 条）
  await redis.quit();
  console.log(`\n已清理测试房间 ${code} 的 ${keys.length} 个 Redis 键`);
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
