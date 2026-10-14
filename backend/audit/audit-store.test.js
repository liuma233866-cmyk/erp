"use strict";
// 审计存储单元测试：行映射往返、写入串行化、失败可恢复、hydrate 顺序与裁剪。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIT_TABLE_DDL,
  AUDIT_INSERT_COLUMNS,
  auditRowValues,
  createAuditStore,
  rowToAuditEntry
} = require("./audit-store");

function makePool(handlers = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, values) => {
      calls.push({ kind: "execute", sql, values });
      return handlers.execute ? handlers.execute(sql, values) : [{}];
    },
    query: async (sql) => {
      calls.push({ kind: "query", sql });
      return handlers.query ? handlers.query(sql) : [[]];
    }
  };
}

function makeEntry(id, extra = {}) {
  return {
    id,
    ts: "2026-09-27T02:00:00.000Z",
    actorUserId: "USR-1",
    actorUsername: "admin",
    actorRole: "admin",
    ip: "127.0.0.1",
    method: "PUT",
    path: `/api/orders/${id}/purchase`,
    actionType: "update",
    resourceType: "order",
    resourceId: id,
    statusCode: 200,
    success: true,
    errorMessage: "",
    warningMessage: "",
    query: { page: "1" },
    requestBodyMasked: { purchasePriceRmb: "12.5" },
    responseBodyMasked: { ok: true },
    ...extra
  };
}

test("DDL 与列清单覆盖表结构", () => {
  assert.match(AUDIT_TABLE_DDL, /CREATE TABLE IF NOT EXISTS audit_logs/);
  for (const column of ["id", "ts", "tsDt", "queryJson", "requestBodyMaskedJson", "responseBodyMaskedJson", "success"]) {
    assert.ok(AUDIT_INSERT_COLUMNS.includes(column), `缺少列 ${column}`);
    assert.match(AUDIT_TABLE_DDL, new RegExp(`\\b${column}\\b`));
  }
});

test("auditRowValues 按列顺序编码，并把 JSON 列序列化", () => {
  const values = auditRowValues(makeEntry("AUD-1"));
  assert.equal(values.length, AUDIT_INSERT_COLUMNS.length);
  const byColumn = Object.fromEntries(AUDIT_INSERT_COLUMNS.map((column, index) => [column, values[index]]));
  assert.equal(byColumn.id, "AUD-1");
  assert.equal(byColumn.method, "PUT");
  assert.equal(byColumn.statusCode, 200);
  assert.equal(byColumn.success, 1);
  assert.equal(byColumn.queryJson, '{"page":"1"}');
  assert.equal(byColumn.requestBodyMaskedJson, '{"purchasePriceRmb":"12.5"}');
  assert.equal(byColumn.responseBodyMaskedJson, '{"ok":true}');
  assert.ok(byColumn.tsDt instanceof Date);
});

test("auditRowValues 在请求/响应体缺失时写 NULL，而不是字符串 undefined", () => {
  const values = auditRowValues(makeEntry("AUD-2", { requestBodyMasked: null, responseBodyMasked: undefined }));
  const byColumn = Object.fromEntries(AUDIT_INSERT_COLUMNS.map((column, index) => [column, values[index]]));
  assert.equal(byColumn.requestBodyMaskedJson, null);
  assert.equal(byColumn.responseBodyMaskedJson, null);
  assert.equal(byColumn.queryJson, '{"page":"1"}');
});

test("rowToAuditEntry 解析 JSON 列并补齐默认值", () => {
  const entry = rowToAuditEntry({
    id: "AUD-9",
    ts: "2026-09-27T03:00:00.000Z",
    tsDt: new Date("2026-09-27T03:00:00.000Z"),
    actorUsername: "ops",
    method: "GET",
    path: "/api/orders",
    statusCode: 500,
    success: 0,
    queryJson: '{"page":"2"}',
    requestBodyMaskedJson: "",
    responseBodyMaskedJson: null,
    actionType: "",
    resourceType: ""
  });
  assert.equal(entry.id, "AUD-9");
  assert.deepEqual(entry.query, { page: "2" });
  assert.equal(entry.requestBodyMasked, null);
  assert.equal(entry.success, false);
  assert.equal(entry.statusCode, 500);
  assert.equal(entry.actionType, "read", "空 actionType 回退为 read");
  assert.equal(entry.resourceType, "system", "空 resourceType 回退为 system");
});

test("行映射可往返：entry → values → row → entry 关键字段一致", () => {
  const original = makeEntry("AUD-RT", { success: false, statusCode: 403, errorMessage: "Forbidden", warningMessage: "warn" });
  const values = auditRowValues(original);
  const row = Object.fromEntries(AUDIT_INSERT_COLUMNS.map((column, index) => [column, values[index]]));
  // 表里存的是 JSON 文本，读取时按文本解析。
  row.queryJson = values[AUDIT_INSERT_COLUMNS.indexOf("queryJson")];
  row.requestBodyMaskedJson = values[AUDIT_INSERT_COLUMNS.indexOf("requestBodyMaskedJson")];
  row.responseBodyMaskedJson = values[AUDIT_INSERT_COLUMNS.indexOf("responseBodyMaskedJson")];

  const restored = rowToAuditEntry(row);
  assert.equal(restored.id, original.id);
  assert.equal(restored.ts, original.ts);
  assert.equal(restored.path, original.path);
  assert.equal(restored.success, false);
  assert.equal(restored.statusCode, 403);
  assert.equal(restored.errorMessage, "Forbidden");
  assert.deepEqual(restored.query, original.query);
  assert.deepEqual(restored.requestBodyMasked, original.requestBodyMasked);
  assert.deepEqual(restored.responseBodyMasked, original.responseBodyMasked);
});

test("insert 串行化：即使前一条很慢，后一条也不会先落库", async () => {
  const order = [];
  const pool = makePool({
    execute: async (sql, values) => {
      order.push(values[0]);
      await new Promise((resolve) => setTimeout(resolve, values[0] === "AUD-1" ? 20 : 0));
      return [{}];
    }
  });
  const store = createAuditStore({ getSqlPool: () => pool, isSqlReady: () => true, logError: () => {} });
  const first = store.insert(makeEntry("AUD-1"));
  const second = store.insert(makeEntry("AUD-2"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["AUD-1", "AUD-2"]);
});

test("SQL 未就绪时 insert 直接返回 false 且不碰连接池", async () => {
  const pool = makePool();
  const store = createAuditStore({ getSqlPool: () => pool, isSqlReady: () => false, logError: () => {} });
  assert.equal(await store.insert(makeEntry("AUD-1")), false);
  assert.equal(pool.calls.length, 0);
});

test("单条写入失败会被记录，且不影响后续写入", async () => {
  let attempts = 0;
  const errors = [];
  const pool = makePool({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("duplicate key");
      return [{}];
    }
  });
  const store = createAuditStore({ getSqlPool: () => pool, isSqlReady: () => true, logError: (message) => errors.push(String(message)) });
  assert.equal(await store.insert(makeEntry("AUD-BAD")), false);
  assert.equal(await store.insert(makeEntry("AUD-OK")), true);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /duplicate key/);
});

test("loadRecent 把倒序查询结果还原为时间正序，并钳制 limit", async () => {
  const rows = [
    { id: "AUD-3", ts: "2026-09-27T03:00:00.000Z", tsDt: new Date("2026-09-27T03:00:00.000Z") },
    { id: "AUD-2", ts: "2026-09-27T02:00:00.000Z", tsDt: new Date("2026-09-27T02:00:00.000Z") },
    { id: "AUD-1", ts: "2026-09-27T01:00:00.000Z", tsDt: new Date("2026-09-27T01:00:00.000Z") }
  ];
  const pool = makePool({ query: async () => [rows] });
  const store = createAuditStore({ getSqlPool: () => pool, isSqlReady: () => true, logError: () => {} });

  const entries = await store.loadRecent(3);
  assert.deepEqual(entries.map((entry) => entry.id), ["AUD-1", "AUD-2", "AUD-3"]);
  assert.match(pool.calls[0].sql, /ORDER BY ts DESC LIMIT 3/);

  await store.loadRecent(0);
  assert.match(pool.calls[1].sql, /LIMIT 10000/, "非法 limit 回退为默认 10000");

  await store.loadRecent(10 ** 9);
  assert.match(pool.calls[2].sql, /LIMIT 100000/, "过大 limit 被钳制到 100000");
});

test("ensureTable 执行建表 DDL，trimTo 返回删除行数", async () => {
  const pool = makePool({ query: async (sql) => (sql.includes("DELETE FROM") ? [{ affectedRows: 7 }] : [[]]) });
  const store = createAuditStore({ getSqlPool: () => pool, isSqlReady: () => true, logError: () => {} });

  assert.equal(await store.ensureTable(), true);
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS audit_logs/);

  assert.equal(await store.trimTo(5000), 7);
  assert.match(pool.calls[1].sql, /DELETE FROM `audit_logs`/);
  assert.match(pool.calls[1].sql, /LIMIT 5000/);
});
