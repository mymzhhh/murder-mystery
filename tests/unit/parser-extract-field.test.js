// 单元测试：extractField 的"空值不许吞下一行"。
//
// 实测（真跑出来的两本稿都中）：
//   ## 三、死者信息
//   - **姓名与身份**：邱长贵（红星录像厅老板）
//   - **死亡时间**：              ← 空
//   - **死亡地点**：放映室
//
// extractField 的 `\s*?` 能跨换行，于是取不到值时把**下一行整个当成自己的值**：
//   victim.deathTime === "**死亡地点**：放映室"
// 这串垃圾顺 ai-player-llm 会念给 AI 玩家（"死亡时间 **死亡地点**：放映室"）——
// 比字段为空更糟：空是"不知道"，这是"知道错了"。
//
// 同时必须保住"值另起一段"的合法写法（`- **尸体状态**：\n<整段描述>`），
// 所以修法是"只拒绝下一行本身是另一个字段标题"，而不是禁止跨行。
const test = require("node:test");
const assert = require("node:assert");
const { extractField } = require("../../src/script/script-parser");

test("空值字段不得吞掉下一行（真稿形态回归）", () => {
  const md = [
    "## 三、死者信息",
    "",
    "- **姓名与身份**：邱长贵（红星录像厅老板）",
    "",
    "- **死亡时间**：",
    "",
    "- **死亡地点**：放映室",
    "",
    "- **直接死因**：钝器击打后脑",
  ].join("\n");
  assert.strictEqual(extractField(md, "死亡时间"), "", "空字段必须是空，不能把「- **死亡地点**：放映室」当成值");
  assert.strictEqual(extractField(md, "死亡地点"), "放映室");
  assert.strictEqual(extractField(md, "姓名与身份"), "邱长贵（红星录像厅老板）");
  assert.strictEqual(extractField(md, "直接死因"), "钝器击打后脑");
});

test("只隔一个换行时也不许吞下一行（同一形态，无空行版）", () => {
  const md = "- **死亡时间**：\n- **死亡地点**：放映室\n";
  assert.strictEqual(extractField(md, "死亡时间"), "");
  assert.strictEqual(extractField(md, "死亡地点"), "放映室");
});

test("非空值照常取到（不得因为修这个洞而读空）", () => {
  const md = "- **死亡时间**：22:28\n- **死亡地点**：放映室\n";
  assert.strictEqual(extractField(md, "死亡时间"), "22:28");
});

test("值另起一段的合法写法仍然要能取到（保住多行能力，别把洞补成另一个洞）", () => {
  const md = [
    "- **尸体状态**：",
    "",
    "他倒在血泊中，后脑有钝器伤，右手边有一卷胶片。",
    "地上有拖拽痕迹。",
    "",
    "- **死亡地点**：放映室",
  ].join("\n");
  const got = extractField(md, "尸体状态");
  assert.ok(got.includes("他倒在血泊中"), `值另起一段时必须仍能取到，实际取到「${got}」`);
  assert.ok(!got.includes("放映室"), "多行值不得越过下一个字段标题");
});

test("非加粗的 label 形态同样不许吞下一行", () => {
  const md = "死亡时间：\n死亡地点：放映室\n";
  assert.strictEqual(extractField(md, "死亡时间"), "");
  assert.strictEqual(extractField(md, "死亡地点"), "放映室");
});
