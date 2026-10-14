"use strict";
// 发布控制器测试：批次迁移/收尾与占用七条路径的路由映射、权限与错误处理。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createPublishController } = require("./publishController");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

const USER = { id: "u-1", companyId: "12" };

function makeController(overrides = {}) {
  const calls = [];
  const audits = [];
  const batchService = {
    createBatch: async (input) => { calls.push(["createBatch", input]); return { batch: { publicId: "PB_1" }, reused: false }; },
    transition: async (input) => { calls.push(["transition", input]); return { batch: { publicId: input.batchPublicId }, from: "queued", to: input.to }; },
    finishBatch: async (input) => { calls.push(["finishBatch", input]); return { status: "partially_succeeded" }; },
    ...(overrides.batchService || {})
  };
  const claimService = {
    acquire: async (input) => { calls.push(["acquire", input]); return { claim: { id: 1, status: "held" }, reused: false }; },
    renew: async (input) => { calls.push(["renew", input]); return { claim: { id: input.claimId }, renewed: true }; },
    markProbeRequired: async (input) => { calls.push(["markProbeRequired", input]); return { claim: { id: input.claimId, status: "probe_required" } }; },
    releaseTerminal: async (input) => { calls.push(["releaseTerminal", input]); return { claim: { id: input.claimId, status: "released" }, released: true }; },
    recoverExpiredLeases: async () => { calls.push(["recoverExpiredLeases", {}]); return { recovered: [], count: 0 }; },
    ...(overrides.claimService || {})
  };
  const controller = createPublishController({
    batchService,
    claimService,
    tenant: overrides.tenant || { resolve: (user, requested) => requested || user.companyId },
    permission: overrides.permission || { require: () => true },
    audit: overrides.audit === null ? null : { record: async (entry) => { audits.push(entry); } }
  });
  return { controller, calls, audits };
}

function call(controller, method, pathname, body = {}, query = {}) {
  return controller.handle({ method, pathname, body, query, user: USER, requestId: "v2-req-9" });
}

test("POST /batches 创建批次并带上操作者与预估字段", async () => {
  const { controller, calls, audits } = makeController();
  const result = await call(controller, "POST", "/batches", {
    requestedItemCount: 3, requestNamespace: "publish.create", clientRequestId: "cli-1", estimatedCost: 1.5, estimatedSeconds: 30
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.requestId, "v2-req-9");
  const [name, input] = calls[0];
  assert.equal(name, "createBatch");
  assert.equal(input.companyId, "12");
  assert.equal(input.requestedBy, "u-1");
  assert.equal(input.requestedItemCount, 3);
  assert.equal(audits[0].outcome, "success");
});

test("POST /batches/:id/transitions 透传目标状态与乐观锁版本", async () => {
  const { controller, calls } = makeController();
  await call(controller, "POST", "/batches/PB_9/transitions", { to: "queued", expectedRowVersion: 0 });
  assert.deepEqual(calls[0], ["transition", { companyId: "12", batchPublicId: "PB_9", to: "queued", expectedRowVersion: 0, patch: {} }]);
});

test("POST /batches/:id/finish 按子流程状态聚合", async () => {
  const { controller, calls } = makeController();
  const result = await call(controller, "POST", "/batches/PB_9/finish", { jobStatuses: ["succeeded", "blocked"], actualCost: 2.5 });
  assert.equal(result.body.data.status, "partially_succeeded");
  assert.deepEqual(calls[0], ["finishBatch", {
    companyId: "12", batchPublicId: "PB_9", jobStatuses: ["succeeded", "blocked"], jobCount: null, actualCost: 2.5
  }]);
});

test("POST /claims 获取占用并透传业务键与租约", async () => {
  const { controller, calls } = makeController();
  const result = await call(controller, "POST", "/claims", {
    platform: "yandex", shopId: "10001", businessKey: "SKU-A", publishJobId: "J1", leaseMs: 60000
  });
  assert.equal(result.body.data.claim.status, "held");
  assert.deepEqual(calls[0], ["acquire", {
    companyId: "12", platform: "yandex", shopId: "10001", businessKey: "SKU-A", publishJobId: "J1", leaseMs: 60000
  }]);
});

test("POST /claims/recover-expired 不会被误当成 claimId", async () => {
  const { controller, calls } = makeController();
  const result = await call(controller, "POST", "/claims/recover-expired");
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.count, 0);
  assert.equal(calls[0][0], "recoverExpiredLeases");
});

test("占用的续租 / 探测态 / 释放三条路径", async () => {
  const { controller, calls } = makeController();
  await call(controller, "POST", "/claims/9/renew", { leaseMs: 120000 });
  await call(controller, "POST", "/claims/9/probe-required");
  await call(controller, "POST", "/claims/9/release");

  assert.deepEqual(calls[0], ["renew", { companyId: "12", claimId: "9", leaseMs: 120000 }]);
  assert.deepEqual(calls[1], ["markProbeRequired", { companyId: "12", claimId: "9" }]);
  assert.deepEqual(calls[2], ["releaseTerminal", { companyId: "12", claimId: "9" }]);
});

test("权限不足返回 403，且不会调用任何服务", async () => {
  const { controller, calls, audits } = makeController({
    permission: { require: () => { throw new V2Error(ERROR_CODES.PERMISSION_DENIED, "Permission required: publish.write"); } }
  });
  const result = await call(controller, "POST", "/claims", { platform: "yandex", shopId: "1", businessKey: "K" });
  assert.equal(result.statusCode, 403);
  assert.equal(calls.length, 0);
  assert.equal(audits[0].outcome, "error");
});

test("占用冲突返回 409 并保留错误码", async () => {
  const { controller } = makeController({
    claimService: { acquire: async () => { throw new V2Error(ERROR_CODES.CLAIM_CONFLICT, "Claim already held"); } }
  });
  const result = await call(controller, "POST", "/claims", { platform: "yandex", shopId: "1", businessKey: "K" });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.code, ERROR_CODES.CLAIM_CONFLICT);
});

test("未知路径与方法返回 400", async () => {
  const { controller } = makeController();
  const unknown = await call(controller, "POST", "/nope");
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.body.error.message, /Unsupported publish method/);

  const wrongMethod = await call(controller, "GET", "/batches");
  assert.equal(wrongMethod.statusCode, 400);
});

test("长路径的审计 action 被截断到 64 字符", async () => {
  const { controller, audits } = makeController();
  const longId = "PB_0123456789012345678901234567890123456789";
  const result = await call(controller, "POST", `/batches/${longId}/transitions`, { to: "queued", expectedRowVersion: 0 });

  assert.equal(result.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.ok(audits[0].action.length <= 64, `action 长度 ${audits[0].action.length} 超过列宽`);
  assert.equal(audits[0].metadata.path.includes("/transitions"), true);
});

test("缺少租户返回 400", async () => {
  const { controller } = makeController({
    tenant: { resolve: () => { throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required"); } }
  });
  const result = await call(controller, "POST", "/claims", { platform: "yandex", shopId: "1", businessKey: "K" });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error.code, ERROR_CODES.TENANT_REQUIRED);
});
