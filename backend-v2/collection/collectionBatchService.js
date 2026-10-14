"use strict";
// V2 阶段 2：采集批次状态机（collection_batches / collection_items）。
//
// 契约来自 DEVELOPMENT_PRODUCT_PUBLISH_V2.md §5.1 / §6.1：
//   批次状态：created → running → succeeded | partially_succeeded | failed
//   项目状态：pending → succeeded | failed | duplicate
//   - 幂等：批次按 (company_id, request_namespace, request_id) 唯一，重复提交返回已有批次；
//   - 批次内幂等：项目按 (batch, source_platform, source_product_id) 唯一，重复投递记为 duplicate；
//   - 聚合规则：只有全部项目 succeeded 才是 succeeded；没有任何 succeeded 且无未决项目是 failed；
//     其余是 partially_succeeded（duplicate 不计成功，但也不会把批次拉成 failed）。
//
// 服务只依赖注入的 repository，本身不碰 MySQL，便于单测；SQL 由 mysqlCollectionRepository 提供。

const crypto = require("node:crypto");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");
const { toMysqlDatetime } = require("../core/dateTime");

const COLLECTION_BATCH_STATUS = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  PARTIALLY_SUCCEEDED: "partially_succeeded",
  FAILED: "failed"
});

const COLLECTION_ITEM_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DUPLICATE: "duplicate"
});

const TERMINAL_BATCH_STATUSES = new Set([
  COLLECTION_BATCH_STATUS.SUCCEEDED,
  COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED,
  COLLECTION_BATCH_STATUS.FAILED
]);

function createCollectionPublicId(prefix = "CB") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new V2Error(ERROR_CODES.TENANT_REQUIRED, "A company tenant is required");
  return value;
}

function requireText(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is required`);
  if (text.length > maxLength) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `${field} is too long`);
  return text;
}

// 纯函数：由项目计数推导批次状态。finishBatch 会先保证没有 pending 项目。
function deriveCollectionBatchStatus({ itemCount, successCount, failedCount }) {
  const total = Math.max(0, Number(itemCount) || 0);
  const success = Math.max(0, Number(successCount) || 0);
  if (total <= 0) return COLLECTION_BATCH_STATUS.FAILED;
  if (success === total) return COLLECTION_BATCH_STATUS.SUCCEEDED;
  if (success === 0) return COLLECTION_BATCH_STATUS.FAILED;
  return COLLECTION_BATCH_STATUS.PARTIALLY_SUCCEEDED;
}

function countItems(items) {
  const counts = { itemCount: 0, successCount: 0, failedCount: 0, pendingCount: 0, duplicateCount: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    counts.itemCount += 1;
    const status = String(item?.status || "").toLowerCase();
    if (status === COLLECTION_ITEM_STATUS.SUCCEEDED) counts.successCount += 1;
    else if (status === COLLECTION_ITEM_STATUS.FAILED) counts.failedCount += 1;
    else if (status === COLLECTION_ITEM_STATUS.DUPLICATE) counts.duplicateCount += 1;
    else counts.pendingCount += 1;
  }
  return counts;
}

class CollectionBatchService {
  constructor({ repository, clock = () => new Date(), publicIdFactory = createCollectionPublicId } = {}) {
    if (!repository) throw new TypeError("A collection repository is required");
    this.repository = repository;
    this.clock = clock;
    this.publicIdFactory = publicIdFactory;
  }

  _now() {
    return toMysqlDatetime(this.clock());
  }

  /**
   * 打开（或复用）采集批次。同一 (companyId, requestNamespace, requestId) 重复调用只创建一次。
   */
  async openBatch({ companyId, source, requestedBy = null, requestNamespace, requestId } = {}) {
    const tenant = requireCompanyId(companyId);
    const sourceName = requireText(source, "source", 64);
    const namespace = requireText(requestNamespace, "requestNamespace", 64);
    const idempotencyKey = requireText(requestId, "requestId", 128);

    const existing = await this.repository.findBatchByRequest(tenant, namespace, idempotencyKey);
    if (existing) return { batch: existing, reused: true };

    const now = this._now();
    const batch = await this.repository.createBatch({
      publicId: this.publicIdFactory("CB"),
      companyId: tenant,
      source: sourceName,
      requestedBy: requestedBy === null || requestedBy === undefined ? null : String(requestedBy),
      status: COLLECTION_BATCH_STATUS.CREATED,
      itemCount: 0,
      successCount: 0,
      failedCount: 0,
      requestNamespace: namespace,
      requestId: idempotencyKey,
      createdAt: now,
      finishedAt: null
    });
    return { batch, reused: false };
  }

  async _requireBatch(companyId, batchPublicId) {
    const tenant = requireCompanyId(companyId);
    const publicId = requireText(batchPublicId, "batchPublicId", 40);
    const batch = await this.repository.findBatchByPublicId(tenant, publicId);
    if (!batch) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection batch not found", { batchPublicId: publicId });
    if (TERMINAL_BATCH_STATUSES.has(String(batch.status || "").toLowerCase())) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection batch is already finished", { status: batch.status });
    }
    return batch;
  }

  /**
   * 追加一个采集项目。批次内重复的 (sourcePlatform, sourceProductId) 记为 duplicate，不新增行。
   */
  async addItem({ companyId, batchPublicId, sourcePlatform, sourceProductId, rawPayload = {} } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const platform = requireText(sourcePlatform, "sourcePlatform", 32).toLowerCase();
    const productId = requireText(sourceProductId, "sourceProductId", 255);

    const existingItem = await this.repository.findItem(batch.id, platform, productId);
    if (existingItem) {
      if (String(existingItem.status || "").toLowerCase() === COLLECTION_ITEM_STATUS.PENDING) {
        const updated = await this.repository.updateItem(existingItem.id, {
          status: COLLECTION_ITEM_STATUS.DUPLICATE,
          updatedAt: this._now()
        });
        return { item: updated || { ...existingItem, status: COLLECTION_ITEM_STATUS.DUPLICATE }, duplicate: true };
      }
      return { item: existingItem, duplicate: true };
    }

    const now = this._now();
    const item = await this.repository.createItem({
      collectionBatchId: batch.id,
      companyId: batch.companyId,
      sourcePlatform: platform,
      sourceProductId: productId,
      rawPayload: rawPayload && typeof rawPayload === "object" ? rawPayload : {},
      centralProductId: null,
      status: COLLECTION_ITEM_STATUS.PENDING,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    });

    if (String(batch.status || "").toLowerCase() === COLLECTION_BATCH_STATUS.CREATED) {
      await this.repository.updateBatch(batch.id, { status: COLLECTION_BATCH_STATUS.RUNNING });
    }
    await this.repository.updateBatchCounters(batch.id, { itemCount: Number(batch.itemCount || 0) + 1 });
    return { item, duplicate: false };
  }

  async _resolveItem(batch, itemId) {
    const id = String(itemId || "").trim();
    if (!id) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "itemId is required");
    const items = await this.repository.listItems(batch.id);
    const item = (items || []).find((entry) => String(entry.id) === id);
    if (!item) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection item not found", { itemId: id });
    return item;
  }

  async _recount(batchId) {
    const counts = countItems(await this.repository.listItems(batchId));
    await this.repository.updateBatchCounters(batchId, counts);
    return counts;
  }

  async markItemSucceeded({ companyId, batchPublicId, itemId, centralProductId = null } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const item = await this._resolveItem(batch, itemId);
    const updated = await this.repository.updateItem(item.id, {
      status: COLLECTION_ITEM_STATUS.SUCCEEDED,
      centralProductId: centralProductId === null || centralProductId === undefined ? null : String(centralProductId),
      errorCode: null,
      errorMessage: null,
      updatedAt: this._now()
    });
    const counts = await this._recount(batch.id);
    return { item: updated, counts };
  }

  async markItemFailed({ companyId, batchPublicId, itemId, errorCode = null, errorMessage = "" } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const item = await this._resolveItem(batch, itemId);
    const updated = await this.repository.updateItem(item.id, {
      status: COLLECTION_ITEM_STATUS.FAILED,
      errorCode: errorCode === null || errorCode === undefined ? null : String(errorCode).slice(0, 64),
      errorMessage: String(errorMessage || ""),
      updatedAt: this._now()
    });
    const counts = await this._recount(batch.id);
    return { item: updated, counts };
  }

  /**
   * 收尾批次：要求没有 pending 项目，然后按聚合规则落终态。
   */
  async finishBatch({ companyId, batchPublicId } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const counts = countItems(await this.repository.listItems(batch.id));
    if (counts.pendingCount > 0) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection batch still has pending items", {
        pendingCount: counts.pendingCount
      });
    }
    const status = deriveCollectionBatchStatus(counts);
    const updated = await this.repository.updateBatch(batch.id, {
      status,
      itemCount: counts.itemCount,
      successCount: counts.successCount,
      failedCount: counts.failedCount,
      finishedAt: this._now()
    });
    return { batch: updated, counts, status };
  }

  async getBatchSummary({ companyId, batchPublicId } = {}) {
    const tenant = requireCompanyId(companyId);
    const publicId = requireText(batchPublicId, "batchPublicId", 40);
    const batch = await this.repository.findBatchByPublicId(tenant, publicId);
    if (!batch) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Collection batch not found", { batchPublicId: publicId });
    const items = await this.repository.listItems(batch.id);
    return { batch, counts: countItems(items), items };
  }
}

module.exports = {
  COLLECTION_BATCH_STATUS,
  COLLECTION_ITEM_STATUS,
  TERMINAL_BATCH_STATUSES,
  CollectionBatchService,
  countItems,
  createCollectionPublicId,
  deriveCollectionBatchStatus
};
