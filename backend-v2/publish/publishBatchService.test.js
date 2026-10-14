"use strict";
// 发布批次状态机 + 刊登占用（publish_claims）单元测试。
// 使用内存 repository，不接触 MySQL。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PUBLISH_BATCH_STATUS,
  PublishBatchService,
  canTransitionBatch,
  derivePublishBatchStatus
} = require("./publishBatchService");
const { CLAIM_STATUS, PublishClaimService, isLeaseExpired, toMillis } = require("./publishClaimService");
const { ERROR_CODES } = require("../core/errorCodes");
const { toMysqlDatetime } = require("../core/dateTime");

function makeRepository() {
  const batches = [];
  const claims = [];
  let seq = 0;
  return {
    batches,
    claims,
    async findBatchByRequest(companyId, requestNamespace, clientRequestId) {
      return batches.find((batch) => String(batch.companyId) === String(companyId)
        && batch.requestNamespace === requestNamespace && batch.clientRequestId === clientRequestId) || null;
    },
    async findBatchByPublicId(companyId, publicId) {
      return batches.find((batch) => String(batch.companyId) === String(companyId) && batch.publicId === publicId) || null;
    },
    async createBatch(record) {
      const row = { id: ++seq, ...record };
      batches.push(row);
      return row;
    },
    async updateBatch(id, patch) {
      const row = batches.find((batch) => batch.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async findClaim(companyId, platform, shopId, businessKey) {
      return claims.find((claim) => String(claim.companyId) === String(companyId) && claim.platform === platform
        && String(claim.shopId) === String(shopId) && claim.businessKey === businessKey) || null;
    },
    async findClaimById(id) {
      return claims.find((claim) => String(claim.id) === String(id)) || null;
    },
    async createClaim(record) {
      const row = { id: ++seq, ...record };
      claims.push(row);
      return row;
    },
    async updateClaim(id, patch) {
      const row = claims.find((claim) => String(claim.id) === String(id));
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async listExpiredHeldClaims(nowDatetime) {
      const nowMs = toMillis(nowDatetime);
      return claims.filter((claim) => claim.status === CLAIM_STATUS.HELD && toMillis(claim.leaseUntil) <= nowMs);
    }
  };
}

function makeService(nowIso = "2026-09-27T10:00:00.000Z") {
  const repository = makeRepository();
  let current = new Date(nowIso);
  const clock = () => current;
  const setNow = (iso) => { current = new Date(iso); };
  return {
    repository,
    setNow,
    batchService: new PublishBatchService({ repository, clock }),
    claimService: new PublishClaimService({ repository, clock })
  };
}

async function createBatch(batchService, clientRequestId = "cli-1") {
  const { batch } = await batchService.createBatch({
    companyId: "C1", requestedBy: "U1", requestedItemCount: 2, requestNamespace: "publish.create", clientRequestId
  });
  return batch;
}

test("derivePublishBatchStatus 覆盖全部聚合分支", () => {
  assert.equal(derivePublishBatchStatus(["succeeded", "succeeded"]), PUBLISH_BATCH_STATUS.SUCCEEDED);
  assert.equal(derivePublishBatchStatus(["succeeded", "failed"]), PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED);
  assert.equal(derivePublishBatchStatus(["succeeded", "blocked", "timed_out"]), PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED);
  assert.equal(derivePublishBatchStatus(["blocked", "blocked"]), PUBLISH_BATCH_STATUS.BLOCKED);
  assert.equal(derivePublishBatchStatus(["failed", "blocked"]), PUBLISH_BATCH_STATUS.FAILED);
  assert.equal(derivePublishBatchStatus(["failed"]), PUBLISH_BATCH_STATUS.FAILED);
  assert.equal(derivePublishBatchStatus([]), PUBLISH_BATCH_STATUS.FAILED);
});

test("批次允许/禁止的迁移被集中约束", () => {
  assert.equal(canTransitionBatch("created", "queued"), true);
  assert.equal(canTransitionBatch("queued", "running"), true);
  assert.equal(canTransitionBatch("running", "partially_succeeded"), true);
  assert.equal(canTransitionBatch("blocked", "running"), true, "解除阻塞可以回到 running");
  assert.equal(canTransitionBatch("succeeded", "running"), false, "终态不可回退");
  assert.equal(canTransitionBatch("created", "partially_succeeded"), false, "不能跳过 queued/running");
});

test("createBatch 幂等且带公开 ID 与乐观锁版本", async () => {
  const { batchService, repository } = makeService();
  const first = await batchService.createBatch({
    companyId: "C1", requestedItemCount: 3, requestNamespace: "publish.create", clientRequestId: "cli-1", estimatedCost: 1.5, estimatedSeconds: 30
  });
  const second = await batchService.createBatch({
    companyId: "C1", requestedItemCount: 3, requestNamespace: "publish.create", clientRequestId: "cli-1"
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(repository.batches.length, 1);
  assert.match(first.batch.publicId, /^PB_/);
  assert.equal(first.batch.status, PUBLISH_BATCH_STATUS.CREATED);
  assert.equal(first.batch.rowVersion, 0);
  assert.equal(first.batch.estimatedCost, 1.5);
});

test("transition 校验合法迁移、终态保护与乐观锁", async () => {
  const { batchService } = makeService();
  const batch = await createBatch(batchService);

  const queued = await batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "queued" });
  assert.equal(queued.to, "queued");
  assert.equal(queued.batch.rowVersion, 1);

  await assert.rejects(
    () => batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "partially_succeeded" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );

  const running = await batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "running", expectedRowVersion: 1 });
  assert.equal(running.batch.status, "running");

  await assert.rejects(
    () => batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "failed", expectedRowVersion: 1 }),
    (error) => error.code === ERROR_CODES.ROW_VERSION_CONFLICT
  );

  await batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "partially_succeeded", expectedRowVersion: 2 });
  await assert.rejects(
    () => batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "running" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED && /terminal/.test(error.message)
  );
});

test("未知状态值被拒绝", async () => {
  const { batchService } = makeService();
  const batch = await createBatch(batchService);
  await assert.rejects(
    () => batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "published" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED && /Unknown publish batch status/.test(error.message)
  );
});

test("finishBatch 由子流程状态聚合，并记录完成时间", async () => {
  const { batchService } = makeService();
  const batch = await createBatch(batchService);
  await batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "queued" });
  await batchService.transition({ companyId: "C1", batchPublicId: batch.publicId, to: "running" });

  const result = await batchService.finishBatch({
    companyId: "C1", batchPublicId: batch.publicId, jobStatuses: ["succeeded", "failed", "blocked"], actualCost: 2.25
  });

  assert.equal(result.status, PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED);
  assert.equal(result.batch.jobCount, 3);
  assert.equal(result.batch.actualCost, 2.25);
  assert.ok(result.batch.finishedAt);
});

test("非 running 的批次收尾不会误报成功", async () => {
  const { batchService } = makeService();
  const batch = await createBatch(batchService);
  const result = await batchService.finishBatch({ companyId: "C1", batchPublicId: batch.publicId, jobStatuses: ["succeeded"] });
  assert.equal(result.status, PUBLISH_BATCH_STATUS.FAILED, "created 直接收尾只能算失败");
});

test("acquire 首次创建 held 占用并带租约", async () => {
  const { claimService, repository } = makeService();
  const result = await claimService.acquire({ companyId: "C1", platform: "Yandex", shopId: "S1", businessKey: "SKU-1", publishJobId: "J1", leaseMs: 60000 });

  assert.equal(result.reused, false);
  assert.equal(result.claim.status, CLAIM_STATUS.HELD);
  assert.equal(result.claim.platform, "yandex", "平台名统一小写");
  assert.equal(repository.claims.length, 1);
  assert.equal(toMillis(result.claim.leaseUntil) > toMillis("2026-09-27 10:00:30.000"), true, "租约应为 UTC 语义");
});

test("acquire 命中已有 held 占用时返回复用，不重复创建", async () => {
  const { claimService, repository } = makeService();
  const first = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });
  const second = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });

  assert.equal(second.reused, true);
  assert.equal(second.claim.id, first.claim.id);
  assert.equal(second.leaseExpired, false);
  assert.equal(repository.claims.length, 1);
});

test("租约过期时返回 leaseExpired 但绝不自动释放", async () => {
  const { claimService, repository, setNow } = makeService();
  await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1", leaseMs: 60000 });

  setNow("2026-09-27T10:05:00.000Z");
  const result = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });

  assert.equal(result.reused, true);
  assert.equal(result.leaseExpired, true);
  assert.equal(repository.claims[0].status, CLAIM_STATUS.HELD, "过期不等于可重试，状态保持 held 直到恢复流程处理");
});

test("probe_required 占用被识别并保持，不会被自动接管", async () => {
  const { claimService, repository } = makeService();
  const { claim } = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });
  await claimService.markProbeRequired({ companyId: "C1", claimId: claim.id });

  const again = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });
  assert.equal(again.probeRequired, true);
  assert.equal(repository.claims[0].status, CLAIM_STATUS.PROBE_REQUIRED);
});

test("released 后可以重新获取同一业务键", async () => {
  const { claimService, repository } = makeService();
  const { claim } = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" });
  await claimService.releaseTerminal({ companyId: "C1", claimId: claim.id });
  assert.equal(repository.claims[0].status, CLAIM_STATUS.RELEASED);
  assert.equal(repository.claims[0].leaseUntil, null);

  const reacquired = await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1", publishJobId: "J2" });
  assert.equal(reacquired.reused, false);
  assert.equal(reacquired.reacquired, true);
  assert.equal(reacquired.claim.status, CLAIM_STATUS.HELD);
  assert.equal(reacquired.claim.publishJobId, "J2");
  assert.equal(repository.claims.length, 1, "重新获取复用同一行（唯一约束）");
});

test("renew 仅在 held 时续租，否则钉在 probe_required", async () => {
  const { claimService } = makeService();
  const held = (await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1", leaseMs: 60000 })).claim;

  const renewed = await claimService.renew({ companyId: "C1", claimId: held.id, leaseMs: 120000 });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.probeRequired, false);

  await claimService.markProbeRequired({ companyId: "C1", claimId: held.id });
  const failedRenew = await claimService.renew({ companyId: "C1", claimId: held.id });
  assert.equal(failedRenew.renewed, false);
  assert.equal(failedRenew.probeRequired, true);
  assert.equal(failedRenew.claim.status, CLAIM_STATUS.PROBE_REQUIRED);
});

test("recoverExpiredLeases 把过期 held 转为 probe_required，而不是 released", async () => {
  const { claimService, repository, setNow } = makeService();
  const expired = (await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1", leaseMs: 1000 })).claim;
  const fresh = (await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-2", leaseMs: 600000 })).claim;

  setNow("2026-09-27T10:01:00.000Z");
  const result = await claimService.recoverExpiredLeases();

  assert.equal(result.count, 1);
  assert.equal(repository.claims.find((claim) => claim.id === expired.id).status, CLAIM_STATUS.PROBE_REQUIRED);
  assert.equal(repository.claims.find((claim) => claim.id === fresh.id).status, CLAIM_STATUS.HELD);
});

test("releaseTerminal 幂等，重复释放不报错", async () => {
  const { claimService } = makeService();
  const claim = (await claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "SKU-1" })).claim;
  const first = await claimService.releaseTerminal({ companyId: "C1", claimId: claim.id });
  const second = await claimService.releaseTerminal({ companyId: "C1", claimId: claim.id });
  assert.equal(first.released, true);
  assert.equal(second.released, false);
  assert.equal(second.alreadyReleased, true);
});

test("isLeaseExpired 对空租约视为已过期，且按 UTC 解析 MySQL 时间", () => {
  const now = new Date("2026-09-27T10:00:00.000Z").getTime();
  assert.equal(isLeaseExpired({ leaseUntil: null }, now), true);
  assert.equal(isLeaseExpired({ leaseUntil: toMysqlDatetime(new Date("2026-09-27T09:59:00.000Z")) }, now), true);
  assert.equal(isLeaseExpired({ leaseUntil: toMysqlDatetime(new Date("2026-09-27T10:01:00.000Z")) }, now), false);
  assert.equal(isLeaseExpired({ leaseUntil: "2026-09-27T10:01:00.000Z" }, now), false, "ISO 字符串同样支持");
});

test("占用接口校验必填字段", async () => {
  const { claimService } = makeService();
  await assert.rejects(
    () => claimService.acquire({ companyId: "", platform: "yandex", shopId: "S1", businessKey: "K" }),
    (error) => error.code === ERROR_CODES.TENANT_REQUIRED
  );
  await assert.rejects(
    () => claimService.acquire({ companyId: "C1", platform: "yandex", shopId: "S1", businessKey: "" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});
