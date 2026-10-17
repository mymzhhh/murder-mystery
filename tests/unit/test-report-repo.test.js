// 测试报告落库的保留策略单测
//
// 用户反馈："同一个剧本的报告太多了"（实测一次会话内堆了 22 条）。
// 现在的规则是：**同一个剧本只保留最新 3 条**，更早的在入库后自动清掉。
//
// 用假 db 替换 core/db：这一层要测的是"发出什么 SQL、带什么参数"，
// 不需要真 PG（真库的端到端效果另在容器里验过：插 4 条 → 只剩 3 条）。
const test = require("node:test");
const assert = require("node:assert");

const DB_PATH = require.resolve("../../src/core/db");
const REPO_PATH = require.resolve("../../src/core/test-report-repo");

/** 注入假 db 并重新加载 repo；responses[i] 是第 i 次 query 的返回（或抛错） */
function loadRepo(responses) {
  const calls = [];
  let i = 0;
  require.cache[DB_PATH] = {
    id: DB_PATH, filename: DB_PATH, loaded: true,
    exports: {
      query: async (sql, params) => {
        calls.push({ sql: String(sql || ""), params });
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r || { rows: [] };
      },
    },
  };
  delete require.cache[REPO_PATH];
  return { repo: require(REPO_PATH), calls };
}

test("入库后按 script_id 只保留最新 3 条", async () => {
  const { repo, calls } = loadRepo([{ rows: [{ id: 9 }] }, { rows: [{ id: 1 }, { id: 2 }] }]);
  const id = await repo.insertTestReport({ roomCode: "AAAAAA", scriptSessionId: "s1", title: "T" });
  assert.strictEqual(id, 9);
  assert.strictEqual(calls.length, 2, "应先 INSERT 再 DELETE 清理");
  assert.ok(/INSERT INTO test_reports/.test(calls[0].sql));
  assert.ok(/DELETE FROM test_reports/.test(calls[1].sql), "第二条必须是清理语句");
  assert.deepStrictEqual(calls[1].params, ["s1", 3], "清理参数 = 剧本 id + 保留条数 3");
  // 清理语句的语义：同一 script_id 里不在"最新 N 条"中的全部删掉
  assert.ok(/NOT IN/.test(calls[1].sql), "清理必须是『不在最新 N 条里就删』的语义");
  assert.ok(/ORDER BY created_at DESC, id DESC/.test(calls[1].sql), "最新的判定按时间倒序、id 兜底");
});

test("script_id 为空时不做清理（不能把没带标识的报告当成同一个剧本）", async () => {
  const { repo, calls } = loadRepo([{ rows: [{ id: 7 }] }]);
  await repo.insertTestReport({ roomCode: "BBBBBB", scriptSessionId: "", title: "T" });
  assert.strictEqual(calls.length, 1, "只该有 INSERT，不该发清理");
  assert.ok(!calls.some((c) => /DELETE/.test(c.sql)), "空 script_id 绝不能触发删除");
});

test("清理失败不影响入库结果（存报告不能因为清理失败而失败）", async () => {
  const { repo } = loadRepo([{ rows: [{ id: 11 }] }, new Error("pg down")]);
  const id = await repo.insertTestReport({ roomCode: "CCCCCC", scriptSessionId: "s2", title: "T" });
  assert.strictEqual(id, 11, "清理抛错时仍要返回入库的 id");
});

test("入库本身失败时返回 null，且不再发清理", async () => {
  const { repo, calls } = loadRepo([new Error("insert failed")]);
  const id = await repo.insertTestReport({ roomCode: "DDDDDD", scriptSessionId: "s3", title: "T" });
  assert.strictEqual(id, null);
  assert.strictEqual(calls.length, 1, "入库都失败了就不该再去清理");
});

test("保留条数就是 3（用户指定的值）", () => {
  const { repo } = loadRepo([]);
  assert.strictEqual(repo.KEEP_PER_SCRIPT, 3);
});
