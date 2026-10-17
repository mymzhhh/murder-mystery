# docs — 设计与变更文档

| 文件 | 内容 |
|---|---|
| `生成流程推理链.md` | 剧本生成流水线的「可校验推理链」改造：核心诡计与证明链阶段、确定性校验规则、分级修复、验证结果与已知限制 |
| `前端视觉改版.md` | 前端「卷宗」主题的设计约定、ComfyUI 素材来源、逐页改动、修掉的界面缺陷与验证结果 |
| `优化方案.md` | 代码审查后的优化建议（P0–P3 分级），部分已实施 |
| `修改方案.md` | 「评测报告增强 + 自然语言搜证」的实施设计 |
| `修改记录.md` | 按日期的变更流水（并发修复、安全加固、全链路测试等） |
| `text-gen-agent-plan.md` | 项目最初的架构设计与技术选型 |

## ⚠️ 文档中的路径已过时

这些文档写于目录重构之前，正文里引用的 `modules/xxx.js`、`routes/xxx.js`、`socket/xxx.js`
是**当时的路径**。重构后全部源码收进了 `src/`，对应关系如下：

| 文档里写的 | 现在的位置 |
|---|---|
| `server.js` | `src/server.js` |
| `modules/auth.js`、`db.js`、`redis-client.js`、`pg-sync.js`、`history-manager.js` | `src/core/` |
| `modules/generator.js`、`agnes-client.js`、`llm-gate.js`、`model-manager.js` | `src/llm/` |
| `modules/murder-mystery-builder.js`、`script-*.js`、`prompt-agent.js`、`timeline-consistency.js` | `src/script/` |
| `modules/game-*.js`、`room-*.js`、`dm-agent.js`、`npc-agent.js`、`ai-player*.js` | `src/game/` |
| `routes/*.js` | `src/routes/` |
| `socket/*.js` | `src/socket/` |
| `templates/*` | `src/templates/` |
| `tests/*.test.js` | `tests/unit/` |

文档里的行号同样已经漂移，只作历史记录参考，不要按行号定位代码。
