// 「测试剧本」侧边栏小组件的纯逻辑（无 DOM / 无网络，便于 node --test 直接单测）
//
// 为什么把这些算法单独抽一层：这一页新加的六个部件全是"把服务器给的原始数据算成一眼能读的结论"，
// 算错了管理员会据此**误判剧本**（例如把服务端的 3 秒余量当成"这一阶段在拖时间"，
// 或者把名字没解析出来的发言算成"某个 AI 一直没说话"）。所以这几件事必须被单测钉住：
//   · 阶段耗时与"超时"判据      · 公屏按 kind 聚合（各项之和必须等于总条数）
//   · 票型分布                  · 与死者的关系（从剧本正文小节里取）

/**
 * 测试房实际会经过的阶段顺序（用于"第 n 步 / 共 m 步"）。
 * 与 src/game/game-engine.js 的 PHASES 同序，但只保留测试房会走的这一段
 * （测试局从 reading 开始，到 truth_reveal / finished 结束）。
 * 刻意**不**从这里生成"阶段耗时"的行：实测有房间的阶段流水会跳过 truth_reveal 直接落 finished
 * （CXSCPC 的 phaseLog 就是 reading→round1→round2→voting→finished），
 * 所以耗时表只按服务器真实记录的 phaseLog 渲染，多一段少一段都不会算错。
 */
export const TEST_PHASE_ORDER = ["reading", "round1", "round2", "voting", "truth_reveal", "finished"];

/** 摘要里的短标签（面板里空间只有 380px，全称放不下；全称仍用于 tooltip） */
export const PHASE_SHORT = {
  lobby: "等待", reading: "阅读", intro: "介绍", round1: "首轮",
  round2: "次轮", voting: "投票", truth_reveal: "真相", finished: "结束",
};

/** 测试房里 reading 是固定短阶段（服务端 TEST_READING_MS，默认 30 秒）。
 *  它的"设定时长"不在 meta.phaseMs 里，拿 phaseMs 去比会得出"阅读阶段永远没超时"的假结论，
 *  所以这个阶段不判超时 —— 只报实际耗时。 */
export const READING_PHASE = "reading";

/** 服务端给每个阶段留了 3 秒推进余量（见 socket/test-run.js 的 `meta.phaseMs + 3000`），
 *  所以"超时"的阈值必须大于余量，否则每个阶段都会报警。取 8 秒。 */
export const OVER_MARGIN_MS = 8000;

/**
 * 名册里的"身份/职业"。
 * 优先用结构化的 occupation；它是空的（实测《再见卡门》四个角色全是空）就退一步取正文首句 ——
 * 那正好是自我介绍（"我是塞维利亚的一名占卜师…"）。跳过的三类行都是模板噪声：
 * 角色名单独成行、（温馨提示…）、【】形式的小节标题。
 * @returns {{text:string, from:'occupation'|'script'|'none'}}
 */
export function identityText(char, maxLen) {
  const c = char || {};
  const occ = String(c.occupation || "").trim();
  if (occ) return { text: occ, from: "occupation" };
  const name = String(c.name || "").trim();
  const cap = Number(maxLen) > 0 ? Number(maxLen) : 46;
  for (const raw of String(c.script || "").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l === name) continue;                                   // 角色名单独一行
    if (/^[【\[#]/.test(l)) continue;                            // 小节标题
    if (/温馨提示/.test(l.slice(0, 12))) continue;               // 模板提醒
    const t = l.replace(/^[（(][^）)]{0,20}[）)]\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (t.length < 6) continue;
    const m = t.match(/^(.{6,}?[。！？])/);
    const s = m ? m[1] : t;
    return { text: s.length > cap ? s.slice(0, cap) + "…" : s, from: "script" };
  }
  return { text: "", from: "none" };
}

/** 毫秒 → m:ss（负数/非法值返回 "—"，不让 NaN 打到界面上） */export function fmtClock(ms) {
  // ⚠️ Number(null) === 0、Number("") === 0：不显式挡掉就会把"结束时刻不可知"显示成 0:00
  if (ms === null || ms === undefined || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const total = Math.round(n / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 阶段流水 → 每一步的实际耗时。
 * @param {Array<{phase:string, at:number}>} phaseLog 服务器登记的各阶段**开始**时刻
 * @param {{now?:number, phaseMs?:number, finished?:boolean, currentPhase?:string}} [opts]
 *   currentPhase = 页面上**已知的最新阶段**（服务端登记 + socket 事件里更靠后的那个）。
 *   为什么要它：实测这一局的真相事件是先到的 —— AI 全投完票后 vote-advance 直接推到了
 *   truth_reveal 并广播 truth_revealed，而测试房自己的登记要等它的计时器（阶段时长 + 3 秒）
 *   才写上 phaseLog。于是会出现"页面已经显示真相，最后一段还写着投票在进行中"。
 *   这种"登记落后"的最后一段标 stale：**不判超时**（它其实早就结束了，按已过时间判会误报），
 *   耗时仍显示（那是"这一段的开始时刻距今多久"，是真的）。
 * @returns {{rows:Array, elapsedMs:number}} rows[i].ms 为 null 表示"这一阶段的结束时刻不可知"
 *   （最后一段且已结束：测试局在跑到终点时不再登记结束时刻）
 */
export function phaseSteps(phaseLog, opts) {
  const o = opts || {};
  const now = Number(o.now) || 0;
  const nominal = Number(o.phaseMs) || 0;
  const currentPhase = String(o.currentPhase || "");
  const log = (Array.isArray(phaseLog) ? phaseLog : []).filter((x) => x && typeof x === "object" && x.phase);
  const rows = [];
  for (let i = 0; i < log.length; i++) {
    const cur = log[i], next = log[i + 1];
    const at = Number(cur.at) || 0;
    const running = !next && !o.finished;
    let ms = null;
    if (next) ms = Math.max(0, (Number(next.at) || 0) - at);
    else if (running && now) ms = Math.max(0, now - at);
    const comparable = nominal > 0 && cur.phase !== READING_PHASE;
    const stale = !!(running && currentPhase && currentPhase !== cur.phase);
    rows.push({
      phase: cur.phase, at, ms, running, stale,
      nominal: comparable ? nominal : null,
      over: !!(comparable && ms !== null && !stale && ms > nominal + OVER_MARGIN_MS),
      deltaMs: 0,
    });
  }
  for (const r of rows) if (r.over) r.deltaMs = r.ms - r.nominal;
  // 已跑总时长：跑完时用各段之和（否则会一直涨），在跑时用 now - 第一段的开始时刻
  const known = rows.reduce((a, r) => a + (r.ms === null ? 0 : r.ms), 0);
  const elapsedMs = o.finished ? known : (log.length && now ? Math.max(0, now - (Number(log[0].at) || now)) : known);
  return { rows, elapsedMs };
}

/** 当前阶段在测试房流程里的第几步（认不出来时返回 null，不硬编一个数字） */
export function phaseStep(phase) {
  const i = TEST_PHASE_ORDER.indexOf(String(phase || ""));
  return i < 0 ? null : { index: i + 1, total: TEST_PHASE_ORDER.length };
}

/**
 * 在若干"当前阶段候选"里取**最靠后**的那个。
 * 候选来自三处，它们各自可能领先或落后：
 *   · 测试房登记（runMeta.phase）—— 最权威，但只在自己的计时器到点时才更新；
 *   · socket 的 phase_changed（state.phase）—— 实时，但真相阶段服务端**有意只发 truth_revealed**；
 *   · truth_revealed 到了（truth 非空）—— 说明至少已经进入 truth_reveal。
 * 取最靠后的：页面显示的进度只会"不低于"任何一路已知信息，不会出现"真相都出来了还写着投票"。
 */
export function furthestPhase(candidates) {
  let best = "";
  let bestIdx = -1;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const i = TEST_PHASE_ORDER.indexOf(String(c || ""));
    if (i > bestIdx) { bestIdx = i; best = String(c); }
  }
  return best;
}

/** 公屏消息分类。判据来自**服务端真实写死的文本前缀**，不是猜的：
 *   · 提问 = ai-player.js askTurn 的 `❓ 我想问 X：…`
 *   · 投票 = ai-player.js actVote 的 `🤖 我投票给 X`
 *   · 兜底 = ai-player.js speakTurn 在 LLM 没给稿子时的 `🤖 ` 模板发言（⚠️ 必须放在投票之后判，
 *            因为投票也用这个前缀；顺序反了会把投票算成发言）
 *   · 其余 = 发言（LLM 稿子 / AI 被点名后的回答 / 真人玩家的话 —— 三者在公屏上无法区分，
 *            所以都计入"发言"，不硬拆） */
export function classifyChat(body) {
  const t = String(body == null ? "" : body);
  if (/^❓\s*我想问/.test(t)) return "asked";
  if (/^🤖\s*我投票给/.test(t)) return "voted";
  if (/^🤖\s/.test(t)) return "fallback";
  return "spoke";
}

/** 公屏按 kind 聚合；chat 再按发言人拆。
 *  两条不变量（单测钉住）：
 *   · 四种 chat 分类之和 === chat.total（分类是对"每一条"的划分）
 *   · Σ各发言人 chat + chat.unnamed === chat.total（unnamed 是"解析不出名字"的子集，
 *     与四分类交叉，所以不参与上面那条相加 —— 它存在的意义是不让无名发言冒充某个角色） */
export function tallyStream(stream) {
  const list = Array.isArray(stream) ? stream : [];
  const byKind = {};
  const byName = {};
  const chat = { total: 0, spoke: 0, fallback: 0, asked: 0, voted: 0, unnamed: 0 };
  let total = 0;
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    total++;
    const kind = String(e.kind || "?");
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (kind !== "chat") continue;
    chat.total++;
    const raw = String(e.text == null ? "" : e.text);
    const i = raw.indexOf("：");
    const name = i > 0 ? raw.slice(0, i).trim() : "";
    const body = i > 0 ? raw.slice(i + 1) : raw;
    const bucket = classifyChat(body);
    chat[bucket]++;
    if (!name) { chat.unnamed++; continue; }
    if (!byName[name]) byName[name] = { name, talk: 0, fallback: 0, asked: 0, voted: 0, chat: 0 };
    const s = byName[name];
    s.chat++;
    if (bucket === "spoke") s.talk++;
    else if (bucket === "fallback") { s.fallback++; s.talk++; }   // 兜底发言也算"说了话"
    else s[bucket]++;
  }
  const preferred = ["chat", "phase", "narrative", "truth", "error", "aiError", "report"];
  const kinds = Object.entries(byKind)
    .map(([kind, n]) => ({ kind, n }))
    .sort((a, b) => {
      const ia = preferred.indexOf(a.kind), ib = preferred.indexOf(b.kind);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return b.n - a.n;
    });
  const speakers = Object.values(byName).sort((a, b) => b.chat - a.chat || a.name.localeCompare(b.name, "zh"));
  return { total, byKind, kinds, chat, speakers };
}

export const OUTCOME_TEXT = {
  true_accusation: "指认成功", wrong_accusation: "指认错误", tie: "票数平局", no_votes: "无人投票",
};

/**
 * 票型分布。`truth.votes` 的形状由服务端定了：**目标角色名 → 票数**（见 game-engine.tallyVotes）。
 * 平局时所有并列最高票都会标 isTop（这本身就是"AI 集体投错/分裂"的信号）。
 */
export function voteRows(truth) {
  const v = truth && truth.votes;
  const out = { hasVotes: false, rows: [], top: null, outcome: "", outcomeText: "", desc: "", detail: [] };
  if (!truth) return out;
  out.outcome = String(truth.outcome || "");
  out.outcomeText = OUTCOME_TEXT[truth.outcome] || String(truth.outcome || "");
  out.desc = String(truth.description || "");
  // 逐票理由（2026-10-22 用户要求）：服务端在 truth_revealed 里带 voteDetail，
  // 形如 [{voter, target, reason, isAI}]。这里原样透出，供界面回答"他为什么投这个人"。
  if (Array.isArray(truth.voteDetail)) {
    out.detail = truth.voteDetail
      .filter((d) => d && d.voter)
      .map((d) => ({
        voter: String(d.voter),
        target: String(d.target || ""),
        reason: String(d.reason || "").trim(),
        // 依据线索编号（2026-10-22）：valid=真实存在，invalid=模型编的
        basis: Array.isArray(d.basis) ? d.basis.map(String) : [],
        invalidBasis: Array.isArray(d.invalidBasis) ? d.invalidBasis.map(String) : [],
        isAI: !!d.isAI,
      }))
      .sort((a, b) => String(a.voter).localeCompare(String(b.voter), "zh"));
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const rows = Object.entries(v)
    .filter(([, n]) => typeof n === "number" && Number.isFinite(n))
    .map(([name, n]) => ({ name, count: n, isMurderer: !!(truth.murdererName && name === truth.murdererName) }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), "zh"));
  const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 0;
  out.rows = rows.map((r) => ({ ...r, isTop: max > 0 && r.count === max }));
  out.top = rows.length ? rows[0].name : null;
  out.hasVotes = rows.length > 0;
  return out;
}

/**
 * 从角色剧本正文里取"与死者的关系"。
 * 角色剧本有三种形态（见 templates/murder-mystery/character.js）：
 *   · NPC 目击者/嫌疑人 → 有独立小节「一、人物关系」
 *   · 单人侦探 → 有独立小节「二、你与死者的关系」
 *   · PVP 玩家 → **没有**独立小节（关系揉在第一人称背景故事里）
 * 所以这里取不到就返回空串，由调用方显示"剧本里没有独立的关系小节"，
 * 绝不编一段关系出来 —— 名册一旦掺假，管理员对着它查剧本就是白查。
 */
export function relationText(script, maxLen) {
  const lines = String(script == null ? "" : script).split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s*(.+?)\s*$/);
    if (!h) continue;
    const title = h[2];
    // 「关系图」是全局设定集小节，不是"这个角色与死者的关系"，必须排除
    if (/关系/.test(title) && !/关系图/.test(title) && !/时间线/.test(title)) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return "";
  const buf = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    buf.push(lines[i]);
  }
  const text = buf.join(" ")
    .replace(/\*\*/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")          // 图片行不是关系文字
    .replace(/^[\s\-*+•\d.、)（(]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const cap = Number(maxLen) > 0 ? Number(maxLen) : 120;
  return text.length > cap ? text.slice(0, cap) + "…" : text;
}
