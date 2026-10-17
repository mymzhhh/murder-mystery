// 时间线解析（前端纯逻辑 frontend/src/lib/player-timeline.mjs）。
//
// 这一份与后端 `src/script/timeline-utils.js` 是**同一套规则的两处实现**（前后端不能互相 require），
// 所以必须各有一份测试钉住，且用例要一一对应 —— 否则就会出现"页面上有时间线、体检却说没有"
// 这类最难查的问题（本项目为此专门写过注释警告）。
//
// 本轮真正修的东西：标题识别原来只认 markdown `#`，真实剧本用 `【…时间线…】` / `**时间线**`，
// 于是导入的真实剧本「全员时间线」永远是 0 个时刻。
import test from "node:test";
import assert from "node:assert";
import { timelineHeading, timelineLines, parseEntry, buildTimelineTable } from "../../frontend/src/lib/player-timeline.mjs";

test("标题识别：三种形态都认，并给出形态（形态决定条目容忍度）", () => {
  assert.deepStrictEqual(timelineHeading("### 二、你的时间线"), { kind: "md", level: 3, title: "二、你的时间线" });
  assert.strictEqual(timelineHeading("【三、时间线（严格遵循全局时间线，精确到分钟）】").kind, "bracket");
  assert.strictEqual(timelineHeading("**时间线**").kind, "bold");
  assert.strictEqual(timelineHeading("### 一、你的背景故事"), null);
  assert.strictEqual(timelineHeading(""), null);
  assert.strictEqual(timelineHeading(null), null);
});

test("标题识别：他人视角/基准类不算（含【】与加粗形态）", () => {
  for (const h of ["### 真实时间线", "【完整时间线】", "**故事时间线**", "### 上帝时间线", "【表面时间线】"]) {
    assert.strictEqual(timelineHeading(h), null, `${h} 不该被当成角色自己的时间线`);
  }
});

test("小节边界：markdown 在下一个同级/更高级标题处结束", () => {
  const lines = timelineLines([
    "### 二、你的时间线",
    "- 20:30 在门口",
    "#### 小注",
    "- 21:00 上楼",          // 四级标题比三级更深 → 仍在节内
    "### 三、你的任务",
    "隐瞒。",
  ].join("\n"));
  assert.deepStrictEqual(lines.map((l) => l.trim()).filter(Boolean), ["- 20:30 在门口", "#### 小注", "- 21:00 上楼"]);
});

test("小节边界：【…】在下一个【…】处结束", () => {
  const lines = timelineLines([
    "【推荐自我介绍及时间线】",
    "我 23：50 目击了重要的事。",
    "【你的任务】",
    "隐瞒身份。",
  ].join("\n"));
  assert.deepStrictEqual(lines.map((l) => l.trim()).filter(Boolean), ["我 23：50 目击了重要的事。"]);
});

test("条目容忍度跟着标题形态走：markdown 节里散文行不认（零回归），【】节里认", () => {
  const prose = "我在门口等了很久，直到20:30才看见有人上楼。";
  // markdown 小节：生成的剧本该节全是条目，放宽会把正文里顺口提到的时刻也算进来
  assert.strictEqual(parseEntry(prose), null, "markdown 节不得把散文行当成条目");
  assert.ok(parseEntry("- " + prose), "条列式行照常认");
  // 【】小节：作者已经把这段放在"时间线"标题下了，那就是该书对该节的读法
  const e = parseEntry(prose, { allowProse: true });
  assert.ok(e, "【】节里的散文行要认");
  assert.strictEqual(e.time, "20:30");
});

test("parseEntry：正文开头不能被削掉（真实剧本散文条目的回归）", () => {
  // 实测 bug：原来的 `.replace(/^[^0-9]{0,12}/, "")` 本意是去掉"1月8日"这类日期前缀，
  // 却把散文开头最多 12 个非数字字符一起吞了 —— 占卜师那条被削成「卜师，与诸位萍水相逢…」。
  const prose = "我是塞维利亚德高望重的占卜师，23：50之后我目击了一些重要的事。";
  const e = parseEntry(prose, { allowProse: true });
  assert.ok(e.body.startsWith("我是塞维利亚德高望重的占卜师"), `开头被削掉了：${e.body}`);
  assert.ok(e.body.includes("目击"));

  // 日期前缀仍然要按原意去掉（生成稿的条目形态）
  const dated = parseEntry("- **2005年10月16日 20:30**：放映厅 — 在门口");
  assert.strictEqual(dated.time, "20:30");
  assert.ok(dated.body.startsWith("放映厅"), `日期前缀没去掉：${dated.body}`);
});

test("parseEntry：常见真实写法都能取到时刻与正文", () => {
  const cases = [
    ["- **10月16日 20:30**：放映厅 — 我在门口", "20:30"],
    ["- 21：05 在走廊", "21:05"],
    ["1. **22:10（座钟）** 上楼", "22:10"],
    ["（2）23:50之后目击", "23:50"],
  ];
  for (const [line, want] of cases) {
    const e = parseEntry(line);
    assert.ok(e, `应能解析：${line}`);
    assert.strictEqual(e.time, want, `时刻取错：${line}`);
  }
  assert.strictEqual(parseEntry("- 没有任何时刻的一行"), null);
  assert.strictEqual(parseEntry(""), null);
});

test("buildTimelineTable：真实剧本（【】+ 散文）与生成稿（### + 条目）混在一张表里", () => {
  const pack = {
    characters: [
      // 生成稿形态
      { name: "阿明", playerScript: "### 二、你的时间线\n- **10月16日 20:30**：放映厅 — 在门口\n- **10月16日 21:00**：走廊 — 上楼" },
      // 真实剧本形态（散文，带一个时刻）
      { name: "占卜师", playerScript: "【推荐自我介绍及时间线】\n我是占卜师，23：50之后我目击了一些重要的事。" },
      // 完全没有时间线
      { name: "旅人", playerScript: "### 一、你的背景故事\n我是旅人。" },
    ],
  };
  const { chars, times, table } = buildTimelineTable(pack);
  assert.strictEqual(chars.length, 3);
  assert.strictEqual(times.length, 3, `应汇总出 3 个不同时刻，实际 ${JSON.stringify(times)}`);
  assert.deepStrictEqual(times, ["20:30", "21:00", "23:50"], "按时间字符串序排列");
  const cell = (t, name) => table.find((r) => r.time === t).cells.find((c) => c.name === name).body;
  assert.ok(cell("20:30", "阿明").includes("放映厅"));
  assert.ok(cell("23:50", "占卜师").includes("目击"), "真实剧本的散文条目要进表");
  assert.strictEqual(cell("20:30", "占卜师"), "", "该角色这一时刻没交代 → 留空（页面显示 —）");
  assert.strictEqual(chars.find((c) => c.name === "旅人").noTimeline, true);
  assert.strictEqual(chars.find((c) => c.name === "阿明").noTimeline, false);
});

test("buildTimelineTable：脏输入不抛", () => {
  for (const bad of [null, undefined, {}, { characters: null }, [], { characters: [] }]) {
    const r = buildTimelineTable(bad);
    assert.deepStrictEqual(r.times, []);
    assert.deepStrictEqual(r.chars, []);
  }
  // 条目缺字段/空名要过滤掉，不能塞进表里
  const r = buildTimelineTable({ characters: [{ name: "", playerScript: "x" }, { name: "有名字没正文" }] });
  assert.strictEqual(r.chars.length, 0);
});
