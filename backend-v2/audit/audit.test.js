"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MySqlAuditSink } = require("./mysqlAuditSink");
const { toMysqlDatetime } = require("../core/dateTime");

test("MySqlAuditSink converts ISO timestamps to UTC DATETIME(3)", async () => {
  let captured;
  const sink = new MySqlAuditSink({
    pool: { execute: async (_sql, params) => { captured = params; } }
  });
  await sink.write({
    requestId: "req-1",
    companyId: "c-1",
    actorId: "u-1",
    action: "create",
    resourceType: "publish_batch",
    resourceId: "b-1",
    outcome: "success",
    statusCode: 200,
    metadata: {},
    occurredAt: "2026-08-18T00:00:00.000Z"
  });
  assert.equal(captured.at(-1), "2026-08-18 00:00:00.000");
});

test("toMysqlDatetime preserves UTC and rejects invalid values", () => {
  assert.equal(toMysqlDatetime("2026-08-18T08:00:00.123+08:00"), "2026-08-18 00:00:00.123");
  assert.throws(() => toMysqlDatetime("not-a-date"), /valid date/i);
});
