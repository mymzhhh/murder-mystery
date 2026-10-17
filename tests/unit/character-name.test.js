// 角色名单的解析契约（纯函数，无 Redis/PG 依赖）
//
// 起因是一次真实事故：某剧本生成阶段写好了 4 玩家 + 3 NPC，切分后只剩 3 玩家 + 2 NPC。
// 丢的是 `玛格丽特·伦诺克斯`（9 字）与 `科尔姆·布莱斯`（7 字）—— 正好卡在
// 解析器旧的 `name.length > 6` 这一刀上。被丢的角色在游戏里**根本不存在**：
// 选角选不到、AI 补位补不上，而 DM 时间线却还在讲他。
//
// 这个文件同时钉两件事：
//   1) 长名字必须留下来（回归这次的事故）
//   2) 上限放宽之后，"说明文字当名字""占位符"仍然要被拒（放宽不等于不设防）
const test = require("node:test");
const assert = require("node:assert");
const {
  parseScript, cutCharacterName, isValidCharacterName, checkCharacterCoverage,
} = require("../../src/script/script-parser");
const { extractCharactersFallback } = require("../../src/script/murder-mystery-builder");

// ---- 实测那局的角色标题原样（灰雾庄园·密道回声）----
const HEADINGS = [
  ["### 玩家角色 1：休·格雷", "player", "休·格雷"],
  ["### 玩家角色 2：玛格丽特·伦诺克斯", "player", "玛格丽特·伦诺克斯"],   // 9 字，旧版被丢
  ["### 玩家角色 3：托马斯·里德", "player", "托马斯·里德"],
  ["### 玩家角色 4：朱利安·佩恩", "player", "朱利安·佩恩"],
  ["### NPC 1：安格斯·莫罗", "npc", "安格斯·莫罗"],
  ["### NPC 2：薇拉·哈罗兰 [凶手]", "npc", "薇拉·哈罗兰"],
  ["### NPC 3：科尔姆·布莱斯", "npc", "科尔姆·布莱斯"],                    // 7 字，旧版被丢
];

function buildMd(lines) {
  return [
    "# 《灰雾庄园·密道回声》",
    "",
    "## 凶手设定",
    "- 凶手姓名：薇拉·哈罗兰",
    "",
    ...lines,
    "",
    "## 线索系统",
    "### A1：",
    "- 线索内容：门锁完好。",
  ].join("\n");
}

test("实测那局：4 玩家 + 3 NPC 一个都不能少（回归：旧版丢掉 9 字与 7 字名字）", () => {
  const p = parseScript(buildMd(HEADINGS.map(h => h[0])));
  const names = p.characters.map(c => c.name);
  assert.strictEqual(p.characters.length, 7, `应解析出 7 个角色，实际 ${names.join("、")}`);
  assert.ok(names.includes("玛格丽特·伦诺克斯"), "9 字玩家名被丢了");
  assert.ok(names.includes("科尔姆·布莱斯"), "7 字 NPC 名被丢了");

  const players = p.characters.filter(c => c.roleType === "player");
  const npcs = p.characters.filter(c => c.roleType === "npc");
  assert.strictEqual(players.length, 4, `应为 4 玩家，实际 ${players.length}`);
  assert.strictEqual(npcs.length, 3, `应为 3 NPC，实际 ${npcs.length}`);
  // 凶手标记仍在（[凶手] 后缀不该影响判定）
  const killer = p.characters.find(c => c.name === "薇拉·哈罗兰");
  assert.ok(killer && killer.isMurderer, "凶手没被标记");
});

test("cutCharacterName：切掉说明文字与身份后缀，只留名字本体", () => {
  assert.strictEqual(cutCharacterName("玛格丽特·伦诺克斯"), "玛格丽特·伦诺克斯");
  assert.strictEqual(cutCharacterName("薇拉·哈罗兰 [凶手]"), "薇拉·哈罗兰");
  assert.strictEqual(cutCharacterName("薇拉·哈罗兰【凶手】"), "薇拉·哈罗兰");
  assert.strictEqual(cutCharacterName("格雷（男，35岁，庄园管家）"), "格雷");
  assert.strictEqual(cutCharacterName("托马斯·里德，男性，29岁"), "托马斯·里德");
  assert.strictEqual(cutCharacterName("  休·格雷  "), "休·格雷");
});

test("isValidCharacterName：放宽到 12 字，但垃圾仍要拒", () => {
  assert.strictEqual(isValidCharacterName("玛格丽特·伦诺克斯"), true, "9 字真名字必须通过");
  assert.strictEqual(isValidCharacterName("凯瑟琳·冯·霍亨索伦三世"), true, "12 字是边界（含边界）");
  assert.strictEqual(isValidCharacterName("亚历山德琳娜·玛丽亚·冯·哈布斯堡"), false, "17 字超出上限");
  assert.strictEqual(isValidCharacterName("甲"), false, "1 字太短");
  assert.strictEqual(isValidCharacterName(""), false);
  assert.strictEqual(isValidCharacterName(null), false);
  assert.strictEqual(isValidCharacterName("嫌疑人甲"), false, "占位符/说明文字不该当名字");
  assert.strictEqual(isValidCharacterName("凶手"), false);
  assert.strictEqual(isValidCharacterName("格雷（男，35岁）"), false, "切之前的整段不算名字");
});

test("兜底方法B（**姓名** 列表）：长名字不被丢", () => {
  // 必须保证方法A 抓不到（没有 `### 玩家角色N / NPC N / 角色N` 标题），否则 A 抓到就跳过 B
  const md = [
    "# 《灰雾庄园·密道回声》", "",
    "## 角色设定",
    "- **姓名**：玛格丽特·伦诺克斯",
    "- **与死者关系**：侄女", "",
    "- **姓名**：科尔姆·布莱斯",
    "- **职业/身份**：马车夫",
  ].join("\n");
  const names = parseScript(md).characters.map(c => c.name);
  assert.ok(names.includes("玛格丽特·伦诺克斯"), `方法B 丢了名字：${names.join("、")}`);
  assert.ok(names.includes("科尔姆·布莱斯"), `方法B 丢了名字：${names.join("、")}`);
});

test("兜底方法C（无编号的角色标题）：长名字不被丢", () => {
  const md = ["# 《灰雾庄园·密道回声》", "", "## 角色设定", "", "### 角色：科尔姆·布莱斯"].join("\n");
  const names = parseScript(md).characters.map(c => c.name);
  assert.ok(names.includes("科尔姆·布莱斯"), `方法C 丢了名字：${names.join("、")}`);
});

test("生成链路兜底：正则不再把 9 字名字截成 6 字", () => {
  const fw = [
    "玩家1：休·格雷",
    "玩家2：玛格丽特·伦诺克斯",
    "玩家3：托马斯·里德",
    "玩家4：朱利安·佩恩",
    "NPC1：安格斯·莫罗",
    "NPC2：薇拉·哈罗兰",
    "NPC3：科尔姆·布莱斯",
    "凶手姓名：薇拉·哈罗兰",
  ].join("\n");
  const chars = extractCharactersFallback(fw, 7);
  const names = chars.map(c => c.name);
  assert.strictEqual(chars.length, 7, `应提取 7 个角色：${names.join("、")}`);
  assert.ok(names.includes("玛格丽特·伦诺克斯"), `名字被截断了：${names.join("、")}`);
  assert.ok(!names.some(n => n === "玛格丽特·伦"), "旧版会截成 6 字，必须不再出现");
  const killer = chars.find(c => c.name === "薇拉·哈罗兰");
  assert.ok(killer && killer.isMurderer, "7 字凶手名没被标出来（结局判定会因此永远判错）");
});

test("生成链路兜底：名字后面跟说明文字时只取名字", () => {
  const fw = [
    "玩家1：休·格雷",
    "玩家2：格雷，男，35岁，庄园管家",
    "凶手姓名：薇拉·哈罗兰",
  ].join("\n");
  const chars = extractCharactersFallback(fw, 2);
  assert.ok(chars.find(c => c.name === "格雷"), `应切出"格雷"：${chars.map(c => c.name).join("、")}`);
  assert.ok(!chars.find(c => c.name.startsWith("格雷，")), "说明文字不该混进名字");
});

test("护栏 checkCharacterCoverage：标题里有的角色没解析出来就要报缺口", () => {
  const good = buildMd(HEADINGS.map(h => h[0]));
  const c1 = checkCharacterCoverage(good, parseScript(good).characters);
  assert.strictEqual(c1.headingCount, 7);
  assert.strictEqual(c1.parsedCount, 7);
  assert.strictEqual(c1.dropped, 0, "7 个标题都对上了，不该报缺口");

  // 造一个解析器必定拒掉的名字（1 字），护栏必须把这个缺口报出来
  const bad = buildMd([...HEADINGS.map(h => h[0]), "### NPC 4：甲"]);
  const c2 = checkCharacterCoverage(bad, parseScript(bad).characters);
  assert.strictEqual(c2.headingCount, 8);
  assert.strictEqual(c2.parsedCount, 7);
  assert.strictEqual(c2.dropped, 1, "少了一个角色就必须报出来（这类丢人以前是静默的）");
});
