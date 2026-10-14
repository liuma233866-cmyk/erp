"use strict";
// V2 阶段 2：发布批次状态机（publish_batches）。
//
// 契约来自 DEVELOPMENT_PRODUCT_PUBLISH_V2.md §5.1 / §5.3 / §6.7：
//   状态值：created / queued / running / partially_succeeded / succeeded / failed / blocked / cancelled / timed_out
//   - 批次是用户指令的父实体，子流程（publish_jobs）失败不得回滚已成功的商品；
//   - 批次状态由子流程聚合：全部 succeeded 才是 succeeded；有成功也有失败/阻塞是 partially_succeeded；
//     没有任何成功但有阻塞是 blocked；没有任何成功是 failed；
//   - 任意阶段可进入 cancelled / timed_out；
//   - 状态迁移必须由后端集中执行（本模块），前端不得直接改状态字段。

const crypto = require("node:crypto");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");
const { toMysqlDatetime } = require("../core/dateTime");

const PUBLISH_BATCH_STATUS = Object.freeze({
  CREATED: "created",
  QUEUED: "queued",
  RUNNING: "running",
  PARTIALLY_SUCCEEDED: "partially_succeeded",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out"
});

const TERMINAL_PUBLISH_BATCH_STATUSES = new Set([
  PUBLISH_BATCH_STATUS.SUCCEEDED,
  PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED,
  PUBLISH_BATCH_STATUS.FAILED,
  PUBLISH_BATCH_STATUS.CANCELLED,
  PUBLISH_BATCH_STATUS.TIMED_OUT
]);

// blocked 不是终态：解除阻塞后可以回到 running。
const ALLOWED_BATCH_TRANSITIONS = Object.freeze({
  [PUBLISH_BATCH_STATUS.CREATED]: [PUBLISH_BATCH_STATUS.QUEUED, PUBLISH_BATCH_STATUS.RUNNING, PUBLISH_BATCH_STATUS.CANCELLED, PUBLISH_BATCH_STATUS.FAILED],
  [PUBLISH_BATCH_STATUS.QUEUED]: [PUBLISH_BATCH_STATUS.RUNNING, PUBLISH_BATCH_STATUS.CANCELLED, PUBLISH_BATCH_STATUS.FAILED, PUBLISH_BATCH_STATUS.TIMED_OUT, PUBLISH_BATCH_STATUS.BLOCKED],
  [PUBLISH_BATCH_STATUS.RUNNING]: [
    PUBLISH_BATCH_STATUS.SUCCEEDED,
    PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED,
    PUBLISH_BATCH_STATUS.FAILED,
    PUBLISH_BATCH_STATUS.BLOCKED,
    PUBLISH_BATCH_STATUS.CANCELLED,
    PUBLISH_BATCH_STATUS.TIMED_OUT
  ],
  [PUBLISH_BATCH_STATUS.BLOCKED]: [PUBLISH_BATCH_STATUS.RUNNING, PUBLISH_BATCH_STATUS.FAILED, PUBLISH_BATCH_STATUS.CANCELLED, PUBLISH_BATCH_STATUS.TIMED_OUT]
});

function createPublishBatchPublicId(prefix = "PB") {
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

function canTransitionBatch(from, to) {
  const allowed = ALLOWED_BATCH_TRANSITIONS[String(from || "").toLowerCase()];
  if (!allowed) return false;
  return allowed.includes(String(to || "").toLowerCase());
}

// 纯函数：由子流程状态聚合批次状态。jobStatuses 为 publish_jobs.status 列表。
function derivePublishBatchStatus(jobStatuses) {
  const statuses = (Array.isArray(jobStatuses) ? jobStatuses : []).map((status) => String(status || "").toLowerCase());
  if (!statuses.length) return PUBLISH_BATCH_STATUS.FAILED;
  const succeeded = statuses.filter((status) => status === PUBLISH_BATCH_STATUS.SUCCEEDED).length;
  const blocked = statuses.filter((status) => status === PUBLISH_BATCH_STATUS.BLOCKED).length;
  if (succeeded === statuses.length) return PUBLISH_BATCH_STATUS.SUCCEEDED;
  if (succeeded > 0) return PUBLISH_BATCH_STATUS.PARTIALLY_SUCCEEDED;
  if (blocked > 0 && blocked === statuses.length) return PUBLISH_BATCH_STATUS.BLOCKED;
  return PUBLISH_BATCH_STATUS.FAILED;
}

class PublishBatchService {
  constructor({ repository, clock = () => new Date(), publicIdFactory = createPublishBatchPublicId } = {}) {
    if (!repository) throw new TypeError("A publish repository is required");
    this.repository = repository;
    this.clock = clock;
    this.publicIdFactory = publicIdFactory;
  }

  _now() {
    return toMysqlDatetime(this.clock());
  }

  /** 幂等创建：同一 (companyId, requestNamespace, clientRequestId) 只创建一次。 */
  async createBatch({
    companyId,
    requestedBy = null,
    requestedItemCount = 0,
    requestNamespace,
    clientRequestId,
    estimatedCost = 0,
    estimatedSeconds = 0
  } = {}) {
    const tenant = requireCompanyId(companyId);
    const namespace = requireText(requestNamespace, "requestNamespace", 64);
    const idempotencyKey = requireText(clientRequestId, "clientRequestId", 128);
    const count = Math.max(0, Math.floor(Number(requestedItemCount) || 0));
    if (!Number.isFinite(count)) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "requestedItemCount is invalid");

    const existing = await this.repository.findBatchByRequest(tenant, namespace, idempotencyKey);
    if (existing) return { batch: existing, reused: true };

    const now = this._now();
    const batch = await this.repository.createBatch({
      publicId: this.publicIdFactory("PB"),
      companyId: tenant,
      requestedBy: requestedBy === null || requestedBy === undefined ? null : String(requestedBy),
      status: PUBLISH_BATCH_STATUS.CREATED,
      requestedItemCount: count,
      jobCount: 0,
      estimatedCost: Number(estimatedCost) || 0,
      actualCost: 0,
      estimatedSeconds: Math.max(0, Math.floor(Number(estimatedSeconds) || 0)),
      requestNamespace: namespace,
      clientRequestId: idempotencyKey,
      createdAt: now,
      finishedAt: null,
      rowVersion: 0
    });
    return { batch, reused: false };
  }

  async _requireBatch(companyId, batchPublicId) {
    const tenant = requireCompanyId(companyId);
    const publicId = requireText(batchPublicId, "batchPublicId", 40);
    const batch = await this.repository.findBatchByPublicId(tenant, publicId);
    if (!batch) throw new V2Error(ERROR_CODES.VALIDATION_FAILED, "Publish batch not found", { batchPublicId: publicId });
    return batch;
  }

  /**
   * 状态迁移。终态不可再变；非法迁移抛 VALIDATION_FAILED；expectedRowVersion 不匹配抛 ROW_VERSION_CONFLICT。
   */
  async transition({ companyId, batchPublicId, to, expectedRowVersion = null, patch = {} } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const from = String(batch.status || "").toLowerCase();
    const target = String(to || "").toLowerCase();
    if (!Object.values(PUBLISH_BATCH_STATUS).includes(target)) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `Unknown publish batch status: ${to}`);
    }
    if (TERMINAL_PUBLISH_BATCH_STATUSES.has(from)) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `Publish batch is already terminal (${from})`);
    }
    if (!canTransitionBatch(from, target)) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `Illegal publish batch transition ${from} → ${target}`);
    }
    if (expectedRowVersion !== null && Number(expectedRowVersion) !== Number(batch.rowVersion || 0)) {
      throw new V2Error(ERROR_CODES.ROW_VERSION_CONFLICT, "Publish batch was changed by another request");
    }
    const updated = await this.repository.updateBatch(batch.id, {
      status: target,
      rowVersion: Number(batch.rowVersion || 0) + 1,
      updatedAt: this._now(),
      ...(TERMINAL_PUBLISH_BATCH_STATUSES.has(target) ? { finishedAt: this._now() } : {}),
      ...patch
    });
    return { batch: updated, from, to: target };
  }

  /** 由子流程状态聚合收尾：只在 running 时可调用。 */
  async finishBatch({ companyId, batchPublicId, jobStatuses = [], jobCount = null, actualCost = null } = {}) {
    const batch = await this._requireBatch(companyId, batchPublicId);
    const status = derivePublishBatchStatus(jobStatuses);
    const target = String(batch.status || "").toLowerCase() === PUBLISH_BATCH_STATUS.RUNNING
      ? status
      : PUBLISH_BATCH_STATUS.FAILED;
    if (!canTransitionBatch(batch.status, target)) {
      throw new V2Error(ERROR_CODES.VALIDATION_FAILED, `Illegal publish batch transition ${batch.status} → ${target}`);
    }
    const updated = await this.repository.updateBatch(batch.id, {
      status: target,
      jobCount: jobCount === null || jobCount === undefined ? (Array.isArray(jobStatuses) ? jobStatuses.length : 0) : Number(jobCount) || 0,
      ...(actualCost === null || actualCost === undefined ? {} : { actualCost: Number(actualCost) || 0 }),
      rowVersion: Number(batch.rowVersion || 0) + 1,
      updatedAt: this._now(),
      finishedAt: this._now()
    });
    return { batch: updated, status: target, aggregatedFrom: Array.isArray(jobStatuses) ? jobStatuses.length : 0 };
  }
}

module.exports = {
  ALLOWED_BATCH_TRANSITIONS,
  PUBLISH_BATCH_STATUS,
  PublishBatchService,
  TERMINAL_PUBLISH_BATCH_STATUSES,
  canTransitionBatch,
  createPublishBatchPublicId,
  derivePublishBatchStatus
};
