// 单元测试：时间线一致性后处理（纯函数）
const test = require("node:test");
const assert = require("node:assert");
const { extractBaseline, extractTimelineSections, replaceSection, extractTableAfter, matchAnchor } = require("../modules/timeline-consistency");

const SAMPLE = `# 剧本杀完整剧本
## 六、故事时间线

| 时间 | 地点 | 事件 |
|------|------|------|
| 十九点三十 | 大门 | 两名侦探抵达，被迎入大厅 |
| 二十点五十五 | 书房 | 周管家端茶进入书房 |
| 二十二点四十 | 书房 | 尸体被发现 |

## 三、你的时间线（案发前24小时）

**18:00** 我抵达听松宅。

**21:00** 我独自在大厅抽烟。

# 第二部分：角色内容
### 玩家角色 1：某人
## 三、我的时间线（案发前24小时）

（表格等内容……）
`;

test("extractBaseline 从故事时间线表提取基准", () => {
  const base = extractBaseline(SAMPLE);
  assert.ok(base.length >= 3, "应提取出 3 行表格");
  assert.equal(base[0].time, "十九点三十");
  assert.ok(base[0].event.includes("侦探抵达"));
  // 表头行不应被纳入
  assert.ok(!base.some(b => b.time === "时间"));
});

test("extractTimelineSections 提取时间线章节（锚标题+正文）", () => {
  const secs = extractTimelineSections(SAMPLE);
  const anchors = secs.map(s => s.anchor);
  assert.ok(anchors.some(a => a.includes("你的时间线")));
  assert.ok(secs.some(s => s.content.includes("18:00")));
});

test("replaceSection 只替换锚标题下正文、保留标题与后续章节", () => {
  const out = replaceSection(SAMPLE, "## 三、你的时间线（案发前24小时）", "**17:00** 校正后的新时间线");
  assert.ok(out.includes("## 三、你的时间线（案发前24小时）"), "标题应保留");
  assert.ok(out.includes("17:00"), "新正文应生效");
  assert.ok(!out.includes("**18:00** 我抵达听松宅。"), "旧正文应被替换");
  assert.ok(out.includes("# 第二部分：角色内容"), "后续章节应保留");
});

test("replaceSection 锚点不存在返回 null", () => {
  assert.equal(replaceSection(SAMPLE, "不存在的标题"), null);
});

test("extractTableAfter 处理无表头格式", () => {
  const entries = extractTableAfter("### 真实时间线（DM掌握）\n\n| 20:55 | 书房 | 下毒 |\n| 21:06 | 书房 | 密室形成 |\n", /真实时间线/);
  assert.ok(entries.length >= 2);
  assert.ok(entries.some(e => e.event.includes("下毒")));
});

test("matchAnchor 容错匹配（空格/括号差异）", () => {
  const anchors = ["## 三、我的时间线（案发前24小时）", "### 四、完整时间线"];
  assert.equal(matchAnchor("## 三、我的时间线（案发前24小时）", anchors), anchors[0]);
  // LLM 常见变体：全角括号、多余空格、省略标题层级
  assert.equal(matchAnchor("## 三、我的时间线(案发前24小时)", anchors), anchors[0]);
  assert.equal(matchAnchor("三、我的时间线（案发前24小时）", anchors), anchors[0]);
  assert.equal(matchAnchor("### 四、完整时间线", anchors), anchors[1]);
  assert.equal(matchAnchor("不存在", anchors), null);
});