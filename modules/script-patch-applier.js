// 剧本局部修改器 — 根据评测 suggestedPatches 执行精准修改
// PG 优先：Redis 无数据时从 PG 同步后再修改
const { getRedis, scanKeys } = require("./redis-client");
const { splitScript } = require("./script-splitter");

/** 如果 Redis split 数据不存在，从 PG 同步到 Redis */
async function ensureSplitInRedis(scriptId) {
  const meta = await getRedis().hgetall(`split:${scriptId}:meta`);
  if (meta && meta.title) return; // Redis 已有数据，跳过

  try {
    const { getScript } = require("./db");
    const pg = await getScript(scriptId);
    if (!pg || !pg.title) return;
    // 写入 meta
    const metaData = {
      title: pg.title, era: pg.era || "", location: pg.location || "",
      playerCount: String(pg.player_count || 0), npcCount: String(pg.npc_count || 0),
      clueCount: String(pg.clue_count || 0), layoutDescription: pg.layout_description || "",
      originalMarkdown: (pg.original_markdown || "").substring(0, 50000),
      splitAt: pg.split_at || new Date().toISOString(),
      characterNames: JSON.stringify((pg.characters || []).map(c => c.name)),
    };
    const r = getRedis();
    const pipe = r.pipeline();
    pipe.hset(`split:${scriptId}:meta`, metaData);
    (pg.characters || []).forEach(c => {
      pipe.hset(`split:${scriptId}:char:${c.name}`, {
        name: c.name, playerScript: c.player_script || "", secret: c.secret || "",
        isMurderer: c.is_murderer ? "1" : "0", roleType: c.role_type || "player",
        occupation: c.occupation || "",
      });
    });
    (pg.clues || []).forEach(c => {
      pipe.hset(`split:${scriptId}:clue:${c.clue_id}`, {
        id: c.clue_id, content: c.content || "", location: c.location || "",
        round: String(c.round || 1), clueType: c.clue_type || "",
      });
    });
    if (pg.dm) {
      pipe.hset(`split:${scriptId}:dm`, {
        openingMonologue: pg.dm.opening_monologue || "",
        truthReveal: pg.dm.truth_reveal || "",
        murdererName: pg.dm.murderer_name || "",
        murdererMotive: pg.dm.murderer_motive || "",
      });
    }
    pipe.sadd("scripts:split", scriptId);
    await pipe.exec();
    console.log("[patch] PG 数据已同步到 Redis:", pg.title);
  } catch (e) { console.warn("[patch] PG→Redis 同步失败:", e.message); }
}

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

  // PG 优先：Redis 无数据时从 PG 同步
  await ensureSplitInRedis(scriptId);

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

module.exports = { applyPatchesAndReSplit };
