"use strict";
// 采集批次表的 MySQL 仓储（collection_batches / collection_items）。
// 契约见 DEVELOPMENT_PRODUCT_PUBLISH_V2.md §6.1；逻辑在 collection/services/collectionBatchService.js。
// 幂等兜底：插入撞唯一约束（ER_DUP_ENTRY）时改为回读已存在行，避免并发重复创建。

function isDuplicateKeyError(error) {
  return String(error?.code || "") === "ER_DUP_ENTRY";
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    companyId: row.company_id,
    source: row.source,
    requestedBy: row.requested_by,
    status: row.status,
    itemCount: Number(row.item_count || 0),
    successCount: Number(row.success_count || 0),
    failedCount: Number(row.failed_count || 0),
    requestNamespace: row.request_namespace,
    requestId: row.request_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

function mapItem(row) {
  if (!row) return null;
  let rawPayload = {};
  try {
    rawPayload = row.raw_payload_json == null ? {} : (typeof row.raw_payload_json === "object" ? row.raw_payload_json : JSON.parse(row.raw_payload_json));
  } catch {
    rawPayload = {};
  }
  return {
    id: row.id,
    collectionBatchId: row.collection_batch_id,
    companyId: row.company_id,
    sourcePlatform: row.source_platform,
    sourceProductId: row.source_product_id,
    rawPayload,
    centralProductId: row.central_product_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class MysqlCollectionRepository {
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

  async findBatchByRequest(companyId, requestNamespace, requestId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM collection_batches WHERE company_id = ? AND request_namespace = ? AND request_id = ? LIMIT 1",
      [companyId, requestNamespace, requestId]
    );
    return mapBatch(rows[0]);
  }

  async findBatchByPublicId(companyId, publicId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM collection_batches WHERE company_id = ? AND public_id = ? LIMIT 1",
      [companyId, publicId]
    );
    return mapBatch(rows[0]);
  }

  async createBatch(batch) {
    try {
      const [result] = await this.executor.execute(
        `INSERT INTO collection_batches
         (public_id, company_id, source, requested_by, status, item_count, success_count, failed_count, request_namespace, request_id, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batch.publicId, batch.companyId, batch.source, batch.requestedBy, batch.status, batch.itemCount || 0,
          batch.successCount || 0, batch.failedCount || 0, batch.requestNamespace, batch.requestId, batch.createdAt, batch.finishedAt || null]
      );
      return { ...batch, id: result.insertId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.findBatchByRequest(batch.companyId, batch.requestNamespace, batch.requestId);
      if (existing) return existing;
      throw error;
    }
  }

  async updateBatch(id, patch) {
    const sets = [];
    const values = [];
    const put = (column, value) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.itemCount !== undefined) put("item_count", patch.itemCount);
    if (patch.successCount !== undefined) put("success_count", patch.successCount);
    if (patch.failedCount !== undefined) put("failed_count", patch.failedCount);
    if (patch.finishedAt !== undefined) put("finished_at", patch.finishedAt);
    if (!sets.length) return this.findBatchById(id);
    values.push(id);
    await this.executor.execute(`UPDATE collection_batches SET ${sets.join(", ")} WHERE id = ?`, values);
    return this.findBatchById(id);
  }

  async updateBatchCounters(id, counters) {
    return this.updateBatch(id, {
      itemCount: counters.itemCount,
      successCount: counters.successCount,
      failedCount: counters.failedCount
    });
  }

  async findBatchById(id) {
    const [rows] = await this.executor.execute("SELECT * FROM collection_batches WHERE id = ? LIMIT 1", [id]);
    return mapBatch(rows[0]);
  }

  async findItem(collectionBatchId, sourcePlatform, sourceProductId) {
    const [rows] = await this.executor.execute(
      `SELECT * FROM collection_items
       WHERE collection_batch_id = ? AND source_platform = ? AND source_product_id = ? LIMIT 1`,
      [collectionBatchId, sourcePlatform, sourceProductId]
    );
    return mapItem(rows[0]);
  }

  async listItems(collectionBatchId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM collection_items WHERE collection_batch_id = ? ORDER BY id ASC",
      [collectionBatchId]
    );
    return rows.map(mapItem);
  }

  async createItem(item) {
    try {
      const [result] = await this.executor.execute(
        `INSERT INTO collection_items
         (collection_batch_id, company_id, source_platform, source_product_id, raw_payload_json, central_product_id, status, error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.collectionBatchId, item.companyId, item.sourcePlatform, item.sourceProductId, JSON.stringify(item.rawPayload || {}),
          item.centralProductId, item.status, item.errorCode, item.errorMessage, item.createdAt, item.updatedAt]
      );
      return { ...item, id: result.insertId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await this.findItem(item.collectionBatchId, item.sourcePlatform, item.sourceProductId);
      if (existing) return existing;
      throw error;
    }
  }

  async updateItem(id, patch) {
    const sets = [];
    const values = [];
    const put = (column, value) => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.centralProductId !== undefined) put("central_product_id", patch.centralProductId);
    if (patch.errorCode !== undefined) put("error_code", patch.errorCode);
    if (patch.errorMessage !== undefined) put("error_message", patch.errorMessage);
    if (patch.updatedAt !== undefined) put("updated_at", patch.updatedAt);
    if (!sets.length) return this.findItemById(id);
    values.push(id);
    await this.executor.execute(`UPDATE collection_items SET ${sets.join(", ")} WHERE id = ?`, values);
    return this.findItemById(id);
  }

  async findItemById(id) {
    const [rows] = await this.executor.execute("SELECT * FROM collection_items WHERE id = ? LIMIT 1", [id]);
    return mapItem(rows[0]);
  }
}

module.exports = {
  MysqlCollectionRepository,
  isDuplicateKeyError,
  mapBatch,
  mapItem
};
