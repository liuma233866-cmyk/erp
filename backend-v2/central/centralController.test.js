"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCentralController } = require("./centralController");

test("central controller enforces tenant/permission adapters and exposes list contract", async () => {
  const calls = [];
  const controller = createCentralController({
    service: { listProducts: async (companyId, query) => { calls.push({ companyId, query }); return [{ publicId: "CP_1" }]; } },
    tenant: { resolve: (_user, requested) => requested || "1" },
    permission: { require: (_user, permission) => assert.equal(permission, "central.read") },
    audit: { record: async () => undefined }
  });
  const response = await controller.handle({ pathname: "/products", query: { status: "ready" }, user: { id: "u-1" }, requestId: "req-1" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.items, [{ publicId: "CP_1" }]);
  assert.deepEqual(calls[0], { companyId: "1", query: { status: "ready" } });
});

test("central controller returns structured validation errors", async () => {
  const controller = createCentralController({
    service: {},
    tenant: { resolve: () => "1" },
    permission: { require: () => undefined }
  });
  const response = await controller.handle({ pathname: "/unknown", user: { id: "u-1" }, requestId: "req-2" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.requestId, "req-2");
});

