// 线索"发现地点" → 大地点归类
//
// 抽成独立模块是为了能被单测覆盖：这段逻辑曾经坏得很隐蔽 ——
// 旧实现依赖一份写死的房间名清单（书房/卧室/厨房…），匹配不到就直接拿原始字符串当分组名。
// 而剧本的房间是动态生成的（"御花园凉亭"不在清单里），于是
// "御花园凉亭（地面）" 和 "御花园凉亭（栏杆）" 各自成了独立分组，一局几十条线索平铺下来，
// 找某一条要滚很久 —— 界面上看起来"有分组"，实际上等于没分。
//
// 现在按结构而不是词表来判断：剥掉括号里的细分位置，剩下的就是大地点。
//
// 第二轮修正：只剥括号还不够 —— 剧本里的地点本身是有层级的
// （御花园 / 御花园凉亭 / 御花园假山后），一局下来仍然会拆出二十来个分组，
// 筛选框里二十多个选项，比不筛还累。所以再加一步"前缀归并"：
// 谁的名字是另一个的前缀，就并到名字更短的那个（"御花园"）底下。
// 被并掉的原始地点不丢，记在条目的 place 字段上，界面上以小标签显示。

/** 搜身线索的括号里通常写的是随身物件/身体部位 → 这类线索的大地点是"那个人" */
const BODY_HINT = /随身|身上|尸身|袖|怀中|胸口|口袋|衣|裤|鞋|帽|佩|珮|簪|表|戒|包|袋|首饰|手|颈|腰/;
/** 证词类线索本身就是"某人的说法"，没有地点 */
const TESTIMONY_HINT = /证词|口供|供述|陈述|目击|听说|看到|听到/;

/**
 * 把"发现地点"归一成 { 大地点, 细分位置, 类别 }。
 * @param {string} loc 原始地点，如 "御花园凉亭（地面）"、"赵恒（怀中玉珮）"
 * @returns {{ cat: "地点"|"人物证词"|"搜身物品", label: string, sub: string }}
 */
export function parseCluePlace(loc) {
  const raw = String(loc === null || loc === undefined ? "" : loc).trim();
  if (!raw) return { cat: "地点", label: "未知", sub: "" };

  const paren = raw.match(/[（(]([^）)]*)[）)]/);
  const sub = paren ? paren[1].trim() : "";
  // 剥掉括号注记后剩下的就是大地点；剥完为空则退回原串（避免只剩空白）
  const main = raw.replace(/[（(][^）)]*[）)]/g, "").trim() || raw;

  if (TESTIMONY_HINT.test(raw)) return { cat: "人物证词", label: main, sub };
  if (sub && BODY_HINT.test(sub)) return { cat: "搜身物品", label: main, sub };
  // 没有括号但整串就带随身语义（"王铎的袖袋"）
  if (!sub && BODY_HINT.test(raw)) return { cat: "搜身物品", label: main, sub };
  return { cat: "地点", label: main, sub };
}

/** 类别排序权重：地点 → 人物证词 → 搜身物品 */
export const CATEGORY_ORDER = ["地点", "人物证词", "搜身物品"];

/** 参与前缀归并的最短地名。1 个字太容易误并（"东"/"西"），所以至少 2 个字。 */
const MIN_PREFIX_LEN = 2;

/**
 * 把同类别里"名字是别人前缀"的分组并到更短的那个底下。
 * 只处理同一类别，且只处理 地点 —— 人名的前缀关系没有意义。
 * 输入是 Map<key, group>，输出是新的 Map（不修改入参）。
 */
function mergeByPrefix(map) {
  const out = new Map();
  // 短的先确定父节点，长的再往上挂：这样"御花园→御花园凉亭→御花园凉亭东角"
  // 会全部落到"御花园"，而不会出现辈分层。
  const ordered = [...map.values()].sort(
    (a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label, "zh"),
  );
  for (const g of ordered) {
    let parent = null;
    if (g.cat === "地点") {
      for (const cand of out.values()) {
        if (cand.cat !== "地点") continue;
        if (cand.label.length < MIN_PREFIX_LEN) continue;
        if (g.label.length > cand.label.length && g.label.startsWith(cand.label)) {
          parent = cand;
          break;
        }
      }
    }
    if (!parent) {
      out.set(g.key, { ...g, places: [g.label], items: [...g.items] });
      continue;
    }
    parent.places.push(g.label);
    parent.items.push(...g.items);
  }
  return out;
}

/**
 * 把线索列表按大地点分组（先剥括号，再前缀归并）。
 * @param {Array} clues
 * @returns {Array<{
 *   key: string, cat: string, label: string,
 *   places: string[],
 *   items: Array<{clue: object, sub: string, place: string}>,
 * }>}
 */
export function groupCluesByPlace(clues) {
  const flat = new Map();
  for (const c of clues || []) {
    const loc = (c && (c.discoveryLocation || c.location || c.discoveredAt)) || "";
    const { cat, label, sub } = parseCluePlace(loc);
    const key = cat + "|" + label;
    if (!flat.has(key)) flat.set(key, { key, cat, label, items: [] });
    // place 是归并前的原始大地点：界面上当 group.label 更宽时补一个小标签，避免丢信息
    flat.get(key).items.push({ clue: c, sub, place: label });
  }
  return [...mergeByPrefix(flat).values()].sort((a, b) => {
    const d = CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat);
    // 同类里线索多的排前面：一眼能看到信息量最大的地方
    if (d !== 0) return d;
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.label.localeCompare(b.label, "zh");
  });
}

/**
 * 每个类别有几条线索、几个大地点 —— 给筛选按钮用。
 * 之所以要"几个地点"：线索条数一样的两个类别，分组多的那个更难扫。
 * @param {Array} clues
 * @returns {Array<{cat: string, clues: number, groups: number}>} 只含非空类别，按 CATEGORY_ORDER 排
 */
export function clueCategoryStats(clues) {
  const groups = groupCluesByPlace(clues);
  return CATEGORY_ORDER.map((cat) => {
    const gs = groups.filter((g) => g.cat === cat);
    return {
      cat,
      clues: gs.reduce((n, g) => n + g.items.length, 0),
      groups: gs.length,
    };
  }).filter((s) => s.clues > 0);
}
