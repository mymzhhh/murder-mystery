// 角色标题完整性：标题行是切分的唯一锚点，丢了就等于丢角色。
//
// 实测事故（2026-10-19《沪西照相馆除夕谜案》）：
// 定向修订/整段重写把 `### 玩家角色 3：林小满` 这一行吃掉了，她的正文变成
// **没有归属的孤儿段**留在别人后面；切分后库里只有 3 个角色，而生成时报的是 4 人
// —— 玩家选角选不到她、AI 也补不上位，整本少一个人。
const test = require("node:test");
const assert = require("node:assert");
const {
  isCharacterHeadingLine, repairMissingCharacterHeadings,
} = require("../../src/script/murder-mystery-builder.js");

const CHARS = [
  { name: "陈阿生", type: "player", isMurderer: true },
  { name: "张秀娥", type: "player" },
  { name: "林小满", type: "player" },
  { name: "王大富", type: "player" },
];

test("标题行识别要宽松（可选空格、半角冒号）", () => {
  assert.ok(isCharacterHeadingLine("### 玩家角色 3：林小满"));
  assert.ok(isCharacterHeadingLine("### 玩家角色3：林小满"));
  assert.ok(isCharacterHeadingLine("### 玩家角色3:林小满"));
  assert.ok(isCharacterHeadingLine("### NPC 1：周管家"));
  assert.ok(!isCharacterHeadingLine("### 一、你的背景故事"), "子标题不是角色标题");
  assert.ok(!isCharacterHeadingLine("### 玩家角色 3："), "没有名字不算");
});

test("标题被吃掉 + 正文成了孤儿段 → 补回标题（真实事故形态）", () => {
  const text = [
    "# 第二部分：人物角色",
    "## 玩家角色剧本",
    "",
    "### 玩家角色 1：陈阿生 [凶手]",
    "### 一、你的背景故事",
    "我是帮工。",
    "### 玩家角色 2：张秀娥",
    "### 一、你的背景故事",
    "我是老板娘。",
    "### 玩家角色 4：王大富",
    "### 一、你的背景故事",
    "我是账房。",
    // ↓ 这里本该有 `### 玩家角色 3：林小满`，被修订吃掉了
    "### 一、你的背景故事",
    "我是学徒林小满。",
    "# 第三部分：线索系统",
  ].join("\n");
  const r = repairMissingCharacterHeadings(text, CHARS);
  assert.deepStrictEqual(r.fixed.map((f) => f.name), ["林小满"]);
  assert.ok(r.text.includes("### 玩家角色 3：林小满"), "要补回带正确序号与名字的标题");
  assert.ok(r.text.includes("我是学徒林小满。"), "正文不能动");
  // 标题必须在孤儿段之前
  assert.ok(r.text.indexOf("### 玩家角色 3：林小满") < r.text.indexOf("我是学徒林小满。"));
});

test("标题都在时一个字都不改", () => {
  const text = CHARS.map((c) => `### 玩家角色 1：${c.name}\n### 一、你的背景故事\n内容`).join("\n");
  const r = repairMissingCharacterHeadings(text, CHARS);
  assert.strictEqual(r.fixed.length, 0);
  assert.strictEqual(r.text, text);
});

test("没有孤儿段时不做危险插入（宁可不动）", () => {
  // 少一个标题，但也找不到孤儿段 → 不能瞎补到别处
  const text = [
    "### 玩家角色 1：陈阿生 [凶手]",
    "### 一、你的背景故事",
    "甲",
    "### 玩家角色 2：张秀娥",
    "### 一、你的背景故事",
    "乙",
  ].join("\n");
  const r = repairMissingCharacterHeadings(text, CHARS);
  assert.strictEqual(r.text, text, "找不到孤儿段就保持原样");
});

test("凶手标题要带 [凶手] 标记", () => {
  const text = ["### 一、你的背景故事", "甲的正文"].join("\n");
  const r = repairMissingCharacterHeadings(text, [CHARS[0]]);
  assert.ok(r.text.includes("[凶手]"), "凶手标记不能丢");
});

test("多个缺失按名单顺序与孤儿段顺序配对", () => {
  const text = [
    "### 玩家角色 1：陈阿生 [凶手]",
    "### 一、你的背景故事", "甲",
    "### 一、你的背景故事", "乙",
    "### 一、你的背景故事", "丙",
  ].join("\n");
  const chars = [CHARS[0], { name: "乙乙" }, { name: "丙丙" }];
  const r = repairMissingCharacterHeadings(text, chars);
  assert.deepStrictEqual(r.fixed.map((f) => f.name), ["乙乙", "丙丙"]);
});

test("真实成稿形态：标题与正文之间夹着元数据行/凶手提示，不得误判成孤儿", () => {
  // 这正是 assembleScript 的真实输出形态：
  //   ### 玩家角色 1：陈阿生 [凶手]
  //   > ⚠️ 你就是凶手！…
  //
  //   > 职业/身份：… ｜ 语气：… ｜ 个人任务：…
  //
  //   ### 一、你的背景故事
  // 第一版只跳过空行，于是**每个角色都被判成孤儿**，标题会被插到别人正文前面。
  const text = [
    "### 玩家角色 1：陈阿生 [凶手]",
    "> ⚠️ 你就是凶手！你的处境与真实过程见下方剧本。",
    "",
    "> 职业/身份：照相馆帮工 ｜ 语气：语速偏快 ｜ 个人任务：隐瞒",
    "",
    "",
    "### 一、你的背景故事",
    "我叫陈阿生。",
    "### 玩家角色 2：张秀娥",
    "> 职业/身份：裁缝铺老板",
    "",
    "### 一、你的背景故事",
    "我是张秀娥。",
    // 林小满的标题被吃掉，正文孤儿
    "",
    "### 一、你的背景故事",
    "我是林小满。",
  ].join("\n");
  const r = repairMissingCharacterHeadings(text, [
    { name: "陈阿生", type: "player", isMurderer: true },
    { name: "张秀娥", type: "player" },
    { name: "林小满", type: "player" },
  ]);
  assert.deepStrictEqual(r.fixed.map((f) => f.name), ["林小满"], "只该补林小满一个");
  assert.ok(r.text.includes("### 玩家角色 3：林小满"));
  // 补的标题必须紧邻林小满的正文，而不是插到陈阿生前面
  const idx = r.text.indexOf("### 玩家角色 3：林小满");
  assert.ok(r.text.slice(idx, idx + 200).includes("我是林小满"), "标题要紧邻她的正文");
  assert.ok(r.text.indexOf("我叫陈阿生") < r.text.indexOf("### 玩家角色 3：林小满"), "不能插到最前面");
});
