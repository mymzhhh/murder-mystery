// 验证 script-parser 对两轮剧本的基本契约（无 Redis/PG 依赖）
const test = require("node:test");
const assert = require("node:assert");
const { parseScript } = require("../modules/script-parser");

test("两轮线索剧本：按 ## 第X轮 标题分轮正确", () => {
  const md = `# 线索系统
导读……
## 第一轮线索
### A1：
- 线索类型：痕迹
- 发现地点：书房地板
- 线索内容：地板中央有一道水渍痕迹。
### A2：
- 线索类型：人证
- 发现地点：周管家
- 线索内容：周管家左手手背有一块烧伤疤痕。
## 第二轮线索
### B1：
- 线索类型：文件（知识型线索）
- 发现地点：林医生药箱
- 线索内容：一张手写笔记，记载毒物发作时间。
### B2：
- 线索类型：物证
- 发现地点：书房座钟
- 线索内容：座钟后盖边缘有轻微撬动痕迹。`;
  const p = parseScript(md);
  const c = p.clues;
  assert.equal(c.round1.length, 2);
  assert.equal(c.round2.length, 2);
  assert.equal(c.round3.length, 0);
  assert.deepEqual(c.round1.map(x => x.id), ["A1", "A2"]);
  assert.deepEqual(c.round2.map(x => x.id), ["B1", "B2"]);
  for (const clue of [...c.round1, ...c.round2]) {
    assert.ok(clue.content, `线索 ${clue.id} 缺内容`);
    assert.ok(clue.location, `线索 ${clue.id} 缺地点`);
    assert.ok(clue.clueType, `线索 ${clue.id} 缺类型`);
  }
});

test("旧格式（无分轮标题）：按前缀兜底分轮 A→1, B/C/M→2", () => {
  const old = `# 线索系统
### A1：
- 线索类型：物证
- 发现地点：书房
- 线索内容：一把钥匙
### B1：
- 线索类型：文件
- 发现地点：大厅
- 线索内容：一封信
### C1：
- 线索类型：物证
- 发现地点：花园
- 线索内容：一把匕首
### M1：
- 线索类型：人证
- 发现地点：管家
- 线索内容：管家声称没离开`;
  const p = parseScript(old);
  const c = p.clues;
  assert.deepEqual(c.round1.map(x => x.id), ["A1"]);
  assert.deepEqual(c.round2.map(x => x.id).sort(), ["B1", "C1", "M1"]);
  assert.equal(c.round3.length, 0);
});

test("线索系统被其他章节紧跟时不被截断（回归：## 第一轮线索 标题误判）", () => {
  const md = `# 线索系统

线索共 2 条，分两轮发放。

## 第一轮线索

### A1：
- 线索类型：物证
- 发现地点：书房
- 线索内容：一把钥匙

## 第二轮线索

### B1：
- 线索类型：物证
- 发现地点：大厅
- 线索内容：一封烧毁的信

# 第四部分：DM 手册

## 一、游戏流程总览
| 第一轮搜证 | 30分钟 | 人物关系 |
| 第二轮搜证 | 30分钟 | 重推理 |`;
  const p = parseScript(md);
  const c = p.clues;
  assert.equal(c.round1.length, 1);
  assert.equal(c.round2.length, 1);
});

test("基本设定字段解析：兼容 CRLF 与加粗标签（游戏模式识别）", () => {
  const md = "# 剧本杀完整剧本\r\n\r\n# 第一部分：故事框架\r\n\r\n## 一、基本设定\r\n\r\n- **剧本名称**：测试剧本\r\n- **游戏模式**：PVE侦探对抗\r\n- **时代背景**：民国年间\r\n- **地点场景**：雾隐镇\r\n- **参与人数**：4名玩家\r\n";
  const p = parseScript(md);
  assert.equal(p.setting.era, "民国年间");
  assert.equal(p.setting.gameMode, "PVE");
  const mdPvp = md.replace("PVE侦探对抗", "PVP玩家互疑");
  assert.equal(parseScript(mdPvp).setting.gameMode, "PVP");
});