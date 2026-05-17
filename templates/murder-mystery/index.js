// 剧本杀模板 — 模块化版本
const framework = require("./framework");
const character = require("./character");
const clues = require("./clues");
const dmGuide = require("./dm-guide");

module.exports = {
  type: "murder-mystery",
  name: "剧本杀剧本",
  description: "生成完整剧本杀剧本，含玩家剧本、NPC信息、线索卡、时间线、真相复盘",

  limits: {
    minPlayers: 1,
    maxPlayers: 6,
    maxNpc: 3,
    maxTotal: 9,
  },

  stages: {
    framework,
    characterScript: character.main,
    clues,
    dmGuide,
  },

  // 角色类型模板（从 character 模块导出）
  playerInstruction: character.player,
  soloDetectiveInstruction: character.soloDetective,
  npcWitnessInstruction: character.npcWitness,
  npcInstruction: character.npcSuspect,

  systemPrompt: "剧本杀剧本生成专家。生成沉浸式深度剧本（2-6名玩家，0-3名NPC，总计≤9人）。剧本纯叙事，无玩法指导，由玩家自主决策。",

  formatOutput(text, params) {
    return text;
  }
};
