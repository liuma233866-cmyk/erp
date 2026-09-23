"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ERROR_CODES, V2Error, toErrorResponse } = require("./errorCodes");
const { getOrCreateRequestId, normalizeRequestId } = require("./requestId");
const { AuditLogger, maskValue } = require("../audit/auditLogger");

test("request ids accept safe inbound ids and create a V2 id otherwise", () => {
  assert.equal(normalizeRequestId("client-123"), "client-123");
  assert.equal(normalizeRequestId("bad value"), "");
  assert.match(getOrCreateRequestId({ headers: { "x-request-id": "client-123" } }), /^client-123$/);
  assert.match(getOrCreateRequestId({ headers: {} }), /^v2-/);
});

test("unknown errors are hidden while V2 errors preserve code and request id", () => {
  const known = toErrorResponse(new V2Error(ERROR_CODES.PERMISSION_DENIED, "No access"), "req-1");
  assert.equal(known.statusCode, 403);
  assert.deepEqual(known.body.error, { code: ERROR_CODES.PERMISSION_DENIED, message: "No access", requestId: "req-1" });
  const unknown = toErrorResponse(new Error("secret"), "req-2");
  assert.equal(unknown.statusCode, 500);
  assert.equal(unknown.body.error.message, "Internal server error");
});

test("audit logger masks sensitive metadata and writes immutable entries", async () => {
  const entries = [];
  const logger = new AuditLogger({ sink: { write: async (entry) => entries.push(entry) }, clock: () => new Date("2026-08-18T00:00:00.000Z") });
  const entry = await logger.record({ requestId: "req-1", companyId: "c-1", action: "create", metadata: { token: "secret", apiKey: "key", requestJson: { secret: "payload" }, nested: { value: 1 } } });
  assert.equal(entries.length, 1);
  assert.equal(entry.metadata.token, "[masked]");
  assert.equal(entry.metadata.apiKey, "[masked]");
  assert.equal(entry.metadata.requestJson, "[masked]");
  assert.equal(entry.metadata.nested.value, 1);
  assert.throws(() => { entry.action = "changed"; }, TypeError);
  assert.throws(() => { entry.metadata.nested.value = 2; }, TypeError);
  assert.equal(maskValue({ password: "secret" }).password, "[masked]");
});
