// AI 发言/提问的顺序：座位序 + 严格轮流
//
// 背景（用户反馈）：多位 AI 会"同时"发言/提问——公屏上几条 AI 消息挤在一起、
// 或几个 AI 一起向同一目标发问。原因有两层：
//   ① 调度侧原来给每个 AI 各算一个**随机延迟**（发言 3–11s），窗口高度重叠；
//   ② **只错开时刻不够**：LLM 闸门 MAX_CONCURRENCY=6 是并发的，生成快的 AI 会后发先至，
//      消息落地顺序并不由预约时刻决定。
// 改成"座位序 + 严格轮流"后，这里钉住三条性质：
//   顺序来自剧本角色顺序（不是 getPlayers 的 Redis SCAN 顺序）、
//   回合序列是"先自我介绍 → 再逐个发言 → 最后逐个提问"、
//   回合链**严格串行**且阶段一变就放弃剩余回合。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const { orderAiPlayers, buildTurnPlan, runTurnChain, makeTurnWaiter, TURN_CYCLE_MS, MAX_TURNS_PER_ROUND, TEST_TURN_CYCLE_MS, TEST_PHASE_MS } = require("../../src/game/ai-player");
const { PHASE_DEADLINE_MS } = require("../../src/game/game-engine");

// 剧本角色顺序（"玩家角色 1/2/3…"）
const CHARS = [
  { name: "李长贵", roleType: "player" },
  { name: "吴秀兰", roleType: "player" },
  { name: "郑国维", roleType: "player" },
  { name: "冯玉娥", roleType: "player" },
];
const ai = (name, id) => ({ playerId: id || name, characterName: name, isAI: true });

// ==================== orderAiPlayers ====================

test("orderAiPlayers：按剧本角色顺序排（与入参顺序无关）", () => {
  const shuffled = [ai("冯玉娥"), ai("李长贵"), ai("郑国维")];
  assert.deepStrictEqual(orderAiPlayers(shuffled, CHARS).map(p => p.characterName), ["李长贵", "郑国维", "冯玉娥"]);
  // 换一个入参顺序，结果必须一致（这是"稳定顺序"的核心）
  const shuffled2 = [ai("郑国维"), ai("李长贵"), ai("冯玉娥")];
  assert.deepStrictEqual(orderAiPlayers(shuffled2, CHARS).map(p => p.characterName), ["李长贵", "郑国维", "冯玉娥"]);
});

test("orderAiPlayers：不在剧本里的角色排到最后，并按名字兜底（顺序可复现）", () => {
  const list = [ai("野角色B"), ai("吴秀兰"), ai("野角色A")];
  const got = orderAiPlayers(list, CHARS).map(p => p.characterName);
  assert.deepStrictEqual(got, ["吴秀兰", "野角色A", "野角色B"]);
});

test("orderAiPlayers：同角色名（异常数据）按 playerId 兜底，不会乱序", () => {
  const list = [ai("李长贵", "p2"), ai("李长贵", "p1")];
  assert.deepStrictEqual(orderAiPlayers(list, CHARS).map(p => p.playerId), ["p1", "p2"]);
});

test("orderAiPlayers：不改动入参，且空/缺失输入安全", () => {
  const input = [ai("冯玉娥"), ai("李长贵")];
  const snapshot = input.map(p => p.characterName);
  orderAiPlayers(input, CHARS);
  assert.deepStrictEqual(input.map(p => p.characterName), snapshot, "不能就地排序（会污染调用方的数组）");
  assert.deepStrictEqual(orderAiPlayers([], CHARS), []);
  assert.deepStrictEqual(orderAiPlayers(null, null), []);
  assert.deepStrictEqual(orderAiPlayers([ai("甲")], null).map(p => p.characterName), ["甲"], "没有剧本角色表也不该炸");
});

// ==================== buildTurnPlan ====================

// 节奏：用户要求"每 5 分钟有一次发言或提问的机会"，并且每人每轮最多 5 次。
// 计划由**阶段时长**推出来：floor(阶段时长/周期) 轮，每轮每人一次机会。
const CYCLE = 5 * 60 * 1000;
const PHASE = 10 * 60 * 1000;

test("buildTurnPlan：第一轮 = 开场白 + 出手轮转，且每人每 5 分钟一次机会", () => {
  const ordered = orderAiPlayers([ai("李长贵"), ai("吴秀兰"), ai("郑国维"), ai("冯玉娥")], CHARS);
  const plan = buildTurnPlan(ordered, "round1", { cycleMs: CYCLE, phaseMs: PHASE });
  assert.deepStrictEqual(plan.filter(t => t.kind === "intro").map(t => t.ai.characterName),
    ["李长贵", "吴秀兰", "郑国维", "冯玉娥"], "第一轮先按座位序做开场白");

  const turns = plan.filter(t => t.kind === "turn");
  // 阶段 10 分钟 / 周期 5 分钟 = 2 轮 → 4 人 × 2 = 8 次出手
  assert.strictEqual(turns.length, 8);
  const per = {};
  for (const t of turns) per[t.ai.characterName] = (per[t.ai.characterName] || 0) + 1;
  assert.deepStrictEqual(per, { 李长贵: 2, 吴秀兰: 2, 郑国维: 2, 冯玉娥: 2 }, "每人每周期一次");
  // 轮转顺序仍是座位序
  assert.deepStrictEqual(turns.map(t => t.ai.characterName),
    ["李长贵", "吴秀兰", "郑国维", "冯玉娥", "李长贵", "吴秀兰", "郑国维", "冯玉娥"]);
  // 相邻两次出手的间隔 = 周期 / 人数（4 人 → 75 秒一条，整轮都有动静）
  assert.strictEqual(turns[0].delayMs, 75000);
  // 同一个人两次机会之间正好隔着一整轮（4 次出手 = 一个周期）
  assert.strictEqual(turns.map(t => t.ai.characterName).indexOf("李长贵", 1), 4);
});

test("buildTurnPlan：每人每轮最多 5 次（用户指定的兜底上限）", () => {
  const ordered = orderAiPlayers([ai("李长贵"), ai("吴秀兰")], CHARS);
  // 阶段 60 分钟 / 周期 5 分钟 = 12 轮 → 被上限截到 5 轮
  const plan = buildTurnPlan(ordered, "round2", { cycleMs: CYCLE, phaseMs: 60 * 60 * 1000, maxPerRound: 5 });
  const turns = plan.filter(t => t.kind === "turn");
  assert.strictEqual(turns.length, 10, "2 人 × 5 次");
  const per = {};
  for (const t of turns) per[t.ai.characterName] = (per[t.ai.characterName] || 0) + 1;
  assert.deepStrictEqual(per, { 李长贵: 5, 吴秀兰: 5 }, "上限必须真的截住（否则长阶段会无限说）");
});

test("buildTurnPlan：只有 1 个 AI 时，出手间隔就是一个完整周期", () => {
  const plan = buildTurnPlan([ai("李长贵")], "round2", { cycleMs: CYCLE, phaseMs: PHASE });
  const turns = plan.filter(t => t.kind === "turn");
  assert.strictEqual(turns.length, 2, "10 分钟 / 5 分钟 = 2 次机会");
  assert.strictEqual(turns[0].delayMs, CYCLE, "一个人的时候，机会间隔就是 5 分钟");
  assert.deepStrictEqual(plan.filter(t => t.kind === "intro"), [], "第二轮没有开场白");
});

// 自我介绍只在第一轮发一遍：原来 `round > 0` 就发，于是 round2 又念一遍，
// 而 publishIntro 发完会清掉预备内容 → 第二轮那几条是**现场重新生成**的
// （实测 5 个 AI 多花 33 秒 + 5 次 LLM 调用），公屏上还重复同一段自我介绍。
test("buildTurnPlan：自我介绍只在第一轮发一遍，第二轮不再发", () => {
  const ordered = orderAiPlayers([ai("李长贵"), ai("吴秀兰"), ai("郑国维")], CHARS);
  const r1 = buildTurnPlan(ordered, "round1", { cycleMs: CYCLE, phaseMs: PHASE });
  assert.deepStrictEqual(r1.filter(t => t.kind === "intro").map(t => t.ai.characterName),
    ["李长贵", "吴秀兰", "郑国维"], "第一轮要有自我介绍");

  const r2 = buildTurnPlan(ordered, "round2", { cycleMs: CYCLE, phaseMs: PHASE });
  assert.deepStrictEqual(r2.filter(t => t.kind === "intro"), [], "第二轮不该再发自我介绍");
  assert.deepStrictEqual([...new Set(r2.map(t => t.kind))], ["turn"], "第二轮只有出手轮转");
});

test("buildTurnPlan：阶段短于一个周期时，至少也给每人一次机会", () => {
  const ordered = orderAiPlayers([ai("李长贵"), ai("吴秀兰")], CHARS);
  // 2 分钟的阶段：floor(120/300) = 0 → 不能变成"一句话都不说"
  const plan = buildTurnPlan(ordered, "round2", { cycleMs: CYCLE, phaseMs: 2 * 60 * 1000 });
  const turns = plan.filter(t => t.kind === "turn");
  assert.strictEqual(turns.length, 2, "再短的阶段也要让每人有机会开口（否则玩家干等）");
});

test("buildTurnPlan：投票阶段按座位序逐个投；不接受回合的阶段返回空", () => {
  const ordered = orderAiPlayers([ai("冯玉娥"), ai("李长贵")], CHARS);
  const vote = buildTurnPlan(ordered, "voting");
  assert.deepStrictEqual(vote.map(t => t.kind), ["vote", "vote"]);
  assert.deepStrictEqual(vote.map(t => t.ai.characterName), ["李长贵", "冯玉娥"]);
  for (const phase of ["lobby", "reading", "intro", "truth_reveal", "finished"]) {
    assert.deepStrictEqual(buildTurnPlan(ordered, phase), [], `${phase} 不该排公屏回合`);
  }
  assert.deepStrictEqual(buildTurnPlan([], "round1"), []);
});

// ==================== runTurnChain ====================

test("runTurnChain：严格串行（任何两个回合都不重叠），且顺序与传入一致", async () => {
  let running = 0;
  const log = [];
  const turns = ["a", "b", "c"].map((k) => ({
    kind: k,
    run: async () => {
      assert.strictEqual(running, 0, `回合 ${k} 开始时不该有别的回合在跑（说明重叠了）`);
      running++;
      log.push(`start:${k}`);
      await new Promise((r) => setTimeout(r, 5));   // 模拟生成耗时
      log.push(`end:${k}`);
      running--;
    },
  }));
  const done = await runTurnChain(turns, { gapMs: 0 });
  assert.strictEqual(done, 3);
  assert.deepStrictEqual(log, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"], "必须是上一个结束之后下一个才开始");
});

test("runTurnChain：按 gapMs 留出呼吸间隔（相邻回合之间）", async () => {
  const slept = [];
  const turns = [1, 2, 3].map((k) => ({ kind: String(k), run: async () => {} }));
  await runTurnChain(turns, { gapMs: 2500, sleep: async (ms) => { slept.push(ms); } });
  assert.deepStrictEqual(slept, [2500, 2500], "3 个回合之间只应有 2 次间隔");
});

test("runTurnChain：阶段一变就放弃剩余回合（旧阶段的 AI 不能跑到新阶段说话）", async () => {
  const ran = [];
  let current = true;
  const turns = ["a", "b", "c"].map((k) => ({ kind: k, run: async () => { ran.push(k); current = false; } }));
  const done = await runTurnChain(turns, { gapMs: 0, isPhaseCurrent: async () => current });
  assert.deepStrictEqual(ran, ["a"], "第 1 个回合结束后阶段已变，b/c 都不该执行");
  assert.strictEqual(done, 1);
});

test("runTurnChain：某个回合抛错不能拖垮整条链（后面的 AI 仍要说话）", async () => {
  const ran = [];
  const errors = [];
  const turns = [
    { kind: "a", run: async () => { ran.push("a"); } },
    { kind: "b", run: async () => { throw new Error("生成失败"); } },
    { kind: "c", run: async () => { ran.push("c"); } },
  ];
  const done = await runTurnChain(turns, { gapMs: 0, onError: (e, t) => errors.push(`${t.kind}:${e.message}`) });
  assert.deepStrictEqual(ran, ["a", "c"], "失败的回合跳过后要继续");
  assert.strictEqual(done, 2, "只统计成功的回合");
  assert.deepStrictEqual(errors, ["b:生成失败"], "失败要被上报（不能静默吞掉）");
});

test("runTurnChain：initialDelayMs 生效，空计划安全", async () => {
  const slept = [];
  await runTurnChain([], { initialDelayMs: 800, sleep: async (ms) => { slept.push(ms); } });
  assert.deepStrictEqual(slept, [800], "空计划也要先等初始延迟（保持时序可预期）");
  const slept2 = [];
  await runTurnChain([{ kind: "a", run: async () => {} }], { initialDelayMs: 0, sleep: async (ms) => { slept2.push(ms); } });
  assert.deepStrictEqual(slept2, [], "单回合没有间隔");
});

// ==================== makeTurnWaiter（"问 → 答"并进回合链） ====================
// 实测（没有它时）：严格轮流之后仍有 2 处相邻消息 <1.2s，全部来自"回答车道"与回合链平行。
// 让提问回合等到回答结束，公屏才是"问 → 答 → 下一个问"。

test("makeTurnWaiter：被等的动作做完后立即放行", async () => {
  const w = makeTurnWaiter(5000);
  let released = false;
  w.promise.then(() => { released = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(released, false, "还没做完时不能放行");
  w.finish();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(released, true, "做完就要放行（否则回合链卡死）");
});

test("makeTurnWaiter：超时兜底 —— 被等的动作永远不会执行时也必须放行", async () => {
  const w = makeTurnWaiter(20);
  const t0 = Date.now();
  await w.promise;                                  // 不调 finish，靠超时
  assert.ok(Date.now() - t0 >= 15, "应当在超时后才放行");
});

test("makeTurnWaiter：finish 可以重复调用，且不会二次 resolve", async () => {
  let count = 0;
  const w = makeTurnWaiter(5000);
  w.promise.then(() => { count++; });
  w.finish();
  w.finish();
  w.finish();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(count, 1, "重复放行只能生效一次");
});

test("makeTurnWaiter：放行后要清掉超时定时器（否则定时器泄漏）", async () => {
  const cleared = [];
  const w = makeTurnWaiter(9999, (fn, ms) => ({ __fn: fn, __ms: ms }), (t) => { cleared.push(t.__ms); });
  w.finish();
  assert.deepStrictEqual(cleared, [9999], "放行后必须 clearTimeout");
});

// ==================== 发消息前复核阶段（端到端抓到的缺陷） ====================
// runTurnChain 只在**回合开始前**复核阶段，而一个回合要跑几十秒（LLM 生成）——
// 那个已经"飞在路上"的回合会把消息发到新阶段的公屏上。
// 实测（2026-10-14 端到端）：投票第一票 +195.7s，紧接着 +195.8s 冒出一句上一轮的讨论（相隔 83ms），
// 且这条发言的 phase 字段还是旧阶段。
// 这里用打桩把"生成期间阶段被推进"这件事变成确定的：对照组必须发出，实验组必须丢弃。

/** 装载 ai-player，并把 game-manager / ai-player-llm 换成桩（按模块名后缀匹配，见 README 约定） */
function loadAiPlayer({ getRoom, speakText, decision }) {
  const aiPath = require.resolve("../../src/game/ai-player");
  delete require.cache[aiPath];
  const orig = Module._load;
  const calls = { chat: [], votes: [], intros: [] };
  Module._load = function (request) {
    if (request.endsWith("game-manager")) {
      return {
        getRoom,
        getPlayers: async () => [
          { playerId: "p1", characterName: "甲", isAI: true },
          { playerId: "p2", characterName: "乙", isAI: true },
        ],
        getClues: async () => [],
        addChatMessage: async (code, pid, pname, cname, content, phase) => {
          const m = { code, pid, cname, content, phase };
          calls.chat.push(m);
          return m;
        },
        addIntroduction: async (code, who, text) => { calls.intros.push({ who, text }); },
        recordVote: async (code, pid, target) => { calls.votes.push({ pid, target }); },
        getVotes: async () => ({}),
        assignClue: async () => {}, revealClue: async () => {}, claimClue: async () => {},
        consumeSearchQuota: async () => {}, getSearchQuota: async () => ({ remaining: 0 }),
        updatePlayer: async () => {}, addPlayer: async () => {}, removePlayer: async () => {},
      };
    }
    if (request.endsWith("ai-player-llm")) {
      return {
        buildKnowledge: async () => ({}),
        getPublicContext: async () => [],
        turnLLM: async () => (decision !== undefined ? decision : { action: "speak", speech: speakText }),
        replyToQuestionLLM: async () => "我是这么看的，那会儿我在库房。",
        voteLLM: async () => null,
        introLLM: async () => "预备好的自我介绍",
      };
    }
    return orig.apply(this, arguments);
  };
  try {
    return { mod: require("../../src/game/ai-player"), calls };
  } finally {
    Module._load = orig;
    delete require.cache[aiPath];
  }
}

const fakeIo = () => ({ to: () => ({ emit: () => {} }) });
// actTurn 的"可问对象"来自剧本角色表（allChars），测试要真的传进去
const TURN_CHARS = [{ name: "甲", roleType: "player" }, { name: "乙", roleType: "player" }];

test("actTurn 对照组：阶段没变时，发言必须正常发到公屏", async () => {
  const room = { phase: "round1", parsedScript: "{}" };
  const { mod, calls } = loadAiPlayer({ getRoom: async () => room, speakText: "这是我的发言" });
  await mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "turn" }, TURN_CHARS);
  assert.strictEqual(calls.chat.length, 1, "阶段没变就该发出去（否则这个修复会把正常发言也吃掉）");
  assert.strictEqual(calls.chat[0].content, "这是我的发言");
});

test("actTurn：生成期间阶段被推进 → 这条发言必须丢弃（不能发到新阶段的公屏）", async () => {
  let n = 0;
  // 第一次取房间（回合开始）是 round1；生成完再取时已经是 voting
  const { mod, calls } = loadAiPlayer({
    getRoom: async () => (n++ === 0 ? { phase: "round1", parsedScript: "{}" } : { phase: "voting", parsedScript: "{}" }),
    speakText: "上一轮的发言",
  });
  await mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "turn" }, TURN_CHARS);
  assert.strictEqual(calls.chat.length, 0, "阶段已变，旧阶段的发言不能发到新阶段");
});

test("actVote：投票结果也要复核阶段 —— 迟到的票不能写进真相阶段", async () => {
  // 对照组：一直是 voting → 正常记录
  const ok = loadAiPlayer({ getRoom: async () => ({ phase: "voting", parsedScript: "{}" }), speakText: "" });
  await ok.mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "vote" }, []);
  assert.strictEqual(ok.calls.votes.length, 1, "voting 阶段的票要记上");

  // 实验组：生成期间已进入 truth_reveal → 不能记（真相阶段前有 voteForAllPending 兜底补投）
  let n = 0;
  const late = loadAiPlayer({
    getRoom: async () => (n++ === 0 ? { phase: "voting", parsedScript: "{}" } : { phase: "truth_reveal", parsedScript: "{}" }),
    speakText: "",
  });
  await late.mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "vote" }, []);
  assert.strictEqual(late.calls.votes.length, 0, "迟到的票不能写进真相阶段");
});
test("actTurn：LLM 决定提问时，公屏出现针对具体对象、具体时间的问题", async () => {
  const room = { phase: "round1", parsedScript: "{}" };
  const { mod, calls } = loadAiPlayer({
    getRoom: async () => room,
    decision: { action: "ask", target: "乙", question: "你说14:30在库房，那14:30到15:30有谁见过你？" },
  });
  const p = mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "turn" }, TURN_CHARS);
  await new Promise((r) => setTimeout(r, 60));   // 不等回答（回答要等 2.5s 的错峰才排上）
  assert.strictEqual(calls.chat.length, 1);
  assert.ok(calls.chat[0].content.startsWith("❓ 我想问 乙："), "提问要指明对象：" + calls.chat[0].content);
  assert.ok(calls.chat[0].content.includes("14:30"), "问题要落在具体时间上（用户要求问时间线）");
  assert.strictEqual(typeof p.then, "function", "提问要返回「等回答」的 promise，回合链才会等它答完");
});

test("actTurn：LLM 没给出决策（降级）→ 回退成规则发言，而不是瞎问", async () => {
  const room = { phase: "round1", parsedScript: "{}" };
  const { mod, calls } = loadAiPlayer({ getRoom: async () => room, decision: null });
  await mod.runAiTurn(fakeIo(), "R1", { ai: { playerId: "p1", characterName: "甲" }, kind: "turn" }, TURN_CHARS);
  assert.strictEqual(calls.chat.length, 1);
  assert.ok(calls.chat[0].content.startsWith("🤖"), "降级要说一句基于公开线索的话，而不是随便问一个人：" + calls.chat[0].content);
});

test("节奏常量：默认每人每 5 分钟一次机会、每轮上限 5 次（用户指定）", () => {
  assert.strictEqual(process.env.AI_TURN_CYCLE_MIN, undefined, "该用例假定环境没有覆盖周期");
  assert.strictEqual(TURN_CYCLE_MS, 5 * 60 * 1000);
  assert.strictEqual(MAX_TURNS_PER_ROUND, 5);
});
// ==================== 管理端"测试剧本"用的压缩节奏 ====================
// 真人局"每人每 5 分钟一次 + 阶段兜底 10 分钟"，跑完一局 40 分钟以上，测剧本太慢。
// 测试房用压缩节奏（阶段 4 分钟、出手周期 45 秒）。这里钉住两条性质：
// 压缩后必须**真的能让每个 AI 在一个阶段里轮到**，否则测试局会变成"AI 一句话不说"。
test("测试房压缩节奏：一个阶段内每位 AI 都轮得到，且明显快于真人局", () => {
  const names = ["甲", "乙", "丙", "丁", "戊", "己"];
  const ordered = orderAiPlayers(names.map((n) => ai(n)), []);
  const plan = buildTurnPlan(ordered, "round2", { cycleMs: TEST_TURN_CYCLE_MS, phaseMs: TEST_PHASE_MS });
  const turns = plan.filter(t => t.kind === "turn");
  assert.strictEqual(new Set(turns.map(t => t.ai.characterName)).size, names.length, "6 个 AI 都要有机会");
  const interval = turns[0].delayMs;
  assert.strictEqual(interval, Math.round(TEST_TURN_CYCLE_MS / names.length), "相邻出手间隔 = 周期 ÷ 人数");
  assert.ok(interval * names.length <= TEST_PHASE_MS, "一个周期必须装得进一个阶段");
  assert.ok(TEST_PHASE_MS < PHASE_DEADLINE_MS, "测试阶段必须短于真人局的 10 分钟兜底");
});