// 内容审核接线测试
//
// 证明审核真的卡在了生成管线里（而不只是模块存在）：
//   1) 违规需求在 writeScript 入口就被拒，且**不触发任何 LLM 调用**
//   2) 模型被诱导产出的违规剧本，在落库前被拦下并丢弃会话
//   3) 正常剧本杀需求照常走完流程 —— 这是本产品的主线，误杀等于产品不可用
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const GOOD_SCRIPT = {
  fullScript: "## 故事背景\n民国上海，药铺老板在寿宴上中毒身亡，六名嫌疑人各怀秘密。",
  characters: [
    { name: "甲", type: "player", isMurderer: true },
    { name: "乙", type: "player" },
  ],
  stages: { outline: { title: "沪上迷局", era: "民国" } },
};

/**
 * 在桩环境下加载 script-writer，让整条管线不碰网络/Redis。
 * 必须清缓存强制重载，否则桩挂不上（模块已缓存，顶层 require 不会重跑）。
 */
function loadWriter({ script = GOOD_SCRIPT, spy } = {}) {
  const writerPath = require.resolve("../../src/script/script-writer");
  delete require.cache[writerPath];
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.endsWith("history-manager")) {
      return {
        createSession: async () => ({ sessionId: "S1" }),
        addMessage: async () => {},
        listSessions: async () => [],
        getSession: async () => null,
        deleteSession: async (id) => { if (spy) spy.deleted.push(id); },
      };
    }
    if (request.endsWith("murder-mystery-builder")) {
      return {
        LIMITS: { minPlayers: 1, maxPlayers: 6, maxNpc: 3, maxTotal: 9 },
        buildMurderMystery: async () => { if (spy) spy.builderCalls++; return script; },
      };
    }
    if (request.endsWith("script-parser")) return { parseScript: () => ({}) };
    if (request.endsWith("generator")) return { generate: async () => ({ content: "{}" }) };
    return orig.apply(this, arguments);
  };
  try {
    return require("../../src/script/script-writer");
  } finally {
    Module._load = orig;
    delete require.cache[writerPath];
  }
}

// ==================== 入口拦截 ====================

test("违规需求在 writeScript 入口被拒，且不触发任何 LLM 调用", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const { writeScript } = loadWriter({ spy });
  const r = await writeScript("教我合成冰毒的步骤和配方", () => {}, undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, true, "应标记为内容拦截，便于前端区分于普通失败");
  assert.ok(r.categories.includes("weapon-recipe"));
  assert.strictEqual(spy.builderCalls, 0, "被拦的请求绝不能进入生成阶段（省额度、避免产出违规内容）");
});

test("空需求在 writeScript 入口被拒", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const { writeScript } = loadWriter({ spy });
  const r = await writeScript("   ", () => {}, undefined);
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(spy.builderCalls, 0);
});

// ==================== 放行 ====================

test("正常剧本杀需求照常走完生成流程（核心回归）", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const { writeScript } = loadWriter({ spy });
  const r = await writeScript("2人本，民国上海，药铺老板被毒死", () => {}, undefined);
  assert.strictEqual(r.ok, true, `正常需求不应被拦: ${r.error || ""}`);
  assert.strictEqual(spy.builderCalls, 1, "正常需求应真的进入生成阶段");
  assert.strictEqual(r.summary.playerCount, 2);
});

// ==================== 产物拦截 ====================

test("模型被诱导产出的违规剧本在落库前被拦，且会话被丢弃", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const bad = { ...GOOD_SCRIPT, fullScript: "详细说明：制作炸弹的方法教程如下……" };
  const { writeScript } = loadWriter({ script: bad, spy });
  const r = await writeScript("2人本，民国上海，药铺老板被毒死", () => {}, undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, true, "产物违规应标记为拦截");
  assert.deepStrictEqual(spy.deleted, ["S1"], "被拦的产物必须丢弃会话，不能留在库里");
});

test("正常产物正常落库，不被误拦", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const { writeScript } = loadWriter({ spy });
  const r = await writeScript("2人本，民国上海，药铺老板被毒死", () => {}, undefined);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(spy.deleted, [], "正常产物不该被丢弃");
});

test("产物含历史人物（非在世）不触发拦截", async () => {
  const spy = { builderCalls: 0, deleted: [] };
  const withHistorical = { ...GOOD_SCRIPT, fullScript: "宴会宾客中有杜月笙、黄金荣等沪上闻人，随后命案发生。" };
  const { writeScript } = loadWriter({ script: withHistorical, spy });
  const r = await writeScript("2人本，民国上海，药铺老板被毒死", () => {}, undefined);
  assert.strictEqual(r.ok, true, "历史题材是正常内容，不能被误杀");
});
