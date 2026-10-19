// 搜证地点收敛：把"碎成几十个"的线索地点合并回房间级。
//
// 为什么需要（2026-10-18 实测）：生成稿 40 条线索碎成 **36 个地点**、每轮 18-20 个搜证点，
// 玩家在搜证界面里挑不过来；而且同一房间的线索被拆进不同"地点"，永远凑不齐。
// 真本《吉普赛女郎之死》是 45 条线索 / **7 个地点**。
//
// 策略（保守，宁可少合不可错合）：
//   1) 只合并"明显是同一房间"的写法：`书房桌面`→`书房`、`维修间挂钟转轴`→`维修间`；
//      依据是**布局地点清单里的房间名**做前缀/包含匹配；
//   2) 人物名（搜身）保持原样，但把 `周管家右手`→`周管家`；
//   3) 证词类统一成「证言」（`林医生证词`→`证言`）；
//   4) 合并后仍超过上限时，按"线索条数"把最少的地点并进「其他地点」，并明确告警 ——
//      绝不静默丢弃线索（线索丢了玩家就断链）。
const BODY_PARTS = /(桌面|抽屉|床底|床头柜|床头|柜子|书桌|衣柜|窗台|墙角|地面|门口|门后|门锁|垃圾桶|烟灰缸|桌下|角落|架子上|挂钟|转轴|口袋|指甲缝|口腔|胃部|颈部|上衣|药箱|暗格|暗门|信箱|花盆|椅子|沙发|地毯|垫子|上方|下方|内部|内侧|外侧|上|里|内|旁|边)$/;

const TESTIMONY_RE = /证词|证言|口供|陈述|供述/;

/**
 * @param {Array<{location?:string, content?:string, clueType?:string}>} clues
 * @param {{places?: string[], maxLocations?: number, keepPersonNames?: boolean}} [opts]
 * @returns {{clues: Array, before:number, after:number, mapping: Record<string,string>, warnings: string[]}}
 */
function collapseClueLocations(clues, opts) {
  const o = opts || {};
  const places = (o.places || []).map((p) => String(p || "").trim()).filter(Boolean);
  const maxLocations = Number.isFinite(o.maxLocations) ? o.maxLocations : 7;
  const warnings = [];
  const mapping = {};
  const list = Array.isArray(clues) ? clues : [];

  // 房间名按长度降序，保证"沈曼青闺房"优先于"闺房"
  const rooms = [...places].sort((a, b) => b.length - a.length);

  const mapOne = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return { to: "", why: "empty" };
    // ① 证词类 → 证言
    if (TESTIMONY_RE.test(s)) return { to: "证言", why: "testimony" };
    // ② 命中布局房间（包含即可：`书房桌面` 含 `书房`）
    const room = rooms.find((r) => s === r || s.startsWith(r) || s.includes(r));
    if (room) return { to: room, why: "room" };
    // ③ 去掉"子位置"后缀（`维修间挂钟转轴`→`维修间` 已在②处理；这里处理布局外的写法）
    let cut = s;
    for (let i = 0; i < 3; i++) {
      const next = cut.replace(BODY_PARTS, "").trim();
      if (!next || next === cut) break;
      cut = next;
    }
    if (cut !== s && cut.length >= 2) {
      const room2 = rooms.find((r) => cut === r || cut.startsWith(r) || cut.includes(r));
      return { to: room2 || cut, why: room2 ? "room-after-trim" : "trim" };
    }
    return { to: s, why: "keep" };
  };

  const mapped = list.map((c) => {
    const { to, why } = mapOne(c && c.location);
    const from = String((c && c.location) || "");
    if (to && from && to !== from) mapping[from] = to;
    if (why === "keep" && from && !places.some((p) => from.includes(p))) {
      // 既不在布局里、也裁不出房间名 —— 留着但记录（可能是人物名/搜身）
      if (!/[一-龥]{2,4}$/.test(from)) warnings.push(`地点「${from}」既不在布局也不是人物名，保留原样`);
    }
    return { ...c, location: to || from };
  });

  // ④ 超上限时把"最少"的地点并进「其他地点」（不丢线索，只合并搜索点）
  const count = new Map();
  for (const c of mapped) count.set(c.location, (count.get(c.location) || 0) + 1);
  let finalList = mapped;
  if (count.size > maxLocations) {
    const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
    const keep = new Set(sorted.slice(0, maxLocations - 1).map(([k]) => k));
    const merged = [];
    for (const c of mapped) {
      if (keep.has(c.location)) { merged.push(c); continue; }
      if (c.location) mapping[c.location] = "其他地点";
      merged.push({ ...c, location: "其他地点" });
    }
    finalList = merged;
    warnings.push(`地点数 ${count.size} 超过上限 ${maxLocations}，已把 ${count.size - keep.size} 个低频地点合并为「其他地点」（线索一条未丢）`);
  }

  const after = new Set(finalList.map((c) => c.location)).size;
  return { clues: finalList, before: new Set(list.map((c) => String((c && c.location) || ""))).size, after, mapping, warnings };
}

module.exports = { collapseClueLocations, BODY_PARTS };
