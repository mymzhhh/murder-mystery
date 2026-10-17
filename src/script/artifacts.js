// 中间产物（推理链等）的装配 —— 纯函数，可被单测穷举。
//
// ## 为什么需要它
//
// `report` 里的 trickDesign / outline / crossCheck 此前**只在内存**：
// 进程结束或页面刷新即失，管理端事后无法复核"这稿的诡计为什么这么设计、
// 交叉校验报了哪些问题"。而这三样正是判断"这稿弱在哪"的全部依据。
//
// 落盘前必须做三件事，所以单独成一个可测的步骤：
//   1. **挑对字段**——不要把整个 report 塞进去（里面有 prompt、全文剧本等无关大件）；
//   2. **限体积**——Redis 与 PG 都不该存无上限的文本，必须先按确定性规则截断，
//      而不是"存了再说"（一个异常的大纲能把 session 列表/详情接口拖垮）；
//   3. **绝不抛错**——落盘是附带的，缺字段/结构异常时返回 null 即可，不能影响出本。

/** 中间产物的体积上限（字节，UTF-8）。超过就按优先级丢件，见 buildArtifacts。 */
const ARTIFACTS_MAX_BYTES = 256 * 1024;

/** 各字段的单串截断上限（字符）——按用途给足，正常情况下都碰不到 */
const STR_CAP = { trickDesign: 2000, outline: 1200, crossCheck: 800 };
/** 各数组字段的条数上限 */
const ARR_CAP = 200;

/** 递归把对象里的字符串截断到 maxStr、数组截到 maxArr（返回新对象，不改原对象） */
function clipDeep(value, maxStr, maxArr = ARR_CAP) {
  if (typeof value === "string") return value.length > maxStr ? value.slice(0, maxStr) : value;
  if (Array.isArray(value)) return value.slice(0, maxArr).map((v) => clipDeep(v, maxStr, maxArr));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, maxStr, maxArr);
    return out;
  }
  return value;
}

const bytesOf = (obj) => Buffer.byteLength(JSON.stringify(obj), "utf8");

/**
 * 装配要落盘的中间产物。
 * @param {object} report buildMurderMystery 的 report（stages）
 * @returns {object|null} 可 JSON 序列化的产物；没有可用内容时返回 null
 */
function buildArtifacts(report) {
  if (!report || typeof report !== "object") return null;
  const out = { savedAt: new Date().toISOString() };
  if (report.trickDesign && typeof report.trickDesign === "object") {
    out.trickDesign = clipDeep(report.trickDesign, STR_CAP.trickDesign);
  }
  if (report.outline && typeof report.outline === "object") {
    out.outline = clipDeep(report.outline, STR_CAP.outline);
  }
  // 权威表对账的留档：自洽问题、跨角色候选、改了谁、剩下什么。
  // 与 crossCheck 同理必须可复核 —— 否则"它到底改了什么/还剩什么没解决"查不到。
  if (report.bibleCheck && typeof report.bibleCheck === "object") {
    out.bibleCheck = clipDeep(report.bibleCheck, 600);
  }
  const issues = report.crossCheck && Array.isArray(report.crossCheck.issues) ? report.crossCheck.issues : null;
  if (issues && issues.length) {
    out.crossCheck = { count: issues.length, issues: clipDeep(issues, STR_CAP.crossCheck).map(String) };
  }
  // 自动改写的留档：照着哪些问题、把哪几段换成了什么。
  // 驱动它的问题清单是 LLM 产的（有噪声），所以"改了什么"必须可复核——
  // 否则想核对"它对某条误报做了什么"时查不到任何痕迹。
  const rev = Array.isArray(report.revision) ? report.revision : null;
  if (rev && rev.length) {
    out.revision = rev.slice(0, 6).map((r) => ({
      round: r && r.round,
      issueCount: r && r.issueCount,
      applied: r && r.applied,
      skipped: r && r.skipped,
      // "为什么没改动"（模型没产出补丁 / 补丁定位不到 / 复检判定会改坏而回退）——
      // 审计时比数字更重要
      note: r && r.note ? String(r.note).slice(0, 120) : undefined,
      // 复检判定这一轮会把已有内容改坏 → 已整体撤销
      reverted: r && r.reverted ? true : undefined,
      // 复检输出无法解析 → 这一轮**没有结论**（沿用原清单继续，不是"没问题"）
      recheckFailed: r && r.recheckFailed ? true : undefined,
      // 补丁是从"被截断的输出"里抢救回来的（截断前写完的那些）——清单本身可能不全
      salvaged: r && r.salvaged ? r.salvaged : undefined,
      // 修订后的**确定性体检**结论（护栏用的那几项），即"机器对'这轮改完怎么样'的判定"
      verdict: r && r.verdict ? {
        dateAgreement: r.verdict.dateAgreement,
        roundUnlock: r.verdict.roundUnlock,
        deathViolations: r.verdict.deathViolations,
      } : undefined,
      issues: Array.isArray(r && r.issues) ? clipDeep(r.issues, STR_CAP.crossCheck).map(String) : [],
      patches: Array.isArray(r && r.patches)
        ? r.patches.slice(0, 40).map((p) => ({
            oldText: String((p && p.oldText) || "").slice(0, 600),
            newText: String((p && p.newText) || "").slice(0, 600),
          }))
        : [],
    }));
  }
  // 修订后复检的剩余问题。注意区分两种情况：
  //   · 数组 → 复检有结论，count 是"这次抽样报出几个"
  //   · {failed:true} → 复检**没有结论**（输出无法解析）——绝不能显示成"0 个问题"
  const recheck = report.revisionRecheck;
  if (Array.isArray(recheck)) {
    out.revisionRecheck = { count: recheck.length, issues: clipDeep(recheck, STR_CAP.crossCheck).map(String) };
  } else if (recheck && typeof recheck === "object" && recheck.failed) {
    out.revisionRecheck = { count: null, failed: true, issues: [] };
  }
  if (!out.trickDesign && !out.outline) return null;   // 没有推理链也没有大纲，不值得落盘

  // 体积兜底：按"信息量/体积比"从低到高丢件，保证留下的总是最该留的
  if (bytesOf(out) > ARTIFACTS_MAX_BYTES) {
    delete out.outline;                                 // 大纲最大且可从成稿重建，先丢
    console.warn("[artifacts] 产物超限，已丢弃 outline");
  }
  if (bytesOf(out) > ARTIFACTS_MAX_BYTES) {
    // 大纲丢了还超限：只保留推理链的"结论面"（面板要展示的部分），丢掉逐条证明链
    const t = out.trickDesign || {};
    out.trickDesign = {
      type: t.type, genre: t.genre, coreTrick: t.coreTrick, dependsOnClock: t.dependsOnClock,
      mechanism: String(t.mechanism || "").slice(0, 800),
      conceal: String(t.conceal || "").slice(0, 800),
      breakPoint: String(t.breakPoint || "").slice(0, 800),
      feasibility: t.feasibility, attempts: t.attempts, lastErrors: t.lastErrors,
      proofChainOmitted: (t.proofChain || []).length,   // 如实记录被丢弃的条数，不假装没有
    };
    console.warn("[artifacts] 产物仍超限，已精简 trickDesign（保留 proofChainOmitted 计数）");
  }
  if (bytesOf(out) > ARTIFACTS_MAX_BYTES) {
    delete out.crossCheck;
    console.warn("[artifacts] 产物仍超限，已丢弃 crossCheck");
  }
  if (bytesOf(out) > ARTIFACTS_MAX_BYTES) {
    delete out.revision;   // 最后才丢留档：它体积中等，且是"自动改写可复核"的唯一依据
    console.warn("[artifacts] 产物仍超限，已丢弃 revision 留档");
  }
  return out;
}

module.exports = { buildArtifacts, clipDeep, ARTIFACTS_MAX_BYTES, STR_CAP, ARR_CAP };
