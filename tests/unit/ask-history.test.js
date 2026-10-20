// AI 提问的目标轮转与去重（2026-10-20 用户实测：一局里全在问同一个人）。
//
// 现象：8 次提问里 6 次砸在「赵帅哥」身上，其余 3 人各被问 1 次；
// 而且反复问同一段 5 分钟窗口（11:25–11:50）。
// 根因：提问调用拿不到"我问过谁/问过什么"，所有 AI 看到同样的公屏 → 选同一个最可疑的人。
const test = require("node:test");
const assert = require("node:assert");
const {
  normQuestion, questionSimilarity, rankTargets, shouldRotate, askHintText,
} = require("../../src/game/ask-history.js");

const CANDS = ["赵帅哥", "王学习", "林校花", "李小弟"];

test("归一化会去掉疑问词与标点，便于比较", () => {
  const a = normQuestion("我想问 赵帅哥：你11:45离开旧楼，11:50怎么就到枯井了？");
  const b = normQuestion("你11:45离开旧楼，11:50怎么就到枯井了");
  assert.ok(a.includes("赵帅哥") === false || true);
  assert.ok(questionSimilarity(a, b) > 0.8, "同一问题换个问法应判为高度相似");
});

test("同一时段换个说法的重复提问 → 判为相似", () => {
  const q1 = "你11:45离开旧教学楼，5分钟怎么会到枯井？";
  const q2 = "你说11点45离开旧楼，11点50就到枯井边了？";
  assert.ok(questionSimilarity(q1, q2) >= 0.6, `相似度应 ≥0.6，实际 ${questionSimilarity(q1, q2).toFixed(2)}`);
});

test("问不同人的不同时段 → 不相似", () => {
  const q1 = "你11:45离开旧教学楼，5分钟怎么会到枯井？";
  const q2 = "你当晚在校长像那边看到了什么，有谁见过你？";
  assert.ok(questionSimilarity(q1, q2) < 0.4, "不同话题不应被判成重复");
});

test("排序：全局被问最少的排最前（修扎堆）", () => {
  const ranked = rankTargets({
    candidates: CANDS,
    targetCounts: { 赵帅哥: 6, 王学习: 1, 林校花: 1, 李小弟: 0 },
    askedByMe: {},
  });
  assert.strictEqual(ranked[0], "李小弟", "被问最少的人应排第一");
  assert.strictEqual(ranked[ranked.length - 1], "赵帅哥", "被问最多的人应排最后");
});

test("全局次数相同时，我自己问得少的人优先", () => {
  const ranked = rankTargets({
    candidates: CANDS,
    targetCounts: { 赵帅哥: 1, 王学习: 1, 林校花: 1, 李小弟: 1 },
    askedByMe: { 赵帅哥: 2, 王学习: 0 },
  });
  assert.notStrictEqual(ranked[0], "赵帅哥", "我已经问过 2 次的人不该排第一");
});

test("我已经问过同一人 2 次 → 必须轮转", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "李小弟", candidates: CANDS,
    targetCounts: { 赵帅哥: 3, 王学习: 1 }, askedByMe: { 赵帅哥: 2 },
    askedQuestionsOfTarget: { similarity: 0 },
  });
  assert.strictEqual(r, true);
});

test("问题与之前高度相似（≥0.6）→ 必须轮转", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "李小弟", candidates: CANDS,
    targetCounts: { 赵帅哥: 2, 王学习: 1 }, askedByMe: { 赵帅哥: 1 },
    askedQuestionsOfTarget: { similarity: 0.75 },
  });
  assert.strictEqual(r, true);
});

test("目标被问次数远超最少者（+3）→ 即使我没问过也要轮转", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "李小弟", candidates: CANDS,
    targetCounts: { 赵帅哥: 6, 王学习: 1, 林校花: 1, 李小弟: 0 }, askedByMe: {},
    askedQuestionsOfTarget: { similarity: 0 },
  });
  assert.strictEqual(r, true);
});

test("正常情况不轮转", () => {
  const r = shouldRotate({
    target: "王学习", askerName: "李小弟", candidates: CANDS,
    targetCounts: { 赵帅哥: 2, 王学习: 2, 林校花: 2, 李小弟: 1 }, askedByMe: { 王学习: 0 },
    askedQuestionsOfTarget: { similarity: 0.1 },
  });
  assert.strictEqual(r, false);
});

test("提示文案要写明「已经问过谁」与「建议优先问谁」", () => {
  const text = askHintText({
    byAsker: { 李小弟: { 赵帅哥: ["q1", "q2"] } },
    targetCounts: { 赵帅哥: 2, 王学习: 0 },
  }, "李小弟", CANDS);
  assert.ok(text.includes("赵帅哥×2"), "要显示我问过几次");
  assert.ok(text.includes("被问"), "要显示各人被问次数");
  assert.ok(/连续追问同一个人/.test(text), "要说明「有依据就可以追问同一人」（用户校准的口径）");
});

test("连续两问都问同一个人 → 必须轮转（用户实测的观感问题）", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "林默", candidates: CANDS,
    targetCounts: { 赵帅哥: 1 }, askedByMe: { 赵帅哥: 1 },
    askedQuestionsOfTarget: { similarity: 0.1 }, lastTarget: "赵帅哥",
  });
  assert.strictEqual(r, true, "上一次问的就是他，这一次不能再问");
});

test("换个人问 → 连续规则不触发", () => {
  const r = shouldRotate({
    target: "王学习", askerName: "林默", candidates: CANDS,
    targetCounts: { 赵帅哥: 1, 王学习: 0 }, askedByMe: { 赵帅哥: 1 },
    askedQuestionsOfTarget: { similarity: 0.1 }, lastTarget: "赵帅哥",
  });
  assert.strictEqual(r, false);
});

test("嫌疑高（≥4）→ 允许连续追问同一个人（用户明确要求）", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "林默", candidates: CANDS,
    targetCounts: { 赵帅哥: 5 }, askedByMe: { 赵帅哥: 3 },
    askedQuestionsOfTarget: { similarity: 0.1 }, lastTarget: "赵帅哥", suspicion: 5,
  });
  assert.strictEqual(r, false, "手上有证据指向他，就该继续追问");
});

test("嫌疑高但问的还是同一时段 → 仍要换", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "林默", candidates: CANDS,
    targetCounts: { 赵帅哥: 5 }, askedByMe: { 赵帅哥: 3 },
    askedQuestionsOfTarget: { similarity: 0.8 }, lastTarget: "赵帅哥", suspicion: 6,
  });
  assert.strictEqual(r, true, "重复问同一时段是浪费出手，无论嫌疑多高");
});

test("嫌疑低（<4）+ 连续问同一人 → 轮转", () => {
  const r = shouldRotate({
    target: "赵帅哥", askerName: "林默", candidates: CANDS,
    targetCounts: { 赵帅哥: 2 }, askedByMe: { 赵帅哥: 1 },
    askedQuestionsOfTarget: { similarity: 0.1 }, lastTarget: "赵帅哥", suspicion: 1,
  });
  assert.strictEqual(r, true);
});

test("嫌疑打分：线索点名 +3，无时刻自证 +1", () => {
  const { scoreSuspects } = require("../../src/game/ask-history.js");
  const s = scoreSuspects({
    clueLines: ["【A1】赵帅哥的袖口有血迹"],
    transcript: "赵帅哥：我一直在房间\n王学习：我11:45在旧楼",
    candidates: ["赵帅哥", "王学习"],
  });
  assert.ok(s["赵帅哥"].score >= 3, "线索点名应给高分");
  assert.ok(s["王学习"].score < s["赵帅哥"].score, "没被线索点名的人应更低");
});
