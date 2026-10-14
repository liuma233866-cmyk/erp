"use strict";
// 采集控制器测试：路由映射、租户/权限、参数透传、错误与审计。
// 服务用桩替换（业务逻辑已在 collectionBatchService.test.js 覆盖）。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createCollectionController } = require("./collectionController");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

const USER = { id: "u-1", companyId: "12" };

function makeController(overrides = {}) {
  const calls = [];
  const audits = [];
  const service = {
    openBatch: async (input) => { calls.push(["openBatch", input]); return { batch: { publicId: "CB_1" }, reused: false }; },
    getBatchSummary: async (input) => { calls.push(["getBatchSummary", input]); return { batch: { publicId: input.batchPublicId }, counts: {}, items: [] }; },
    addItem: async (input) => { calls.push(["addItem", input]); return { item: { id: 1 }, duplicate: false }; },
    markItemSucceeded: async (input) => { calls.push(["markItemSucceeded", input]); return { item: { id: input.itemId }, counts: {} }; },
    markItemFailed: async (input) => { calls.push(["markItemFailed", input]); return { item: { id: input.itemId }, counts: {} }; },
    finishBatch: async (input) => { calls.push(["finishBatch", input]); return { status: "succeeded", counts: {} }; },
    ...(overrides.service || {})
  };
  const controller = createCollectionController({
    service,
    tenant: overrides.tenant || { resolve: (user, requested) => requested || user.companyId },
    permission: overrides.permission || { require: () => true },
    audit: overrides.audit === null ? null : { record: async (entry) => { audits.push(entry); } }
  });
  return { controller, calls, audits };
}

function call(controller, method, pathname, body = {}, query = {}) {
  return controller.handle({ method, pathname, body, query, user: USER, requestId: "v2-req-1" });
}

test("POST /batches 开启批次并把操作者默认设为当前用户", async () => {
  const { controller, calls, audits } = makeController();
  const result = await call(controller, "POST", "/batches", {
    source: "collector.extension", requestNamespace: "collector.import", requestId: "req-1"
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.requestId, "v2-req-1");
  assert.equal(result.body.data.batch.publicId, "CB_1");
  const [name, input] = calls[0];
  assert.equal(name, "openBatch");
  assert.equal(input.companyId, "12");
  assert.equal(input.requestedBy, "u-1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].outcome, "success");
});

test("GET /batches/:id 返回批次详情", async () => {
  const { controller, calls } = makeController();
  const result = await call(controller, "GET", "/batches/CB_9");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls[0], ["getBatchSummary", { companyId: "12", batchPublicId: "CB_9" }]);
});

test("POST /batches/:id/items 投递项目并透传平台与载荷", async () => {
  const { controller, calls } = makeController();
  await call(controller, "POST", "/batches/CB_9/items", {
    sourcePlatform: "ozon", sourceProductId: "P-1", rawPayload: { title: "x" }
  });
  assert.deepEqual(calls[0], ["addItem", {
    companyId: "12", batchPublicId: "CB_9", sourcePlatform: "ozon", sourceProductId: "P-1", rawPayload: { title: "x" }
  }]);
});

test("项目成功/失败路径解析 itemId 与可选字段", async () => {
  const { controller, calls } = makeController();
  await call(controller, "POST", "/batches/CB_9/items/77/succeeded", { centralProductId: 555 });
  await call(controller, "POST", "/batches/CB_9/items/77/failed", { errorCode: "V2_VALIDATION_FAILED", errorMessage: "bad" });

  assert.deepEqual(calls[0], ["markItemSucceeded", { companyId: "12", batchPublicId: "CB_9", itemId: "77", centralProductId: 555 }]);
  assert.deepEqual(calls[1], ["markItemFailed", { companyId: "12", batchPublicId: "CB_9", itemId: "77", errorCode: "V2_VALIDATION_FAILED", errorMessage: "bad" }]);
});

test("POST /batches/:id/finish 收尾批次", async () => {
  const { controller, calls } = makeController();
  const result = await call(controller, "POST", "/batches/CB_9/finish");
  assert.equal(result.body.data.status, "succeeded");
  assert.deepEqual(calls[0], ["finishBatch", { companyId: "12", batchPublicId: "CB_9" }]);
});

test("权限不足返回 403 并记录错误审计", async () => {
  const { controller, audits, calls } = makeController({
    permission: { require: () => { throw new V2Error(ERROR_CODES.PERMISSION_DENIED, "Permission required: collection.write"); } }
  });
  const result = await call(controller, "POST", "/batches", { source: "excel", requestNamespace: "ns", requestId: "r1" });

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.error.code, ERROR_CODES.PERMISSION_DENIED);
  assert.equal(calls.length, 0);
  assert.equal(audits[0].outcome, "error");
  assert.equal(audits[0].statusCode, 403);
});

test("缺少租户返回 400", async () => {
  const { controller } = makeController({
    tenant: { resolve: () => { throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required"); } }
  });
  const result = await call(controller, "GET", "/batches/CB_9");
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, ERROR_CODES.TENANT_REQUIRED);
});

test("未知路径与方法返回 400", async () => {
  const { controller } = makeController();
  const unknown = await call(controller, "POST", "/unknown");
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.body.error.message, /Unknown collection route/);

  const unsupported = await call(controller, "DELETE", "/batches/CB_9");
  assert.equal(unsupported.statusCode, 400);
  assert.match(unsupported.body.error.message, /Unsupported collection method/);
});

test("长路径的审计 action 被截断到 64 字符，完整路径落到 metadata", async () => {
  const { controller, audits } = makeController();
  const longId = "CB_0123456789012345678901234567890123456789";
  const result = await call(controller, "POST", `/batches/${longId}/items/12345/succeeded`, { centralProductId: 1 });

  assert.equal(result.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.ok(audits[0].action.length <= 64, `action 长度 ${audits[0].action.length} 超过 v2_audit_logs.action 列宽`);
  assert.equal(audits[0].metadata.path.includes("/items/12345/succeeded"), true);
});

test("没有 audit 适配器时控制器仍可用", async () => {
  const { controller } = makeController({ audit: null });
  const result = await call(controller, "GET", "/batches/CB_9");
  assert.equal(result.statusCode, 200);
});

test("服务抛错时映射为错误响应并保留错误码", async () => {
  const { controller } = makeController({
    service: { finishBatch: async () => { throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection batch still has pending items"); } }
  });
  const result = await call(controller, "POST", "/batches/CB_9/finish");
  assert.equal(result.statusCode, 400);
  assert.match(result.body.error.message, /pending items/);
});
