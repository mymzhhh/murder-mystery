// "需要隐瞒的事"提取的回归测试
//
// 这条链路的真实故障：生成模型对这个小节的措辞极不稳定，而解析器只认固定字面量
// 「你需要隐瞒的事」，于是线上某剧本 7 个角色里 5 个的秘密是空的
// （苏婉娘写成"你需要隐瞒的事"能匹配，沈砚写成"需要隐瞒的事"、柳文渊写成
// "你必须隐瞒的事"、沈青梧写成"必须隐瞒的事"就全部匹配不上）。
// 秘密丢了会连带毁掉两件事：玩家看不到自己的隐藏信息、AI 玩家演不出隐藏动机。
//
// 下面四个变体全部取自线上真实剧本原文。
const test = require("node:test");
const assert = require("node:assert");
const { extractSecretFromScript } = require("../modules/script-parser");

test("变体一：你需要隐瞒的事（原来唯一能匹配的写法）", () => {
  const text = [
    "### 三、你的任务",
    "",
    "1. 开场交代：向众人说明你的身份与到场缘由（可选择性隐瞒）。",
    "2. 查明真相：核对每个人的时间线。",
    "3. **你需要隐瞒的事**：",
    "   - 你怀疑沈青梧是你亲生女儿，银锁片是依据。",
    "   - 你收到的那封重续旧情的信。",
    "4. 你的底线：找出真凶。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("银锁片"), "应当提取到秘密内容");
  assert.ok(s.includes("重续旧情"));
  assert.ok(!s.includes("你的底线"), "不该吞掉下一个条目");
});

test("变体二：需要隐瞒的事（少了开头的'你'）", () => {
  const text = [
    "3. **需要隐瞒的事**：①你曾以账目亏空要挟柳文渊在遗嘱上做手脚；②你宴前一日进过酒窖。",
    "4. **你是凶手**：尽一切可能隐藏凶手身份。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("账目亏空"));
  assert.ok(!s.includes("你是凶手"), "不该吞掉下一个条目");
});

test("变体三：你必须隐瞒的事", () => {
  const text = [
    "### 三、你的任务",
    "2. **查明真相**：结合酒坛、酒窖、各人时间线。",
    "3. **你必须隐瞒的事**：",
    "   - 三千两账目亏空与东家的三日通牒。",
    "   - 你曾收下霍连城的五百两茶资未入账。",
    "4. **你的底线**：把嫌疑从自己身上摘干净。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("三千两账目亏空"));
  assert.ok(s.includes("五百两茶资"));
  assert.ok(!s.includes("你的底线"));
});

test("变体四：必须隐瞒的事（无主语）", () => {
  const text = [
    "3. **必须隐瞒的事**：",
    "   - 你袖中那张无落款短笺。",
    "   - 你前一日 19:05 在走廊撞见沈砚从酒窖出来。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("无落款短笺"));
  assert.ok(s.includes("沈砚"));
});

test("误报防护：'开场交代…（可选择性隐瞒）'不能被当成秘密条目", () => {
  const text = [
    "### 三、你的任务",
    "1. 开场交代：向众人说明你的身份与到场缘由（可选择性隐瞒）。",
    "2. 查明真相：核对时间线。",
  ].join("\n");
  assert.strictEqual(extractSecretFromScript(text), "", "顺带一提的'隐瞒'不该被当成秘密");
});

test("独立小节标题（NPC 风格）优先于编号条目", () => {
  const text = [
    "## 二、目击信息与需要隐瞒的事",
    "",
    "我当晚在酒窖外见过沈砚。",
    "",
    "## 三、时间线",
    "",
    "18:35 去酒窖。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("酒窖外见过沈砚"));
  assert.ok(!s.includes("18:35"), "不该越过下一个标题");
});

test("找不到任何线索时返回空串，不抛异常", () => {
  assert.strictEqual(extractSecretFromScript("### 一、背景\n\n我是一名医生。"), "");
  for (const bad of [null, undefined, "", 123, {}]) {
    assert.doesNotThrow(() => extractSecretFromScript(bad));
    assert.strictEqual(extractSecretFromScript(bad), "");
  }
});

test("长度上限生效", () => {
  const text = "3. **必须隐瞒的事**：" + "x".repeat(5000);
  assert.strictEqual(extractSecretFromScript(text, 200).length, 200);
  assert.ok(extractSecretFromScript(text, 1200).length <= 1200);
});

test("正文含多个含关键词的条目时，取第一个（即任务清单里的那一条）", () => {
  const text = [
    "3. **你必须隐瞒的事**：第一处秘密内容。",
    "5. **隐瞒的后果**：第二处内容。",
  ].join("\n");
  const s = extractSecretFromScript(text);
  assert.ok(s.includes("第一处秘密内容"));
  assert.ok(!s.includes("第二处内容"));
});
