import React from "react";

/**
 * 左侧竖排模块栏（图标在上、文字在下）。
 *
 * 为什么抽成组件：测试剧本页和玩家对局页要**长得一样**（用户明确要求），
 * 两处各写一份内联样式，迟早会一处改了另一处没改。这里只做"展示 + 回调"，
 * 不持有任何业务状态 —— 打开哪个模块由调用方决定（测试房用弹框，玩家页按模块性质分派）。
 *
 * @param {Array<{key:string, icon?:string, label:string, title?:string, badge?:string}>} items
 * @param {(key:string)=>void} onSelect 点击回调
 * @param {string} [active] 当前激活项的 key（只影响高亮）
 * @param {boolean} [sticky] 是否滚动时钉住（默认 true）
 * @param {string} [ariaLabel]
 */
export function SideRail({ items = [], onSelect, active = "", sticky = true, ariaLabel = "模块栏", order }) {
  if (!items.length) return null;
  return (
    <nav
      aria-label={ariaLabel}
      style={{
        flex: "0 0 92px",
        alignSelf: "flex-start",
        // 调用方靠 flex order 决定它排在哪一列（测试房用它把竖栏排到主列左边）
        ...(order === undefined ? {} : { order }),
        position: sticky ? "sticky" : "static",
        // 让开固定顶栏，否则往下滚时整栏会钻到顶栏底下
        top: sticky ? "calc(var(--header-h) + 12px)" : undefined,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {items.map((it) => {
        const on = active && active === it.key;
        return (
          <button
            key={it.key}
            className={"btn btn-sm" + (on ? "" : " btn-outline")}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
              padding: "8px 4px", lineHeight: 1.25, position: "relative",
            }}
            onClick={() => onSelect && onSelect(it.key)}
            title={it.title || it.label}
            aria-pressed={on || undefined}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{it.icon || "•"}</span>
            <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{it.label}</span>
            {it.badge ? (
              <span style={{
                position: "absolute", top: 3, right: 4, fontSize: 10, lineHeight: 1,
                padding: "1px 4px", borderRadius: 999, background: "var(--brass, #c9a45f)", color: "#1a1206",
              }}>{it.badge}</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export default SideRail;
