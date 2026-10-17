// 测试报告的持久化（PostgreSQL）。
//
// 与 redis 那条链的分工：**房间是临时的，报告是结论** —— 房间 6 小时后会被
// 生命周期回收器删掉，而"这局测出了什么"要能长期回看，所以报告落 PG。
//
// 表结构在 core/db.js 的 initDB 里建（跟其它表同一个地方，避免两处建表漂移）。

const { query } = require("./db");

/** 存一份报告；返回 id（PG 不可用时返回 null，不抛 —— 不能因为存报告失败把测试流程搞挂） */
async function insertTestReport(report) {
  try {
    const r = report || {};
    const res = await query(
      `INSERT INTO test_reports
        (room_code, script_id, script_title, started_at, ended_at, duration_ms, phase_minutes,
         verdict, verdict_text, clue_total, clue_found, unreachable_count, silent_ai_count,
         error_count, outcome, reason, report)
       VALUES ($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,
               $8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        r.roomCode || "", r.scriptSessionId || "", r.title || "",
        r.startedAt || Date.now(), r.endedAt || Date.now(), r.durationMs || 0, r.phaseMinutes || 0,
        r.verdict || "", r.verdictText || "",
        r.clueTotal || 0, r.clueFound || 0,
        (r.unreachable || []).length, (r.silentAi || []).length, r.errorCount || 0,
        (r.voting && r.voting.outcome) || "", r.reason || "",
        JSON.stringify(r),
      ]
    );
    return res.rows[0] ? res.rows[0].id : null;
  } catch (e) {
    console.warn("[test-report] 报告入库失败:", e.message);
    return null;
  }
}

/** 列表（不含完整 report，列表页用不到；要详情再取一次） */
async function listTestReports(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const res = await query(
    `SELECT id, room_code, script_id, script_title, started_at, ended_at, duration_ms, phase_minutes,
            verdict, verdict_text, clue_total, clue_found, unreachable_count, silent_ai_count,
            error_count, outcome, reason, created_at
       FROM test_reports ORDER BY created_at DESC, id DESC LIMIT $1`,
    [n]
  );
  return res.rows;
}

/** 详情（含完整 report） */
async function getTestReport(id) {
  const res = await query(`SELECT * FROM test_reports WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function deleteTestReport(id) {
  const res = await query(`DELETE FROM test_reports WHERE id = $1 RETURNING id`, [id]);
  return res.rows[0] ? res.rows[0].id : null;
}

module.exports = { insertTestReport, listTestReports, getTestReport, deleteTestReport };
