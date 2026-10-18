import { useEffect, useMemo, useState } from "react";
import { collectImageRefs, imageUrl, isMapImageKey } from "../lib/script-body.mjs";

// 房间里的「场景地图」。
//
// 为什么需要它：剧本正文里可以带"地图/场景布局图"（键名以 map- 开头），
// 但那行图片引用多半写在 DM 手册或某个角色的本里 —— 开局之后搜证/讨论时要对照平面图，
// 却得指望手里正好有那张本。所以这里按"该剧本所有 map- 开头的图"单独聚成一块。
//
// 键名从后端列表接口拿（GET /api/scripts/:id/images，只回键名/mime/体积，不含字节）；
// 说明文字（alt）只有正文里有，所以从传进来的正文里捞一份对照表，捞不到就退回显示键名。
//
// 刻意用裸 fetch 而不是 lib/api.js 的 apiJson：apiJson 遇到 401 会清登录态并跳回首页，
// 而一块地图取不到最多应该"少显示一块"，绝不该把正在对局的玩家踢出房间。

export function SceneMap({ scriptId, layoutText = "", altText = "" }) {
  const [images, setImages] = useState([]);

  useEffect(() => {
    if (!scriptId) { setImages([]); return; }
    let cancelled = false;
    fetch(`/api/scripts/${encodeURIComponent(String(scriptId))}/images`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setImages(d && Array.isArray(d.images) ? d.images : []);
      })
      .catch(() => { /* 后端不可用就当没有地图，不影响对局 */ });
    return () => { cancelled = true; };
  }, [scriptId]);

  const maps = useMemo(() => images.filter((x) => isMapImageKey(x.imgKey)), [images]);
  const alts = useMemo(() => collectImageRefs(`${layoutText}\n${altText}`), [layoutText, altText]);

  // 没有地图就整块不出现：不给每一个剧本都塞一个空面板
  if (!scriptId || maps.length === 0) return null;

  return (
    <section className="panel scene-map" aria-label="场景地图">
      <div className="panel-head">
        <strong>🗺 场景地图</strong>
        <span className="text-xs text-dim">{maps.length} 张布局图</span>
      </div>
      {layoutText ? <p className="scene-map-text">{layoutText}</p> : null}
      <div className="scene-map-grid">
        {maps.map((m, i) => {
          // 说明文字的三级回退：库里存的 alt（原剧本给的标题，如"案发现场布局"）
          // → 正文里能捞到的 alt → 序号。**绝不能显示原始键名**（"map-2"对玩家毫无意义，
          // 实测就是这么印在界面上的）。
          const caption = (m.alt && String(m.alt).trim()) || alts.get(m.imgKey) || `布局图 ${i + 1}`;
          return (
            <figure key={m.imgKey} className="script-figure scene-map-figure">
              <img
                className="script-img"
                src={imageUrl(scriptId, m.imgKey)}
                alt={caption}
                loading="lazy"
                decoding="async"
              />
              <figcaption className="script-figcaption">{caption}</figcaption>
            </figure>
          );
        })}
      </div>
    </section>
  );
}

export default SceneMap;
