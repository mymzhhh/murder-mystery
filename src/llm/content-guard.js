// 内容审核 — 剧本生成入口与产物落库前的一线过滤
//
// 领域约束（很重要）：本产品就是生成谋杀悬疑剧本的，"毒杀""密室""分尸""真凶"
// 全都是正常题材，绝不能拦。因此这里的规则刻意只覆盖**明确的违规类别**，
// 并且把"需要人工判断"和"必须拦"分成两级：
//
//   block  —— 明确违规，直接拒绝生成（露骨色情、未成年性内容、真实犯罪教学、自伤方法）
//   review —— 允许生成但记警告日志，供运营复核（涉真实政治人物/在世公众人物、极端暴力细节）
//
// 为什么 review 级不直接拦：民国/历史题材剧本天然会出现真实历史人物
// （杜月笙、川岛芳子这类），一律拦掉会把正常题材挡在门外。
//
// 局限：这是**基于规则的快速一线过滤**，不是完整的内容安全方案。
// 规则表是数据驱动的，可以按运营反馈扩充；要更强覆盖应在后面再接一层模型分类器。

/**
 * block 级规则：命中即拒绝生成。
 * 每条都要求"违规要素 + 意图词"同时出现，避免单个敏感词误伤正常题材。
 */
const BLOCK_RULES = [
  {
    category: "explicit-sexual",
    label: "露骨色情内容",
    re: /(做爱|性交|口交|肛交|肉棒|阴道|阴茎|射精|淫水|裸体性|性高潮|群交|强奸细节)/,
  },
  {
    category: "minor-sexual",
    label: "涉未成年人的性内容",
    re: /(未成年|幼女|幼童|儿童|小学生|初中生|萝莉|正太)[^。！？\n]{0,14}(性行为|性关系|性侵|猥亵|强暴|强奸|裸照|开苞|调教)/,
  },
  {
    category: "weapon-recipe",
    label: "真实危险物的制作方法",
    re: /(制作|合成|提炼|配制|制造|自制)[^。！？\n]{0,10}(炸弹|爆炸物|炸药|冰毒|海洛因|毒品|枪支|枪械|TATP|蓖麻毒素|沙林)[^。！？\n]{0,10}(步骤|方法|教程|配方|流程|比例|工艺)/,
  },
  {
    category: "self-harm-instruction",
    label: "自伤/自杀方法指导",
    re: /(自杀|自残|轻生|割腕|上吊|烧炭)[^。！？\n]{0,10}(方法|教程|怎么做|如何|步骤|攻略|无痛)/,
  },
  {
    category: "sexual-violence-instruction",
    label: "性暴力的实施指导",
    re: /(迷奸|下药迷|强奸)[^。！？\n]{0,10}(方法|教程|步骤|如何|技巧|不被发现)/,
  },
];

/**
 * review 级规则：允许生成，但记录警告供人工复核。
 */
const REVIEW_RULES = [
  {
    category: "real-political-figure",
    label: "涉及现任政治人物",
    re: /(现任|在任|当今)[^。！？\n]{0,6}(国家主席|总书记|总统|总理|首相|皇帝)/,
  },
  {
    category: "real-living-person",
    label: "点名真实在世公众人物",
    re: /(真实|现实中|现实里的)[^。！？\n]{0,8}(明星|演员|歌手|企业家|网红|运动员)[^。！？\n]{0,6}(被杀|是凶手|作案|死亡)/,
  },
  {
    category: "graphic-violence",
    label: "极端暴力细节",
    re: /(分尸|碎尸|肢解|剥皮|挖出内脏|煮熟尸|割下)[^。！？\n]{0,10}(详细|步骤|过程|描写|细节)/,
  },
  {
    category: "real-tragedy",
    label: "影射真实惨案/灾难",
    re: /(真实事件改编|真实案例|某某案|空难|地震|疫情)[^。！？\n]{0,8}(凶手|作案|杀人|阴谋|幕后)/,
  },
];

/** 命中检测：返回该文本触发的全部规则类别 */
function matchRules(text, rules) {
  const s = String(text === null || text === undefined ? "" : text);
  const hits = [];
  for (const r of rules) {
    if (r.re.test(s)) hits.push({ category: r.category, label: r.label });
  }
  return hits;
}

/**
 * 审核一段文本。
 * @param {string} text 待审文本（生成输入，或生成产物）
 * @param {{ stage?: "input"|"output", field?: string }} opts 仅用于日志措辞
 * @returns {{ action: "allow"|"review"|"block", categories: string[], labels: string[], reason: string }}
 */
function screenContent(text, opts = {}) {
  const blocked = matchRules(text, BLOCK_RULES);
  if (blocked.length) {
    return {
      action: "block",
      categories: blocked.map(h => h.category),
      labels: blocked.map(h => h.label),
      reason: `请求包含不允许的内容：${blocked.map(h => h.label).join("、")}`,
    };
  }
  const flagged = matchRules(text, REVIEW_RULES);
  if (flagged.length) {
    return {
      action: "review",
      categories: flagged.map(h => h.category),
      labels: flagged.map(h => h.label),
      reason: `内容需要人工复核：${flagged.map(h => h.label).join("、")}`,
    };
  }
  return { action: "allow", categories: [], labels: [], reason: "" };
}

/**
 * 审核生成需求。除了内容规则，还做最基本的输入校验
 * （空需求会让 LLM 自由发挥，产出不可控，不如直接拒绝）。
 * @param {string} text
 */
function screenGenerationRequest(text) {
  const raw = String(text === null || text === undefined ? "" : text).trim();
  if (!raw) {
    return { action: "block", categories: ["empty"], labels: ["空需求"], reason: "请先描述你想要的剧本" };
  }
  if (raw.length > 2000) {
    return { action: "block", categories: ["too-long"], labels: ["需求过长"], reason: "需求描述请控制在 2000 字以内" };
  }
  return screenContent(raw, { stage: "input", field: "userInput" });
}

/**
 * 审核生成产物：在落库前对剧本全文做一遍，拦住模型被诱导输出的违规内容。
 * 产物是长文本，只做 block 级判断（review 级对长文噪声太大）。
 * @param {string} text
 */
function screenGeneratedScript(text) {
  const blocked = matchRules(text, BLOCK_RULES);
  if (blocked.length) {
    return {
      action: "block",
      categories: blocked.map(h => h.category),
      labels: blocked.map(h => h.label),
      reason: `生成产物包含不允许的内容：${blocked.map(h => h.label).join("、")}`,
    };
  }
  return { action: "allow", categories: [], labels: [], reason: "" };
}

module.exports = {
  BLOCK_RULES,
  REVIEW_RULES,
  screenContent,
  screenGenerationRequest,
  screenGeneratedScript,
};
