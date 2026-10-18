import React, { useState } from "react";
import { classifyLine, parseInline } from "../lib/paginate.mjs";
import { buildBodyNodes, imageUrl } from "../lib/script-body.mjs";

// 剧本正文渲染器（玩家端「我的剧本」抽屉 / 阅读视图、管理端剧本详情共用一份）。
//
// 改造前：正文直接丢进 white-space: pre-wrap，于是 "###" 和 "**" 原样打出来；
// 现在这一层负责把 markdown 级的行结构化成标题/小标题/列表/段落，其余原样保留换行与空白。
//
// 本次新增的唯一一档结构：独立成行的 `![说明](img:键名)` → 真图。
// 图片字节在后端（PG 的 script_images 表），这里只拼地址：
//   /api/scripts/<scriptId>/images/<键名>
//
// 两条硬性约束（踩过就会整页空白，所以写在最显眼处）：
//   1. 解析不出图片的行必须**当普通文本渲染**，不能吞掉 —— 正文是玩家的全部信息；
//   2. 拿不到 scriptId 时同样退回文本渲染（把语法原样露出来，比渲染成破图更有诊断价值）。

function inlineNodes(text) {
  return parseInline(text).map((seg, i) =>
    seg.t === "bold"
      ? <strong key={i} className="md-strong">{seg.v}</strong>
      : <React.Fragment key={i}>{seg.v}</React.Fragment>
  );
}

/** 单张配图：图在上、说明小字在下。
 *  加载失败时不再显示浏览器的破图图标，而是把失败这件事说清楚 ——
 *  "图挂了"和"这里本来就没图"在页面上必须能区分开。 */
function ScriptFigure({ src, alt }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="script-figure">
      {failed ? (
        <div className="script-img-broken" role="img" aria-label={alt || "配图"}>
          配图加载失败{alt ? `（${alt}）` : ""}
        </div>
      ) : (
        <img
          className="script-img"
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
      {alt ? <figcaption className="script-figcaption">{alt}</figcaption> : null}
    </figure>
  );
}

/**
 * 渲染剧本正文。
 * @param {string} text 正文（纯文本 + 独立成行的图片引用）
 * @param {string} scriptId 剧本 id；缺省时图片行按文本渲染
 */
export function ScriptBody({ text, scriptId }) {
  const nodes = buildBodyNodes(text);
  const canRenderImage = !!scriptId;
  return (
    <>
      {nodes.map((n, i) => {
        if (n.kind === "image" && canRenderImage) {
          return <ScriptFigure key={i} src={imageUrl(scriptId, n.key)} alt={n.alt} />;
        }
        const c = classifyLine(n.raw);
        if (c.kind === "blank") return <div key={i} className="md-blank" />;
        if (c.kind === "heading") {
          // 标题色走 CSS 变量而不是内联色值：同一个渲染器既用在墨底（DM 叙述）上，
          // 也用在纸面（剧本正文 / 真相）上，而黄铜压米色纸的对比度明显不够。
          // 让 surface 决定颜色，渲染器只负责结构。
          const lvl = Math.min(4, Math.max(1, c.level));
          // 「你的任务」单独一档：它是玩家要执行的目标，必须比普通小标题更跳
          //（真实剧本里任务和正文一样大，玩家翻半天找不到要干什么 —— 实测反馈过）
          const isTask = /^你的任务/.test(String(c.text || "").trim());
          return <div key={i} className={`md-h md-l${lvl}${isTask ? " md-task" : ""}`}>{c.text}</div>;
        }
        if (c.kind === "subheading") {
          return <div key={i} className="md-sub">{c.text}</div>;
        }
        if (c.kind === "list" || c.kind === "ordered") {
          return (
            <div key={i} className="md-list">
              <span className="md-marker">{c.kind === "ordered" ? c.index + "." : "•"}</span>
              <span>{inlineNodes(c.text)}</span>
            </div>
          );
        }
        return <p key={i} className="md-p">{inlineNodes(c.text)}</p>;
      })}
    </>
  );
}

export default ScriptBody;
