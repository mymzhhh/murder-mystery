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

// ---- 用桩替换依赖，让 buildKnowledge 可被确定性地测试（不依赖 Redis）----
const stubs = { clues: [], players: [], messages: [], agnesReply: null, lastUserPrompt: "" };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./game-manager") {
    return {
      getClues: async () => stubs.clues,
      getPlayers: async () => stubs.players,
      getChatMessages: async () => stubs.messages,
    };
  }
  if (request === "./agnes-client") {
    return {
      chat: async (_sys, user) => { stubs.lastUserPrompt = user; return stubs.agnesReply; },
    };
  }
  return origLoad.apply(this, arguments);
};
const llm = require("../modules/ai-player-llm");
Module._load = origLoad; // 立刻还原，避免影响其他测试文件

const { systemPrompt, buildKnowledge, askLLM, voteLLM } = llm;

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

test("systemPrompt 包含自己的剧本/秘密/线索/角色名单", () => {
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
  assert.ok(p.includes("书房抽屉里发现一把生锈的钥匙"));
  assert.ok(p.includes("李四"));
  assert.ok(p.includes("沪上迷局"));
  // 新增：公开线索、自己说过的话、案情、场景都应进入 prompt
  assert.ok(p.includes("后厨水缸边有半枚鞋印"), "全场公开线索必须进入 prompt");
  assert.ok(p.includes("我八点就在书房了"), "自己说过的话必须进入 prompt（防自我矛盾）");
  assert.ok(p.includes("20:45"), "案情（死亡时间）必须进入 prompt");
  assert.ok(p.includes("茶楼二层"), "场景必须进入 prompt");
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

test("buildKnowledge：已公开的线索（含他人发现的）必须收进来", async () => {
  resetStubs();
  stubs.clues = [
    { id: "A1", content: "我自己找到的", foundBy: ["ai_1"] },
    { id: "A2", content: "张三公开的线索", foundBy: ["h_1"] },
    { id: "A3", content: "全场都没发现", foundBy: [] },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.deepStrictEqual(k.myClues.map(x => x.includes("我自己找到的")), [true]);
  assert.strictEqual(k.otherClues.length, 1);
  assert.ok(k.otherClues[0].includes("张三公开的线索"));
  assert.ok(k.otherClues[0].includes("张三"), "要标明是谁公开的，便于交叉质证");
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

test("buildKnowledge：带上自己之前的发言与公开对话、案情、场景", async () => {
  resetStubs();
  stubs.messages = [
    { playerId: "h_1", characterName: "张三", content: "我八点半在楼下" },
    { playerId: "ai_1", characterName: "李四", content: "我看到你上楼了" },
  ];
  const k = await buildKnowledge("ROOM", AI, PARSED);
  assert.strictEqual(k.myStatements.length, 1);
  assert.ok(k.myStatements[0].includes("我看到你上楼了"));
  assert.ok(k.transcript.includes("我八点半在楼下"));
  assert.ok(k.transcript.includes("我看到你上楼了"));
  assert.ok(k.victim.includes("陆老板"));
  assert.ok(k.scene.includes("茶楼二层"));
});

test("buildKnowledge：依赖读取失败时不抛异常（降级为空知识）", async () => {
  const savedLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "./game-manager") {
      return {
        getClues: async () => { throw new Error("redis down"); },
        getPlayers: async () => { throw new Error("redis down"); },
        getChatMessages: async () => { throw new Error("redis down"); },
      };
    }
    return savedLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve("../modules/ai-player-llm")];
  const fresh = require("../modules/ai-player-llm");
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

test("askLLM：解析出合法的 target 与 question", async () => {
  resetStubs();
  stubs.agnesReply = '{"target":"张三","question":"你说八点半在楼下，有谁能证明？"}';
  const r = await askLLM(baseK(), ["张三", "李四"]);
  assert.strictEqual(r.target, "张三");
  assert.ok(r.question.includes("谁能证明"));
});

test("askLLM：目标不在候选里 / JSON 非法时返回 null（不瞎问）", async () => {
  resetStubs();
  stubs.agnesReply = '{"target":"王五","question":"在吗"}';
  assert.strictEqual(await askLLM(baseK(), ["张三", "李四"]), null);

  stubs.agnesReply = "我觉得应该问张三吧";
  assert.strictEqual(await askLLM(baseK(), ["张三"]), null);

  stubs.agnesReply = '{"target":"张三","question":""}';
  assert.strictEqual(await askLLM(baseK(), ["张三"]), null);

  stubs.agnesReply = null; // 调用失败
  assert.strictEqual(await askLLM(baseK(), ["张三"]), null);
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
