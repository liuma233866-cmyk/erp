"use strict";
// 发布批次与刊登占用的 MySQL 仓储（publish_batches / publish_claims）。
// 契约见 DEVELOPMENT_PRODUCT_PUBLISH_V2.md §6.7 / §12.4。
// 注意：publish_batches 没有 updated_at 列，更新字段必须白名单化，不能把服务的 patch 直接展开。

function isDuplicateKeyError(error) {
  return String(error?.code || "") === "ER_DUP_ENTRY";
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    companyId: row.company_id,
    requestedBy: row.requested_by,
    status: row.status,
    requestedItemCount: Number(row.requested_item_count || 0),
    jobCount: Number(row.job_count || 0),
    estimatedCost: Number(row.estimated_cost || 0),
    actualCost: Number(row.actual_cost || 0),
    estimatedSeconds: Number(row.estimated_seconds || 0),
    requestNamespace: row.request_namespace,
    clientRequestId: row.client_request_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    rowVersion: Number(row.row_version || 0)
  };
}

function mapClaim(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    platform: row.platform,
    shopId: row.shop_id,
    businessKey: row.business_key,
    publishJobId: row.publish_job_id,
    status: row.status,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class MysqlPublishRepository {
  constructor({ pool }) {
    if (!pool) throw new TypeError("A MySQL pool is required");
    this.pool = pool;
    this.executor = pool;
  }

  async transaction(work) {
    const connection = await this.pool.getConnection();
    const previous = this.executor;
    this.executor = connection;
    try {
      await connection.beginTransaction();
      const result = await work(this);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* ignore */ }
      throw error;
    } finally {
      this.executor = previous;
      connection.release();
    }
  }

  async findBatchByRequest(companyId, requestNamespace, clientRequestId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM publish_batches WHERE company_id = ? AND request_namespace = ? AND client_request_id = ? LIMIT 1",
      [companyId, requestNamespace, clientRequestId]
    );
    return mapBatch(rows[0]);
  }

  async findBatchByPublicId(companyId, publicId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM publish_batches WHERE company_id = ? AND public_id = ? LIMIT 1",
      [companyId, publicId]
    );
    return mapBatch(rows[0]);
  }

  async findBatchById(id) {
    const [rows] = await this.executor.execute("SELECT * FROM publish_batches WHERE id = ? LIMIT 1", [id]);
    return mapBatch(rows[0]);
  }

  async createBatch(batch) {
    try {
      const [result] = await this.executor.execute(
        `INSERT INTO publish_batches
         (public_id, company_id, requested_by, status, requested_item_count, job_count, estimated_cost, actual_cost,
          estimated_seconds, request_namespace, client_request_id, created_at, finished_at, row_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batch.publicId, batch.companyId, batch.requestedBy, batch.status, batch.requestedItemCount || 0, batch.jobCount || 0,
          batch.estimatedCost || 0, batch.actualCost || 0, batch.estimatedSeconds || 0, batch.requestNamespace,
          batch.clientRequestId, batch.createdAt, batch.finishedAt || null, batch.rowVersion || 0]
      );
      return { ...batch, id: result.insertId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.findBatchByRequest(batch.companyId, batch.requestNamespace, batch.clientRequestId);
      if (existing) return existing;
      throw error;
    }
  }

  async updateBatch(id, patch) {
    const sets = [];
    const values = [];
    const put = (column, value) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.jobCount !== undefined) put("job_count", patch.jobCount);
    if (patch.actualCost !== undefined) put("actual_cost", patch.actualCost);
    if (patch.estimatedCost !== undefined) put("estimated_cost", patch.estimatedCost);
    if (patch.estimatedSeconds !== undefined) put("estimated_seconds", patch.estimatedSeconds);
    if (patch.finishedAt !== undefined) put("finished_at", patch.finishedAt);
    if (patch.rowVersion !== undefined) put("row_version", patch.rowVersion);
    if (!sets.length) return this.findBatchById(id);
    values.push(id);
    await this.executor.execute(`UPDATE publish_batches SET ${sets.join(", ")} WHERE id = ?`, values);
    return this.findBatchById(id);
  }

  async findClaim(companyId, platform, shopId, businessKey) {
    const [rows] = await this.executor.execute(
      `SELECT * FROM publish_claims
       WHERE company_id = ? AND platform = ? AND shop_id = ? AND business_key = ? LIMIT 1`,
      [companyId, platform, shopId, businessKey]
    );
    return mapClaim(rows[0]);
  }

  async findClaimById(id) {
    const [rows] = await this.executor.execute("SELECT * FROM publish_claims WHERE id = ? LIMIT 1", [id]);
    return mapClaim(rows[0]);
  }

  async createClaim(claim) {
    try {
      const [result] = await this.executor.execute(
        `INSERT INTO publish_claims
         (company_id, platform, shop_id, business_key, publish_job_id, status, lease_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [claim.companyId, claim.platform, claim.shopId, claim.businessKey, claim.publishJobId, claim.status,
          claim.leaseUntil, claim.createdAt, claim.updatedAt]
      );
      return { ...claim, id: result.insertId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.findClaim(claim.companyId, claim.platform, claim.shopId, claim.businessKey);
      if (existing) return existing;
      throw error;
    }
  }

  async updateClaim(id, patch) {
    const sets = [];
    const values = [];
    const put = (column, value) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.publishJobId !== undefined) put("publish_job_id", patch.publishJobId);
    if (patch.leaseUntil !== undefined) put("lease_until", patch.leaseUntil);
    if (patch.updatedAt !== undefined) put("updated_at", patch.updatedAt);
    if (!sets.length) return this.findClaimById(id);
    values.push(id);
    await this.executor.execute(`UPDATE publish_claims SET ${sets.join(", ")} WHERE id = ?`, values);
    return this.findClaimById(id);
  }

  // 恢复流程用：只取租约已到期的 held 占用。
  async listExpiredHeldClaims(nowDatetime, limit = 200) {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
    const [rows] = await this.executor.execute(
      `SELECT * FROM publish_claims
       WHERE status = 'held' AND lease_until IS NOT NULL AND lease_until <= ?
       ORDER BY lease_until ASC LIMIT ${safeLimit}`,
      [nowDatetime]
    );
    return rows.map(mapClaim);
  }
}

module.exports = {
  MysqlPublishRepository,
  isDuplicateKeyError,
  mapBatch,
  mapClaim
};
