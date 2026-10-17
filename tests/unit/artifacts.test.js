// 中间产物装配（落盘前的挑字段 + 限体积）。
//
// 这层要保证三件事，缺一不可：
//   ① 挑对字段（不要把整个 report 塞进去）；
//   ② 体积可控（超限时**按优先级丢件**，且如实记录被丢了什么，不假装没丢）；
//   ③ 绝不抛错（落盘是附带的，不能影响出本）。
const test = require("node:test");
const assert = require("node:assert");
const { buildArtifacts, clipDeep, ARTIFACTS_MAX_BYTES } = require("../../src/script/artifacts");

const smallReport = () => ({
  trickDesign: {
    type: "时间诡计", genre: "本格", coreTrick: "拨慢座钟伪造死亡时间", dependsOnClock: true,
    mechanism: "凶手把座钟拨慢四十分钟", conceal: "对外称整晚在大厅", breakPoint: "机芯有新鲜拨动痕迹",
    feasibility: { physics: "物理可行", witness: "无人目击", weakest: "钟面读数对不上" },
    proofChain: [{ clue: "座钟读数与怀表差四十分钟", kind: "physical", supports: "means-timeline", proves: "钟被动过" }],
    attempts: 2, lastErrors: ["三锁缺动机"],
  },
  outline: { title: "雾锁", genre: "本格", players: [{ name: "甲" }], timeline: [{ time: "21:00", desc: "案发" }] },
  crossCheck: { issues: ["甲的时间线与乙冲突", "线索 A3 地点不存在"] },
});

test("buildArtifacts：空/异常入参返回 null（绝不能抛）", () => {
  assert.strictEqual(buildArtifacts(null), null);
  assert.strictEqual(buildArtifacts(undefined), null);
  assert.strictEqual(buildArtifacts("string"), null);
  assert.strictEqual(buildArtifacts(42), null);
  assert.strictEqual(buildArtifacts({}), null, "没有任何可用产物时不值得落盘");
});

test("buildArtifacts：保留面板需要的全部字段", () => {
  const a = buildArtifacts(smallReport());
  assert.ok(a.trickDesign, "推理链必须保留");
  assert.strictEqual(a.trickDesign.coreTrick, "拨慢座钟伪造死亡时间");
  assert.strictEqual(a.trickDesign.feasibility.weakest, "钟面读数对不上");
  assert.strictEqual(a.trickDesign.proofChain.length, 1, "证明链要留给面板逐条展示");
  assert.strictEqual(a.trickDesign.attempts, 2, "「第几次通过」也要留");
  assert.deepStrictEqual(a.trickDesign.lastErrors, ["三锁缺动机"]);
  assert.ok(a.outline, "大纲保留");
  assert.strictEqual(a.crossCheck.count, 2, "交叉校验问题数要留");
  assert.strictEqual(a.crossCheck.issues.length, 2);
  assert.ok(a.savedAt, "要有落盘时间");
});

test("buildArtifacts：只有 crossCheck 时返回 null（推理链与大纲才是落盘的意义）", () => {
  assert.strictEqual(buildArtifacts({ crossCheck: { issues: ["x"] } }), null);
});

test("buildArtifacts：不修改传入的 report（纯函数）", () => {
  const r = smallReport();
  const before = JSON.stringify(r);
  buildArtifacts(r);
  assert.strictEqual(JSON.stringify(r), before, "原对象必须原样不动");
});

test("clipDeep：递归截断字符串与数组，且不改原对象", () => {
  const src = { s: "x".repeat(50), arr: Array.from({ length: 10 }, () => "y".repeat(50)), nested: { deep: "z".repeat(50) }, n: 7, b: true };
  const out = clipDeep(src, 10, 3);
  assert.strictEqual(out.s.length, 10);
  assert.strictEqual(out.arr.length, 3, "数组截到上限");
  assert.strictEqual(out.arr[0].length, 10);
  assert.strictEqual(out.nested.deep.length, 10, "嵌套对象也要截");
  assert.strictEqual(out.n, 7, "非字符串原样保留");
  assert.strictEqual(out.b, true);
  assert.strictEqual(src.s.length, 50, "原对象不被修改");
});

test("体积兜底：大纲过大时被丢弃，推理链必须留下", () => {
  const huge = { timeline: Array.from({ length: 200 }, () => "x".repeat(1200)) };
  const r = { ...smallReport(), outline: { ...smallReport().outline, ...huge, blob: Array.from({ length: 200 }, () => "y".repeat(1200)) } };
  const a = buildArtifacts(r);
  assert.ok(a.trickDesign, "推理链是落盘的意义所在，任何情况下都必须留下");
  assert.strictEqual(a.outline, undefined, "超限时先丢大纲");
  assert.ok(Buffer.byteLength(JSON.stringify(a), "utf8") <= ARTIFACTS_MAX_BYTES);
});

test("体积兜底：推理链本身过大时精简为结论面，并如实记录被丢的条数", () => {
  const hugeTrick = {
    type: "密室", coreTrick: "反锁书房", mechanism: "鱼线",
    proofChain: Array.from({ length: 200 }, () => ({ clue: "x".repeat(2000), proves: "y".repeat(2000) })),
  };
  const a = buildArtifacts({ trickDesign: hugeTrick });
  assert.ok(a.trickDesign, "仍要有推理链（哪怕精简）");
  assert.strictEqual(a.trickDesign.proofChain, undefined, "逐条证明链被精简掉");
  assert.strictEqual(a.trickDesign.proofChainOmitted, 200, "必须如实记录丢了多少条，不能假装没有");
  assert.strictEqual(a.trickDesign.coreTrick, "反锁书房", "结论面保留");
  assert.ok(Buffer.byteLength(JSON.stringify(a), "utf8") <= ARTIFACTS_MAX_BYTES);
});

test("buildArtifacts：正常入参的产物体积远小于上限（不该无谓触发丢件）", () => {
  const a = buildArtifacts(smallReport());
  assert.ok(Buffer.byteLength(JSON.stringify(a), "utf8") < ARTIFACTS_MAX_BYTES / 10,
    "正常产物不该接近上限");
  assert.ok(a.outline && a.crossCheck, "正常入参下三件都该在");
});

test("buildArtifacts：结构异常（字段类型不对）也不抛", () => {
  const weird = { trickDesign: "不是对象", outline: 123, crossCheck: { issues: "不是数组" } };
  assert.doesNotThrow(() => buildArtifacts(weird));
  assert.strictEqual(buildArtifacts(weird), null, "没有可用产物 → null");
  const partial = { trickDesign: { coreTrick: "只有一句话" }, crossCheck: { issues: [null, undefined, "真问题"] } };
  const a = buildArtifacts(partial);
  assert.ok(a && a.trickDesign.coreTrick === "只有一句话");
  assert.strictEqual(a.crossCheck.issues.length, 3, "null/undefined 也要能序列化（转成字符串）");
});

// ==================== 自动改写的留档（revision）====================
// 驱动定向修订的是一份 LLM 产出的问题清单，**有噪声**（实测复核过其中一条：读原文后
// 并不成立，是校验器自己误报），而修订会照着它自动改写成稿。所以"照着什么改了什么"
// 必须留档可复核，否则想核对"它对那条误报做了什么"时查不到任何痕迹。

test("buildArtifacts：保留每轮修订的问题清单与补丁（可复核自动改写）", () => {
  const report = {
    trickDesign: { coreTrick: "x" },
    crossCheck: { issues: ["问题A", "问题B"] },
    revision: [{
      round: 1, issueCount: 2, applied: 1, skipped: 1,
      issues: ["问题A", "问题B"],
      patches: [{ oldText: "旧的那一句原文", newText: "改后的那一句" }],
    }],
  };
  const a = buildArtifacts(report);
  assert.ok(Array.isArray(a.revision) && a.revision.length === 1, "留档要在");
  const r0 = a.revision[0];
  assert.strictEqual(r0.round, 1);
  assert.strictEqual(r0.issueCount, 2);
  assert.strictEqual(r0.applied, 1);
  assert.strictEqual(r0.skipped, 1);
  assert.deepStrictEqual(r0.issues, ["问题A", "问题B"]);
  assert.strictEqual(r0.patches[0].oldText, "旧的那一句原文", "补丁原文要能逐字复核");
  assert.strictEqual(r0.patches[0].newText, "改后的那一句");
});

test("buildArtifacts：补丁文本过长时被截断（限体积），但结构保留", () => {
  const long = "长".repeat(3000);
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{ round: 1, issues: ["i"], patches: Array.from({ length: 60 }, () => ({ oldText: long, newText: long })) }],
  });
  assert.strictEqual(a.revision[0].patches.length, 40, "补丁条数封顶");
  assert.strictEqual(a.revision[0].patches[0].oldText.length, 600, "单条文本封顶");
});

test("buildArtifacts：revision 结构异常不抛，也不产出脏留档", () => {
  assert.doesNotThrow(() => buildArtifacts({ trickDesign: { coreTrick: "x" }, revision: "不是数组" }));
  const a = buildArtifacts({ trickDesign: { coreTrick: "x" }, revision: "不是数组" });
  assert.strictEqual(a.revision, undefined);
  const b = buildArtifacts({ trickDesign: { coreTrick: "x" }, revision: [null, { round: 2 }] });
  assert.ok(Array.isArray(b.revision) && b.revision.length === 2, "缺字段的轮次也要能落盘（字段为空）");
  assert.deepStrictEqual(b.revision[1].patches, []);
  assert.deepStrictEqual(b.revision[1].issues, []);
});

test("buildArtifacts：留住『为什么没改动』（一条补丁都没产出 / 定位不到）", () => {
  // 实测遇过：交叉校验报了 12 个问题，修订第 1 轮却"未产出可用补丁"（LLM 输出被 max_tokens 截断）。
  // 这种"检测到了但没改"的情形，审计时比"应用了 N 条"更需要解释。
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    crossCheck: { issues: Array.from({ length: 12 }, (_, i) => `问题${i}`) },
    revision: [{ round: 1, issueCount: 12, applied: 0, skipped: 0, patches: [], issues: ["问题0"], note: "模型未产出可用补丁" }],
  });
  assert.strictEqual(a.revision[0].applied, 0);
  assert.strictEqual(a.revision[0].note, "模型未产出可用补丁", "审计要看的是原因，不只是数字");
  assert.strictEqual(a.revision[0].issueCount, 12);
  const b = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{ round: 1, applied: 0, skipped: 3, patches: [{ oldText: "a", newText: "b" }], note: "补丁均无法在原文定位" }],
  });
  assert.strictEqual(b.revision[0].note, "补丁均无法在原文定位");
});

// ==================== 修订后复检的留档 ====================
// 修订照着 LLM 产的问题清单自动改稿，原来两轮都用同一份清单、改完不复核。
// 现在每轮改完做确定性体检（护栏：改坏了就整轮回退）、并重新交叉校验拿新清单。

test("buildArtifacts：留住每轮复检的『确定性体检』结论（机器对改写结果的判定）", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{
      round: 1, issueCount: 9, applied: 14, skipped: 0, issues: ["问题A"], patches: [],
      verdict: { dateAgreement: "ok", roundUnlock: "ok", deathViolations: 0, sectionCount: 6 },
    }],
  });
  assert.strictEqual(a.revision[0].verdict.dateAgreement, "ok");
  assert.strictEqual(a.revision[0].verdict.roundUnlock, "ok");
  assert.strictEqual(a.revision[0].verdict.deathViolations, 0);
});

test("buildArtifacts：被护栏判为『会改坏』而整轮撤销的轮次，要留下撤销标记与原因", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{
      round: 1, issueCount: 9, applied: 0, skipped: 0, issues: ["问题A"], patches: [],
      reverted: true, note: "修订使确定性校验变红：跨角色日期一致性由通过变为不通过",
    }],
  });
  assert.strictEqual(a.revision[0].reverted, true, "撤销标记必须在");
  assert.ok(a.revision[0].note.includes("变红"), "撤销原因必须在");
  assert.strictEqual(a.revision[0].applied, 0, "撤销后应用数应归零");
});

test("buildArtifacts：留住复检后的剩余问题数（直接回答『改了到底有没有用』）", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    crossCheck: { issues: ["问题A", "问题B"] },
    revisionRecheck: ["还剩的问题1", "还剩的问题2", "还剩的问题3"],
  });
  assert.strictEqual(a.revisionRecheck.count, 3);
  assert.strictEqual(a.revisionRecheck.issues.length, 3);
  // 没做复检时不该凭空造出这个字段
  const b = buildArtifacts({ trickDesign: { coreTrick: "x" } });
  assert.strictEqual(b.revisionRecheck, undefined);
});

// ==================== "没有结论"绝不能显示成"没有问题" ====================
// 实测踩过：交叉校验的 JSON 解析失败时，原代码 `extractJsonStrict(...) || {}` 会得到空 issues，
// 对外表现为"校验通过、零问题"；更危险的是复检拿到空清单会**静默跳过后续修订**
// （把"校验失败"变成"提前收工"）。所以失败必须单独标记。

test("buildArtifacts：复检『没有结论』要标记为 failed，不能显示成 0 个问题", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revisionRecheck: { count: null, issues: [], failed: true },   // 复检输出无法解析
  });
  assert.strictEqual(a.revisionRecheck.failed, true, "必须标记失败");
  assert.strictEqual(a.revisionRecheck.count, null, "不能写成 0（0 的含义是『真的没有问题了』）");
  assert.deepStrictEqual(a.revisionRecheck.issues, []);
});

test("buildArtifacts：复检没有结论时，该轮要留下 recheckFailed 标记", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{
      round: 1, issueCount: 9, applied: 14, skipped: 0, issues: ["问题A"], patches: [],
      recheckFailed: true, verdict: { dateAgreement: "ok", roundUnlock: "ok", deathViolations: 0 },
    }],
  });
  assert.strictEqual(a.revision[0].recheckFailed, true, "复检失败必须可见（否则看起来像正常走完）");
  assert.strictEqual(a.revision[0].applied, 14, "复检失败不影响这一轮已应用的补丁");
});

// ==================== 截断抢救的留档 ====================
// 模型输出被截断时，修补丁是"截断前写完的那些"抢救来的——清单本身可能不全，
// 必须让人知道这一轮的补丁来源与平时不同。

test("buildArtifacts：补丁来自截断输出抢救时，要留下 salvaged 条数", () => {
  const a = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{
      round: 1, issueCount: 9, applied: 5, skipped: 0, issues: ["问题A"],
      patches: [{ oldText: "旧文", newText: "新文" }], salvaged: 5,
    }],
  });
  assert.strictEqual(a.revision[0].salvaged, 5, "抢救条数要留档（人才知道这一轮补丁来源不同）");
  // 没抢救时不凭空造字段
  const b = buildArtifacts({
    trickDesign: { coreTrick: "x" },
    revision: [{ round: 1, issueCount: 9, applied: 5, skipped: 0, issues: ["问题A"], patches: [] }],
  });
  assert.strictEqual(b.revision[0].salvaged, undefined);
});
