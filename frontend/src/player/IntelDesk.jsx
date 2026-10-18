import { useMemo, useState } from "react";
import { groupCluesByPlace, clueCategoryStats } from "../lib/clue-place.mjs";

/**
 * 左列「情报台」——对局中常驻的小组件栏（线索目录 / 在场人物 / 进度）。
 *
 * 为什么会有这个东西：改造前 `.game-shell` 是「minmax(0,1fr) 380px」两列 + align-items:start，
 * 左列（全屋讨论 602px + 在场玩家 285px）是**固定高度 920px**，而右列的线索列表随搜证无上限增长。
 * 真浏览器实测（42 条线索）：右列内容底 7267px、左列内容底 3370px —— 左列下方 3897px × 868px
 * 是空的；同一滚动位置把这块栏藏起来量覆盖率，左半屏可见内容 5%（就是纯背景图）。
 *
 * 设计取舍：
 *   1) **不搬右列的内容**。线索全文常驻可见是有意为之（"短行文本窄列更好扫"），
 *      所以这里只做**目录 + 统计**，点一行让右列展开该分组并滚过去 —— 两边不重复。
 *   2) **六个页签改成一条常驻滚动**。页签版实测：线索页签能填满，但"人物"只有 4 张卡、
 *      "进度"只有 6 行，两个页签各自在 891px 面板里留了约 500px 空白 ——
 *      等于把"左半屏的空白"搬进了面板内部。堆叠成一条之后内容约 900px > 面板 768px，
 *      任何状态下都是满的，而且三个部件都不必点页签就能看到（只差一次栏内滚动）。
 *   3) 高度锁成"表头以下的整屏"，钉住时才填得满 —— 见 pages.css 的 .intel-desk。
 *
 * 数据全部来自对局已有状态（players / myClues / chats / searchInfo / myChar），没有新增接口。
 */

/** 从线索对象取编号：口径与 GroupedClues 完全一致（clueId → id → title → label）。 */
function clueLabel(c) {
  return String((c && (c.clueId || c.id || c.title || c.label)) || "?").trim();
}

/** 情报台里的阶段短名（完整名在页头已经有，这里只求一眼能认） */
function phaseLabelShort(p) {
  return {
    lobby: "等待开局", reading: "阅读剧本", intro: "自我介绍",
    round1: "第一轮搜证与讨论", round2: "第二轮搜证与讨论",
    voting: "投票指控", truth_reveal: "真相复盘", finished: "游戏结束",
  }[p] || String(p || "—");
}

export default function IntelDesk({ phase, myChar, players = [], myClues = [], chats = [], searchInfo = null, compact = false, onShowFull = null }) {
  // 记录「被手动展开」的分组；默认全收起 = 一份地点目录（右列默认全展开，两边互补）。
  const [open, setOpen] = useState(() => new Set());
  const [cat, setCat] = useState("");
  // 点目录后给右侧那一行一个短暂高亮，否则玩家不知道跳到哪去了
  const [jumped, setJumped] = useState("");

  const groups = useMemo(() => groupCluesByPlace(myClues), [myClues]);
  const stats = useMemo(() => clueCategoryStats(myClues), [myClues]);
  const shownGroups = cat ? groups.filter((g) => g.cat === cat) : groups;

  // ---- 人物：发言数按 (characterName || playerName) 对齐公屏的 from 口径 ----
  const people = useMemo(() => {
    const countBy = new Map();
    for (const c of chats || []) {
      const k = String(c && c.from ? c.from : "");
      if (!k) continue;
      countBy.set(k, (countBy.get(k) || 0) + 1);
    }
    return players.map((p, i) => {
      const name = p.characterName || p.playerName || "?";
      // foundByName 是"甲、乙"这种顿号拼接（服务端 nameOfPlayer 的产物），必须整段相等，
      // 不能用子串 —— 否则"占卜师"会命中"占卜师学徒"。
      const found = (myClues || []).filter((c) =>
        String((c && c.foundByName) || "").split("、").map((s) => s.trim()).includes(name)).length;
      return {
        seat: i + 1,
        name,
        playerName: p.playerName || "",
        isMe: !!myChar?.name && name === myChar.name,
        isMurderer: !!(myChar && myChar.isMurderer && myChar.name === name),
        isAI: !!p.isAI,
        isNPC: !!p.isNPC,
        connected: p.connected !== false,
        speeches: countBy.get(name) || 0,
        found,
      };
    });
  }, [players, chats, myClues, myChar]);

  const spokenCount = people.filter((p) => p.speeches > 0).length;

  // ---- 进度 ----
  const quota = (searchInfo && searchInfo.quota) || null;
  const roundNo = (searchInfo && searchInfo.round)
    || (phase === "round2" ? 2 : phase === "round1" ? 1 : 0);
  // round 字段是否真的下发了：没下发就不显示"本轮"这一项，免得永远显示 0 条像是坏了。
  const roundKnown = (myClues || []).some((c) => Number.isFinite(Number(c && c.round)));
  const thisRound = roundKnown && roundNo
    ? (myClues || []).filter((c) => Number(c && c.round) === Number(roundNo)).length
    : null;
  const mySpeeches = (chats || []).filter((c) => myChar?.name && c.from === myChar.name).length;

  /**
   * 「看全文」：优先交给调用方（对局页现在把线索全文放在「搜证」模块里，
   * 这里回调一下就切过去）；没给回调时退回老办法 —— 找右列的 `.evidence-panel` 分组头跳过去。
   * ⚠️ 改版后右列已经不存在了，所以老办法会**静默失效**；这就是为什么必须加回调，
   * 否则按钮点了毫无反应（和"审讯没反馈"是同一类问题）。
   */
  function showFull(label) {
    if (onShowFull) { try { onShowFull(label); } catch (e) { /* 不影响对局 */ } return; }
    jumpToGroup(label);
  }

  /**
   * 跳到右侧「已发现的线索」里对应的分组：分组头永远在 DOM 里（收起的组只是不渲染 body），
   * 所以按分组名找得到；收起状态读 aria-expanded（GroupedClues 已经写好了这个属性）。
   * 这是纯粹的"读 DOM + 点已有控件"，不改右列任何状态与行为；找不到就安静地什么都不做。
   */
  function jumpToGroup(label) {
    try {
      const find = () => [...document.querySelectorAll(".evidence-panel .clue-group-head")]
        .find((h) => (h.textContent || "").includes(label));
      const head = find();
      if (!head) return;
      const collapsed = head.getAttribute("aria-expanded") === "false";
      if (collapsed) head.click();        // 先展开，否则跳过去只有一个标题
      const go = () => {
        const h = find();
        if (!h) return;
        // block:'center' 而不是 'start'：顶部有 60px 的吸顶表头，'start' 会被表头压住。
        h.scrollIntoView({ behavior: "instant", block: "center" });
        setJumped(label);
        setTimeout(() => setJumped(""), 1600);
      };
      if (collapsed) setTimeout(go, 80); else go();
    } catch (e) { /* 跳转失败不该影响对局 */ }
  }

  return (
    <div className={"panel intel-desk" + (compact ? " is-compact" : "")} aria-label="情报台">
      <div className="panel-head">
        <strong>🧭 情报台</strong>
        <span className="text-xs text-dim">随对局常驻，滚到下面也看得见</span>
      </div>

      <div className="intel-desk-body">
        {/* ===================== ① 线索目录 ===================== */}
        <section className="intel-desk-sec">
          <div className="intel-desk-sec-head">
            <span>🔍 线索</span>
            <span className="badge clue-count">{myClues.length}</span>
            <span className="text-xs text-dim" style={{ marginLeft: "auto" }}>
              {groups.length} 个大地点
            </span>
          </div>

          {(myClues || []).length === 0 ? (
            <div className="intel-desk-empty">
              还没有线索被发现。线索一被搜到就会自动公开给全场，
              出现后这里会按大地点列成目录，点「看全文」就到「搜证」模块里读原文。
            </div>
          ) : (
            <div>
              <div className="text-xs text-dim" style={{ marginBottom: 8, lineHeight: 1.7 }}>
                点一行 → 右侧「已发现的线索」展开该组并滚过去
              </div>

              {stats.length > 1 && (
                <div className="chip-row" style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    className={"chip" + (cat === "" ? " active" : "")}
                    onClick={() => setCat("")}
                  >
                    全部 {myClues.length}
                  </button>
                  {stats.map((s) => (
                    <button
                      key={s.cat}
                      type="button"
                      className={"chip" + (cat === s.cat ? " active" : "")}
                      onClick={() => setCat(cat === s.cat ? "" : s.cat)}
                      title={`${s.cat}：${s.clues} 条 / ${s.groups} 个大地点`}
                    >
                      {s.cat} {s.clues}
                    </button>
                  ))}
                </div>
              )}

              {shownGroups.map((g) => {
                const isOpen = open.has(g.key);
                const isJumped = jumped && g.label === jumped;
                return (
                  <div
                    key={g.key}
                    className="intel-desk-clue-group"
                    style={isJumped ? { borderColor: "var(--brass-line)", background: "var(--brass-tint)" } : undefined}
                  >
                    {/* 行内两个独立按钮（展开 / 看全文）——HTML 不允许 button 里套 button，
                        所以这里用 div 包住两个兄弟按钮，而不是把第二个塞进第一个里。 */}
                    <div className="intel-desk-clue-row">
                      <button
                        type="button"
                        className="intel-desk-clue-toggle"
                        aria-expanded={isOpen}
                        onClick={() => setOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                          return next;
                        })}
                        title={isOpen ? "在本栏收起该地点的线索编号" : "在本栏展开该地点的线索编号"}
                      >
                        <span style={{ opacity: 0.65, width: 10, flexShrink: 0 }}>{isOpen ? "▾" : "▸"}</span>
                        <span>📍 {g.label === "未知" ? "地点未记录" : g.label}</span>
                        {g.cat !== "地点" ? (
                          <span className="text-muted" style={{ fontWeight: 400, fontSize: 11 }}>（{g.cat}）</span>
                        ) : null}
                        <span className="badge clue-count" style={{ marginLeft: "auto" }}>{g.items.length}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-xs"
                        style={{ flexShrink: 0 }}
                        title="看线索全文（打开「搜证」模块，里面按地点分组列了全文）"
                        onClick={() => showFull(g.label)}
                      >
                        看全文 ↗
                      </button>
                    </div>

                    {isOpen && (
                      <div className="intel-desk-clue-ids">
                        {g.items.map(({ clue: c }, i) => (
                          <button
                            key={i}
                            type="button"
                            className="chip"
                            title={`${clueLabel(c)}${c.foundByName ? " ｜ " + c.foundByName + " 发现" : ""}（在「搜证」里看全文）`}
                            onClick={() => jumpToGroup(g.label)}
                          >
                            {clueLabel(c)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ===================== ② 在场人物 ===================== */}
        <section className="intel-desk-sec">
          <div className="intel-desk-sec-head">
            <span>👥 在场人物</span>
            <span className="badge">{people.length}</span>
            <span className="text-xs text-dim" style={{ marginLeft: "auto" }}>
              已开口 {spokenCount} 人
              {people.length - spokenCount > 0 ? ` ｜ ${people.length - spokenCount} 人未发言` : ""}
            </span>
          </div>
          {people.length === 0 && <div className="intel-desk-empty">还没有玩家入座。</div>}
          {people.map((p) => (
            <div key={p.seat + p.name} className={"intel-desk-person" + (p.isMe ? " is-me" : "")}>
              <span className="roster-seat">{p.seat}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontFamily: "var(--font-serif)", color: p.isMe ? "var(--brass)" : "var(--text)" }}>
                  {p.name}
                </span>
                {p.playerName && p.playerName !== p.name ? (
                  <span className="text-xs text-dim">（{p.playerName}）</span>
                ) : null}
                <span style={{ marginLeft: 6 }}>
                  {p.isMe ? <span className="tag tag-admin">我</span> : null}
                  {p.isMurderer ? <span className="tag tag-danger">凶手</span> : null}
                  {p.isNPC ? <span className="tag tag-npc">NPC</span> : null}
                  {p.isAI && !p.isNPC ? <span className="tag tag-npc">AI</span> : null}
                  {!p.connected ? <span className="tag tag-warning">掉线</span> : null}
                </span>
              </span>
              <span className="text-xs text-dim" style={{ textAlign: "right", flexShrink: 0, lineHeight: 1.6 }}>
                发言 {p.speeches}
                <br />发现 {p.found}
              </span>
            </div>
          ))}
        </section>

        {/* ===================== ③ 进度 ===================== */}
        <section className="intel-desk-sec">
          <div className="intel-desk-sec-head"><span>🎯 进度</span></div>
          <div className="field-row">
            <span className="field-key">阶段</span>
            <span className="field-val">{phaseLabelShort(phase)}</span>
          </div>
          <div className="field-row">
            <span className="field-key">轮次</span>
            <span className="field-val">{roundNo ? `第 ${roundNo} 轮` : "—"}</span>
          </div>
          <div className="field-row">
            <span className="field-key">搜证次数</span>
            <span className="field-val">
              {!quota ? "读取中…"
                : quota.unlimited ? <span>不限次数</span>
                  : <span>剩余 <strong style={{ color: "var(--brass)" }}>{quota.remaining}</strong> / {quota.max} 次</span>}
            </span>
          </div>
          <div className="field-row">
            <span className="field-key">线索</span>
            <span className="field-val">
              全场 {myClues.length} 条 · {groups.length} 个大地点
              {thisRound !== null ? <span className="text-dim">（本轮已搜出 {thisRound} 条）</span> : null}
            </span>
          </div>
          <div className="field-row">
            <span className="field-key">发言</span>
            <span className="field-val">全场 {chats.length} 条 · 我 {mySpeeches} 条</span>
          </div>
          <div className="field-row">
            <span className="field-key">我的角色</span>
            <span className="field-val">
              {myChar?.name || "尚未分配"}
              {myChar?.isMurderer ? <span className="tag tag-danger" style={{ marginLeft: 6 }}>凶手</span> : null}
            </span>
          </div>
          {roundKnown === false && myClues.length > 0 && (
            <div className="intel-desk-empty" style={{ marginTop: 8 }}>
              这一局的线索数据里没有带轮次字段，所以只统计了全场条数。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
