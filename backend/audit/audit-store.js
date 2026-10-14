"use strict";
// 审计日志持久化：增量写 audit_logs 表 + 启动 hydrate。
//
// 背景：审计日志曾整块塞在 AppState 快照里（8600+ 条 ≈ 13MB），每次 saveDatabase()
// 都要重写整块快照。这里改成与其它实体一致的「唯一归属」：audit_logs 表是唯一载体，
// 写入走增量 INSERT，不再进快照。表的列结构与历史遗留表一致，可直接复用。
//
// 归属声明见 backend/persistence/store-manifest.js（auditLogs 为 append 模式）。

const AUDIT_TABLE = "audit_logs";
const AUDIT_INSERT_COLUMNS = [
  "id", "ts", "tsDt", "actorUserId", "actorUsername", "actorRole", "ip", "method", "path",
  "actionType", "resourceType", "resourceId", "statusCode", "success", "errorMessage", "warningMessage",
  "queryJson", "requestBodyMaskedJson", "responseBodyMaskedJson"
];

const AUDIT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  ts VARCHAR(64) NOT NULL DEFAULT '',
  tsDt DATETIME(3) NULL,
  actorUserId VARCHAR(64) NOT NULL DEFAULT '',
  actorUsername VARCHAR(64) NOT NULL DEFAULT '',
  actorRole VARCHAR(32) NOT NULL DEFAULT '',
  ip VARCHAR(128) NOT NULL DEFAULT '',
  method VARCHAR(16) NOT NULL DEFAULT '',
  path VARCHAR(512) NOT NULL DEFAULT '',
  actionType VARCHAR(64) NOT NULL DEFAULT '',
  resourceType VARCHAR(64) NOT NULL DEFAULT '',
  resourceId VARCHAR(128) NOT NULL DEFAULT '',
  statusCode INT NOT NULL DEFAULT 0,
  success TINYINT(1) NOT NULL DEFAULT 0,
  errorMessage TEXT,
  warningMessage TEXT,
  queryJson LONGTEXT,
  requestBodyMaskedJson LONGTEXT,
  responseBodyMaskedJson LONGTEXT,
  KEY idx_audit_logs_ts (ts),
  KEY idx_audit_logs_action (actionType),
  KEY idx_audit_logs_success (success)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  const text = String(value);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 内存条目 → 表行（与历史表列一一对应）。
function auditRowValues(entry) {
  const masked = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
  return [
    String(entry?.id || ""),
    String(entry?.ts || ""),
    entry?.ts ? new Date(entry.ts) : null,
    String(entry?.actorUserId || ""),
    String(entry?.actorUsername || ""),
    String(entry?.actorRole || ""),
    String(entry?.ip || ""),
    String(entry?.method || ""),
    String(entry?.path || ""),
    String(entry?.actionType || ""),
    String(entry?.resourceType || ""),
    String(entry?.resourceId || ""),
    Number(entry?.statusCode) || 0,
    entry?.success ? 1 : 0,
    String(entry?.errorMessage || ""),
    String(entry?.warningMessage || ""),
    JSON.stringify(entry?.query ?? {}),
    masked(entry?.requestBodyMasked),
    masked(entry?.responseBodyMasked)
  ];
}

// 表行 → 内存条目（写回内存后 /api/audit-logs、log-checker、采购恢复都用同一形状）。
function rowToAuditEntry(row) {
  if (!row) return null;
  const tsDtIso = row.tsDt instanceof Date ? row.tsDt.toISOString() : String(row.tsDt || "");
  return {
    id: String(row.id || ""),
    ts: String(row.ts || tsDtIso || ""),
    actorUserId: String(row.actorUserId || ""),
    actorUsername: String(row.actorUsername || ""),
    actorRole: String(row.actorRole || ""),
    ip: String(row.ip || ""),
    method: String(row.method || ""),
    path: String(row.path || ""),
    actionType: String(row.actionType || "read"),
    resourceType: String(row.resourceType || "system"),
    resourceId: String(row.resourceId || ""),
    requestBodyMasked: parseJsonColumn(row.requestBodyMaskedJson),
    responseBodyMasked: parseJsonColumn(row.responseBodyMaskedJson),
    statusCode: Number(row.statusCode) || 0,
    success: Boolean(row.success),
    errorMessage: String(row.errorMessage || ""),
    warningMessage: String(row.warningMessage || ""),
    query: parseJsonColumn(row.queryJson) || {}
  };
}

function createAuditStore(deps = {}) {
  const {
    getSqlPool,
    isSqlReady = () => false,
    logError = (message) => console.error(message),
    table = AUDIT_TABLE
  } = deps;

  // 写入串行化：审计是 fire-and-forget，但同一连接池上必须保持顺序，避免乱序落库。
  let writeQueue = Promise.resolve();

  async function ensureTable() {
    if (!isSqlReady() || !getSqlPool()) return false;
    await getSqlPool().query(AUDIT_TABLE_DDL);
    return true;
  }

  function insert(entry) {
    if (!isSqlReady() || !getSqlPool()) return Promise.resolve(false);
    const values = auditRowValues(entry);
    const placeholders = AUDIT_INSERT_COLUMNS.map(() => "?").join(", ");
    writeQueue = writeQueue
      .then(() => getSqlPool().execute(
        `INSERT INTO \`${table}\` (${AUDIT_INSERT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
        values
      ))
      .then(() => true)
      .catch((error) => {
        logError(`Audit log insert failed: ${String(error)}`);
        return false;
      });
    return writeQueue;
  }

  function flush() {
    return writeQueue;
  }

  async function loadRecent(limit = 10000) {
    if (!isSqlReady() || !getSqlPool()) return [];
    const safeLimit = Math.max(1, Math.min(100000, Math.floor(Number(limit) || 10000)));
    const [rows] = await getSqlPool().query(
      `SELECT ${AUDIT_INSERT_COLUMNS.join(", ")} FROM \`${table}\` ORDER BY ts DESC LIMIT ${safeLimit}`
    );
    const entries = (Array.isArray(rows) ? rows : []).map(rowToAuditEntry).filter(Boolean);
    // 查询是倒序取最近 N 条，恢复成时间正序，与内存中 push 的顺序一致。
    return entries.reverse();
  }

  // 把表裁剪到最近 limit 条，避免无限增长（启动时调用一次即可）。
  async function trimTo(limit = 10000) {
    if (!isSqlReady() || !getSqlPool()) return 0;
    const safeLimit = Math.max(1, Math.min(100000, Math.floor(Number(limit) || 10000)));
    const [result] = await getSqlPool().query(
      `DELETE FROM \`${table}\` WHERE id NOT IN (
         SELECT id FROM (SELECT id FROM \`${table}\` ORDER BY ts DESC LIMIT ${safeLimit}) AS keep_rows
       )`
    );
    return Number(result?.affectedRows) || 0;
  }

  return { ensureTable, insert, flush, loadRecent, trimTo, table, AUDIT_TABLE_DDL };
}

module.exports = {
  AUDIT_TABLE,
  AUDIT_TABLE_DDL,
  AUDIT_INSERT_COLUMNS,
  auditRowValues,
  createAuditStore,
  parseJsonColumn,
  rowToAuditEntry
};
