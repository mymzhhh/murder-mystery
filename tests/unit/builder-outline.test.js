// 验证大纲阶段：buildOutline 输出锁人数 JSON / outlineToText / extractCharactersFromOutline（纯逻辑，无 LLM）
const test = require("node:test");
const assert = require("node:assert");
const { outlineToText, extractCharactersFromOutline } = require("../../src/script/murder-mystery-builder");

const outline = {
  title: "测试本",
  genre: "本格",
  coreTrick: "密室",
  duration: "3.5小时",
  murdererCanLie: true,
  storyBackground: "民国药铺命案",
  layout: ["大堂", "库房", "药铺厢房", "师傅卧室"],
  victim: { name: "林师傅", identity: "药铺东家", gender: "男", causeOfDeath: "砒霜中毒", deathPlace: "卧室" },
  players: [
    { name: "陈远舟", gender: "男", identity: "大徒弟", background: "掌管运营", connection: "师承", isMurderer: true },
    { name: "林小棠", gender: "女", identity: "二徒弟", background: "管账", connection: "师承", isMurderer: false },
  ],
  npcs: [
    { name: "赵小婉", gender: "女", identity: "药商之女", background: "对门千金", connection: "与师傅争执", role: "嫌疑人", isMurderer: false },
  ],
  murderer: { name: "陈远舟", motive: "夺秘方", method: "毒入茶中", misdeedClues: ["空药瓶", "茶渍"] },
  timeline: [
    { time: "20:55", desc: "凶手进书房下毒" },
    { time: "21:30", desc: "死者饮茶毒发" },
  ],
};

test("outlineToText：生成可注入的大纲文本（含人物/凶手/时间线）", () => {
  const t = outlineToText(outline);
  assert.ok(t.includes("陈远舟"));
  assert.ok(t.includes("赵小婉"));
  assert.ok(t.includes("凶手"));
  assert.ok(t.includes("时间线骨架"));
  assert.ok(t.includes("20:55"));
  // 设定集字段
  assert.ok(t.includes("本格"));
  assert.ok(t.includes("密室"));
  assert.ok(t.includes("3.5小时"));
  assert.ok(t.includes("凶手是否允许说谎：是"));
});

test("extractCharactersFromOutline：人数与凶手标记正确", () => {
  const chars = extractCharactersFromOutline(outline, { playerCount: 2, npcCount: 1 });
  assert.equal(chars.length, 3);
  assert.equal(chars.filter(c => c.type === "player").length, 2);
  assert.equal(chars.filter(c => c.type === "npc").length, 1);
  const murderer = chars.find(c => c.isMurderer);
  assert.equal(murderer.name, "陈远舟");
  assert.equal(murderer.type, "player");
});