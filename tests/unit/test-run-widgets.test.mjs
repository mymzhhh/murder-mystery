// 「测试剧本」侧边栏小组件的契约（纯逻辑，无 DOM / 无 Redis / 无 PG）
//
// 这一层锁的是"管理员据此判断剧本好坏"的那几个数：
//   1) 阶段耗时与超时判据 —— 判错了两边都糟：把余量当超时会天天误报，漏报则看不出哪一段拖时间；
//   2) 公屏聚合 —— 各项之和必须恒等于总条数（报告里要拿它和"公屏实录 N 条"对账）；
//   3) 票型 —— 平局/投错/投对要能一眼分辨；
//   4) 与死者的关系 —— 取不到就得是空串，绝不能编（名册掺假等于白查）。
import test from "node:test";
import assert from "node:assert";
import {
  fmtClock, phaseSteps, phaseStep, classifyChat, tallyStream, voteRows, relationText,
  identityText, furthestPhase, TEST_PHASE_ORDER, OVER_MARGIN_MS,
} from "../../frontend/src/lib/test-run-widgets.mjs";

test("fmtClock：非法值与负数显示占位，不把 NaN 打到界面上", () => {
  assert.strictEqual(fmtClock(0), "0:00");
  assert.strictEqual(fmtClock(32_400), "0:32");
  assert.strictEqual(fmtClock(184_000), "3:04");
  assert.strictEqual(fmtClock(3_600_000), "60:00");
  assert.strictEqual(fmtClock(null), "—");
  assert.strictEqual(fmtClock(undefined), "—");
  assert.strictEqual(fmtClock(NaN), "—");
  assert.strictEqual(fmtClock(-5), "—");
  assert.strictEqual(fmtClock("abc"), "—");
});

test("phaseSteps：按真实 phaseLog 算各段耗时（用 CXSCPC 的真实形状）", () => {
  // 这就是 CXSCPC 落库的那串：10 分钟一阶段，且**跳过了 truth_reveal 直接落 finished**
  const phaseMs = 600_000;
  const log = [
    { phase: "reading", at: 1_792_228_611_476 },
    { phase: "round1", at: 1_792_228_644_653 },
    { phase: "round2", at: 1_792_229_247_698 },
    { phase: "voting", at: 1_792_229_850_675 },
    { phase: "finished", at: 1_792_230_453_652 },
  ];
  const { rows, elapsedMs } = phaseSteps(log, { phaseMs, finished: true, now: 9_999_999_999_999 });
  assert.strictEqual(rows.length, 5, "有几段画几段：不按固定阶段表补行");
  assert.strictEqual(rows[0].ms, 33_177, "reading 实际 33 秒（服务端 30 秒 + 3 秒余量）");
  assert.strictEqual(rows[1].ms, 603_045);
  assert.strictEqual(rows[4].phase, "finished");
  assert.strictEqual(rows[4].ms, null, "最后一段已结束 → 结束时刻不可知，显示 null 而不是编一个数");
  assert.strictEqual(rows[4].running, false);
  assert.strictEqual(rows.every((r) => !r.over), true, "3 秒余量不许被算成超时（这是最开始会误报的地方）");
  assert.strictEqual(rows[0].nominal, null, "reading 的设定时长不在 meta 里 → 不参与超时判断");
  assert.strictEqual(rows[1].nominal, phaseMs);
  // 已跑总时长在"已结束"时用各段之和，不能跟着 now 一直涨
  assert.strictEqual(elapsedMs, 33_177 + 603_045 + 602_977 + 602_977);
  const later = phaseSteps(log, { phaseMs, finished: true, now: 9_999_999_999_999 + 86_400_000 });
  assert.strictEqual(later.elapsedMs, elapsedMs, "已结束的局，隔一天再看总时长不变");
});

test("phaseSteps：真正拖时间的阶段才标 over（阈值 = 设定时长 + 余量）", () => {
  const phaseMs = 60_000;
  const log = [{ phase: "round1", at: 1000 }, { phase: "round2", at: 1000 + phaseMs + OVER_MARGIN_MS + 12_000 }, { phase: "voting", at: 1 }];
  const { rows } = phaseSteps(log, { phaseMs, finished: false, now: 999_999 });
  assert.strictEqual(rows[0].over, true);
  assert.strictEqual(rows[0].deltaMs, OVER_MARGIN_MS + 12_000);
  const justUnder = phaseSteps([{ phase: "round1", at: 0 }, { phase: "round2", at: phaseMs + OVER_MARGIN_MS }], { phaseMs });
  assert.strictEqual(justUnder.rows[0].over, false, "刚好到阈值不算超时（边界只许一个方向）");
});

test("phaseSteps：在跑的最后一段用 now 算，且脏输入不抛", () => {
  const now = 100_000;
  const { rows, elapsedMs } = phaseSteps([{ phase: "reading", at: 40_000 }, { phase: "round1", at: 70_000 }], { now, phaseMs: 60_000 });
  assert.strictEqual(rows[1].running, true);
  assert.strictEqual(rows[1].ms, 30_000);
  assert.strictEqual(elapsedMs, 60_000);
  for (const bad of [null, undefined, "", 42, {}, [{ at: 1 }], [{ phase: "" }], "nope"]) {
    const r = phaseSteps(bad, { now, phaseMs: 1000 });
    assert.strictEqual(Array.isArray(r.rows), true);
    assert.strictEqual(r.rows.length, 0);
  }
  const noNow = phaseSteps([{ phase: "voting", at: 5 }], {});
  assert.strictEqual(noNow.rows[0].ms, null, "没有 now 时不能拿 0 去减，得显示未知");
});

test("phaseStep：认得出就是第 n/m 步，认不出返回 null（不硬编数字）", () => {
  assert.deepStrictEqual(phaseStep("reading"), { index: 1, total: TEST_PHASE_ORDER.length });
  assert.deepStrictEqual(phaseStep("voting"), { index: 4, total: TEST_PHASE_ORDER.length });
  assert.strictEqual(phaseStep("lobby"), null);
  assert.strictEqual(phaseStep(""), null);
  assert.strictEqual(phaseStep(undefined), null);
});

test("phaseSteps：登记落后于实际阶段时标 stale，且不误报超时（实测 XMHQLS 就是这个情形）", () => {
  // 真实情形：AI 全投完票 → vote-advance 直接推到 truth_reveal 并广播 truth_revealed，
  // 而测试房的登记要等自己的计时器（阶段时长 + 3 秒）才写上投票段的结束。
  // 于是页面上"真相已经出来"，最后一段却还写着"投票进行中"，且已过时间 > 设定时长。
  const phaseMs = 60_000;
  const log = [
    { phase: "reading", at: 0 },
    { phase: "round1", at: 33_000 },
    { phase: "round2", at: 96_000 },
    { phase: "voting", at: 159_000 },
  ];
  const now = 159_000 + 100_000;              // 投票段已过 100 秒（> 60+8 秒阈值），但真相早就到了
  const lagging = phaseSteps(log, { phaseMs, now, currentPhase: "truth_reveal", finished: false });
  const last = lagging.rows[lagging.rows.length - 1];
  assert.strictEqual(last.phase, "voting");
  assert.strictEqual(last.running, true);
  assert.strictEqual(last.stale, true, "实际阶段已经更靠后 → 这一段是登记落后");
  assert.strictEqual(last.ms, 100_000, "耗时仍要显示（开始时刻距今多久是真的）");
  assert.strictEqual(last.over, false, "登记落后不能报超时：这一段其实早结束了");
  // 反过来：登记阶段**就是**当前阶段时，超时该报就得报
  const stuck = phaseSteps(log, { phaseMs, now, currentPhase: "voting", finished: false });
  assert.strictEqual(stuck.rows[3].stale, false);
  assert.strictEqual(stuck.rows[3].over, true, "真的卡在投票段必须报出来");
  // 没给 currentPhase（不知道实际阶段）→ 不标 stale，保持原有判断
  assert.strictEqual(phaseSteps(log, { phaseMs, now, finished: false }).rows[3].stale, false);
});

test("furthestPhase：取最靠后的那一路上报的阶段（真相到了就不许还显示投票）", () => {
  assert.strictEqual(furthestPhase(["voting", "truth_reveal", ""]), "truth_reveal");
  assert.strictEqual(furthestPhase(["finished", "voting"]), "finished");
  assert.strictEqual(furthestPhase([null, undefined, "round1"]), "round1");
  assert.strictEqual(furthestPhase(["lobby", "怪阶段", ""]), "", "认不出的阶段一律不算数");
  assert.strictEqual(furthestPhase([]), "");
  assert.strictEqual(furthestPhase(null), "");
});

test("identityText：职业为空时退到正文首句，且跳过三类模板噪声", () => {
  // 实测《再见卡门》三个角色的前两行就是这样：先来一句温馨提醒，再来个【】小节标题
  const zhan = {
    name: "占卜师", occupation: "",
    script: "占卜师\n【第一幕  初识】\n我是塞维利亚的一名占卜师，平时穿着一件黑色的长袍，在自己昏暗狭小的帐篷里为人们占卜命运。\n后面还有内容",
  };
  const a = identityText(zhan);
  assert.strictEqual(a.from, "script");
  assert.match(a.text, /占卜师/);
  assert.strictEqual(a.text.includes("【"), false);
  assert.strictEqual(a.text.length <= 47, true, "截断到 46 字 + 省略号");
  const tang = identityText({ name: "唐·何塞", script: "（温馨提示：看完剧本前请勿与其他玩家交流）\n【第一幕  初识】\n我叫唐·何塞，是塞维利亚的一名骑士。" });
  assert.strictEqual(tang.text, "我叫唐·何塞，是塞维利亚的一名骑士。");
  // 有结构化职业就用它
  assert.deepStrictEqual(identityText({ name: "A", occupation: "歌女", script: "正文" }), { text: "歌女", from: "occupation" });
  // 什么都取不到 → none（页面据此显示占位，不编）
  assert.deepStrictEqual(identityText({ name: "A", script: "A\n【标题】" }), { text: "", from: "none" });
  assert.deepStrictEqual(identityText(null), { text: "", from: "none" });
});

test("classifyChat：判据来自服务端真实文本前缀（投票不许被算成发言）", () => {
  assert.strictEqual(classifyChat("❓ 我想问 何秀云：你昨晚在哪？"), "asked");
  assert.strictEqual(classifyChat("🤖 我投票给 何秀云"), "voted");
  assert.strictEqual(classifyChat("🤖 我在账房发现了半张烧焦的票据"), "fallback");
  assert.strictEqual(classifyChat("我昨晚一直在后台没离开过"), "spoke");
  assert.strictEqual(classifyChat(""), "spoke");
  assert.notStrictEqual(classifyChat("🤖 我投票给 A"), "fallback", "投票比兜底发言先判");
});

test("tallyStream：各项之和恒等于总条数（报告要拿它对账）", () => {
  const stream = [
    { kind: "phase", text: "进入「阅读剧本」" },
    { kind: "chat", text: "何秀云：我先说" },
    { kind: "chat", text: "张明：❓ 我想问 何秀云：你去过账房吗？" },
    { kind: "chat", text: "何秀云：🤖 我在账房发现了半张烧焦的票据" },
    { kind: "chat", text: "张明：🤖 我投票给 何秀云" },
    { kind: "chat", text: "张明：我还想问一句" },
    { kind: "narrative", text: "DM：烛火摇曳" },
    { kind: "truth", text: "真相揭晓：真凶 何秀云（true_accusation）" },
    { kind: "aiError", text: "AI 异常：timeout" },
    { kind: "report", text: "报告已生成" },
  ];
  const t = tallyStream(stream);
  assert.strictEqual(t.total, stream.length);
  assert.strictEqual(t.kinds.reduce((a, k) => a + k.n, 0), t.total, "按 kind 求和必须等于总数");
  assert.strictEqual(t.byKind.chat, 5);
  assert.strictEqual(t.chat.total, 5);
  assert.strictEqual(t.chat.spoke + t.chat.fallback + t.chat.asked + t.chat.voted, t.chat.total, "四种分类之和 === chat 总数");
  assert.strictEqual(t.chat.spoke, 2);
  assert.strictEqual(t.chat.asked, 1);
  assert.strictEqual(t.chat.voted, 1);
  assert.strictEqual(t.chat.fallback, 1);
  const he = t.speakers.find((s) => s.name === "何秀云");
  assert.deepStrictEqual({ talk: he.talk, asked: he.asked, voted: he.voted, fallback: he.fallback, chat: he.chat },
    { talk: 2, asked: 0, voted: 0, fallback: 1, chat: 2 }, "兜底发言也算说过话");
  const zhang = t.speakers.find((s) => s.name === "张明");
  assert.deepStrictEqual({ talk: zhang.talk, asked: zhang.asked, voted: zhang.voted, chat: zhang.chat },
    { talk: 1, asked: 1, voted: 1, chat: 3 }, "提问与投票都不算「发言」（talk），但它们仍是公屏条目");
  assert.strictEqual(t.speakers.reduce((a, s) => a + s.chat, 0), t.chat.total - t.chat.unnamed);
  // 非 chat 的 kind 不许污染发言人表
  assert.strictEqual(t.speakers.some((s) => s.name.includes("DM")), false);
  // 排序：发言多的在前
  assert.strictEqual(t.speakers[0].name, "张明");
});

test("tallyStream：没有名字前缀/脏输入都不能把「没说话」算错", () => {
  const t = tallyStream([
    { kind: "chat", text: "没有冒号的整句" },
    { kind: "chat", text: "：只有冒号" },
    { kind: "chat" },
    null, 0, "x", { kind: "chat", text: "李四：好" },
  ]);
  assert.strictEqual(t.total, 4, "非对象条目跳过（null/0/\"x\" 都不算公屏条目）");
  assert.strictEqual(t.chat.total, 4);
  assert.strictEqual(t.chat.unnamed, 3, "解析不出名字的归到 unnamed，不冒充某个人在说话");
  assert.strictEqual(t.speakers.length, 1);
  assert.strictEqual(t.speakers[0].name, "李四");
  assert.strictEqual(t.speakers[0].talk, 1);
  const empty = tallyStream(null);
  assert.strictEqual(empty.total, 0);
  assert.deepStrictEqual(empty.speakers, []);
});

test("voteRows：按票数排序、标出最高票与真凶（平局全标）", () => {
  const t = voteRows({ murdererName: "何秀云", outcome: "wrong_accusation", description: "玩家指认了 张明", votes: { 张明: 2, 何秀云: 1, 李四: 1 } });
  assert.strictEqual(t.hasVotes, true);
  assert.strictEqual(t.rows[0].name, "张明");
  assert.strictEqual(t.rows[0].isTop, true);
  assert.strictEqual(t.rows[0].isMurderer, false);
  assert.strictEqual(t.rows.find((r) => r.name === "何秀云").isMurderer, true);
  assert.strictEqual(t.outcomeText, "指认错误");
  assert.strictEqual(t.desc, "玩家指认了 张明");
  const tie = voteRows({ murdererName: "A", outcome: "tie", votes: { A: 2, B: 2 } });
  assert.deepStrictEqual(tie.rows.map((r) => r.isTop), [true, true], "平局时并列最高票都标出来");
  assert.strictEqual(tie.top, "A");
});

test("voteRows：真相还没出来时给空结果（页面据此显示占位，不当成「零票」）", () => {
  for (const bad of [null, undefined, {}, { votes: null }, { votes: "3" }, { votes: [] }, { votes: { A: "x" } }]) {
    const t = voteRows(bad);
    assert.strictEqual(t.hasVotes, false);
    assert.deepStrictEqual(t.rows, []);
  }
  const noVotes = voteRows({ murdererName: "A", outcome: "no_votes", votes: {}, description: "无人投票，真相永远成谜。" });
  assert.strictEqual(noVotes.hasVotes, false);
  assert.strictEqual(noVotes.outcomeText, "无人投票");
  assert.strictEqual(noVotes.desc, "无人投票，真相永远成谜。", "结局文案要留着：它解释了「为什么没有票型」");
});

test("relationText：三种角色剧本形态都要取对，取不到就返回空串", () => {
  // NPC 目击者/嫌疑人形态
  const npc = [
    "# 王五 [NPC嫌疑人]", "",
    "### 一、人物关系", "王五与死者卡门是**主仆**关系，明面上恭顺，暗中挪用过卡门的钱。", "",
    "### 二、作案动机", "被卡门发现挪用账目的当晚被威胁报官。",
  ].join("\n");
  const r1 = relationText(npc);
  assert.match(r1, /主仆/);
  assert.strictEqual(r1.includes("**"), false, "markdown 加粗要去掉");
  assert.strictEqual(/动机|报官/.test(r1), false, "只取关系这一节，不能把下一节吞进来");

  // 单人侦探形态（小节名不同）
  const solo = "### 二、你与死者的关系\n我是卡门的旧识，三年前她替我担保过一笔债。\n### 三、你掌握的初步信息\n别的内容";
  assert.match(relationText(solo), /旧识/);

  // PVP 玩家形态：关系揉在背景故事里，没有独立小节 → 必须是空串（绝不编）
  const pvp = "### 一、你的背景故事\n我叫卡门，是这间酒馆的老板娘……";
  assert.strictEqual(relationText(pvp), "");

  // 全局「角色关系图」小节不是"我与死者的关系"，不能被当成关系文案
  assert.strictEqual(relationText("## 七、角色关系图\nA 与 B 有恩怨"), "");

  for (const bad of [null, undefined, 42, {}]) assert.strictEqual(relationText(bad), "");
  assert.match(relationText("### 关系\n" + "长".repeat(300)), /…$/, "超长要截断并加省略号");
  assert.strictEqual(relationText("### 关系\n![图](img:x-1)\n短句").includes("img:"), false, "图片行不是关系文字");
});
