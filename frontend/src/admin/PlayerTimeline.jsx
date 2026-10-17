/**
 * 全员时间线（测试房管理员用）
 *
 * 目的（用户要求）：**给一个具体时间点，看每个玩家在干什么** ——
 * 这是查剧本矛盾最快的一屏：同一时刻谁说在哪、谁说不出（显示「—」）一目了然。
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

/** 从一段文本里取出"时间线"小节的正文行 */
function timelineLines(script) {
  const lines = String(script || "").split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s+(.*)$/);
    if (!h) continue;
    const title = h[2];
    if (/时间线/.test(title) && !/(故事|表面|真实|完整|上帝)时间线/.test(title)) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s+/);
    if (h && h[1].length <= level) break;          // 只在同级或更高级标题处结束（与后端一致）
    out.push(lines[i]);
  }
  return out;
}

/** 一行里取时刻（HH:MM）与事件正文 */
function parseEntry(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  if (!/^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/.test(raw)) return null;   // 只认条列式行
  const bare = raw.replace(/^(?:[-*+]|\d+[.、)]|[（(]\d+[）)])\s*/, "").replace(/\*\*/g, "");
  const m = bare.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!m) return null;
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = m[2];
  const body = bare
    .replace(/^[^0-9]{0,12}/, "")                              // 去掉行首的"1月8日"等日期前缀
    .replace(/\d{1,2}\s*[:：]\s*\d{2}/, "")                    // 去掉时刻本身
    .replace(/[（(](真实|座钟)[^）)]*[）)]/g, "")
    .replace(/[【\[][^】\]]*[】\]]/g, "")
    .replace(/^[\s—\-–:：、，,。;；]+/, "")
    .trim();
  return { time: `${hh}:${mm}`, body: body || bare };
}

/** scripts 可能是数组，也可能是 {characters:[...]}（接口形状两种都兼容） */
function characterList(scripts) {
  if (!scripts) return [];
  const arr = Array.isArray(scripts) ? scripts : (scripts.characters || scripts.list || []);
  return (Array.isArray(arr) ? arr : [])
    .map((c) => ({ name: String((c && (c.name || c.characterName)) || ""), script: String((c && (c.playerScript || c.script || c.text)) || ""), roleType: (c && c.roleType) || "", noTimeline: timelineLines(String((c && (c.playerScript || c.script || c.text)) || "")).length === 0 }))
    .filter((c) => c.name && c.script);
}

export default function PlayerTimeline({ scripts }) {
  const [onlyGaps, setOnlyGaps] = useState(false);

  const { chars, times, table } = useMemo(() => {
    const cs = characterList(scripts);
    const map = new Map();                       // name -> Map(time -> body)
    for (const c of cs) {
      const m = new Map();
      for (const line of timelineLines(c.script)) {
        const e = parseEntry(line);
        if (e && !m.has(e.time)) m.set(e.time, e.body);     // 同一时刻只取第一条
      }
      map.set(c.name, m);
    }
    const all = new Set();
    for (const m of map.values()) for (const t of m.keys()) all.add(t);
    const sorted = [...all].sort();               // "HH:MM" 字符串序即时间序
    const tb = sorted.map((t) => ({
      time: t,
      cells: cs.map((c) => ({ name: c.name, body: map.get(c.name).get(t) || "" })),
    }));
    return { chars: cs, times: sorted, table: tb };
  }, [scripts]);

  if (!chars.length) return null;
  const gapCount = (name) => times.filter((t) => !table.find((r) => r.time === t).cells.find((c) => c.name === name).body).length;
  const shown = onlyGaps ? table.filter((r) => r.cells.some((c) => !c.body)) : table;

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
