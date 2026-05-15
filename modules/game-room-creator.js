// 共享的房间创建逻辑 — admin 和 player 路由共用，避免循环依赖
const { getRedis, scanKeys } = require("./redis-client");
const { getSession } = require("./history-manager");
const { parseScript } = require("./script-parser");
const { createRoom, updateRoom, removePlayer, loadClues } = require("./game-manager");

async function createGameRoom(scriptSessionId, maxPlayers) {
  const r = getRedis();
  let parsed;
  let allClues = [];
  let characterNames = [];

  // 优先从 PostgreSQL 加载
  try {
    const { getScript } = require("./db");
    const pgData = await getScript(scriptSessionId);
    if (pgData && pgData.title) {
      const characters = (pgData.characters || []).map(c => ({
        name: c.name, isMurderer: c.is_murderer, occupation: c.occupation || "",
        roleType: c.role_type || "player", script: { story: c.player_script || "", secret: c.secret || "" }
      }));
      characterNames = characters.map(c => c.name);
      allClues = (pgData.clues || []).map(c => ({
        id: c.clue_id, content: c.content, location: c.location, round: c.round, clueType: c.clue_type
      }));
      parsed = {
        title: pgData.title,
        setting: { era: pgData.era, location: pgData.location },
        characters,
        clues: { round1: allClues.filter(c => c.round === 1), round2: allClues.filter(c => c.round === 2), round3: allClues.filter(c => c.round === 3), redHerrings: [] },
        murderer: { name: pgData.dm?.murderer_name || "", motive: pgData.dm?.murderer_motive || "", method: pgData.dm?.murderer_method || "" },
        dmGuide: { truthReveal: pgData.dm?.truth_reveal || "", openingMonologue: pgData.dm?.opening_monologue || "" },
        victim: {},
        layoutDescription: pgData.layout_description || "",
      };
    }
  } catch (e) { console.warn("[createRoom] PG 读取失败:", e.message); }

  // 回退：Redis split 数据
  if (!parsed) {
    const meta = await r.hgetall(`split:${scriptSessionId}:meta`);
    if (meta && meta.title) {
      const charKeys = await scanKeys(`split:${scriptSessionId}:char:*`);
      const clueKeys = await scanKeys(`split:${scriptSessionId}:clue:*`);
      const dmData = await r.hgetall(`split:${scriptSessionId}:dm`);
      const pipeline = r.pipeline();
      charKeys.forEach(k => pipeline.hgetall(k));
      clueKeys.forEach(k => pipeline.hgetall(k));
      const results = await pipeline.exec();
      const characters = [];
      for (let i = 0; i < results.length; i++) {
        const d = results[i][1];
        if (!d) continue;
        if (d.playerScript !== undefined) {
          characters.push({ name: d.name, isMurderer: d.isMurderer === "1", occupation: d.occupation, roleType: d.roleType || "player", script: { story: d.playerScript, secret: d.secret } });
          characterNames.push(d.name);
        } else { allClues.push(d); }
      }
      parsed = {
        title: meta.title, setting: { era: meta.era, location: meta.location }, characters,
        clues: { round1: allClues.filter(c => c.round === "1"), round2: allClues.filter(c => c.round === "2"), round3: allClues.filter(c => c.round === "3"), redHerrings: [] },
        murderer: { name: dmData?.murdererName || "", motive: dmData?.murdererMotive || "", method: dmData?.murdererMethod || "" },
        dmGuide: { truthReveal: dmData?.truthReveal || "", openingMonologue: dmData?.openingMonologue || "" },
        victim: {}, layoutDescription: meta.layoutDescription || "",
      };
    }
  }

  // 回退：从 session 解析
  if (!parsed) {
    const session = await getSession(scriptSessionId);
    if (!session) throw new Error("剧本不存在");
    const markdown = session.messages.filter(m => m.role === "assistant").map(m => m.content).join("\n\n");
    parsed = parseScript(markdown);
    allClues = [...(parsed.clues?.round1 || []), ...(parsed.clues?.round2 || []), ...(parsed.clues?.round3 || [])];
    characterNames = parsed.characters?.map(c => c.name) || [];
  }

  const room = await createRoom("system_dm", "AI_DM");
  await updateRoom(room.roomCode, { scriptSessionId, parsedScript: JSON.stringify(parsed), murdererName: parsed.murderer?.name || "", dmType: "ai", maxPlayers: maxPlayers || 6 });
  if (allClues.length > 0) await loadClues(room.roomCode, allClues);
  await r.sadd("rooms:open", room.roomCode);
  await removePlayer(room.roomCode, "system_dm");
  const onlyPlayerNames = (parsed.characters || []).filter(c => c.roleType !== "npc").map(c => c.name);
  return { roomCode: room.roomCode, title: parsed.title, characterCount: onlyPlayerNames.length, characters: onlyPlayerNames };
}

module.exports = { createGameRoom };
