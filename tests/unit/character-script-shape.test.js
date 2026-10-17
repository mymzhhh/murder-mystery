// 角色 script 字段的形态归一化
//
// 回归的是一个会把整页剧本变成 "[object Object]" 的线上 bug：
// 角色的 script 实际是对象（{story, secret, fullScript, ...}），
// 但 /api/player/rooms/:code/my-script 直接 `char.script || ...` 当字符串返回，
// 前端拼 `d.script + secret` 就得到 "[object Object]"。
// 同一个 bug 还会把秘密弄丢：split 路径下秘密在 char.script.secret，char.secret 是 undefined。
const test = require("node:test");
const assert = require("node:assert");
const { normalizeCharacterScript } = require("../../src/script/script-parser");

test("对象形态：取 story 作为正文（split 路径的真实形态）", () => {
  // game-room-creator.js split 分支构造出来的就是这个形状
  const char = {
    name: "老曹", isMurderer: false, roleType: "player",
    script: { story: "【你的背景故事】\n你是钟楼的守夜人……", secret: "你那晚其实不在钟楼。" },
  };
  const r = normalizeCharacterScript(char);
  assert.strictEqual(typeof r.script, "string");
  assert.strictEqual(r.script, "【你的背景故事】\n你是钟楼的守夜人……");
  assert.strictEqual(r.secret, "你那晚其实不在钟楼。");
  assert.ok(!r.script.includes("[object Object]"));
});

test("对象形态：正文优先 fullScript，与 script-splitter 保存口径一致", () => {
  const char = {
    name: "陈碧娥",
    script: { story: "短版背景", fullScript: "完整角色章节（含时间线与凶手确认）", secret: "秘密" },
  };
  const r = normalizeCharacterScript(char);
  assert.strictEqual(r.script, "完整角色章节（含时间线与凶手确认）");
});

test("字符串形态：原样返回（兼容旧数据）", () => {
  const r = normalizeCharacterScript({ name: "阿四", script: "纯文本剧本", secret: "秘密A" });
  assert.strictEqual(r.script, "纯文本剧本");
  assert.strictEqual(r.secret, "秘密A");
});

test("秘密回退：script.secret 缺失时用顶层 char.secret", () => {
  const r = normalizeCharacterScript({ name: "小翠", script: { story: "正文" }, secret: "顶层秘密" });
  assert.strictEqual(r.secret, "顶层秘密");
});

test("playerScript 回退：script 为空对象时用顶层 playerScript", () => {
  const r = normalizeCharacterScript({ name: "周瑞年", script: {}, playerScript: "顶层正文" });
  assert.strictEqual(r.script, "顶层正文");
});

test("缺失与异常输入都返回字符串，绝不返回对象", () => {
  for (const input of [null, undefined, {}, { name: "x" }, { script: null }, { script: 123 }, { script: {} }]) {
    const r = normalizeCharacterScript(input);
    assert.strictEqual(typeof r.script, "string", `script 不是字符串: ${JSON.stringify(input)}`);
    assert.strictEqual(typeof r.secret, "string", `secret 不是字符串: ${JSON.stringify(input)}`);
    assert.ok(!r.script.includes("[object Object]"));
  }
});

// 端到端形状：把真实 split 数据喂进去，模拟路由返回后前端那种拼接方式
test("端到端：前端 `script + 秘密` 的拼接不会产出 [object Object]", () => {
  const splitRow = { name: "赵文轩", roleType: "player", isMurderer: "1", occupation: "医生", playerScript: "【你的背景故事】\n我是赵文轩。", secret: "我伪造了死亡时间。" };
  // 复刻 game-room-creator 的构造
  const char = { name: splitRow.name, isMurderer: splitRow.isMurderer === "1", occupation: splitRow.occupation, roleType: splitRow.roleType, script: { story: splitRow.playerScript, secret: splitRow.secret } };
  const { script, secret } = normalizeCharacterScript(char);
  // 复刻 GameView 的拼接
  const shown = script + (secret ? "\n\n【你的秘密】\n" + secret : "");
  assert.ok(!shown.includes("[object Object]"), `仍然出现 [object Object]: ${shown}`);
  assert.ok(shown.includes("我是赵文轩。"));
  assert.ok(shown.includes("我伪造了死亡时间。"));
});
