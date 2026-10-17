/**
 * 健壮 JSON 提取：从 LLM 返回全文（可能混有大段中文推理 reasoning_content、前后缀、代码块）
 * 中提取"最后一个完整可解析的 JSON 对象/数组"。
 * 策略（按优先级）：
 *   1) 剥离 ```json 代码块围栏后直接 parse
 *   2) 若 parse 失败，扫描最外层花括号/方括号对，逐个尝试，取最后一个能解析成功的对象
 *      （推理型模型常把最终 JSON 写在回答末尾，最外层对象通常就是答案）
 *
 * 为什么单独成模块：需要它的不止流水线主文件（诡计设计等中间产物阶段也要解析 JSON）。
 * 放在主文件里再被别的模块 require 会形成循环依赖，所以抽出来。
 */
function extractJsonStrict(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim().replace(/^\uFEFF/, ""); // 去掉 BOM
  // 剥离代码块围栏（兼容开头 ```json 但结尾可能不闭合）
  const fenceOpen = t.match(/^```(?:json)?[\s]*\n?/i);
  if (fenceOpen) {
    t = t.slice(fenceOpen[0].length);
    // 去掉结尾可能残留的 ```
    t = t.replace(/```[\s]*$/m, "").replace(/\n```$/, "");
  } else {
    // 未以围栏开头，也可能中间有围栏
    const fenced2 = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenced2) t = fenced2[1].trim();
  }
  t = t.trim();

  // 直接 parse
  try { return JSON.parse(t); } catch (e) { /* fallthrough */ }

  // 从前往后扫描，记录每个最外层括号对的子串，取最后一个能解析的
  const candidates = [];
  let depth = 0, start = -1, inStr = false, escaped = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(t.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try { return JSON.parse(candidates[k]); } catch (e) { /* try next */ }
  }
  // 最后兜底：从第一个 { 到最后一个 }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { /* ignore */ }
  }
  return null;
}

/**
 * 截断 JSON 的抢救：模型输出因 `finish_reason=length` 被截断时，
 * `extractJsonStrict` 一律返回 null（它的括号扫描要求成对闭合，截断时 depth 回不到 0）。
 *
 * 实测代价：定向修订拿到 null → 0 条补丁 → 整轮**白跑**（日志只留一句"模型未产出可用补丁"，
 * 看不出其实是"输出被截断"）。而截断前往往已经写好了若干条**完整**补丁——
 * 拿到它们比拿到空集强得多。
 *
 * 做法：从后往前找"结构完整"的切点（每个闭合括号处），把该切点之后没写完的半截元素丢掉，
 * 再把还开着的括号补齐后尝试 parse；取**最长**能成功的那个。
 * 例：`{"patches":[{完整A},{完整B},{截断` → `{"patches":[{完整A},{完整B}]}` ✓
 *
 * @returns {object|null} 抢救成功返回对象；否则 null（**绝不返回假成功**）
 */
function repairTruncatedJson(text) {
  if (!text || typeof text !== "string") return null;
  const stack = [];
  let inStr = false, escaped = false;
  let best = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") { stack.push(ch); continue; }
    if (ch === "}" || ch === "]") {
      stack.pop();
      // 切在闭合符处：该处结构完整，把没写完的尾巴丢掉、补齐还开着的括号
      const closers = stack.slice().reverse().map((x) => (x === "{" ? "}" : "]")).join("");
      try {
        const parsed = JSON.parse(text.slice(0, i + 1) + closers);
        if (parsed && typeof parsed === "object") {
          best = parsed;
          if (!stack.length) return parsed;   // 栈已空 = 这是完整输出
        }
      } catch (e) { /* 这个切点不行，继续找更早的 */ }
    }
  }
  return best;
}

module.exports = { extractJsonStrict, repairTruncatedJson };
