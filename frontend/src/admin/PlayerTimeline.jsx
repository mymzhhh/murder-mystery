/**
 * 全员时间线（测试房管理员用）
 *
 * 目的（用户要求）：**给一个具体时间点，看每个玩家在干什么** ——
 * 这是查剧本矛盾最快的一屏：同一时刻谁说在哪、谁说不出（显示「—」）一目了然。
 *
 * 两种排版（同一个解析结果，只是摆法不同）：
 *   · 默认：多列表格「时刻 × 角色」，给**宽列**用（主列）；
 *   · compact：**堆叠式**「一个时刻一段，段内一行一个角色」，给侧边栏那 380px 窄列用 ——
 *     宽表塞进窄列只有两个结果：要么被截断，要么整列横向滚动（表格的 min-content 就是列数 × 列宽），
 *     两种都读不了。堆叠式把"角色"从列变成行，宽度就与人数无关了。
 *     窄版仍然保留"缺 N"的缺口计数与「只看有缺口的时刻」开关 —— 判据一致，只是换了个摆法。
 *
 * 数据来源：测试房接口返回的全部角色剧本（`/api/admin/test-runs/:room/scripts`）。
 * 不依赖后端改动：时间线小节本来就在每个角色剧本里，这里按与后端**同一套规则**解析：
 *   1. 定位"时间线"小节（标题含"时间线"，排除"故事/表面/真实/完整时间线"这类他人视角标题）；
 *   2. 小节内按**条列式**行提取 `HH:MM`（支持 `**21:00**`、`（真实21:00）`、`21:00前后`）；
 *   3. 汇总所有出现过的时刻，按时间排序，一行一个时刻、一列一个角色。
 *
 * 空缺显示「—」：角色对某个时刻**没有交代**，这正是 DM 要追问的地方。
 */
import { useMemo, useState } from "react";
// 解析规则抽到 lib（可在 node --test 里直接测，也与后端 timeline-utils 的规则摆在一起对照）。
// 本轮的关键修复就在那个文件里：标题识别除 markdown `#` 之外，还要认真实剧本的
// `【三、时间线（…）】` 与 `**时间线**` —— 否则导入的真实剧本永远是 0 个时刻。
// 条目形态的容忍度跟着标题形态走：markdown 小节仍只认条列式行（零回归），
// `【】` 小节连散文行也认（作者已经把它放在"时间线"标题下了）。
import { buildTimelineTable } from "../lib/player-timeline.mjs";

// 说明：timelineLines / parseEntry / characterList 已移到 ../lib/player-timeline.mjs
// （原来三份实现在这里内联，既无法单测、也无法与后端规则对照 —— 见该文件头的说明。）

export default function PlayerTimeline({ scripts, compact }) {
  const [onlyGaps, setOnlyGaps] = useState(false);

  // 解析与「时刻 × 角色」表全部在 lib 里（同一套规则既给这里用，也能被单测直接钉住）
  const { chars, times, table } = useMemo(() => buildTimelineTable(scripts), [scripts]);

  if (!chars.length) return null;
  const gapCount = (name) => times.filter((t) => !table.find((r) => r.time === t).cells.find((c) => c.name === name).body).length;
  const shown = onlyGaps ? table.filter((r) => r.cells.some((c) => !c.body)) : table;

  // ============ 窄列（侧边栏 380px）堆叠式 ============
  // 结构：一个时刻 = 一段；段内一行一个角色。宽度只取决于容器，不随人数增长。
  if (compact) {
    return (
      <div className="text-xs">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <strong>全员时间线</strong>
          <span className="text-dim">{chars.length} 人 / {times.length} 个时刻</span>
          <label className="text-xs text-dim" style={{ marginLeft: "auto", cursor: "pointer" }}>
            <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> 只看有缺口的时刻
          </label>
        </div>
        {/* 缺口计数（宽表里在表头，窄版放这儿）：每个角色有几个时刻没交代 */}
        <div className="text-dim" style={{ lineHeight: 1.7, marginBottom: 4 }}>
          缺口：
          {chars.map((c, i) => (
            <span key={c.name}>
              {i ? "、" : ""}
              {c.name} {c.noTimeline ? "无时间线" : gapCount(c.name)}
            </span>
          ))}
        </div>
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          {shown.map((row) => (
            <div key={row.time} style={{ borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))", padding: "4px 0" }}>
              <div style={{ color: "var(--brass, #c9a227)", fontWeight: 600 }}>{row.time}</div>
              {row.cells.map((c) => (
                <div key={c.name} style={{ display: "flex", gap: 6, lineHeight: 1.7, marginTop: 2 }}>
                  <span className="text-dim" style={{
                    flex: "0 0 62px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }} title={c.name}>{c.name}</span>
                  <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                    {c.body ? String(c.body).slice(0, 90) : <span className="text-dim">—</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {/* 空状态必须说清"为什么空"，否则看起来就像部件坏了：
              本剧本（《再见卡门》）的角色正文用的是【】小节标题 + 散文式时刻（"23：20" 单独成行、
              没有条列式），而这一层与后端 extractCharacterTimeline 同一套判据（都只认 markdown 标题
              + 条列式行），所以两边都取不到 —— 这是剧本形状问题，不是显示问题。 */}
          {!times.length ? (
            <div className="text-dim" style={{ lineHeight: 1.7 }}>
              0 个时刻：这几个角色的正文里没有 markdown 形式的「时间线」小节（本剧本用的是【…】小节标题），
              也没有条列式时刻行（`- **21:00**：…`）。判据与后端取时间线时同一套（只认 markdown 标题 + 条列式行），
              所以后端同样读不到 —— 这是剧本正文的形状问题：玩家手里没有可对照的时间线。
            </div>
          ) : (!shown.length ? (
            <div className="text-dim">勾了「只看有缺口的时刻」，但这一局每个时刻都有人交代（没有缺口）。</div>
          ) : null)}
        </div>
        <div className="text-dim" style={{ marginTop: 6 }}>「—」表示该角色对这个时刻没有交代——这正是 DM 该追问的点（每条正文截断到 90 字，全文见「人物」页签）</div>
      </div>
    );
  }

  return (
    <div className="text-xs" style={{ marginBottom: 10, padding: "6px 8px", border: "1px solid var(--brass-line)", borderRadius: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <strong>全员时间线</strong>
        <span className="text-dim">{chars.length} 人 / {times.length} 个时刻</span>
        <label className="text-xs text-dim" style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> 只看有缺口的时刻
        </label>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, lineHeight: 1.6 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", position: "sticky", top: 0, background: "var(--ink-800, #1b1b1b)", padding: "3px 6px", whiteSpace: "nowrap" }}>时刻</th>
              {chars.map((c) => (
                <th key={c.name} style={{ textAlign: "left", position: "sticky", top: 0, background: "var(--ink-800, #1b1b1b)", padding: "3px 6px", whiteSpace: "nowrap" }}>
                  {c.name}{c.roleType === "npc" ? <span className="text-dim">（NPC）</span> : null}
                  {c.noTimeline ? <span className="text-dim">（无时间线）</span> : <span className="text-dim">（缺 {gapCount(c.name)}）</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.time} style={{ borderTop: "1px solid var(--ink-600, rgba(255,255,255,.08))" }}>
                <td style={{ padding: "3px 6px", whiteSpace: "nowrap", color: "var(--brass, #c9a227)" }}>{row.time}</td>
                {row.cells.map((c) => (
                  <td key={c.name} style={{ padding: "3px 6px", verticalAlign: "top" }}>
                    {c.body ? <span title={String(c.body)}>{String(c.body).slice(0, 110)}</span> : <span className="text-dim">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-dim" style={{ marginTop: 4 }}>「—」表示该角色对这个时刻没有交代——这正是 DM 该追问的点</div>
    </div>
  );
}
