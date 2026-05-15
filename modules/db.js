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
  `);
  console.log("[db] PostgreSQL 表已就绪");
}

/** 保存切分后的剧本 */
async function saveSplitScript(scriptId, meta, characters, clues, dmData) {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO scripts (id, title, era, location, game_mode, player_count, npc_count, clue_count, layout_description, original_markdown, split_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET title=$2, era=$3, location=$4, player_count=$6, npc_count=$7, clue_count=$8, layout_description=$9, original_markdown=$10, split_at=NOW()`,
      [scriptId, meta.title, meta.era, meta.location, meta.gameMode || "PVE", meta.playerCount, meta.npcCount, meta.clueCount, meta.layoutDescription || "", meta.originalMarkdown || ""]
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

/** 查询剧本列表 */
async function listScripts() {
  const r = await query("SELECT id, title, era, location, game_mode, player_count, npc_count, clue_count, layout_description, split_at, created_at FROM scripts ORDER BY split_at DESC NULLS LAST, created_at DESC");
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

module.exports = { initDB, saveSplitScript, listScripts, getScript, deleteScript, createUser, getUser, listUsers };
