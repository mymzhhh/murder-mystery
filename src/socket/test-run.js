// 管理端「测试剧本」：所有玩家位由 AI 扮演，管理员只旁观。
//
// 为什么不复用 socket 层的 start_game：
//  1) `start_game` 有"至少 1 名真人"的门禁（那是防误开空局的保证）。测试房没有真人，
//     但**不该为了测试去放宽一条对真人局的保证**——所以这里走一条独立链路。
//  2) 真人局的节奏是"每人每 5 分钟一次机会 + 阶段兜底 10 分钟"，跑完一局 40 分钟以上，
//     测试太慢。测试房用压缩节奏（`TEST_PHASE_MS`/`TEST_TURN_CYCLE_MS`，在 game/ai-player 里）。
//     ⚠️ 压缩的**只是节奏参数**：阶段机、回合链、AI 出手逻辑全都是同一套，
//     所以测出来的问题是真的（这一点很重要，否则测试房就成了"另一套系统"）。
//
// 推进用的也是真实推进逻辑（socket/ai-dm 的 autoAdvancePhase）：它会清 ready、
// 切阶段、生成 DM 叙事、并在真相阶段前给所有未投票的 AI 补投——全 AI 局正好靠它走完投票。
//
// ── 登记放 Redis（不是内存）────────────────────────────────────────────
// 第一版把测试局登记放在模块内存里，于是**每次容器重建，在跑的测试局就失去推进计时器、
// 管理端也回读不到**，房号变成要手工收拾的孤儿（实测撞了三次）。
// 现在登记在 `game:{code}:testmeta`：重启后管理端仍能看见这些局，
// 而且进程起来时会**接着推进**它们（见 resumeTestRuns）。
// 计时器本身只能是进程内的（setTimeout 没法持久化），所以重启后靠"剩余时间"重装。

const { getRoom, updateRoom, getPlayers, addPlayer, updatePlayer, deleteRoom, getClues, getVotes, getRedis } = require("../game/game-manager");
const { scanKeys } = require("../core/redis-client");
const { getNextPhase } = require("../game/game-engine");
const { createGameRoom } = require("../game/game-room-creator");
const { syncAiFillers, scheduleRoom, TEST_PHASE_MS, TEST_TURN_CYCLE_MS } = require("../game/ai-player");
const { autoAdvancePhase } = require("./ai-dm");
const { readTurns, readErrors } = require("../game/ai-observability");
const { buildTestReport } = require("../game/test-report");
const { insertTestReport } = require("../core/test-report-repo");

/** 房间 → 推进计时器（只能是进程内的：setTimeout 无法持久化） */
const testTimers = {};

const metaKey = (code) => `game:${code}:testmeta`;

/** 阶段时长夹取：下限 1 分钟（比这更短连自我介绍都发不完），上限 60 分钟（防手滑填 10000） */
const PHASE_MIN_MINUTES = 1;
const PHASE_MAX_MINUTES = 60;

/** 测试房的 reading 阶段只需要很短：它存在的唯一目的是让 AI 把自我介绍预先写好
 *  （真人局里玩家在读本，测试房没有真人，读本这一步没人需要）。
 *  第一版让 reading 也吃满一个完整阶段（默认 4 分钟），等于每局白等 4 分钟——
 *  实测就是"开了 4 分钟还一条线索都没搜到"（搜证要等 round1 才开始）。 */
const TEST_READING_MS = Math.max(10 * 1000, (Number(process.env.TEST_RUN_READING_SEC || 30) || 30) * 1000);

function clearTestTimer(roomCode) {
  if (testTimers[roomCode]) { clearTimeout(testTimers[roomCode]); delete testTimers[roomCode]; }
}

/** 读登记（Redis 里的都是字符串，这里统一转成好用的类型） */
async function readMeta(roomCode) {
  try {
    const r = await getRedis();
    const raw = await r.hgetall(metaKey(roomCode));
    if (!raw || !raw.scriptSessionId) return null;
    let phaseLog = [];
    try { phaseLog = JSON.parse(raw.phaseLog || "[]"); } catch (e) { phaseLog = []; }
    return {
      roomCode,
      scriptSessionId: raw.scriptSessionId,
      title: raw.title || "",
      phaseMs: Number(raw.phaseMs) || TEST_PHASE_MS,
      turnCycleMs: Number(raw.turnCycleMs) || TEST_TURN_CYCLE_MS,
      startedAt: Number(raw.startedAt) || 0,
      finished: raw.finished === "1" || raw.finished === "true",
      phase: raw.phase || "reading",
      phaseLog,
      reportId: raw.reportId ? Number(raw.reportId) : null,
      reason: raw.reason || "",
    };
  } catch (e) { return null; }
}

/** 写登记（部分字段） */
async function patchMeta(roomCode, patch) {
  try {
    const r = await getRedis();
    const flat = {};
    for (const [k, v] of Object.entries(patch || {})) {
      flat[k] = (k === "finished") ? (v ? "1" : "0") : (typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    if (Object.keys(flat).length) await r.hset(metaKey(roomCode), flat);
  } catch (e) { /* 写不进去不影响这一局的推进，只是重启后恢复不了 */ }
}

/** 停掉一局（清计时器 + 清登记）。房间本身由调用方决定删不删。 */
async function stopTestRun(roomCode) {
  clearTestTimer(roomCode);
  try {
    const r = await getRedis();
    await r.del(metaKey(roomCode));
  } catch (e) { /* 忽略 */ }
}

/** 已登记的测试房（在跑或已跑完、房间仍在）。**读 Redis**，所以重启后仍能看见。 */
async function listTestRuns() {
  let keys = [];
  try { keys = await scanKeys("game:*:testmeta"); } catch (e) { return []; }
  const out = [];
  for (const k of keys) {
    const m = k.match(/^game:([A-Z0-9]{6}):testmeta$/);
    if (!m) continue;
    const meta = await readMeta(m[1]);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/**
 * 装下一阶段的推进计时器（压缩节奏：到点就推进，不等真人点准备）。
 * @param {number} waitMs 等多久推进。调用方算好（正常路径 = 阶段时长 + 3 秒余量；
 *                        重启恢复 = 阶段剩余时间）—— 这里只负责一件事：到点调推进。
 */
function armTestTimer(io, roomCode, waitMs) {
  clearTestTimer(roomCode);
  const delay = Math.max(5000, Number(waitMs) || 0);
  testTimers[roomCode] = setTimeout(async () => {
    try {
      const meta = await readMeta(roomCode);
      if (!meta || meta.finished) { clearTestTimer(roomCode); return; }
      await advanceTestRun(io, roomCode, meta.phase === "reading" ? TEST_READING_MS : meta.phaseMs);
    } catch (e) {
      console.warn("[test-run] 推进失败:", e.message);
    }
  }, delay);
  if (testTimers[roomCode].unref) testTimers[roomCode].unref();
}

/**
 * 生成这一局的报告并存库。
 * 幂等：已经存过（meta.reportId 有值）就不再存第二份。
 */
async function finishTestRun(roomCode, reason, io) {
  const meta = await readMeta(roomCode);
  if (!meta) return null;
  if (meta.reportId) return meta.reportId;

  const room = await getRoom(roomCode).catch(() => null);
  const [clues, votes, players, turns, errors, voteReasons] = await Promise.all([
    getClues(roomCode).catch(() => []),
    getVotes(roomCode).catch(() => ({})),
    getPlayers(roomCode).catch(() => []),
    readTurns(roomCode),
    readErrors(roomCode),
    // 投票理由（2026-10-22 用户要求）：报告里要能回答"每个 AI 为什么投给这个人"
    (require("../game/game-manager").getVoteReasons(roomCode) || Promise.resolve({})).catch(() => ({})),
  ]);
  const aiNames = (players || []).filter(p => p.isAI && p.characterName).map(p => p.characterName);
  // playerId → 角色名：报告里的票型要按角色名显示（ai_E7Y3TK_何秀云 这种内部 id 对管理员没有意义）
  const voters = {};
  for (const p of (players || [])) voters[p.playerId] = p.characterName || p.playerName || p.playerId;
  const endedAt = Date.now();
  const report = buildTestReport({
    roomCode,
    title: meta.title,
    scriptSessionId: meta.scriptSessionId,
    startedAt: meta.startedAt || endedAt,
    endedAt,
    phaseMinutes: meta.phaseMs / 60000,
    phases: meta.phaseLog,
    clues: clues || [],
    aiNames,
    turns,
    errors,
    votes: votes || {},
    voters,
    voteReasons,
    murdererName: (room && room.murdererName) || "",
    truthRevealed: !!(room && /truth_reveal|finished/.test(room.phase || "")),
    reason,
  });
  const id = await insertTestReport(report);
  await patchMeta(roomCode, { finished: true, reason, reportId: id || "" });
  console.log(`[test-run] ${roomCode} 报告已生成（${reason}，verdict=${report.verdict}${id ? "，id=" + id : "，入库失败"}）`);
  if (io) io.to(roomCode).emit("test_report_ready", { roomCode, reportId: id, verdict: report.verdict, verdictText: report.verdictText });
  return id;
}

/** 推进到下一阶段；到真相揭晓/结束后不再排下一次 */
async function advanceTestRun(io, roomCode, waitMsUsed) {
  const room = await getRoom(roomCode);
  const meta = await readMeta(roomCode);
  if (!room || !room.testRun || !meta) { await stopTestRun(roomCode); return; }
  if (meta.finished) { clearTestTimer(roomCode); return; }
  const next = getNextPhase(room.phase);
  if (!next) { await finishTestRun(roomCode, "completed", io); clearTestTimer(roomCode); return; }
  const parsed = JSON.parse(room.parsedScript || "{}");

  // ⚠️ 要说**这个房间实际用的**阶段时长，而不是常量 —— 管理员可以按请求覆盖它。
  // 第一版写死了 TEST_PHASE_MS，于是设成 1 分钟的测试局里，DM 提示却说"4 分钟到"。
  const isReading = room.phase === "reading";
  const secs = Math.round((waitMsUsed || (isReading ? TEST_READING_MS : meta.phaseMs)) / 1000);
  io.to(roomCode).emit("narrative", {
    text: isReading
      ? `⏱（测试模式）阅读阶段只留 ${secs} 秒（没有真人要读本，AI 只在这里预备自我介绍），准备进入下一阶段。`
      : `⏱（测试模式）本阶段 ${Math.round(secs / 60)} 分钟已到，自动进入下一阶段。`,
  });
  await autoAdvancePhase(io, roomCode, parsed, "");
  scheduleRoom(io, roomCode, next);

  // 测试房的搜证由**代码**扫完（见 game/auto-search）：不占 AI 回合，AI 的回合全给发言/提问/投票。
  // 放在阶段推进之后：这时 room.phase 已经是新一轮，getPhaseRound 才取得到轮次。
  // ⚠️ 这条日志无条件打：实测排查"代码搜证没生效"时，最怕的就是"两个分支都没打日志、
  //    只能反推到底走没走到这里"。阶段流水本身也值得留痕（报告里要看每阶段实际多长）。
  console.log(`[test-run] ${roomCode} 阶段推进：${room.phase} → ${next}${/^round/.test(next) ? "（搜证轮，交给代码搜证）" : ""}`);
  if (next && /^round/.test(next)) {
    try {
      const r = await require("../game/auto-search").sweepRound(io, roomCode);
      if (r.found) io.to(roomCode).emit("narrative", { text: `🔎（测试模式）代码搜证：第 ${r.round} 轮已搜出全部线索（本轮 ${r.found} 条）。AI 接下来只做讨论与投票。` });
    } catch (e) { console.warn(`[test-run] ${roomCode} 代码搜证失败（不影响推进）:`, e.message); }
  }

  // 阶段流水进登记（报告里要看每个阶段实际花了多久）
  const phaseLog = meta.phaseLog.concat([{ phase: next, at: Date.now() }]);
  await patchMeta(roomCode, { phase: next, phaseLog });

  if (next === "truth_reveal" || next === "finished") {
    // 测试跑完：**保留房间**，让管理员还能回看公屏与真相；只停掉计时器
    clearTestTimer(roomCode);
    await finishTestRun(roomCode, "completed", io);
    console.log(`[test-run] ${roomCode} 测试结束（phase=${next}）`);
    return;
  }
  armTestTimer(io, roomCode, (next === "reading" ? TEST_READING_MS : meta.phaseMs) + 3000);
}

/**
 * 开一局测试：建房 → 全 AI 补位 → 进入 reading → 按压缩节奏自动推进
 * @param {object} io socket.io server
 * @param {string} scriptSessionId 剧本会话 id（= 切分后的剧本 id）
 * @param {object} [opts] {phaseMinutes, maxPlayers}
 * @returns {Promise<{roomCode, title, characters, phaseMs, turnCycleMs}>}
 */
async function startTestRun(io, scriptSessionId, opts) {
  const o = opts || {};
  const created = await createGameRoom(scriptSessionId, o.maxPlayers);

  // 测试房**不进公开房间列表**：房号不是秘密（/api/player/rooms 会把开放房间列给任何登录用户），
  // 一旦被真人闯进来，"全 AI 对局"就不成立了，他的 ready 还会把推进押着走。
  // （真人局开局时也会 srem，但那是"开局后"；测试房要在第一秒就摘掉，否则存在几秒的窗口。）
  try {
    const r = await getRedis();
    await r.srem("rooms:open", created.roomCode);
  } catch (e) { /* Redis 不可用不阻塞 */ }

  // ⚠️ 夹取阶段时长：下限 1 分钟（更短连自我介绍都发不完），上限 60 分钟。
  // 第一版只夹了下限，手滑填 10000 就是一局 8 天。
  const wantMin = Number(o.phaseMinutes) || 0;
  const mins = wantMin > 0 ? Math.min(PHASE_MAX_MINUTES, Math.max(PHASE_MIN_MINUTES, wantMin)) : TEST_PHASE_MS / 60000;
  const phaseMs = Math.round(mins * 60 * 1000);
  const startedAt = Date.now();
  await patchMeta(created.roomCode, {
    scriptSessionId, title: created.title || "", phaseMs, turnCycleMs: TEST_TURN_CYCLE_MS,
    startedAt, finished: false, phase: "reading",
    phaseLog: [{ phase: "reading", at: startedAt }],
  });
  await updateRoom(created.roomCode, { testRun: true, status: "playing", phase: "lobby" });

  const room = await getRoom(created.roomCode);
  const parsed = JSON.parse(room.parsedScript || "{}");

  // 审讯 NPC 以虚拟玩家身份入场（与真人局一致，否则 DM 手册里的 NPC 没人扮演）
  const npcChars = (parsed.characters || []).filter(c => c.roleType === "npc");
  for (let i = 0; i < npcChars.length; i++) {
    const npc = npcChars[i];
    const npcId = "npc_" + created.roomCode + "_" + i;
    await addPlayer(created.roomCode, npcId, "NPC:" + npc.name, false);
    await updatePlayer(created.roomCode, npcId, {
      characterName: npc.name, characterScript: JSON.stringify(npc), isNPC: true,
    });
  }
  // 关键一步：0 真人时 syncAiFillers 会把**所有**玩家槽位补成 AI（语义就是"没被真人选的都归 AI"）
  await syncAiFillers(created.roomCode);

  await updateRoom(created.roomCode, { phase: "reading", phaseStartedAt: Date.now(), aiNarrative: "" });
  io.to(created.roomCode).emit("game_started", { phase: "reading", narrative: "（测试模式）AI DM 正在准备开场叙事…" });
  io.to(created.roomCode).emit("phase_changed", { phase: "reading", label: "阅读剧本", narrative: "（测试模式）" });

  scheduleRoom(io, created.roomCode, "reading");
  armTestTimer(io, created.roomCode, TEST_READING_MS + 3000);   // 余量：让最后一个 AI 回合落定

  const players = await getPlayers(created.roomCode);
  console.log(`[test-run] ${created.roomCode} 开测《${created.title}》：${players.filter(p => p.isAI).length} 个 AI 玩家、${npcChars.length} 个 NPC，阶段 ${mins} 分钟`);
  return {
    roomCode: created.roomCode,
    title: created.title,
    characters: created.characters,
    phase: "reading",
    phaseMinutes: mins,
    turnCycleSec: TEST_TURN_CYCLE_MS / 1000,
    aiPlayers: players.filter(p => p.isAI).map(p => p.characterName),
  };
}

/** 关闭测试房（管理员点"结束"）：先落报告，再停计时器 + 删房间 */
async function closeTestRun(io, roomCode) {
  const meta = await readMeta(roomCode);
  if (meta && !meta.finished) await finishTestRun(roomCode, "stopped", io);
  clearTestTimer(roomCode);
  try {
    const r = await getRedis();
    await r.srem("rooms:open", roomCode);
  } catch (e) { /* 忽略 */ }
  await deleteRoom(roomCode).catch(() => {});
  await stopTestRun(roomCode);
  if (io) io.to(roomCode).emit("game_ended", { message: "测试已结束，房间已关闭（报告已保存）" });
}

/**
 * 进程启动后把还在跑的测试局接上。
 *
 * 为什么需要：计时器是进程内的，重启后全丢；而登记在 Redis 里还在，
 * 于是"测试房还在、但永远不会推进"——管理员看到的就是卡住的一局。
 * 这里按**剩余时间**重装计时器，并重建 AI 调度（回合链同样随重启丢了）。
 */
async function resumeTestRuns(io) {
  let runs = [];
  try { runs = await listTestRuns(); } catch (e) { return 0; }
  let resumed = 0;
  for (const meta of runs) {
    const room = await getRoom(meta.roomCode).catch(() => null);
    if (!room) { await stopTestRun(meta.roomCode); continue; }             // 房间被回收了，登记也清掉
    if (!room.testRun) { await stopTestRun(meta.roomCode); continue; }     // 不是测试房了
    if (meta.finished) continue;                                          // 已跑完：留房间供回看，不再推进
    const full = room.phase === "reading" ? TEST_READING_MS : meta.phaseMs;
    const elapsed = Date.now() - (Number(room.phaseStartedAt) || Date.now());
    const remain = Math.max(10 * 1000, full - Math.max(0, elapsed));
    scheduleRoom(io, meta.roomCode, room.phase);
    // 重启后如果正停在搜证轮，补一次代码搜证（否则这一轮回合的线索要靠 AI 出手才有人搜）
    if (/^round/.test(room.phase)) {
      try { await require("../game/auto-search").sweepRound(io, meta.roomCode); }
      catch (e) { console.warn(`[test-run] ${meta.roomCode} 恢复后代码搜证失败:`, e.message); }
    }
    armTestTimer(io, meta.roomCode, remain);
    resumed++;
    console.log(`[test-run] 重启后接着推进 ${meta.roomCode}（${room.phase}，剩余 ${Math.round(remain / 1000)} 秒）`);
  }
  if (resumed) console.log(`[test-run] 已恢复 ${resumed} 局测试`);
  return resumed;
}

// 房间被删（生命周期回收 / 管理端删除）时释放本模块的内存态
try {
  require("../game/room-cleanup-hooks").onRoomDeleted((code) => { clearTestTimer(code); });
} catch (e) { /* 钩子不可用时不影响主流程 */ }

module.exports = {
  startTestRun, advanceTestRun, stopTestRun, closeTestRun, listTestRuns, clearTestTimer,
  finishTestRun, resumeTestRuns, readMeta, TEST_READING_MS, PHASE_MIN_MINUTES, PHASE_MAX_MINUTES,
};
