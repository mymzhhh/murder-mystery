// 剧本杀模板 — 模块化版本（入口）
// 阶段 prompt 拆分为独立文件，方便单独调优：
//   framework.js — 故事框架
//   character.js — 角色个人剧本（含玩家/NPC/侦探子模板）
//   clues.js     — 线索系统
//   dm-guide.js  — DM 完整手册
module.exports = require("./murder-mystery/index");
