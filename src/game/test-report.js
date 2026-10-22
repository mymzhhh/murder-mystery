// 测试报告：把一局的观测数据变成**可判定**的结论（纯函数，不碰 IO）。
//
// 存在的理由：以前"测试剧本"只能靠人盯着看，看完就没了 —— 没人看的那一局什么也没留下。
// 这里把该记的记下来，并且把"能不能下结论"和"下了什么结论"分清楚：
//
//   机制依据（重要）：AI 会一直搜证到**本轮线索池为空**才停（见 ai-player 的 actInvestigate）。
//   所以某一轮**已搜空**时仍然没被发现的线索，是"搜遍全场也没找到"——
//   很可能这条线索不可达（生成缺陷），这才是值得回查的信号。
//   反过来，某一轮**没搜完**（阶段先结束了）时，没搜到不能说明任何问题，
//   此时结论必须是"不确定"，而不是"线索有问题"。

const { determineOutcome } = require("./game-engine");

const VERDICTS = {
  issue: { text: "发现疑似问题", color: "danger" },
  inconclusive: { text: "结论不确定（阶段没跑满）", color: "warning" },
  clean: { text: "未发现问题", color: "success" },
};

const roundOf = (c) => Number(c.round) || 0;
const isFound = (c) => Array.isArray(c.foundBy) ? c.foundBy.length > 0 : !!c.found;

/**
 * @param {object} input
 * @param {string} input.roomCode
 * @param {string} input.title 剧本标题
 * @param {string} input.scriptSessionId
 * @param {number} input.startedAt
 * @param {number} input.endedAt
 * @param {number} input.phaseMinutes 管理员设的阶段时长（分钟）
 * @param {Array}  input.phases [{phase, at, durMs}] 阶段流水
 * @param {Array}  input.clues 房间的全部线索（带 foundBy）
 * @param {Array}  input.aiNames 本局应出手的 AI 角色名
 * @param {object} input.turns "赛场统计"（ai-observability.readTurns 的输出）
 * @param {Array}  input.errors AI 异常（ai-observability.readErrors 的输出）
 * @param {object} input.votes 票型 { playerName: targetCharacterName }
 * @param {string} input.murdererName
 * @param {boolean} input.truthRevealed
 * @param {string} input.reason "completed"（跑到真相）| "stopped"（管理员结束）| "recovered"（重启后收尾）
 * @param {boolean} [input.aiIsNpc] 该角色是 NPC 时不计入"零出手"判定
 * @returns {object} 报告（可直接存库/直接渲染）
 */
function buildTestReport(input) {
  const {
    roomCode = "", title = "", scriptSessionId = "",
    startedAt = 0, endedAt = Date.now(), phaseMinutes = 0,
    phases = [], clues = [], aiNames = [], turns = {}, errors = [],
    votes = {}, murdererName = "", truthRevealed = false, reason = "completed",
  } = input || {};

  const rounds = {};
  for (const c of clues) {
    const r = roundOf(c);
    if (!r) continue;
    if (!rounds[r]) rounds[r] = { round: r, pool: 0, found: 0, unfound: [] };
    rounds[r].pool++;
    if (isFound(c)) rounds[r].found++;
    else rounds[r].unfound.push({ id: c.id, location: c.location || "", content: String(c.content || "").slice(0, 80) });
  }
  const roundList = Object.values(rounds).sort((a, b) => a.round - b.round);
  for (const r of roundList) r.swept = r.pool > 0 && r.found === r.pool;

  // 只在"已搜空"的轮次里把未发现线索升级为"很可能不可达"
  const unreachable = roundList.filter(r => r.swept).flatMap(r => r.unfound.map(u => ({ ...u, round: r.round })));
  const notSwept = roundList.filter(r => !r.swept).map(r => r.round);
  const incompleteSweep = notSwept.length > 0;

  const ai = aiNames.map((name) => {
    const t = turns[name] || {};
    return {
      // ⚠️ 每个动作都必须带**键名**：漏掉 `search:` 只是少一个字段，但写成 `t.search || 0`
      // 会让整个文件变成语法错误 → 测试报告整条路径全废（这个错就是这么进来的：当时只跑了单个测试文件）。
      name, intro: t.intro || 0, speak: t.speak || 0, ask: t.ask || 0, vote: t.vote || 0, search: t.search || 0, total: t.total || 0,
    };
  });
  // 只有真的进过搜证轮才谈"零出手"：停在 reading 的那局谁都没说话，不算异常
  const reachedPlay = roundList.length > 0 || phases.some(p => /^round/.test(p.phase || ""));
  const errorNames = new Set(errors.map(e => e.name));
  const silentAi = reachedPlay ? ai.filter(a => a.total === 0).map(a => a.name) : [];
  const silentWithErrors = silentAi.filter(n => errorNames.has(n));
  const silentClean = silentAi.filter(n => !errorNames.has(n));

  // 结局用游戏自己的判定函数重算（同一个口径，不另立一套）
  const outcome = determineOutcome(votes, murdererName);

  // 票型给人看：按被投对象汇总 + "谁投了谁"。
  // ⚠️ votes 的键是 **playerId**（如 ai_E7Y3TK_何秀云），直接丢给管理员看毫无意义 ——
  // 要换成角色名。映射由调用方给（它手上有 players）。
  const voters = input.voters || {};
  // 投票理由（2026-10-22 用户要求）：管理员要能回答"每个 AI 为什么投给这个人"。
  // 键同样是 playerId，报告里换成角色名一起展示。
  const voteReasons = input.voteReasons || {};
  const tally = {};
  for (const target of Object.values(votes)) tally[target] = (tally[target] || 0) + 1;
  const byVoter = Object.entries(votes).map(([pid, target]) => ({
    voter: voters[pid] || pid,
    target,
    reason: String(voteReasons[pid] || "").trim(),
  }));

  const findings = [];
  for (const u of unreachable) {
    findings.push({
      level: "error", code: "unreachable_clue",
      text: `第 ${u.round} 轮已搜空，但线索 ${u.id}（${u.location}）没人搜到 —— 很可能不可达，建议回查生成结果`,
    });
  }
  for (const n of silentClean) {
    findings.push({ level: "error", code: "silent_ai", text: `AI「${n}」整局一次手都没出（该轮已搜空，说明不是没轮到）` });
  }
  for (const n of silentWithErrors) {
    findings.push({ level: "warn", code: "silent_ai_with_errors", text: `AI「${n}」整局没出手，但它有 AI 异常记录 —— 可能是异常导致，未必是剧本问题` });
  }
  if (incompleteSweep) {
    findings.push({
      level: "warn", code: "incomplete_sweep",
      text: `第 ${notSwept.join("、")} 轮没搜完（阶段先结束了）—— 这些轮次里"没搜到"不能说明线索有问题，把阶段调长再测一次才能定论`,
    });
  }
  if (errors.length) {
    findings.push({ level: "warn", code: "ai_errors", text: `AI 异常 ${errors.length} 次（最近：${errors[0].name || "?"} ${errors[0].kind || "?"} ${String(errors[0].message || "").slice(0, 60)}）` });
  }
  if (reason !== "completed") {
    findings.push({ level: "info", code: "partial_run", text: reason === "stopped" ? "本局被管理员提前结束，结论只覆盖已跑完的阶段" : "本局在服务重启后收尾，结论只覆盖已跑完的阶段" });
  }
  findings.push({
    level: "info", code: "voting",
    text: `投票结局：${outcome.description}${truthRevealed ? "" : "（未到真相阶段）"}`,
  });

  const hasError = findings.some(f => f.level === "error");
  const verdict = hasError ? "issue" : (incompleteSweep ? "inconclusive" : "clean");

  return {
    roomCode, title, scriptSessionId,
    startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt), phaseMinutes,
    phases, reason,
    rounds: roundList.map(r => ({ round: r.round, pool: r.pool, found: r.found, swept: r.swept })),
    unreachable, notSwept, incompleteSweep,
    clueTotal: clues.length,
    clueFound: clues.filter(isFound).length,
    ai, silentAi, hasErrors: errors.length > 0, errorCount: errors.length, errors: errors.slice(0, 10),
    voting: {
      votes, tally, byVoter, murdererName,
      outcome: outcome.outcome, outcomeText: outcome.description,
      accusedCorrectly: outcome.outcome === "true_accusation",
    },
    truthRevealed,
    findings,
    verdict, verdictText: (VERDICTS[verdict] || VERDICTS.inconclusive).text,
  };
}

module.exports = { buildTestReport, VERDICTS };
