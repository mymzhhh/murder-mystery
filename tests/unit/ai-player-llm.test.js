// AI 玩家 LLM 层测试
//
// 重点守住两条容易搞错的边界：
//   1) 隔离红线：未被发现的线索、他人剧本与秘密、DM 真相，绝不能进 prompt。
//   2) 信息完整性：已经被任何人找到的线索是"全桌公开"的（游戏里会广播给全房间），
//      AI 必须看到，否则会表现得极蠢（反复问已经公开过的事）。
// 这两条是相反方向的约束，只测其中一边都会漏掉真实缺陷。
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// ---- 用桩替换依赖，让 buildKnowledge 可被确定性地测试（不依赖 Redis / 不发真实网络请求）----
// 注意：按"模块名后缀"匹配而不是精确匹配 "./xxx" —— 精确匹配会在依赖被移动目录后
// 静默失配，导致真实 LLM 客户端被加载、测试真的去发网络请求（表现为整个测试进程挂死）。
const stubs = { clues: [], players: [], messages: [], agnesReply: null, lastUserPrompt: "" };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith("game-manager")) {
    return {
      getClues: async () => stubs.clues,
      getPlayers: async () => stubs.players,
      getChatMessages: async () => stubs.messages,
    };
  }
  if (request.endsWith("agnes-client")) {
    return {
      chat: async (_sys, user) => { stubs.lastUserPrompt = user; return stubs.agnesReply; },
    };
  }
  return origLoad.apply(this, arguments);
};
const llm = require("../../src/game/ai-player-llm");
Module._load = origLoad; // 立刻还原，避免影响其他测试文件

const { systemPrompt, knowledgePrompt, buildKnowledge, turnLLM, parseTurnOutput, voteLLM } = llm;

const AI = { playerId: "ai_1", characterName: "李四", characterScript: JSON.stringify({ name: "李四", isMurderer: false }) };
const PARSED = {
  title: "沪上迷局", setting: { era: "民国", location: "上海" },
  victim: { name: "陆老板", deathCause: "中毒", deathTime: "20:45" },
  layoutDescription: "茶楼二层，走廊尽头是雅间",
  characters: [{ name: "张三", occupation: "医生", roleType: "player" }, { name: "李四", occupation: "管家", roleType: "player" }],
};

function resetStubs() {
  stubs.clues = [];
  stubs.players = [
    { playerId: "ai_1", characterName: "李四", playerName: "u_li", isAI: true },
    { playerId: "h_1", characterName: "张三", playerName: "u_zhang", isAI: false },
  ];
  stubs.messages = [];
  stubs.agnesReply = null;
  stubs.lastUserPrompt = "";
}

test("systemPrompt 只含**稳定**内容：剧本/秘密/案情/角色名单在，线索与公屏必须挪出去", () => {
  const p = systemPrompt({
    role: { name: "张三", occupation: "医生", isMurderer: false, playerScript: "我是张三，案发当晚我在书房看书", secret: "我背着大家借了高利贷" },
    name: "张三",
    myClues: ["【A1】书房抽屉里发现一把生锈的钥匙（书房）"],
    otherClues: ["【A2】后厨水缸边有半枚鞋印 —— 由 李四 公开"],
    allChars: ["张三（医生）", "李四（管家）"],
    myStatements: ["我八点就在书房了"],
    transcript: "李四: 我一直在前厅",
    victim: "陆老板，中毒，死亡时间 20:45",
    scene: "茶楼二层",
    room: { title: "沪上迷局", setting: "民国，上海" },
  });
  assert.ok(p.includes("我是张三，案发当晚我在书房看书"));
  assert.ok(p.includes("高利贷"));
  assert.ok(p.includes("李四"));
  assert.ok(p.includes("沪上迷局"));
  assert.ok(p.includes("20:45"), "案情（死亡时间）必须进入 prompt");
  assert.ok(p.includes("茶楼二层"), "场景必须进入 prompt");
  // ↓ 本次改动的新契约：易变内容**绝不能**留在 system 段。
  //   提示词缓存只认最长公共前缀 —— system 里只要有一处每轮都变（线索/自己的发言/公屏），
  //   缓存就永远只能命中前面那一小段，剩下每次全价重发（实测改前就是这样）。
  assert.ok(!p.includes("书房抽屉里发现一把生锈的钥匙"), "自己找到的线索必须挪到 user 段");
  assert.ok(!p.includes("后厨水缸边有半枚鞋印"), "公开线索必须挪到 user 段");
  assert.ok(!p.includes("我八点就在书房了"), "自己说过的话必须挪到 user 段");
  assert.ok(!p.includes("我一直在前厅"), "公屏必须挪到 user 段");
});

test("knowledgePrompt 承载易变内容；同一角色的 system 段必须逐字节稳定", () => {
  const base = {
    role: { name: "张三", occupation: "医生", isMurderer: false, playerScript: "我是张三", secret: "我的秘密" },
    name: "张三",
    myClues: ["【A1】书房抽屉里发现一把生锈的钥匙"],
    otherClues: ["【A2】后厨水缸边有半枚鞋印"],
    allChars: ["张三（医生）", "李四（管家）"],
    myStatements: ["我八点就在书房了"],
    transcript: "李四: 我一直在前厅",
    victim: "陆老板，中毒",
    scene: "茶楼二层",
    room: { title: "沪上迷局", setting: "民国，上海" },
  };
  const kb = knowledgePrompt(base);
  assert.ok(kb.includes("书房抽屉里发现一把生锈的钥匙"), "自己找到的线索要在易变段");
  assert.ok(kb.includes("后厨水缸边有半枚鞋印"), "公开线索要在易变段");
  assert.ok(kb.includes("我八点就在书房了"), "自己说过的话要在易变段（防自我矛盾）");
  assert.ok(kb.includes("我一直在前厅"), "公屏要在易变段");

  // 关键不变量：线索/公屏变化后，system 段必须**一模一样** —— 这是提示词缓存能命中的前提。
  // 这条一旦被破坏，缓存命中率会静默归零，而页面和测试都不会报错。
  const changed = { ...base, myClues: ["【A9】新发现的一条线索"], transcript: "张三: 新的一句话" };
  assert.equal(systemPrompt(base), systemPrompt(changed), "线索/公屏变化不得影响 system 段");
  assert.notEqual(knowledgePrompt(base), knowledgePrompt(changed), "易变段必须随线索/公屏变化");
});

test("信息隔离红线：不携带他人剧本、DM 真相、凶手姓名", () => {
  const p = systemPrompt({
    role: { name: "张三", isMurderer: false, playerScript: "我的剧本", secret: "我的秘密" },
    name: "张三", myClues: [], otherClues: [], allChars: ["张三", "李四"],
    myStatements: [], transcript: "", victim: "", scene: "",
    room: { title: "T", setting: "" },
  });
  for (const w of ["truthReveal", "真相复盘", "murdererName", "全部线索", "DM手册"]) {
    assert.ok(!p.toLowerCase().includes(w.toLowerCase()), "违规内容出现: " + w);
  }
});

// ==================== 线索可见性（私有化后）====================
// 改造前：线索一被发现就广播全场，AI 只要看到 foundBy 非空就该知道。
// 现在线索默认私有，AI 只能看到三种：自己找到的 / 已被公开的 / 别人单独分享给它的。
// 这三条边界必须钉死 —— 多给一条就是"AI 知道玩家不知道的事"，穿帮且破坏玩法。

test("buildKnowledge：自己找到的线索进 myClues", async () => {
  resetStubs();
  stubs.clues = [{ id: "A1", content: "我自己找到的", foundBy: ["ai_1"] }];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.myClues.length, 1);
  assert.ok(k.myClues[0].includes("我自己找到的"));
  assert.strictEqual(k.otherClues.length, 0, "自己的线索不该重复出现在 otherClues");
});

test("buildKnowledge：已公开的线索必须收进来（含他人发现的）", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A2", content: "张三公开的线索", foundBy: ["h_1"], revealed: true },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.otherClues.length, 1);
  assert.ok(k.otherClues[0].includes("张三公开的线索"));
  assert.ok(k.otherClues[0].includes("已公开"));
});

test("buildKnowledge：别人未公开的私有线索绝不能进来（信息隔离红线）", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A2", content: "张三私藏的线索", foundBy: ["h_1"], revealed: false },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  const all = JSON.stringify(k);
  assert.ok(!all.includes("张三私藏的线索"), "未公开的私有线索泄漏了");
  assert.strictEqual(k.otherClues.length, 0);
  assert.ok(!systemPrompt(k).includes("张三私藏的线索"), "也不能进最终 prompt");
});

test("buildKnowledge：单独分享给 AI 的线索算它可见，并标明来源", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A5", content: "李四私下给我看的", foundBy: ["h_1"], revealed: false, sharedWith: ["ai_1"] },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.otherClues.length, 1);
  assert.ok(k.otherClues[0].includes("李四私下给我看的"));
  assert.ok(k.otherClues[0].includes("单独告知你"), "要标明是私下给的，AI 才知道这是筹码而非公开信息");
});

test("buildKnowledge：分享给别人（不含 AI）的线索对 AI 仍不可见", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A6", content: "只给了王五", foundBy: ["h_1"], revealed: false, sharedWith: ["h_9"] },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.ok(!JSON.stringify(k).includes("只给了王五"), "别人的私下分享与 AI 无关");
});

test("buildKnowledge：自己没有角色时他人私有线索也不可见", async () => {
  resetStubs();
  stubs.clues = [{ id: "A7", content: "别人的私有线索", foundBy: ["h_2"], revealed: false }];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.otherClues.length, 0);
});

test("buildKnowledge：未被发现的线索绝不能进入知识（隔离红线）", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A9", content: "这是真凶手法，谁都没找到", foundBy: [] },
    { id: "A8", content: "凶手是李四", foundBy: [] },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  const all = JSON.stringify(k);
  assert.ok(!all.includes("这是真凶手法"), "未发现的线索泄漏了");
  assert.ok(!all.includes("凶手是李四"), "未发现的线索泄漏了");
  assert.strictEqual(k.myClues.length, 0);
  assert.strictEqual(k.otherClues.length, 0);
  // 而且不能进入最终 prompt
  const p = systemPrompt(k);
  assert.ok(!p.includes("这是真凶手法"));
});

test("buildKnowledge：自己的发言只在 myStatements 里出现一次，公屏只放别人的", async () => {
  resetStubs();
  stubs.messages = [
    { playerId: "h_1", characterName: "张三", content: "我八点半在楼下" },
    { playerId: "ai_1", characterName: "李四", content: "我看到你上楼了" },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.myStatements.length, 1);
  assert.ok(k.myStatements[0].includes("我看到你上楼了"));
  assert.ok(k.transcript.includes("我八点半在楼下"), "别人的发言必须在公屏里");
  // ⚠️ 自己的发言**不能**再在公屏里出现一份：它已经在【你之前说过的原话】里单列，
  // 两处都放等于同一段话付两次钱（信息一点没少，模型仍能在 myStatements 里看到自己说过什么）。
  assert.ok(!k.transcript.includes("我看到你上楼了"), "自己的发言不得在公屏里重复一份");
  assert.ok(k.victim.includes("陆老板"));
  assert.ok(k.scene.includes("茶楼二层"));
});

test("buildKnowledge：依赖读取失败时不抛异常（降级为空知识）", async () => {
  const savedLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.endsWith("game-manager")) {
      return {
        getClues: async () => { throw new Error("redis down"); },
        getPlayers: async () => { throw new Error("redis down"); },
        getChatMessages: async () => { throw new Error("redis down"); },
      };
    }
    return savedLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve("../../src/game/ai-player-llm")];
  const fresh = require("../../src/game/ai-player-llm");
  Module._load = savedLoad;
  const k = await fresh.buildKnowledge("ROOM", AI, PARSED);
  assert.deepStrictEqual(k.myClues, []);
  assert.strictEqual(k.transcript, "");
});

/** 一份完整（但最小）的 knowledge，供只关心某个函数的用例复用 */
function baseK(over = {}) {
  return {
    role: {}, name: "李四", roomCode: "R",
    myClues: [], otherClues: [], allChars: [], myStatements: [],
    transcript: "", victim: "", scene: "",
    room: { title: "T", setting: "" },
    ...over,
  };
}

test("turnLLM：解析出合法的「发言」决策", async () => {
  resetStubs();
  stubs.agnesReply = '{"action":"speak","speech":"我看那本簿子纸色不对，14:40 那栏还空着。"}';
  const r = await turnLLM(baseK(), ["张三", "李四"]);
  assert.strictEqual(r.action, "speak");
  assert.ok(r.speech.includes("簿子"));
});

test("turnLLM：解析出合法的「提问」决策（要能拿到 target 与 question）", async () => {
  resetStubs();
  stubs.agnesReply = '{"action":"ask","target":"张三","question":"你说八点半在楼下，有谁能证明？"}';
  const r = await turnLLM(baseK(), ["张三", "李四"]);
  assert.strictEqual(r.action, "ask");
  assert.strictEqual(r.target, "张三");
  assert.ok(r.question.includes("谁能证明"));
  assert.ok(stubs.lastUserPrompt.includes("时间"), "提示词必须要求问具体时间/时间线");
});

test("turnLLM：目标不在候选里 / JSON 非法 / 字段缺失一律返回 null（不瞎问不空说）", async () => {
  resetStubs();
  stubs.agnesReply = '{"action":"ask","target":"王五","question":"在吗"}';
  assert.strictEqual(await turnLLM(baseK(), ["张三", "李四"]), null, "目标必须是可问的人");

  stubs.agnesReply = "我觉得应该问张三吧";
  assert.strictEqual(await turnLLM(baseK(), ["张三"]), null, "不是 JSON 就不猜");

  stubs.agnesReply = '{"action":"ask","target":"张三","question":""}';
  assert.strictEqual(await turnLLM(baseK(), ["张三"]), null, "空问题不算提问");

  stubs.agnesReply = '{"action":"speak","speech":""}';
  assert.strictEqual(await turnLLM(baseK(), ["张三"]), null, "空发言不算发言");

  stubs.agnesReply = '{"action":"sing","speech":"唱歌"}';
  assert.strictEqual(await turnLLM(baseK(), ["张三"]), null, "只认 speak/ask 两种动作");

  stubs.agnesReply = null; // 调用失败
  assert.strictEqual(await turnLLM(baseK(), ["张三"]), null);
});

test("parseTurnOutput：围栏/前后缀都能剥离（纯函数）", () => {
  assert.deepStrictEqual(
    parseTurnOutput('```json\n{"action":"ask","target":"张三","question":"14:30 你在哪"}\n```', ["张三"]),
    { action: "ask", target: "张三", question: "14:30 你在哪" });
  assert.deepStrictEqual(
    parseTurnOutput('好的，我的决定是 {"action":"speak","speech":"我说两句"} 就这样', []),
    { action: "speak", speech: "我说两句" });
  // 兼容 text 字段（模型偶尔写 text 而不是 speech）
  assert.deepStrictEqual(parseTurnOutput('{"action":"speak","text":"换个字段名"}', []),
    { action: "speak", speech: "换个字段名" });
});

// 用户明确要求：提问要有利于推理或误导——凶手用提问转移视线，其他人用提问补推理缺口。
// 这条只能靠"提示词里到底写了什么"来钉，所以直接把生成的 user prompt 抓出来断言。
test("turnLLM：凶手与非凶手拿到不同的出手策略（误导 vs 补推理缺口）", async () => {
  resetStubs();
  stubs.agnesReply = '{"action":"speak","speech":"x"}';
  await turnLLM(baseK({ role: { name: "张三", isMurderer: true } }), ["李四"]);
  const murdererPrompt = stubs.lastUserPrompt;
  assert.ok(murdererPrompt.includes("你是凶手"), "凶手要看到凶手策略");
  assert.ok(murdererPrompt.includes("转移") || murdererPrompt.includes("挪开"), "凶手提问是为了转移视线");
  assert.ok(murdererPrompt.includes("绝不能"), "要明确禁止自曝式提问");

  await turnLLM(baseK({ role: { name: "张三", isMurderer: false } }), ["李四"]);
  const innocentPrompt = stubs.lastUserPrompt;
  assert.ok(innocentPrompt.includes("你不是凶手"));
  assert.ok(innocentPrompt.includes("推理"), "非凶手的提问要为推理服务");
  assert.ok(!innocentPrompt.includes("把水搅浑"), "非凶手不该拿到误导策略");

  // 不论是谁，问"具体时间"这条硬要求都在
  assert.ok(innocentPrompt.includes("具体时间"));
  assert.ok(innocentPrompt.includes("不要问") && innocentPrompt.includes("空泛"), "要挡住空泛问题");
});

test("voteLLM：非法目标返回 null，合法目标通过", async () => {
  resetStubs();
  stubs.agnesReply = '```json\n{"target":"张三","reason":"时间线矛盾"}\n```';
  assert.strictEqual(await voteLLM(baseK(), ["张三", "李四"]), "张三");

  stubs.agnesReply = '{"target":"赵六"}';
  assert.strictEqual(await voteLLM(baseK(), ["张三", "李四"]), null);
});

test("systemPrompt 对缺失字段容错（一个字段缺失不该让整轮发言崩掉）", () => {
  assert.doesNotThrow(() => systemPrompt({}));
  assert.doesNotThrow(() => systemPrompt({ role: {}, room: {} }));
  const p = systemPrompt({});
  assert.ok(p.includes("未知"));
});

test("凶手 AI 的提示包含洗清嫌疑规则（但不暴露'我是AI'）", () => {
  const p = systemPrompt({
    role: { name: "李四", isMurderer: true, playerScript: "私密剧本", secret: "" },
    name: "李四", myClues: [], otherClues: [], allChars: [], myStatements: [], transcript: "", victim: "", scene: "",
    room: { title: "T", setting: "" },
  });
  assert.ok(p.includes("凶手"));
  assert.ok(p.includes("洗清嫌疑"));
  assert.ok(!p.includes("我是一个AI"));
  assert.ok(!p.includes("我是人工智能"));
});

test("AI 出手：传入可搜地点时才允许搜证，地点必须在名单内", () => {
  const places = ["顶层客厅", "一楼客厅"];
  const ok = parseTurnOutput('{"action":"search","place":"顶层客厅"}', [], places);
  assert.strictEqual(ok && ok.action, "search", JSON.stringify(ok));
  const bad = parseTurnOutput('{"action":"search","place":"不存在的地方"}', [], places);
  assert.strictEqual(bad, null, "编造的地点必须拒绝，回退规则引擎");
  const off = parseTurnOutput('{"action":"search","place":"顶层客厅"}', [], []);
  assert.strictEqual(off, null, "调用方没给地点时，搜证一律无效（线上行为不变）");
});