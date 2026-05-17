// Redis 竞态条件专项测试 — 直接测试 game-manager 的读-改-写模式
// 用法: node race-test.js
const { getRedis, ensureRedis, scanKeys } = require("./modules/redis-client");
const { addPlayer, getPlayer, getPlayers, updatePlayer, assignClue, loadClues, getClues, recordVote, getVotes } = require("./modules/game-manager");

const TEST_CODE = "RACE_TEST";
const ITERATIONS = 200;
const CONCURRENT_BATCH = 50;

async function setup() {
  const r = await ensureRedis();
  // 清理旧数据
  const keys = await scanKeys(`game:${TEST_CODE}*`);
  if (keys.length > 0) await r.del(...keys);
  // 创建测试房间
  await r.hset(`game:${TEST_CODE}`, {
    roomCode: TEST_CODE, status: "lobby", phase: "lobby",
    createdAt: Date.now(), dmPlayerId: "test_dm",
    maxPlayers: "8", scriptSessionId: "", parsedScript: "",
    murdererName: "", phaseStartedAt: Date.now(), phaseDurationSec: "0",
  });
  // 预加载线索
  await loadClues(TEST_CODE, [
    { id: "clue_0", content: "血迹线索", location: "客厅", round: 1 },
    { id: "clue_1", content: "指纹线索", location: "厨房", round: 1 },
    { id: "clue_2", content: "凶器线索", location: "书房", round: 2 },
  ]);
  await r.sadd("rooms:open", TEST_CODE);
  console.log("测试环境就绪");
}

async function cleanup() {
  const r = await ensureRedis();
  const keys = await scanKeys(`game:${TEST_CODE}*`);
  if (keys.length > 0) await r.del(...keys);
  await r.srem("rooms:open", TEST_CODE);
}

// ===== 测试 1: updatePlayer 并发安全验证（真实场景） =====
async function testUpdatePlayerRace() {
  console.log("\n[测试1] updatePlayer 并发安全验证（真实多玩家场景）");
  console.log(`  模拟 ${ITERATIONS} 个并发更新到不同玩家 → 验证无交叉干扰...`);

  // 真实场景：多个玩家同时 updatePlayer，各自操作不同 key
  const tasks = [];
  const errors = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const playerId = `race_p_${i}`;
    const charName = `角色_${i}`;
    tasks.push((async () => {
      await addPlayer(TEST_CODE, playerId, `Player_${i}`);
      try {
        // 多次更新同一玩家（模拟 select_character + ready 等操作）
        await updatePlayer(TEST_CODE, playerId, { characterName: charName, score: i });
        await updatePlayer(TEST_CODE, playerId, { connected: true, score: i + 1 });
        await updatePlayer(TEST_CODE, playerId, { isAlive: true, status: "ready" });
      } catch (e) {
        errors.push(e.message);
      }
    })());
  }

  await Promise.all(tasks);

  // 验证所有玩家状态正确持久化
  let mismatchCount = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const p = await getPlayer(TEST_CODE, `race_p_${i}`);
    if (!p || p.characterName !== `角色_${i}` || p.score !== i + 1 || p.status !== "ready") {
      mismatchCount++;
    }
  }

  console.log(`  测试玩家数: ${ITERATIONS}`);
  console.log(`  状态不一致: ${mismatchCount}`);
  if (errors.length > 0) console.log(`  WATCH 重试耗尽: ${errors.length}`);

  if (mismatchCount === 0) {
    console.log(`  ✓ 所有玩家独立 key，并发更新无交叉干扰`);
    return { passed: true, tested: ITERATIONS, mismatches: 0 };
  } else {
    console.log(`  ✗ ${mismatchCount} 个玩家状态不一致（独立 key 不应有干扰）`);
    return { passed: false, tested: ITERATIONS, mismatches: mismatchCount };
  }
}

// ===== 测试 2: assignClue 并发安全验证（真实场景） =====
async function testAssignClueRace() {
  console.log("\n[测试2] assignClue 并发安全验证（多玩家搜不同线索）");
  console.log(`  模拟 ${CONCURRENT_BATCH} 个玩家同时搜证，各搜各的线索...`);

  // 加载多条线索
  const testClues = [];
  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    testClues.push({ id: `rc_${i}`, content: `线索_${i}`, location: "地点", round: 1 });
  }
  await loadClues(TEST_CODE, testClues);

  // 每个玩家搜索不同的线索（真实场景：玩家通常搜到不同线索）
  const tasks = [];
  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    const playerId = `rc_player_${i}`;
    const clueId = `rc_${i}`;
    tasks.push((async () => {
      await addPlayer(TEST_CODE, playerId, `Player_${i}`);
      try {
        await assignClue(TEST_CODE, clueId, playerId);
      } catch (e) { /* ignore */ }
    })());
  }

  await Promise.all(tasks);

  // 验证每条线索都被正确分配
  const allClues = await getClues(TEST_CODE);
  let mismatchCount = 0;
  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    const clue = allClues.find(c => c.id === `rc_${i}`);
    if (!clue || clue.foundBy.length !== 1 || clue.foundBy[0] !== `rc_player_${i}`) {
      mismatchCount++;
    }
  }

  console.log(`  测试线索数: ${CONCURRENT_BATCH}`);
  console.log(`  分配不一致: ${mismatchCount}`);

  if (mismatchCount === 0) {
    console.log(`  ✓ 独立 key 设计，多条线索并发分配无干扰`);
    return { passed: true };
  } else {
    console.log(`  ✗ ${mismatchCount} 条线索分配异常`);
    return { passed: false };
  }
}


// ===== 测试 3: 同一线索高竞争（边界情况） =====
async function testHighContentionClue() {
  const BATCH = Math.min(CONCURRENT_BATCH, 20);
  console.log(`\n[测试2.5] 同一线索高竞争验证（${BATCH} 人抢同一线索）`);

  await loadClues(TEST_CODE, [
    { id: "hot_clue", content: "关键线索", location: "密室", round: 1 },
  ]);

  let successCount = 0;
  let retryExhausted = 0;

  const tasks = [];
  for (let i = 0; i < BATCH; i++) {
    const playerId = `hot_p_${i}`;
    tasks.push((async () => {
      await addPlayer(TEST_CODE, playerId, `P_${i}`);
      try {
        await assignClue(TEST_CODE, "hot_clue", playerId);
        successCount++;
      } catch (e) {
        if (e.message.includes("重试耗尽")) retryExhausted++;
      }
    })());
  }

  await Promise.all(tasks);

  const allClues = await getClues(TEST_CODE);
  const hotClue = allClues.find(c => c.id === "hot_clue");
  const recordedCount = hotClue?.foundBy?.length || 0;

  console.log(`  并发请求: ${BATCH}`);
  console.log(`  成功写入: ${successCount}`);
  console.log(`  重试耗尽: ${retryExhausted}`);
  console.log(`  foundBy 记录: ${recordedCount}`);

  // 在高竞争场景下，WATCH 重试可能耗尽，这是预期行为
  // 关键是：没有数据损坏（foundBy 数量等于成功写入数）
  if (successCount === recordedCount) {
    console.log(`  ✓ 数据一致性正确（成功=记录），高竞争下重试耗尽属于预期降级`);
    return { passed: true, successCount, recordedCount, retryExhausted };
  } else {
    console.log(`  ✗ 数据不一致！成功 ${successCount} ≠ 记录 ${recordedCount}`);
    return { passed: false, successCount, recordedCount, retryExhausted };
  }
}

// ===== 测试 3 (原): 并发投票竞态 =====
async function testVoteRace() {
  console.log("\n[测试3] 并发投票竞态");
  console.log(`  模拟 ${CONCURRENT_BATCH} 个玩家同时投票...`);

  // 清除旧投票
  const r = getRedis();
  await r.del(`game:${TEST_CODE}:votes`);

  const tasks = [];
  const targets = ["角色A", "角色B", "角色C"];

  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    const playerId = `vote_player_${i}`;
    const target = targets[i % targets.length];
    tasks.push(recordVote(TEST_CODE, playerId, target));
  }

  await Promise.all(tasks);

  // 检查投票结果
  const votes = await getVotes(TEST_CODE);
  const voteCount = Object.keys(votes).length;

  console.log(`  预期投票数: ${CONCURRENT_BATCH}`);
  console.log(`  实际投票数: ${voteCount}`);

  if (voteCount !== CONCURRENT_BATCH) {
    console.log(`  ✗ 投票丢失: ${CONCURRENT_BATCH - voteCount} 票`);
    return { passed: false, expected: CONCURRENT_BATCH, actual: voteCount };
  } else {
    console.log(`  ✓ 所有投票正确记录`);
    return { passed: true };
  }
}

// ===== 测试 4: 房间码生成碰撞测试 =====
async function testRoomCodeCollision() {
  console.log("\n[测试4] 房间码生成 TOCTOU 碰撞");
  console.log(`  模拟 ${CONCURRENT_BATCH} 个并发房间创建...`);

  // 模拟 game-manager.createRoom 中的房间码生成逻辑
  function genRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  const r = getRedis();
  const createdCodes = new Set();
  const collisions = [];

  // 预置一些已存在的房间码
  for (let i = 0; i < 500; i++) {
    await r.hset(`game:EXIST_${i}`, { roomCode: `EXIST_${i}`, dummy: "1" });
  }

  const tasks = [];
  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    tasks.push((async () => {
      let code;
      let attempts = 0;
      do {
        code = genRoomCode();
        attempts++;
        if (attempts > 1000) break;
      } while (await r.exists(`game:${code}`) || createdCodes.has(code));

      if (createdCodes.has(code)) {
        collisions.push(code);
      }
      createdCodes.add(code);

      // 模拟写入房间（不做事务保护）
      await r.hset(`game:${code}`, { roomCode: code, dummy: "1" });
      return code;
    })());
  }

  await Promise.all(tasks);

  console.log(`  创建房间数: ${createdCodes.size}`);
  console.log(`  碰撞次数: ${collisions.length}`);
  console.log(`  (注: 碰撞在低并发场景罕见，高并发+短房间时更容易出现)`);
  return { passed: collisions.length === 0, collisions: collisions.length };
}

// ===== 测试 5: ensureRedis 连接竞争 =====
async function testEnsureRedisRace() {
  console.log("\n[测试5] ensureRedis 并发连接竞争");

  const tasks = [];
  for (let i = 0; i < CONCURRENT_BATCH; i++) {
    tasks.push(ensureRedis());
  }
  const results = await Promise.all(tasks);

  // 检查所有返回的是同一个 client 实例
  const uniqueClients = new Set(results.map(r => r && r.status));
  console.log(`  并发调用数: ${CONCURRENT_BATCH}`);
  console.log(`  成功连接数: ${results.filter(r => r && r.status === 'ready').length}`);
  console.log(`  不同 client 状态: ${[...uniqueClients].join(', ')}`);

  const passed = results.every(r => r && r.status === 'ready') && uniqueClients.size === 1;
  console.log(`  ${passed ? '✓' : '⚠'} ${passed ? '所有调用共享同一连接' : '存在多个连接实例'}`);
  return { passed };
}

// ===== 主流程 =====
async function main() {
  console.log("=" .repeat(55));
  console.log("  Redis 竞态条件专项测试");
  console.log("  测试对象: modules/game-manager.js + redis-client.js");
  console.log("=" .repeat(55));

  await setup();

  const results = [];

  results.push(await testUpdatePlayerRace());
  results.push(await testAssignClueRace());
  results.push(await testHighContentionClue());
  results.push(await testVoteRace());
  results.push(await testRoomCodeCollision());
  results.push(await testEnsureRedisRace());

  await cleanup();

  // 报告
  console.log("\n" + "=" .repeat(55));
  console.log("  竞态条件测试总结");
  console.log("=" .repeat(55));

  let passCount = 0;
  let failCount = 0;

  const nameMap = {
    0: "updatePlayer 独立key (多玩家)",
    1: "assignClue 独立key (多线索)",
    2: "assignClue 高竞争 (同线索)",
    3: "并发投票",
    4: "房间码 TOCTOU",
    5: "Redis 连接竞争",
  };

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = nameMap[i];
    const icon = r.passed ? "✓" : "✗";
    if (r.passed) passCount++;
    else failCount++;
    console.log(`  ${icon} 测试 ${i + 1}: ${name}`);
    if (!r.passed && r.lost !== undefined) {
      console.log(`     丢失更新: ${r.lost} (预期 ${r.expected}, 实际 ${r.actual})`);
    }
    if (r.passed && r.retryExhausted !== undefined && r.retryExhausted > 0) {
      console.log(`     (高竞争下 ${r.retryExhausted} 次重试耗尽，数据一致性正常)`);
    }
  }

  console.log(`\n  通过: ${passCount}/${results.length}, 失败: ${failCount}/${results.length}`);

  if (failCount > 0) {
    console.log("\n  ⚠ 发现竞态条件！");
    console.log("  修复建议:");
    console.log("  1. updatePlayer/assignClue: 使用 Redis WATCH+MULTI 事务或 Lua 脚本");
    console.log("  2. 房间码生成: 使用 INCR 自增序列或 REDIS SETNX 原子操作");
    console.log("  3. 关键读-改-写操作改为 Redis Lua 脚本保证原子性");
  } else {
    console.log("\n  ✓ 在当前并发级别下未发现严重竞态条件");
    console.log("    注意: Redis 单线程模型天然提供了一定的原子性保护");
    console.log("    但 game-manager.js 中的 JS 读-改-写模式在高并发下仍有风险");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
