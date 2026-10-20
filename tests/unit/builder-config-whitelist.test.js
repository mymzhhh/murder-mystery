// 元测试：`cfg` 是白名单重建，代码里用到的每个 cfg.* 字段都必须在白名单里。
//
// 为什么要这样测（2026-10-20，同类事故第三次）：
//   ① script-writer 的 buildGenConfig 重建配置时漏了 `images`
//      → 生成跑满 108 分钟，配图阶段一次没执行，日志里一行都没有；
//   ② getSplitData 把 Redis hash 原样返回，没做类型归一
//      → `diggable:"false"` 被 `!!` 判成 true，全部线索变成"可深入调查"；
//   ③ builder 内部的 `const cfg = {...}` 白名单漏了 `sessionId`
//      → 配图存到空 script_id，8 张图在切分后全成孤儿（页面全是碎图）。
// 三次都是"重建配置对象时漏字段"。单测逐个字段写死防不住新增字段，
// 所以这里做**源码级比对**：扫出所有 `cfg.xxx` 引用，逐个对照白名单。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "..", "..", "src", "script", "murder-mystery-builder.js");

test("builder 里所有 cfg.* 字段都必须在白名单里声明", () => {
  const src = fs.readFileSync(SOURCE, "utf8");

  // 定位 `const cfg = { ... };` 这一块
  const start = src.indexOf("const cfg = {");
  assert.ok(start > 0, "找不到 cfg 白名单定义");
  const end = src.indexOf("};", start);
  assert.ok(end > start, "cfg 白名单没有正常闭合");
  const block = src.slice(start, end);

  // 白名单里声明的（`key:` 形式）
  const declared = new Set();
  for (const m of block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) declared.add(m[1]);
  assert.ok(declared.size >= 5, `白名单解析异常，只找到 ${[...declared].join(",")}`);

  // 函数体里**后赋值**的（`cfg.key = ...`，例如由设定集派生出来的 era/location/victim）
  // 也只算声明；但赋值必须早于第一次读取，否则依然是读到 undefined。
  const assignAt = new Map();
  for (const m of src.matchAll(/\bcfg\.([A-Za-z_$][\w$]*)\s*=/g)) {
    if (!assignAt.has(m[1])) assignAt.set(m[1], m.index);
  }

  // 全文里用到的 cfg.xxx（排除定义块本身）
  const used = new Map(); // key -> 首次读取位置
  const body = src.slice(0, start) + src.slice(end);
  const bodyOffset = start;
  for (const m of body.matchAll(/\bcfg\.([A-Za-z_$][\w$]*)/g)) {
    // 跳过赋值处本身（`cfg.x =` 不是读取）
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^\s*=[^=]/.test(after)) continue;
    const abs = m.index < start ? m.index : m.index - bodyOffset + (end);
    if (!used.has(m[1])) used.set(m[1], abs);
  }

  const missing = [];
  const outOfOrder = [];
  for (const [key, readAt] of used) {
    if (declared.has(key)) continue;
    if (!assignAt.has(key)) { missing.push(key); continue; }
    if (assignAt.get(key) > readAt) outOfOrder.push(key);
  }

  assert.deepStrictEqual(
    missing, [],
    `这些字段在代码里被 cfg. 读取，但既没在白名单声明、也没有后赋值（会导致静默 undefined）：${missing.join(", ")}`
  );
  assert.deepStrictEqual(
    outOfOrder, [],
    `这些字段虽然在函数体里赋值了，但赋值晚于第一次读取（读到的是 undefined）：${outOfOrder.join(", ")}`
  );
});

test("sessionId 必须在白名单里（配图靠它落库）", () => {
  const src = fs.readFileSync(SOURCE, "utf8");
  const start = src.indexOf("const cfg = {");
  const block = src.slice(start, src.indexOf("};", start));
  assert.ok(/sessionId\s*:/.test(block), "cfg 白名单缺 sessionId —— 配图会存到空 script_id 上");
});
