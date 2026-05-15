// 剧本局部修改器 — 根据评测 suggestedPatches 执行精准修改
// 不重新生成整本，只改 Redis split 数据中的指定字段
const { getRedis, scanKeys } = require("./redis-client");
const { splitScript } = require("./script-splitter");

/** 应用单个 patch 到 split 数据 */
async function applyPatch(scriptId, patch) {
  const r = getRedis();
  const { type, target, operation, description } = patch;
  let matched = false;

  if (type === "clue") {
    const clueKeys = await scanKeys(`split:${scriptId}:clue:*`);
    for (const key of clueKeys) {
      const clue = await r.hgetall(key);
      if (!clue || !clue.id) continue;
      // 按 id 或内容关键词匹配
      const match = clue.id === target ||
        (clue.content && clue.content.includes(target)) ||
        (clue.id && clue.id.includes(target));
      if (!match) continue;
      matched = true;

      if (operation === "split") {
        // 拆分线索：标记原线索 + 追加新线索
        await r.hset(key, "content", (clue.content || "") + "\n[已拆分，详见新线索]");
        await r.hset(key, "patch_note", description);
        // 创建新线索
        const newId = clue.id + "_B";
        await r.hset(`split:${scriptId}:clue:${newId}`, {
          ...clue, id: newId,
          content: `[拆分自${clue.id}] ${description}`,
          patch_note: description,
        });
      } else if (operation === "remove") {
        await r.del(key);
      } else {
        // append / 默认
        await r.hset(key, "content", (clue.content || "") + "\n[补充] " + description);
        await r.hset(key, "patch_note", description);
      }
    }
  } else if (type === "character" || type === "player_script") {
    const charKeys = await scanKeys(`split:${scriptId}:char:*`);
    for (const key of charKeys) {
      const char = await r.hgetall(key);
      if (!char || !char.name) continue;
      if (char.name !== target && !char.name.includes(target)) continue;
      matched = true;

      if (operation === "append") {
        const field = type === "player_script" ? "playerScript" : "secret";
        const current = char[field] || "";
        await r.hset(key, field, current + "\n\n[补充] " + description);
        await r.hset(key, "patch_note", description);
      } else if (operation === "move") {
        // 从当前角色移走内容，追加到 from 指定的目标
        const from = patch.from || "";
        if (from) {
          const fromKeys = await scanKeys(`split:${scriptId}:char:*`);
          for (const fk of fromKeys) {
            const fc = await r.hgetall(fk);
            if (fc && fc.name === from) {
              await r.hset(fk, "playerScript", (fc.playerScript || "") + "\n\n[移自" + char.name + "] " + description);
              await r.hset(fk, "patch_note", description);
              break;
            }
          }
        }
        await r.hset(key, "playerScript", (char.playerScript || "").replace(description, ""));
        await r.hset(key, "patch_note", "内容已移至" + (patch.from || "其他角色"));
      } else if (operation === "remove") {
        await r.del(key);
      }
    }
  }

  if (!matched) return { ok: false, error: `未找到匹配的${type}: ${target}` };
  return { ok: true, applied: description };
}

/** 批量应用 patches 后自动重新切分 */
async function applyPatchesAndReSplit(scriptId, patches) {
  if (!patches || patches.length === 0) return { ok: false, error: "无修改项" };

  const results = [];
  for (const patch of patches) {
    try {
      const res = await applyPatch(scriptId, patch);
      results.push({ ...res, patch });
    } catch (e) {
      results.push({ ok: false, error: e.message, patch });
    }
  }

  // 修改后重新切分以更新 meta（处理线索数变化等）
  try {
    await splitScript(scriptId, () => {});
  } catch (e) {
    console.warn("[patch] 修改后重新切分失败:", e.message);
  }

  return { ok: true, results };
}

module.exports = { applyPatch, applyPatchesAndReSplit };
