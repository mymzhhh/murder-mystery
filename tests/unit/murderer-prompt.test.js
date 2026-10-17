// 回归测试：凶手专属指令的结构约定
// 背景：这条指令历史上反复翻转——原始版让模型把真相"融入时间线"（导致时间线只剩一条），
// 我第一轮又改成"时间线只写伪装口径、真相只放凶手确认"（导致真相变成马后炮摘要）。
// 现行约定：凶手时间线＝真实经过；对外说辞另立；「凶手确认」保留原名但只做要点确认。
const test = require("node:test");
const assert = require("node:assert");
const { buildCharacterPrompt, MIN_TIMELINE_POINTS } = require("../../src/script/murder-mystery-builder");

const FW = "## 二、死者信息\n姓名与身份：荣宗耀\n";
const mk = (isMurderer, name = "白凤") =>
  buildCharacterPrompt({ name, occupation: "二姨太", isMurderer }, FW, 1, 6, false, null);

test("凶手指令：时间线写真实经过（不再是伪装口径）", () => {
  const p = mk(true);
  assert.ok(p.includes("写的是真实发生的经过"), "必须明确时间线＝真实经过");
  assert.ok(!p.includes("绝不要写进时间线"), "不得再要求把真相排除在时间线之外");
  assert.ok(!p.includes("伪装时间线"), "不得把时间线定义为伪装口径");
});

test("凶手指令：要求写清物品与目击（可被反推）", () => {
  const p = mk(true);
  assert.ok(p.includes("接触了哪些具体物品"), "必须要求写明所用物品");
  assert.ok(p.includes("看到谁、被谁看到、听到什么"), "必须要求写明目击关系");
  assert.ok(p.includes("与旁人同等密度的具体观察"), "作案窗口不能空转");
});

test("凶手指令：对外说辞单独成立且必须与真实动线冲突", () => {
  const p = mk(true);
  assert.ok(p.includes("对外说辞（统一口径）"), "必须给出对外说辞");
  assert.ok(p.includes("存在明确冲突"), "说辞必须与真实动线冲突以留下破绽");
});

test("凶手指令：保留「凶手确认」章节名（解析器依赖）", () => {
  const p = mk(true);
  assert.ok(p.includes("### 四、凶手确认"), "script-parser 靠该章节抽取 murderer.method，不得改名");
  assert.ok(p.includes("手法要点确认"), "该节应降级为要点确认而非真相唯一存放处");
  assert.ok(p.includes("禁止在此处马后炮式地补充"), "应明令禁止马后炮式补充");
});

test("非凶手玩家：不出现任何凶手专属内容", () => {
  const p = mk(false, "陈默");
  assert.ok(!p.includes("你是凶手"), "普通玩家不应看到凶手指令");
  assert.ok(!p.includes("凶手确认"), "普通玩家不应有凶手确认章节");
  assert.ok(!p.includes("对外说辞"), "普通玩家不需要对外说辞");
});

test("两种角色：占位符全部被替换，无残留", () => {
  for (const isM of [true, false]) {
    const p = mk(isM);
    assert.ok(!/\{(characterName|investigateTask|isMurdererExtra)\}/.test(p), `isMurderer=${isM} 仍有残留占位符`);
    // 三个必备章节标题（凶手多一个第四节）
    assert.ok(p.includes("### 一、你的背景故事"));
    assert.ok(p.includes("### 二、你的时间线"));
    assert.ok(p.includes("### 三、你的任务"));
  }
});

test("凶手指令：时间线受与普通玩家**同一条**条数约束（不得因是凶手而放宽）", () => {
  // ⚠️ 本测试在 2953d92（把模板从"至少 8 个"上调为"至少 12 个、下限 8"）之后**曾长期是红的**：
  // 它断言 `至少列出 8 个时间点`，而模板早已改成 12。当时没被发现，是因为那一次 npm test
  // 的工作目录传错了、匹配到 0 个测试而假绿。所以这里不再钉死某一句具体措辞，
  // 改为钉**真正的不变量**：两种角色的条数约束必须逐字相同，且下限与代码常量一致。
  const mur = mk(true), plain = mk(false);
  const grab = (s) => (s.match(/- \*\*时间线客观且完整\*\*[^\n]*/) || [""])[0];
  const line = grab(mur);
  assert.ok(line.length > 0, "「时间线客观且完整」约束行必须存在于两种角色的提示词里");
  assert.strictEqual(line, grab(plain), "凶手与普通玩家的时间线条数约束必须逐字相同，否则凶手那条会被静默放宽");
  assert.ok(line.includes(String(MIN_TIMELINE_POINTS)),
    `约束行里的下限必须等于 MIN_TIMELINE_POINTS=${MIN_TIMELINE_POINTS}（改模板时别忘改常量，或反之）`);
  assert.ok(/目标 12~25 条/.test(line), "目标条数（12~25）必须写明——只留下限会让模型贴着下限写");
});
