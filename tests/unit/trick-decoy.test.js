// 诡计设计必须包含"误导解答"（decoy）—— 2026-10-20 用户需求：不能一眼看穿凶手
//
// 背景：语义评审 rubric 三本自产稿的「唯一锁定」都只有 2/3 分，
// 缺的正是"看起来同样成立的错误答案"。没有 decoy，玩家扫一遍线索就锁定真凶。
const test = require("node:test");
const assert = require("node:assert");
const { validateTrickDesign, trickDesignToText } = require("../../src/script/trick-design.js");

function base(over) {
  return {
    genre: "本格",
    type: "密室",
    coreTrick: "用冰锥顶住门闩制造密室",
    dependsOnClock: false,
    mechanism: "凶手在19:40用冰锥从门缝顶住门闩，冰融化后门闩自然落下，形成从内部上锁的假象，",
    conceal: "伪装成死者自己反锁，并擦掉门缝的水渍",
    breakPoint: "地面的水渍、冰锥的残片、门闩上的水痕",
    feasibility: {
      physics: "冰锥长度足够顶住门闩，融化时间与案发时间吻合",
      witness: "19:40 无人经过后廊，走廊灯当时是灭的",
      weakest: "地面水渍若不及时擦干会很明显",
    },
    proofChain: [
      { clue: "后廊青砖地面上有一小片尚未干透的水渍", kind: "physical-trace", supports: "means", proves: "有人带着冰或水经过后廊" },
      { clue: "门闩内侧的木面上留有一圈浅色水痕", kind: "physical-trace", supports: "means", proves: "门闩曾被冰柱顶住形成假锁" },
      { clue: "死者账本上记着欠凶手三个月工钱未结", kind: "record", supports: "motive", proves: "凶手有明确的欠薪动机" },
      { clue: "账房先生说 19:40 经过时后廊的灯是灭的", kind: "testimony", supports: "opportunity", proves: "案发时该路段无人在场" },
    ],
    ...(over || {}),
  };
}

test("没有 decoy → 打回", () => {
  const v = validateTrickDesign(base());
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("decoy")), v.errors.join(" | "));
});

test("decoy 齐全且细节充分 → 通过", () => {
  const v = validateTrickDesign(base({
    decoy: {
      who: "账房先生",
      why: "他当晚确实进过后廊，手上还拿着把锥子，而且死者生前当众骂过他，所有人都看见他脸色发白地离开",
      brokeBy: "后廊的水渍是冰化成的水，不是他带的锥子留下的 —— 物证痕迹可以推翻",
    },
  }));
  assert.strictEqual(v.ok, true, `不该打回，实际：${v.errors.join(" | ")}`);
});

test("decoy.why 敷衍（比机制短太多）→ 打回", () => {
  const v = validateTrickDesign(base({
    decoy: { who: "账房先生", why: "他也有动机", brokeBy: "物证" },
  }));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("敷衍") || e.includes("decoy.why")), v.errors.join(" | "));
});

test("decoy 缺 brokeBy → 打回", () => {
  const v = validateTrickDesign(base({
    decoy: {
      who: "账房先生",
      why: "他当晚确实进过后廊，手上还拿着把锥子，而且死者生前当众骂过他，所有人都看见他脸色发白地离开",
    },
  }));
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("brokeBy")), v.errors.join(" | "));
});

test("trickDesignToText 要把 decoy 传给下游（线索阶段要据此铺证据）", () => {
  const d = base({
    decoy: {
      who: "账房先生",
      why: "他当晚确实进过后廊，手上还拿着把锥子，死者生前当众骂过他",
      brokeBy: "水渍是冰化的",
    },
  });
  const text = trickDesignToText(d);
  assert.ok(text.includes("误导解答"), "要渲染误导解答段");
  assert.ok(text.includes("账房先生"), "要写出被怀疑的人");
  assert.ok(/线索要求/.test(text), "要告诉线索阶段怎么铺证据");
});
