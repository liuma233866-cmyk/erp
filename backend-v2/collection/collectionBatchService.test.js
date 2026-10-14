"use strict";
// 采集批次状态机单元测试：幂等、批次内去重、计数与聚合规则、终态保护。
// 使用内存 repository，不接触 MySQL。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COLLECTION_BATCH_STATUS,
  COLLECTION_ITEM_STATUS,
  CollectionBatchService,
  countItems,
  deriveCollectionBatchStatus
} = require("./collectionBatchService");
const { ERROR_CODES } = require("../core/errorCodes");

function makeRepository() {
  const batches = [];
  const items = [];
  let seq = 0;
  return {
    batches,
    items,
    async findBatchByRequest(companyId, requestNamespace, requestId) {
      return batches.find((batch) => String(batch.companyId) === String(companyId)
        && batch.requestNamespace === requestNamespace && batch.requestId === requestId) || null;
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
    async updateBatchCounters(id, counters) {
      const row = batches.find((batch) => batch.id === id);
      if (!row) return null;
      Object.assign(row, counters);
      return row;
    },
    async findItem(batchId, sourcePlatform, sourceProductId) {
      return items.find((item) => item.collectionBatchId === batchId
        && item.sourcePlatform === sourcePlatform && item.sourceProductId === sourceProductId) || null;
    },
    async listItems(batchId) {
      return items.filter((item) => item.collectionBatchId === batchId);
    },
    async createItem(record) {
      const row = { id: ++seq, ...record };
      items.push(row);
      return row;
    },
    async updateItem(id, patch) {
      const row = items.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }
  };
}

function makeService() {
  const repository = makeRepository();
  const clock = () => new Date("2026-09-27T10:00:00.000Z");
  const service = new CollectionBatchService({ repository, clock });
  return { service, repository };
}

async function openBatch(service, requestId = "req-1") {
  const { batch } = await service.openBatch({
    companyId: "C1", source: "collector.extension", requestedBy: "U1", requestNamespace: "collector.import", requestId
  });
  return batch;
}

test("deriveCollectionBatchStatus 按聚合规则给出四种结果", () => {
  assert.equal(deriveCollectionBatchStatus({ itemCount: 3, successCount: 3, failedCount: 0 }), COLLECTION_BATCH_STATUS.SUCCEEDED);
  assert.equal(deriveCollectionBatchStatus({ itemCount: 3, successCount: 1, failedCount: 2 }), COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED);
  assert.equal(deriveCollectionBatchStatus({ itemCount: 3, successCount: 2, failedCount: 0 }), COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED, "含 duplicate 时不算全成功");
  assert.equal(deriveCollectionBatchStatus({ itemCount: 2, successCount: 0, failedCount: 2 }), COLLECTION_BATCH_STATUS.FAILED);
  assert.equal(deriveCollectionBatchStatus({ itemCount: 0, successCount: 0, failedCount: 0 }), COLLECTION_BATCH_STATUS.FAILED);
});

test("countItems 分别统计成功/失败/重复/未决", () => {
  const counts = countItems([
    { status: "succeeded" }, { status: "failed" }, { status: "duplicate" }, { status: "pending" }, { status: "SUCCEEDED" }
  ]);
  assert.deepEqual(counts, { itemCount: 5, successCount: 2, failedCount: 1, pendingCount: 1, duplicateCount: 1 });
});

test("openBatch 按 (company, namespace, requestId) 幂等", async () => {
  const { service, repository } = makeService();
  const first = await service.openBatch({ companyId: "C1", source: "excel", requestNamespace: "collector.import", requestId: "req-1" });
  const second = await service.openBatch({ companyId: "C1", source: "excel", requestNamespace: "collector.import", requestId: "req-1" });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(repository.batches.length, 1);
  assert.equal(first.batch.status, COLLECTION_BATCH_STATUS.CREATED);
  assert.match(first.batch.publicId, /^CB_/);
});

test("缺少 tenant 或必填字段时拒绝", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.openBatch({ source: "excel", requestNamespace: "ns", requestId: "r1" }),
    (error) => error.code === ERROR_CODES.TENANT_REQUIRED
  );
  await assert.rejects(
    () => service.openBatch({ companyId: "C1", source: "", requestNamespace: "ns", requestId: "r1" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});

test("addItem 落 pending 并把批次从 created 推到 running", async () => {
  const { service, repository } = makeService();
  const batch = await openBatch(service);

  const { item, duplicate } = await service.addItem({
    companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "Ozon", sourceProductId: "P-1", rawPayload: { title: "x" }
  });

  assert.equal(duplicate, false);
  assert.equal(item.status, COLLECTION_ITEM_STATUS.PENDING);
  assert.equal(item.sourcePlatform, "ozon", "平台名统一小写");
  assert.equal(repository.batches[0].status, COLLECTION_BATCH_STATUS.RUNNING);
  assert.equal(repository.batches[0].itemCount, 1);
});

test("同一批次内重复投递同一来源商品记为 duplicate 且不新增行", async () => {
  const { service, repository } = makeService();
  const batch = await openBatch(service);
  await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "P-1" });

  const { item, duplicate } = await service.addItem({
    companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "P-1"
  });

  assert.equal(duplicate, true);
  assert.equal(item.status, COLLECTION_ITEM_STATUS.DUPLICATE);
  assert.equal(repository.items.length, 1);
  assert.equal(repository.batches[0].itemCount, 1);
});

test("不同来源平台的同一 ID 视为两条项目", async () => {
  const { service, repository } = makeService();
  const batch = await openBatch(service);
  await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "SAME" });
  await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "yandex", sourceProductId: "SAME" });
  assert.equal(repository.items.length, 2);
  assert.equal(repository.batches[0].itemCount, 2);
});

test("markItemSucceeded / markItemFailed 更新状态与计数", async () => {
  const { service, repository } = makeService();
  const batch = await openBatch(service);
  const a = (await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "A" })).item;
  const b = (await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "B" })).item;

  await service.markItemSucceeded({ companyId: "C1", batchPublicId: batch.publicId, itemId: a.id, centralProductId: "CP-1" });
  await service.markItemFailed({ companyId: "C1", batchPublicId: batch.publicId, itemId: b.id, errorCode: "V2_VALIDATION_FAILED", errorMessage: "bad payload" });

  const succeeded = repository.items.find((item) => item.id === a.id);
  const failed = repository.items.find((item) => item.id === b.id);
  assert.equal(succeeded.status, COLLECTION_ITEM_STATUS.SUCCEEDED);
  assert.equal(succeeded.centralProductId, "CP-1");
  assert.equal(failed.status, COLLECTION_ITEM_STATUS.FAILED);
  assert.equal(failed.errorCode, "V2_VALIDATION_FAILED");
  assert.equal(repository.batches[0].successCount, 1);
  assert.equal(repository.batches[0].failedCount, 1);
});

test("finishBatch 在仍有 pending 项目时拒绝", async () => {
  const { service } = makeService();
  const batch = await openBatch(service);
  await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "A" });

  await assert.rejects(
    () => service.finishBatch({ companyId: "C1", batchPublicId: batch.publicId }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED && /pending/.test(error.message)
  );
});

test("finishBatch 分别落 succeeded / partially_succeeded / failed", async () => {
  const { service, repository } = makeService();

  const allOk = await openBatch(service, "req-ok");
  const i1 = (await service.addItem({ companyId: "C1", batchPublicId: allOk.publicId, sourcePlatform: "ozon", sourceProductId: "1" })).item;
  await service.markItemSucceeded({ companyId: "C1", batchPublicId: allOk.publicId, itemId: i1.id, centralProductId: "CP-1" });
  const okResult = await service.finishBatch({ companyId: "C1", batchPublicId: allOk.publicId });
  assert.equal(okResult.status, COLLECTION_BATCH_STATUS.SUCCEEDED);
  assert.ok(repository.batches.find((batch) => batch.id === allOk.id).finishedAt);

  const mixed = await openBatch(service, "req-mixed");
  const m1 = (await service.addItem({ companyId: "C1", batchPublicId: mixed.publicId, sourcePlatform: "ozon", sourceProductId: "1" })).item;
  const m2 = (await service.addItem({ companyId: "C1", batchPublicId: mixed.publicId, sourcePlatform: "ozon", sourceProductId: "2" })).item;
  await service.markItemSucceeded({ companyId: "C1", batchPublicId: mixed.publicId, itemId: m1.id });
  await service.markItemFailed({ companyId: "C1", batchPublicId: mixed.publicId, itemId: m2.id, errorMessage: "boom" });
  const mixedResult = await service.finishBatch({ companyId: "C1", batchPublicId: mixed.publicId });
  assert.equal(mixedResult.status, COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED);

  const allBad = await openBatch(service, "req-bad");
  const b1 = (await service.addItem({ companyId: "C1", batchPublicId: allBad.publicId, sourcePlatform: "ozon", sourceProductId: "1" })).item;
  await service.markItemFailed({ companyId: "C1", batchPublicId: allBad.publicId, itemId: b1.id, errorMessage: "boom" });
  const badResult = await service.finishBatch({ companyId: "C1", batchPublicId: allBad.publicId });
  assert.equal(badResult.status, COLLECTION_BATCH_STATUS.FAILED);
});

test("空批次收尾为 failed", async () => {
  const { service } = makeService();
  const batch = await openBatch(service);
  const result = await service.finishBatch({ companyId: "C1", batchPublicId: batch.publicId });
  assert.equal(result.status, COLLECTION_BATCH_STATUS.FAILED);
  assert.equal(result.counts.itemCount, 0);
});

test("终态批次拒绝继续追加项目", async () => {
  const { service } = makeService();
  const batch = await openBatch(service);
  const item = (await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "A" })).item;
  await service.markItemSucceeded({ companyId: "C1", batchPublicId: batch.publicId, itemId: item.id });
  await service.finishBatch({ companyId: "C1", batchPublicId: batch.publicId });

  await assert.rejects(
    () => service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "B" }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED && /finished/.test(error.message)
  );
});

test("其它租户看不到批次", async () => {
  const { service } = makeService();
  const batch = await openBatch(service);
  await assert.rejects(
    () => service.getBatchSummary({ companyId: "C2", batchPublicId: batch.publicId }),
    (error) => error.code === ERROR_CODES.VALIDATION_FAILED
  );
});

test("getBatchSummary 返回批次与项目计数", async () => {
  const { service } = makeService();
  const batch = await openBatch(service);
  const item = (await service.addItem({ companyId: "C1", batchPublicId: batch.publicId, sourcePlatform: "ozon", sourceProductId: "A" })).item;
  await service.markItemSucceeded({ companyId: "C1", batchPublicId: batch.publicId, itemId: item.id });

  const summary = await service.getBatchSummary({ companyId: "C1", batchPublicId: batch.publicId });
  assert.equal(summary.batch.publicId, batch.publicId);
  assert.equal(summary.counts.itemCount, 1);
  assert.equal(summary.counts.successCount, 1);
  assert.equal(summary.items.length, 1);
});
