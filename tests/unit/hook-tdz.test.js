// Hook 依赖数组的 TDZ 检查（前端源码静态扫描）
//
// 为什么需要这个测试：useCallback / useEffect / useMemo 的依赖数组是**渲染时立即求值**的，
// 如果它引用了在**更下方**才声明的 const/let，就会抛
// "Cannot access 'X' before initialization"，React 随即卸载整棵树 —— 页面变成一块纯黑。
//
// 这个错误类型的特点是**逃过所有常规检查**：
//   - vite build 不报（语法完全合法）
//   - 单元测试测不到（测的是后端逻辑）
//   - HTTP 200 也照样通过（HTML 与 assets 都正常）
// 只在真实浏览器里渲染那一刻才暴露。本项目没有 ESLint，所以用这个扫描兜住。
//
// 它是启发式的：不解析 AST，只按"声明行号 vs 依赖数组行号"判断。
// 宁可漏报也不误报 —— 对函数参数、解构、useState 的 setX 做了放行处理。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "frontend", "src");

/** 递归收集 .js/.jsx（跳过 .mjs：那些是纯工具，没有 hook） */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/** 从 '[' 位置找到配对的 ']'（粗略处理字符串与模板串） */
function matchBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 找出该 hook 调用后面的依赖数组 [start, end]；没有则 null */
function findDepsArray(src, from) {
  const re = /,\s*\[/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    let j = close + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === ")") return [open, close];
  }
  return null;
}

/** 收集每个标识符**首次**出现的声明行号 */
function declLines(src) {
  const map = new Map();
  const patterns = [
    /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,          // const x =
    /^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,      // function x(
    /^[ \t]*const\s*\{([^}]*)\}\s*=/gm,                              // const { a, b } =
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const line = lineOf(src, m.index);
      for (const raw of m[1].split(",")) {
        const name = raw.split(":").pop().trim().replace(/^\.\.\./, "").split("=")[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        if (!map.has(name) || line < map.get(name)) map.set(name, line);
      }
    }
  }
  return map;
}

const HOOKS = /\b(useCallback|useEffect|useMemo|useLayoutEffect)\s*\(/g;

/** 扫描一个文件，返回违规列表 */
function scanFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const decls = declLines(src);
  const problems = [];
  HOOKS.lastIndex = 0;
  let m;
  while ((m = HOOKS.exec(src))) {
    const deps = findDepsArray(src, m.index);
    if (!deps) continue;
    const hookLine = lineOf(src, m.index);
    for (const raw of src.slice(deps[0] + 1, deps[1]).split(",")) {
      const name = raw.trim().split(/[.?\s[]/)[0].trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const declaredAt = decls.get(name);
      // 只报"在本文件里有声明、但声明在依赖数组之后"的情况。
      // 没有声明的（函数参数、import 进来的、全局的）一律放行。
      if (declaredAt !== undefined && declaredAt > hookLine) {
        problems.push(`${path.relative(SRC, file)}: ${m[1]} 的依赖 [${name}] 在第 ${hookLine} 行求值，但它到第 ${declaredAt} 行才声明`);
      }
    }
  }
  return problems;
}

test("没有任何 hook 依赖数组引用了下方才声明的变量（TDZ）", () => {
  const files = collect(SRC);
  assert.ok(files.length > 0, "应扫描到前端源码");
  const problems = files.flatMap(scanFile);
  assert.deepStrictEqual(
    problems,
    [],
    "依赖数组是渲染时立即求值的，引用下方声明的 const/let 会抛 TDZ 并导致整页黑屏：\n  " + problems.join("\n  ")
  );
});

test("扫描器本身能发现这类问题（防止它因写错而永远通过）", () => {
  const tmp = path.join(SRC, "__tdz_selftest__.jsx");
  fs.writeFileSync(tmp, [
    "export default function C() {",
    "  const f = useCallback(() => g(), [later]);",
    "  const later = 1;",
    "  return null;",
    "}",
  ].join("\n"), "utf8");
  try {
    const problems = scanFile(tmp);
    assert.strictEqual(problems.length, 1, "扫描器必须能抓到故意写出的 TDZ");
    assert.ok(problems[0].includes("later"));
  } finally {
    fs.unlinkSync(tmp);
  }
});
