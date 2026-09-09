// 单元测试：AI 玩家纯逻辑（补位计算 / 投票 / 发言）— 无需 Redis
const test = require("node:test");
const assert = require("node:assert");

const { computeAiFillers, chooseVoteTarget, voteCandidates, buildAiSpeech } = require("../modules/ai-player");

const CHARS = [
  { name: "张三", roleType: "player", isMurderer: true },
  { name: "李四", roleType: "player", isMurderer: false },
  { name: "王五", roleType: "player", isMurderer: false },
  { name: "目击者A", roleType: "npc", isMurderer: false },
];

function human(name) { return { playerId: "h_" + name, playerName: name, characterName: name, isNPC: false }; }
function ai(name) { return { playerId: "ai_x_" + name, playerName: "AI", characterName: name, isNPC: true, isAI: true }; }

// ==================== 补位计算 ====================

test("computeAiFillers：无人选角时所有玩家槽位由 AI 扮演", () => {
  const fillers = computeAiFillers([], CHARS);
  assert.deepEqual(fillers.map(c => c.name), ["张三", "李四", "王五"]);
});

test("computeAiFillers：审讯 NPC 不参与补位", () => {
  const fillers = computeAiFillers([human("张三")], CHARS);
  assert.deepEqual(fillers.map(c => c.name), ["李四", "王五"]);
});

test("computeAiFillers：全部选完后无补位", () => {
  const fillers = computeAiFillers([human("张三"), human("李四"), human("王五")], CHARS);
  assert.equal(fillers.length, 0);
});

// ==================== 投票 ====================

test("voteCandidates：候选包含真人/AI/审讯NPC，排除自己", () => {
  const players = [human("张三"), ai("李四")];
  const candidates = voteCandidates(players, CHARS, "张三");
  assert.ok(candidates.includes("李四") && candidates.includes("目击者A"));
  assert.ok(!candidates.includes("张三"));
});

test("voteCandidates：excludeNpcs=true（PVP）时排除审讯 NPC", () => {
  const players = [human("张三"), ai("李四")];
  const candidates = voteCandidates(players, CHARS, "张三", true);
  assert.ok(candidates.includes("李四"));
  assert.ok(!candidates.includes("目击者A"));
  assert.ok(!candidates.includes("张三"));
});

test("chooseVoteTarget：凶手 AI 绝不投自己（候选不含自己）", () => {
  const aiScript = { name: "张三", isMurderer: true };
  const clues = [{ content: "李四在案发现场留下脚印", location: "书房", foundBy: ["p1"] }];
  const candidates = ["李四", "王五", "目击者A"];
  for (let i = 0; i < 200; i++) {
    const target = chooseVoteTarget(aiScript, clues, candidates);
    assert.notEqual(target, "张三"); // 张三根本不在候选里，双重保险
    assert.ok(candidates.includes(target));
  }
});

test("chooseVoteTarget：线索指向的角色被更高频选中（统计上）", () => {
  const aiScript = { name: "张三", isMurderer: false };
  const clues = [
    { content: "李四深夜去过死者房间，神色慌张", foundBy: ["p9"] },
    { content: "李四的手套上有血迹", foundBy: ["p9"] },
    { content: "王五在花园散步", foundBy: ["p9"] },
    { content: "目击者A什么也没看到", foundBy: ["p9"] },
  ];
  const candidates = ["李四", "王五", "目击者A"];
  let lisi = 0, total = 2000;
  // 线索只指向李四 → 在非随机分支里权重大，统计上应显著多于他人（扣除 30% 随机噪声后仍应占优）
  for (let i = 0; i < total; i++) {
    if (chooseVoteTarget(aiScript, clues, candidates) === "李四") lisi++;
  }
  assert.ok(lisi > total * 0.4, `李四被选比例应>40%，实际 ${(lisi / total * 100).toFixed(1)}%`);
});

test("chooseVoteTarget：候选为空返回空串", () => {
  assert.equal(chooseVoteTarget(null, [], []), "");
});

// ==================== 发言 ====================

test("buildAiSpeech：总是返回非空模板发言", () => {
  for (let i = 0; i < 50; i++) {
    const s = buildAiSpeech([{ content: "书房的钥匙" }], CHARS);
    assert.ok(s && s.length > 0);
  }
});

test("buildAiSpeech：无线索时也有引导性发言", () => {
  const s = buildAiSpeech([], CHARS);
  assert.ok(s && s.length > 0);
});