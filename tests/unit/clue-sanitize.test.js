// 线索正文净化：剥掉误并入的「推理链说明」小节（2026-10-20 玩家可见剧透泄漏）
//
// 事故：《临河客栈桐油案》B25 的正文末尾混进了
//   「--- ## 推理链说明 1. 动机链：起点A1→A2→B13→B24 … 2. 手法链：… 3. 时间链：…」
// 玩家搜到这一条线索 = 直接拿到完整答案。
const test = require("node:test");
const assert = require("node:assert");
const {
  stripReasoningChain, hasReasoningChain, extractReasoningChain,
} = require("../../src/script/clue-sanitize.js");

const REAL = "- 线索类型：痕迹 - 发现地点：账房 - 线索内容：账房抽屉的锁孔有新鲜的钥匙插拔痕迹，"
  + "整间客栈只有账房先生持有账房抽屉的专属钥匙。 --- ## 推理链说明 "
  + "1. **动机链**：起点A1（账房撕页账册）→A2→B13→B24 2. **手法链**：B11→B4→B7→B21 "
  + "3. **时间链**：A14→A17→B15→B23";

test("真实事故样本：推理链被剥离，线索本体保留", () => {
  const out = stripReasoningChain(REAL);
  assert.ok(!hasReasoningChain(out), "剥离后不应再含推理链小节");
  assert.ok(out.includes("账房抽屉的锁孔有新鲜的钥匙插拔痕迹"), "线索本体必须保留");
  assert.ok(!out.includes("动机链"), "动机链必须剥掉（剧透）");
  assert.ok(!out.includes("---"), "分隔线要一起清掉");
});

test("不同标题写法都能剥（推理链/证据链/定案链/线索总结）", () => {
  for (const head of ["## 推理链说明", "### 推理链总结", "## 推理链", "## 证据链", "## 定案链", "## 线索总结"]) {
    const s = `线索内容：桌角有一道划痕。 ${head} 1. 起点A1→B2`;
    const out = stripReasoningChain(s);
    assert.ok(!out.includes("起点A1"), `${head} 应被剥掉，实际：${out}`);
    assert.ok(out.includes("桌角有一道划痕"), `${head} 不能动线索本体`);
  }
});

test("正常线索原样返回（不得误伤）", () => {
  const good = "- 线索内容：窗沿留着一枚 42 码布鞋泥印，泥印里混有青苔。";
  assert.strictEqual(stripReasoningChain(good), good);
});

test("空输入安全", () => {
  assert.strictEqual(stripReasoningChain(""), "");
  assert.strictEqual(stripReasoningChain(null), "");
  assert.strictEqual(stripReasoningChain(undefined), "");
});

test("抽取推理链小结：内容不丢（留给 DM 侧）", () => {
  const chain = extractReasoningChain(REAL);
  assert.ok(chain.includes("动机链"), "要能抽出小结原文");
  assert.ok(chain.includes("时间链"));
});

test("没有小结时抽取返回空串", () => {
  assert.strictEqual(extractReasoningChain("线索内容：什么都没有。"), "");
});
