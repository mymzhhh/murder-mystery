// 剧本配图的取图接口
//
// 图片字节存在 PostgreSQL 的 script_images 表里（不是 public/）：docker-compose
// 只给 redis / pg 挂了卷，app 的 public/ 没有卷 —— 塞进去的文件一重建镜像就丢。
//
// 认证：这两个接口**刻意不挂 authMiddleware**，理由如下（这是本文件唯一的取舍点）：
//   · 剧本正文里那一行是 `![说明](img:键名)`，渲染出来就是一个裸的
//     `<img src="/api/scripts/<id>/images/<键名>">` —— 浏览器对 <img> 不会带
//     Authorization 头，一旦挂 authMiddleware，图片必然是 401，页面上永远是破图。
//   · 参考的既有读剧本路由是 GET /api/player/rooms/:code/my-script（routes/player.js）：
//     它用 authMiddleware + "你得在这个房间里"两道校验，因为它是**正文+秘密**本身；
//     而这里只是正文里被引用的像素，且键名/剧本 id 都是不可枚举的（剧本 id 是 UUID，
//     键名由写本流程生成）。按"不要把权限收得比读剧本本身更严"的要求，这里只能等于或更宽，
//     而"更宽到匿名可读"是能同时满足「<img> 能显示」的唯一解。
//   · 真要收紧的话，正确做法是前端用 fetch 带 token 取回 blob 再喂给 <img>，
//     或者签发短期 URL 令牌 —— 那是前端改动，不在本次范围内，因此这里如实记录这个事实。
//
// 能做的收紧都做了：键名按 [A-Za-z0-9_-] 严格校验（写入侧同样校验，见 core/db.js），
// 不存在的图统一 404，列表接口不泄漏"剧本是否存在"（一律 200 + 空数组）。

const { getScriptImage, listScriptImages, isValidImageKey } = require("../core/db");

/** 图片内容一存进去就不再变（键名即内容标识），所以可以长时间强缓存 */
const IMG_CACHE_CONTROL = "public, max-age=31536000, immutable";

function setupScriptImageRoutes(app) {
  // 列出某剧本的图片键名（不含字节）。房间里的"场景地图"靠它筛 map- 前缀的图。
  // 放在 :key 之前无所谓（路径段数不同，不会互相抢），但读起来更顺。
  app.get("/api/scripts/:id/images", async (req, res) => {
    try {
      const images = await listScriptImages(req.params.id);
      res.json({ scriptId: req.params.id, images });
    } catch (e) {
      // PG 不可用时按"没有图"处理：地图区域空着，而不是让房间页面弹一堆报错
      res.status(200).json({ scriptId: req.params.id, images: [], error: e.message });
    }
  });

  // 取单张图
  app.get("/api/scripts/:id/images/:key", async (req, res) => {
    const key = String(req.params.key || "");
    if (!isValidImageKey(key)) {
      return res.status(400).json({ error: "图片键名不合法（只允许 A-Za-z0-9_-）" });
    }
    try {
      const img = await getScriptImage(req.params.id, key);
      if (!img) return res.status(404).json({ error: "图片不存在" });
      // 用库里存的 mime，不做类型嗅探：写入侧知道这是什么图，猜测只会猜错
      res.set("Content-Type", img.mime || "application/octet-stream");
      res.set("Cache-Control", IMG_CACHE_CONTROL);
      res.send(img.bytes);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { setupScriptImageRoutes, IMG_CACHE_CONTROL };
