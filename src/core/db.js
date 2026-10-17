// PostgreSQL 连接池 — 持久数据存储（剧本/角色/线索/用户）
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || process.env.database_url || "";

let pool = null;

function getPool() {
  if (!pool) {
    if (!DATABASE_URL) throw new Error("DATABASE_URL 未设置，PostgreSQL 不可用");
    // 自动判断是否需要 SSL：URL 包含 ssl 参数或非本地地址
    const useSSL = /[?&]ssl(mode)?=(require|true|1)/i.test(DATABASE_URL)
      || /[?&]sslmode=require/i.test(DATABASE_URL)
      || /\.(railway\.internal|render\.com|fly\.dev|supabase\.co|neon\.tech|aws\.com)/i.test(DATABASE_URL);
    const opts = { connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30000 };
    if (useSSL) opts.ssl = { rejectUnauthorized: false };
    pool = new Pool(opts);
    pool.on("error", (err) => console.error("PG pool error:", err.message));
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/** 初始化数据库表 */
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'player',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scripts (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      era TEXT DEFAULT '',
      location TEXT DEFAULT '',
      game_mode TEXT DEFAULT 'PVE',
      player_count INT DEFAULT 4,
      npc_count INT DEFAULT 0,
      clue_count INT DEFAULT 0,
      layout_description TEXT DEFAULT '',
      original_markdown TEXT DEFAULT '',
      split_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS characters (
      id SERIAL PRIMARY KEY,
      script_id UUID REFERENCES scripts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role_type TEXT DEFAULT 'player',
      is_murderer BOOLEAN DEFAULT false,
      occupation TEXT DEFAULT '',
      player_script TEXT DEFAULT '',
      secret TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS clues (
      id SERIAL PRIMARY KEY,
      script_id UUID REFERENCES scripts(id) ON DELETE CASCADE,
      clue_id TEXT NOT NULL,
      content TEXT DEFAULT '',
      location TEXT DEFAULT '',
      round INT DEFAULT 1,
      clue_type TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS dm_manuals (
      script_id UUID PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
      opening_monologue TEXT DEFAULT '',
      full_timeline TEXT DEFAULT '',
      truth_reveal TEXT DEFAULT '',
      murderer_name TEXT DEFAULT '',
      murderer_motive TEXT DEFAULT '',
      murderer_method TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_scripts_title ON scripts(title);
    CREATE INDEX IF NOT EXISTS idx_characters_script ON characters(script_id);
    CREATE INDEX IF NOT EXISTS idx_clues_script ON clues(script_id);
    -- 测试剧本的体检报告：一局跑完之后落库，管理端可回看。
    -- 为什么落库而不是留在 Redis：报告是**结论**，要能跨房间回收、跨重启长期回看
    -- （Redis 里的房间 6 小时后就被生命周期回收了）。
    CREATE TABLE IF NOT EXISTS test_reports (
      id SERIAL PRIMARY KEY,
      room_code TEXT NOT NULL,
      script_id TEXT DEFAULT '',
      script_title TEXT DEFAULT '',
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ DEFAULT NOW(),
      duration_ms BIGINT DEFAULT 0,
      phase_minutes NUMERIC DEFAULT 0,
      verdict TEXT DEFAULT '',
      verdict_text TEXT DEFAULT '',
      clue_total INT DEFAULT 0,
      clue_found INT DEFAULT 0,
      unreachable_count INT DEFAULT 0,
      silent_ai_count INT DEFAULT 0,
      error_count INT DEFAULT 0,
      outcome TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      report JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_test_reports_created ON test_reports(created_at DESC);
  `);
  // 幂等迁移：中间产物（推理链/大纲/交叉校验问题）。
  // 用 ALTER 而不是只改上面的 CREATE TABLE —— 已有部署的表不会因为 IF NOT EXISTS 而补列。
  await query(`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS artifacts JSONB`);
  console.log("[db] PostgreSQL 表已就绪");
}

/** 保存切分后的剧本 */
async function saveSplitScript(scriptId, meta, characters, clues, dmData) {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO scripts (id, title, era, location, game_mode, player_count, npc_count, clue_count, layout_description, original_markdown, artifacts, split_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET title=$2, era=$3, location=$4, game_mode=$5, player_count=$6, npc_count=$7, clue_count=$8, layout_description=$9, original_markdown=$10, artifacts=$11, split_at=NOW()`,
      [scriptId, meta.title, meta.era, meta.location, meta.gameMode || meta.game_mode || "PVE", meta.playerCount, meta.npcCount, meta.clueCount, meta.layoutDescription || "", meta.originalMarkdown || "", meta.artifacts || null]
    );
    // 先删旧角色/线索再插入
    await c.query("DELETE FROM characters WHERE script_id=$1", [scriptId]);
    await c.query("DELETE FROM clues WHERE script_id=$1", [scriptId]);
    for (const name of Object.keys(characters)) {
      const ch = characters[name];
      await c.query(
        "INSERT INTO characters (script_id, name, role_type, is_murderer, occupation, player_script, secret) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [scriptId, name, ch.roleType || "player", ch.isMurderer || false, ch.occupation || "", ch.playerScript || "", ch.secret || ""]
      );
    }
    for (const clue of clues) {
      await c.query(
        "INSERT INTO clues (script_id, clue_id, content, location, round, clue_type) VALUES ($1,$2,$3,$4,$5,$6)",
        [scriptId, clue.id, clue.content || "", clue.location || "", parseInt(clue.round) || 1, clue.clueType || ""]
      );
    }
    await c.query(
      `INSERT INTO dm_manuals (script_id, opening_monologue, truth_reveal, murderer_name, murderer_motive, murderer_method)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (script_id) DO UPDATE SET opening_monologue=$2, truth_reveal=$3, murderer_name=$4, murderer_motive=$5, murderer_method=$6`,
      [scriptId, dmData?.openingMonologue || "", dmData?.truthReveal || "", dmData?.murdererName || "", dmData?.murdererMotive || "", dmData?.murdererMethod || ""]
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** 查询剧本列表（带真实角色数：老数据的 player_count 可能为 0，用 characters 表聚合兜底） */
async function listScripts() {
  const r = await query(`
    SELECT s.id, s.title, s.era, s.location, s.game_mode, s.player_count, s.npc_count, s.clue_count,
           s.layout_description, s.split_at, s.created_at,
           (SELECT COUNT(*) FROM characters ch WHERE ch.script_id = s.id AND ch.role_type = 'player') AS real_player_count,
           (SELECT COUNT(*) FROM characters ch WHERE ch.script_id = s.id AND ch.role_type = 'npc') AS real_npc_count
    FROM scripts s
    ORDER BY s.split_at DESC NULLS LAST, s.created_at DESC`);
  return r.rows;
}

/** 获取单个剧本详情 */
async function getScript(id) {
  const s = await query("SELECT * FROM scripts WHERE id=$1", [id]);
  if (s.rows.length === 0) return null;
  const chars = await query("SELECT * FROM characters WHERE script_id=$1", [id]);
  const clues = await query("SELECT * FROM clues WHERE script_id=$1 ORDER BY clue_id", [id]);
  const dm = await query("SELECT * FROM dm_manuals WHERE script_id=$1", [id]);
  return { ...s.rows[0], characters: chars.rows, clues: clues.rows, dm: dm.rows[0] };
}

/** 删除剧本（级联删除角色/线索/DM） */
async function deleteScript(id) {
  await query("DELETE FROM scripts WHERE id=$1", [id]);
}

/** 注册用户 */
async function createUser(username, passwordHash, role = "player") {
  const existing = await getUser(username);
  if (existing) throw { code: "23505" }; // 模拟PG唯一约束冲突
  await query("INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)", [username, passwordHash, role]);
}

/** 登录验证 */
async function getUser(username) {
  const r = await query("SELECT * FROM users WHERE username=$1", [username]);
  return r.rows[0] || null;
}

/** 列出所有用户 */
async function listUsers() {
  const r = await query("SELECT username, role, created_at FROM users ORDER BY created_at DESC");
  return r.rows.map(u => ({ username: u.username, role: u.role, createdAt: u.created_at }));
}

/** 更新用户角色 */
async function updateUserRole(username, role) {
  const r = await query("UPDATE users SET role=$1 WHERE username=$2", [role, username]);
  return r.rowCount > 0;
}

/** 更新用户口令哈希（登录时顺手升级旧哈希、以及按 ADMIN_PASSWORD 轮换管理员口令用） */
async function updateUserPassword(username, passwordHash) {
  const r = await query("UPDATE users SET password_hash=$1 WHERE username=$2", [passwordHash, username]);
  return r.rowCount > 0;
}

/** 删除用户 */
async function deleteUser(username) {
  const r = await query("DELETE FROM users WHERE username=$1", [username]);
  return r.rowCount > 0;
}

// query / getPool 一并导出：给"自带 SQL 的小模块"用（例如测试报告 test-report-repo），
// 否则它们只能各写一套连接池 —— 实测踩过：没导出时 require 到 undefined，
// 调用时报 "query is not a function" 而被 try/catch 吞成"静默不入库"。
module.exports = { initDB, query, getPool, saveSplitScript, listScripts, getScript, deleteScript, createUser, getUser, listUsers, updateUserRole, updateUserPassword, deleteUser };
