// 搜证地点收敛：碎地点合并回房间级（真实缺陷：40 条线索碎成 36 个地点）
const test = require("node:test");
const assert = require("node:assert");
const { collapseClueLocations } = require("../../src/script/location-collapse.js");

const PLACES = ["展厅", "维修间", "会计室", "前厅", "学徒室", "房东休息室", "后院"];

test("房间内子位置合并回房间（真实缺陷形态）", () => {
  const src = [
    { location: "维修间挂钟转轴" }, { location: "维修间桌面" }, { location: "会计室桌面" },
    { location: "前厅柜台烟灰缸" }, { location: "学徒室工具箱" }, { location: "后院杂物箱" },
  ];
  const r = collapseClueLocations(src, { places: PLACES });
  assert.deepStrictEqual(r.clues.map((c) => c.location), ["维修间", "维修间", "会计室", "前厅", "学徒室", "后院"]);
  assert.strictEqual(r.before, 6);
  assert.strictEqual(r.after, 5);
  assert.strictEqual(r.mapping["维修间挂钟转轴"], "维修间");
});

test("证词类统一成「证言」", () => {
  const src = [{ location: "林医生证词" }, { location: "仆役口供" }, { location: "某人供述" }];
  const r = collapseClueLocations(src, { places: PLACES });
  assert.deepStrictEqual([...new Set(r.clues.map((c) => c.location))], ["证言"]);
});

test("人物名（搜身）保持原样", () => {
  const src = [{ location: "周管家" }, { location: "沈曼青" }];
  const r = collapseClueLocations(src, { places: PLACES });
  assert.deepStrictEqual(r.clues.map((c) => c.location), ["周管家", "沈曼青"]);
});

test("超过上限时合并到「其他地点」，但一条线索都不能丢", () => {
  const src = [];
  // 10 个地点：展厅 8 条，其余各 1 条
  for (let i = 0; i < 8; i++) src.push({ location: "展厅" });
  for (const p of ["维修间", "会计室", "前厅", "学徒室", "房东休息室", "后院"]) src.push({ location: p });
  src.push({ location: "周管家" }, { location: "证言" });
  const r = collapseClueLocations(src, { places: PLACES, maxLocations: 7 });
  assert.ok(r.after <= 7, `合并后应 ≤7 个地点，实际 ${r.after}`);
  assert.strictEqual(r.clues.length, src.length, "线索条数必须保持不变");
  assert.ok(r.clues.some((c) => c.location === "其他地点"), "低频地点应被并入其他地点");
  assert.ok(r.warnings.some((w) => w.includes("其他地点")));
});

test("不超上限时不做二次合并", () => {
  const src = [{ location: "展厅" }, { location: "维修间" }, { location: "会计室" }];
  const r = collapseClueLocations(src, { places: PLACES, maxLocations: 7 });
  assert.strictEqual(r.after, 3);
  assert.ok(!r.clues.some((c) => c.location === "其他地点"));
});

test("空地点不会被吞掉（交给上层兜底补）", () => {
  const src = [{ location: "" }];
  const r = collapseClueLocations(src, { places: PLACES });
  assert.strictEqual(r.clues.length, 1);
  assert.strictEqual(r.clues[0].location, "");
});

test("长房间名优先匹配（沈曼青闺房 vs 闺房）", () => {
  const r = collapseClueLocations([{ location: "沈曼青闺房梳妆台" }], { places: ["闺房", "沈曼青闺房"] });
  assert.strictEqual(r.clues[0].location, "沈曼青闺房");
});
