// DM 手册模板必须写明搜证规则。
//
// 为什么（2026-10-20 用语料校验时发现）：把《沪西照相馆除夕谜案》丢进
// skills/murder-mystery-distill/scripts/validate.py 比对真实语料分布，结构不变量里
// 「是否写了 AP/搜证规则」这一项是 ⚠️ —— 我们的 DM 手册从头到尾没有一句搜证规则。
// 而真实语料 19 本里有 7 本明确写了（344 原文：每人11点AP、搜一次1点、深入调查同样1点）。
// 我们平台本身就有配额机制，手册却不写，DM 和玩家都无从知道规则。
const test = require("node:test");
const assert = require("node:assert");
const TEMPLATE = require("../../src/templates/murder-mystery/dm-guide.js");

test("DM 模板里要有独立的搜证规则段", () => {
  assert.ok(TEMPLATE.includes("搜证规则"), "必须有「搜证规则」这一节");
});

test("搜证规则要写清四件事：配额、单次消耗、深入调查也消耗、不能搜自己", () => {
  assert.ok(/搜证配额|点搜证/.test(TEMPLATE), "要有配额点数");
  assert.ok(/搜索一次消耗\s*1\s*点/.test(TEMPLATE), "要写单次消耗");
  assert.ok(/深入调查同样消耗/.test(TEMPLATE), "要写深入调查也扣点（真本原文如此）");
  assert.ok(/不能搜查自己/.test(TEMPLATE), "要写不能搜自己");
});

test("不要替玩家算点数或提前给提示（真本的 DM 原则）", () => {
  assert.ok(/不要替玩家算点数|不要在他们没查之前给出提示/.test(TEMPLATE));
});
