// 验证 builder 的布局地点提取 + 线索地点归一化（纯逻辑，无需 LLM）
const test = require("node:test");
const assert = require("node:assert");
const { extractLayoutPlaces, normalizeClueLocations } = require("../modules/murder-mystery-builder");

test("extractLayoutPlaces：从框架提取真实布局地点（含加粗条目）", () => {
  const framework = `## 一、基本设定
- **地点场景**：雾隐镇，暴雨。
- **参与人数**：4名玩家

## 六、场景布局
- **书房**：位于二层东侧，为案发地点。
- **沈曼青闺房**：位于二层西侧。
- **林医生临时卧室**：位于二层西北角。
- **起居室**：位于二层正中。

## 七、角色关系图`;
  const places = extractLayoutPlaces(framework);
  assert.ok(places.includes("书房"));
  assert.ok(places.includes("沈曼青闺房"));
  assert.ok(places.includes("林医生临时卧室"));
  assert.ok(places.includes("起居室"));
  // 噪音过滤
  assert.ok(!places.some(p => p.includes("**") || p.includes("#") || /描述|布局|参与人数/.test(p)));
});

test("normalizeClueLocations：布局内地点保留，搜身/证词豁免，布局外归一", () => {
  const places = ["书房", "大厅", "沈曼青闺房", "走廊", "起居室"];
  const clues = `### A1：
- 线索类型：物证
- 发现地点：书房桌面
- 线索内容：书桌上的残渣。
### B2：
- 线索类型：物证
- 发现地点：大厅抽屉
- 线索内容：柜里的票据。
### M1：
- 线索类型：物证
- 发现地点：周管家右手
- 线索内容：手上的伤口。
### C3：
- 线索类型：人证
- 发现地点：沈曼青证词
- 线索内容：她的陈述。
### D4：
- 线索类型：痕迹
- 发现地点：走廊地毯
- 线索内容：湿脚印。
### E5：
- 线索类型：痕迹
- 发现地点：地下室暗道
- 线索内容：拖痕。`;
  const norm = normalizeClueLocations(clues, places);
  const locs = [...norm.text.matchAll(/发现地点[：:]\s*(.+)/g)].map(m => m[1].trim());
  // 布局内保留（书房桌面、大厅抽屉、走廊地毯）
  assert.ok(locs[0].includes("书房"));
  assert.ok(locs[1].includes("大厅"));
  // 搜身豁免（周管家右手原样保留）
  assert.equal(locs[2], "周管家右手");
  // 证词豁免
  assert.equal(locs[3], "沈曼青证词");
  // 走廊地毯 → 属于布局中的"走廊"，保留（子位置形态合法）
  assert.equal(locs[4], "走廊地毯");
  // 地下室暗道 不在布局 → 保持原样（不误改）
  assert.equal(locs[5], "地下室暗道");
});