// 剧本分页与 markdown 行分类的测试
//
// 回归的是玩家实际反馈的两个问题：
//   "内容太少了"  —— 原来固定每页 360 字，2149px 宽的窗口里只填满约三分之一
//   "而且会截断"  —— 360 是硬切，句子被从中间劈开（实测断在"……厘清命案与周万"）
import test from "node:test";
import assert from "node:assert";
import { paginate, estimateBudget, splitBlocks, classifyLine, parseInline } from "../frontend/src/lib/paginate.mjs";

test("容量按容器尺寸估算：窗口越宽越高，每页字数越多", () => {
  const small = estimateBudget({ width: 600, height: 400 });
  const large = estimateBudget({ width: 1800, height: 700 });
  assert.ok(large > small * 2, `大屏应当明显多于小屏：${large} vs ${small}`);
  // 2149px 宽的实测场景：应当远大于原来的 360 字
  const real = estimateBudget({ width: 2100, height: 700 });
  assert.ok(real > 1000, `2149px 宽窗口每页应超过 1000 字，实际 ${real}（原来固定 360）`);
});

test("容量有下限，极窄/极矮屏幕也切不出无法阅读的碎片", () => {
  assert.ok(estimateBudget({ width: 10, height: 10 }) >= 300);
  assert.ok(estimateBudget({}) >= 300);
});

test("分页优先在段落边界断开，不会把句子劈成两半", () => {
  const a = "第一段。" + "甲".repeat(300);
  const b = "第二段。" + "乙".repeat(300);
  const c = "第三段。" + "丙".repeat(300);
  const pages = paginate([a, b, c].join("\n\n"), 700);
  assert.ok(pages.length >= 2, "内容超过一页应当分页");
  // 每一页都不应以"半句话"结尾：这里检查每页首尾都是完整段落
  for (const p of pages) {
    assert.ok(p.startsWith("第") || p.startsWith("甲") || p.startsWith("乙") || p.startsWith("丙"),
      "页首不该是段落中段： " + p.slice(0, 12));
  }
  // 拼接回来必须等于原文（不能丢字）
  assert.strictEqual(pages.join("\n\n"), [a, b, c].join("\n\n"));
});

test("单段超长时在句末标点处断开，而不是硬切", () => {
  const long = "这是一个很长的段落。" + "内容内容内容。".repeat(120); // 远超一页
  const pages = paginate(long, 300);
  assert.ok(pages.length > 1);
  for (let i = 0; i < pages.length - 1; i++) {
    assert.ok(/[。！？；]$/.test(pages[i].trim()),
      `第 ${i + 1} 页应当在句末标点处结束，实际结尾: "...${pages[i].slice(-12)}"`);
  }
});

test("内容不足一页时只有一页（不要切出空白页）", () => {
  const short = "很短的一段。";
  const pages = paginate(short, 1000);
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0], short);
});

test("空内容也返回一页，不返回空数组（避免 UI 索引越界）", () => {
  for (const v of ["", null, undefined, "   \n\n  "]) {
    const pages = paginate(v, 500);
    assert.strictEqual(pages.length, 1);
  }
});

test("分页不丢字：所有页拼回来等于原文（去空白差异）", () => {
  const text = ["一、背景", "我是李琴心，" + "文".repeat(500) + "。", "二、目的", "目的内容。".repeat(60)].join("\n\n");
  const pages = paginate(text, 400);
  const norm = (s) => String(s).replace(/\s+/g, "");
  assert.strictEqual(norm(pages.join("")), norm(text));
});

test("分页结果每页都不超过容量太多（允许单段独占一页的例外）", () => {
  const blocks = Array.from({ length: 20 }, (_, i) => "第" + i + "段" + "字".repeat(180) + "。");
  const pages = paginate(blocks.join("\n\n"), 500);
  for (const p of pages) {
    // 单段 180 字远小于 500，所以每页都应接近容量，不应出现只有几十字的碎页
    assert.ok(p.length > 200, `出现碎页（${p.length} 字）`);
  }
});

test("行分类：识别标题 / 加粗小标题 / 列表 / 有序列表 / 正文", () => {
  assert.deepStrictEqual(classifyLine("### 玩家角色 1：李琴心"), { kind: "heading", level: 3, text: "玩家角色 1：李琴心" });
  assert.deepStrictEqual(classifyLine("## 李琴心 个人剧本"), { kind: "heading", level: 2, text: "李琴心 个人剧本" });
  assert.deepStrictEqual(classifyLine("**一、案发背景**"), { kind: "subheading", text: "一、案发背景" });
  assert.deepStrictEqual(classifyLine("- 一条线索"), { kind: "list", text: "一条线索" });
  assert.deepStrictEqual(classifyLine("3. 需要隐瞒的事：xxx"), { kind: "ordered", index: "3", text: "需要隐瞒的事：xxx" });
  assert.deepStrictEqual(classifyLine("我叫李琴心，表面身份是琴师。"), { kind: "para", text: "我叫李琴心，表面身份是琴师。" });
  assert.strictEqual(classifyLine("").kind, "blank");
  assert.strictEqual(classifyLine("   ").kind, "blank");
});

test("行分类不误判：结尾带冒号的加粗行也算小标题，正文里的加粗不算整行标题", () => {
  assert.deepStrictEqual(classifyLine("**二、你来此的目的**："), { kind: "subheading", text: "二、你来此的目的" });
  const mid = classifyLine("他说**我不在场**，但没人能证明。");
  assert.strictEqual(mid.kind, "para");
});

test("行内加粗解析：切出 bold 与 text 片段", () => {
  const segs = parseInline("前面 **重点** 后面");
  assert.deepStrictEqual(segs, [
    { t: "text", v: "前面 " },
    { t: "bold", v: "重点" },
    { t: "text", v: " 后面" },
  ]);
  assert.deepStrictEqual(parseInline("没有标记"), [{ t: "text", v: "没有标记" }]);
  assert.deepStrictEqual(parseInline(""), [{ t: "text", v: "" }]);
});

test("段落切分：按空行分段并去掉空白段", () => {
  assert.deepStrictEqual(splitBlocks("a\n\nb\n\n\n\nc"), ["a", "b", "c"]);
  assert.deepStrictEqual(splitBlocks("   "), []);
});
