const { normalizeShopCurrency } = require("./yandex-publish-service");
const { normalizeOnlineProductRecord } = require("./publish-normalize");
const { normalizeReviewRule } = require("./settings-normalize");
const { sessionSqlValues, userSqlValues } = require("./sql-identity-store");
const { normalizeCollectionBoxEntry, normalizePublishRecordEntry } = require("./page-stores");
const { tableOwnedKeys } = require("./persistence/store-manifest");

const ONLINE_PRODUCT_SQL_COLUMNS = [
  "id", "shopId", "companyId", "provider", "shopName", "campaignId", "offerId", "shopSku", "name", "vendor", "vendorCode", "marketSku",
  "categoryId", "status", "inventory", "salePrice", "originalPrice", "purchasePriceRmb", "purchasePriceRub", "commissionPercent",
  "packageLengthCm", "packageWidthCm", "packageHeightCm", "weightKg", "sourceType", "sourceNote", "purchaseUrl", "purchaseUrl2", "imageUrl",
  "createdAt", "updatedAt", "payloadJson", "categoryName", "stockCount", "profitRub", "profitRmb", "profitRate", "profitRateDate", "profitRateRubToRmb"
];

const ORDER_PURCHASE_FIELDS = [
  "purchasePlatform",
  "purchaseLink",
  "purchaseOrderNo",
  "purchaseExpressNo",
  "purchaseIntlNo",
  "purchasePriceRmb",
  "purchasePriceRub",
  "purchaseUpdatedAt"
];

const REVIEW_RULE_SQL_COLUMNS = [
  "id",
  "companyId",
  "companyName",
  "name",
  "enabled",
  "priority",
  "shopId",
  "platform",
  "shopSkuKeyword",
  "titleKeyword",
  "commissionPercent",
  "logisticsFeeRub",
  "logisticsFeeRmb",
  "otherFeeRub",
  "otherFeeRmb",
  "notes",
  "createdAt",
  "updatedAt",
  "payloadJson",
  "logisticsPerKgRub",
  "logisticsPerKgRmb",
  "registrationFeeRub",
  "registrationFeeRmb",
  "withdrawFeeRub",
  "withdrawFeeRmb",
  "transferFeeRub",
  "transferFeeRmb",
  "packingFeeRub",
  "packingFeeRmb",
  "withdrawPercent",
  "transferPercent",
  "applyToOrders",
  "applyToOnlineProducts"
];

/**
 * 构造 AppState 快照：序列化内存 db，并剔除所有「有专用表」的实体。
 *
 * 归属必须唯一：专用表实体若同时留在快照里，就会出现两份独立演进的副本
 * （历史上正是它造成「页面 91 条草稿 / 查表 64 条」这类分歧）。
 * 归属清单见 backend/persistence/store-manifest.js（每个实体只能有一个存储归属）。
 * 排查方式：node scripts/persistence-divergence.cjs
 */
function buildAppStateSnapshot(source, serializeDatabase) {
  const snapshot = serializeDatabase(source);
  for (const key of tableOwnedKeys()) delete snapshot[key];
  return snapshot;
}

// Yandex 合法费率目录单行表（模块作用域，供启动期直接建表使用）。
const YANDEX_COMMISSION_CATALOG_DDL = `
  CREATE TABLE IF NOT EXISTS yandex_commission_catalog (
    id VARCHAR(32) NOT NULL PRIMARY KEY,
    payloadJson LONGTEXT NOT NULL,
    updatedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
`;

function createSqlWriters(deps) {
  const { getSqlPool, isSqlReady, getDb, serializeDatabase, stateKey, encryptSecret } = deps;
  let sessionSqlWriteQueue = Promise.resolve();
  /*
   * The queue above serializes the existing full-snapshot strategy. This keeps
   * concurrent fire-and-forget saveDatabase() calls from interleaving DELETE
   * and INSERT transactions; the snapshot semantics remain unchanged.
   */

async function saveShopToSql(shop) {
  if (!isSqlReady() || !getSqlPool() || !shop?.id) return;
  const encryptedKey = String(shop.apiKey || "").trim()
    ? encryptSecret(shop.apiKey)
    : String(shop.apiKeyEncrypted || "").trim();
  await getSqlPool().execute(
    `INSERT INTO shops (id, name, code, enabled, provider, campaignId, businessId, shopCurrency, apiKeyEncrypted, companyName, companyId,
       apiKeyVerified, apiKeyVerifiedAt, apiKeyInvalidatedAt, apiKeyVerificationMessage, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), code=VALUES(code), enabled=VALUES(enabled), provider=VALUES(provider),
       campaignId=VALUES(campaignId), businessId=VALUES(businessId), shopCurrency=VALUES(shopCurrency), apiKeyEncrypted=VALUES(apiKeyEncrypted),
       companyName=VALUES(companyName), companyId=VALUES(companyId), apiKeyVerified=VALUES(apiKeyVerified),
       apiKeyVerifiedAt=VALUES(apiKeyVerifiedAt), apiKeyInvalidatedAt=VALUES(apiKeyInvalidatedAt),
       apiKeyVerificationMessage=VALUES(apiKeyVerificationMessage), updatedAt=VALUES(updatedAt)`,
    [
      String(shop.id), String(shop.name || ""), String(shop.code || ""), shop.enabled ? 1 : 0,
      String(shop.provider || "local"), String(shop.campaignId || ""), String(shop.businessId || ""), normalizeShopCurrency(shop.shopCurrency), encryptedKey,
      String(shop.companyName || ""), String(shop.companyId || ""),
      shop.apiKeyVerified ? 1 : 0, String(shop.apiKeyVerifiedAt || ""), String(shop.apiKeyInvalidatedAt || ""),
      String(shop.apiKeyVerificationMessage || ""),
      shop.createdAt ? new Date(shop.createdAt) : new Date(), shop.updatedAt ? new Date(shop.updatedAt) : new Date()
    ]
  );
}

async function deleteShopFromSql(shopId) {
  if (!isSqlReady() || !getSqlPool()) return;
  await getSqlPool().execute("DELETE FROM shops WHERE id = ?", [String(shopId || "")]);
}

async function saveDatabaseToSql() {
  if (!isSqlReady() || !getSqlPool()) return;
  const snapshot = buildAppStateSnapshot(getDb(), serializeDatabase);
  const serialized = JSON.stringify(snapshot);
  await Promise.resolve(
    getSqlPool().execute(
      `
      INSERT INTO AppState (stateKey, stateJson, updatedAt)
      VALUES (?, ?, CURRENT_TIMESTAMP(6))
      ON DUPLICATE KEY UPDATE
        stateJson = VALUES(stateJson),
        updatedAt = VALUES(updatedAt);
    `,
      [stateKey, serialized]
    )
  );
  await saveUsersToSql(getDb().users || []);
  await saveSessionsToSql(getDb().activeSessions || []);
  await saveShopsToSql(getDb().shops || []);
  await saveReviewRulesToSql(getDb().reviewRules || []);
  await saveOnlineProductsToSql(getDb().onlineProducts || []);
  await saveOrdersToSql(getDb().orders || []);
  await saveYandexCommissionCatalogToSql(getDb().yandexCommissionCatalog || {});
}

// Yandex 合法费率目录是单文档（实测 6MB），整体 upsert 到单行表，避免每次 saveDatabase()
// 都要把它整块写进 AppState 快照。
const YANDEX_COMMISSION_CATALOG_ID = "default";

async function ensureYandexCommissionCatalogTable() {
  if (!isSqlReady() || !getSqlPool()) return false;
  await getSqlPool().query(YANDEX_COMMISSION_CATALOG_DDL);
  return true;
}

async function saveYandexCommissionCatalogToSql(document) {
  if (!isSqlReady() || !getSqlPool()) return;
  const payload = JSON.stringify(document && typeof document === "object" ? document : {});
  await getSqlPool().execute(
    `INSERT INTO yandex_commission_catalog (id, payloadJson, updatedAt)
     VALUES (?, ?, CURRENT_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE payloadJson = VALUES(payloadJson), updatedAt = VALUES(updatedAt)`,
    [YANDEX_COMMISSION_CATALOG_ID, payload]
  );
}

async function loadYandexCommissionCatalogFromSql() {
  if (!isSqlReady() || !getSqlPool()) return null;
  const [rows] = await getSqlPool().query(
    "SELECT payloadJson FROM yandex_commission_catalog WHERE id = ? LIMIT 1",
    [YANDEX_COMMISSION_CATALOG_ID]
  );
  const raw = rows?.[0]?.payloadJson;
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveShopsToSql(shops) {
  for (const shop of Array.isArray(shops) ? shops : []) await saveShopToSql(shop);
}

async function saveReviewRulesToSql(rules) {
  for (const rule of Array.isArray(rules) ? rules : []) await saveReviewRuleToSql(rule);
}

async function saveUsersToSql(users) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(users) ? users : []).filter((user) => String(user?.id || "").trim()).map(userSqlValues);
  if (!rows.length) return;
  await getSqlPool().query(
    `INSERT INTO users (id, username, passwordHash, passwordSalt, role, companyId, companyName, createdAt, shopPermissions, shopAssignments)
     VALUES ? ON DUPLICATE KEY UPDATE username=VALUES(username), passwordHash=VALUES(passwordHash), passwordSalt=VALUES(passwordSalt),
     role=VALUES(role), companyId=VALUES(companyId), companyName=VALUES(companyName), createdAt=VALUES(createdAt),
     shopPermissions=VALUES(shopPermissions), shopAssignments=VALUES(shopAssignments)`,
    [rows]
  );
}

async function deleteUserFromSql(userId) {
  if (!isSqlReady() || !getSqlPool()) return;
  await getSqlPool().execute("DELETE FROM users WHERE id = ?", [String(userId || "")]);
}

async function saveSessionsToSql(activeSessions) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(activeSessions) ? activeSessions : []).filter((session) => String(session?.tokenHash || "").trim()).map(sessionSqlValues);
  sessionSqlWriteQueue = sessionSqlWriteQueue.then(async () => {
    const connection = await getSqlPool().getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM active_sessions");
      if (rows.length) {
        await connection.query("INSERT INTO active_sessions (token, userId, expiresAt, payloadJson) VALUES ?", [rows]);
      }
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch {}
      throw error;
    } finally {
      connection.release();
    }
  });
  await sessionSqlWriteQueue;
}

function hydrateOnlineProductFromSqlRow(row) {
  if (!row || typeof row !== "object") return null;
  let payload = {};
  try {
    payload = row.payloadJson ? JSON.parse(String(row.payloadJson)) : {};
  } catch {}
  const product = { ...(payload && typeof payload === "object" ? payload : {}), ...row };
  delete product.payloadJson;
  normalizeOnlineProductRecord(product);
  return product;
}

function onlineProductSqlValues(product) {
  const item = { ...(product || {}) };
  normalizeOnlineProductRecord(item);
  const now = new Date().toISOString();
  const nonNullTextColumns = new Set([
    "companyId", "provider", "shopName", "campaignId", "offerId", "shopSku", "name",
    "vendor", "vendorCode", "marketSku", "categoryId", "status", "sourceType", "sourceNote",
    "purchaseUrl", "purchaseUrl2", "imageUrl", "categoryName", "profitRateDate"
  ]);
  return ONLINE_PRODUCT_SQL_COLUMNS.map((column) => {
    if (column === "payloadJson") return JSON.stringify(item);
    if (column === "stockCount") {
      if (Number.isFinite(Number(item.stockCount))) return Number(item.stockCount);
      return Number.isFinite(Number(item.inventory)) ? Number(item.inventory) : 0;
    }
    if (column === "inventory") return Number.isFinite(Number(item.inventory)) ? Number(item.inventory) : 0;
    if (column === "createdAt" || column === "updatedAt") return item[column] || now;
    if (nonNullTextColumns.has(column)) return String(item[column] ?? "");
    return item[column] ?? null;
  });
}

async function saveOnlineProductsToSql(products) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(products) ? products : [])
    .filter((product) => String(product?.id || "").trim())
    .map(onlineProductSqlValues);
  const connection = await getSqlPool().getConnection();
  try {
    await connection.beginTransaction();
    // Snapshot semantics like orders: rows removed from memory are deleted here
    // so deleted products do not "resurrect" on the next restart.
    await connection.query("DELETE FROM online_products");
    if (rows.length) {
      const updates = ONLINE_PRODUCT_SQL_COLUMNS
        .filter((column) => column !== "id")
        .map((column) => `${column} = VALUES(${column})`)
        .join(", ");
      await connection.query(
        `INSERT INTO online_products (${ONLINE_PRODUCT_SQL_COLUMNS.join(", ")}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`,
        [rows]
      );
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

async function saveOrdersToSql(orders) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(orders) ? orders : [])
    .map((order) => {
      const id = String(order?.id || order?.shopOrderNo || "").trim();
      if (!id) return null;
      return [
        id,
        String(order?.shopOrderNo || "").trim(),
        String(order?.shopId || "").trim(),
        String(order?.companyId || "").trim(),
        String(order?.status || "").trim(),
        Number.isFinite(Number(order?.amount)) ? Number(order.amount) : 0,
        order?.createdAt ? new Date(order.createdAt) : null,
        order?.updatedAt ? new Date(order.updatedAt) : null,
        JSON.stringify(Object.fromEntries(Object.entries(order).filter(([field]) => !ORDER_PURCHASE_FIELDS.includes(field))))
      ];
    })
    .filter(Boolean);
  const connection = await getSqlPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM orders");
    if (rows.length) {
      await connection.query(
        `INSERT INTO orders (id, shopOrderNo, shopId, companyId, status, amount, createdAt, updatedAt, payloadJson) VALUES ?`,
        [rows]
      );
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

async function saveSingleOrderPurchaseToSql(order) {
  if (!isSqlReady() || !getSqlPool()) return;
  const orderRef = String(order?.shopOrderNo || order?.id || "").trim();
  if (!orderRef) return;
  const hasPurchaseData = ORDER_PURCHASE_FIELDS
    .filter((field) => field !== "purchaseUpdatedAt")
    .some((field) => String(order?.[field] || "").trim() !== "");

  if (!hasPurchaseData) {
    await getSqlPool().execute("DELETE FROM order_purchases WHERE orderRef = ?", [orderRef]);
    return;
  }

  const updatedAt = String(order?.purchaseUpdatedAt || order?.updatedAt || new Date().toISOString()).trim();
  await getSqlPool().execute(
    `INSERT INTO order_purchases (
      orderRef, orderId, shopOrderNo, purchasePlatform, purchaseLink, purchaseOrderNo,
      purchaseExpressNo, purchaseIntlNo, purchasePriceRmb, purchasePriceRub, purchaseUpdatedAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      orderId = VALUES(orderId),
      shopOrderNo = VALUES(shopOrderNo),
      purchasePlatform = VALUES(purchasePlatform),
      purchaseLink = VALUES(purchaseLink),
      purchaseOrderNo = VALUES(purchaseOrderNo),
      purchaseExpressNo = VALUES(purchaseExpressNo),
      purchaseIntlNo = VALUES(purchaseIntlNo),
      purchasePriceRmb = VALUES(purchasePriceRmb),
      purchasePriceRub = VALUES(purchasePriceRub),
      purchaseUpdatedAt = VALUES(purchaseUpdatedAt),
      updatedAt = VALUES(updatedAt)`,
    [
      orderRef,
      String(order?.id || "").trim(),
      String(order?.shopOrderNo || orderRef).trim(),
      String(order?.purchasePlatform || "").trim(),
      String(order?.purchaseLink || "").trim(),
      String(order?.purchaseOrderNo || "").trim(),
      String(order?.purchaseExpressNo || "").trim(),
      String(order?.purchaseIntlNo || "").trim(),
      String(order?.purchasePriceRmb || "").trim(),
      String(order?.purchasePriceRub || "").trim(),
      String(order?.purchaseUpdatedAt || "").trim(),
      updatedAt
    ]
  );
}

function reviewRuleSqlValues(rule) {
  const normalized = normalizeReviewRule(rule);
  return REVIEW_RULE_SQL_COLUMNS.map((column) => {
    if (column === "payloadJson") return JSON.stringify(normalized);
    if (column === "createdAt" || column === "updatedAt") {
      // Pass Date objects so mysql2 serializes a valid DATETIME; an ISO string
      // with a trailing "Z" is rejected by MySQL strict mode.
      const d = new Date(normalized[column]);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return normalized[column];
  });
}

async function saveReviewRuleToSql(rule) {
  if (!isSqlReady() || !getSqlPool()) return;
  const placeholders = REVIEW_RULE_SQL_COLUMNS.map(() => "?").join(", ");
  const updates = REVIEW_RULE_SQL_COLUMNS
    .slice(1)
    .map((column) => `${column} = VALUES(${column})`)
    .join(", ");
  await getSqlPool().execute(
    `INSERT INTO review_rules (${REVIEW_RULE_SQL_COLUMNS.join(", ")}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    reviewRuleSqlValues(rule)
  );
}

async function deleteReviewRuleFromSql(ruleId) {
  if (!isSqlReady() || !getSqlPool()) return;
  await getSqlPool().execute("DELETE FROM review_rules WHERE id = ?", [String(ruleId || "").trim()]);
}

// ---------- 采集箱 / 上架记录：各自独立的表 ----------

const COLLECTION_BOX_SQL_COLUMNS = [
  "id", "source", "sourcePlatform", "sourceProductId", "sourceUrl", "collectBatchId",
  "title", "sku", "imageUrl", "aiImageStatus", "publishStatus", "publishMessage",
  "publishProductId", "shopId", "collectedAt", "createdAt", "updatedAt"
];

const PUBLISH_RECORD_SQL_COLUMNS = [
  "id", "ts", "actorUsername", "result", "statusCode", "message",
  "productId", "sku", "title", "shopId", "shopName", "platform", "publishStatus"
];

// mysql2 只接受 Date 或 "YYYY-MM-DD HH:mm:ss.SSS"，带 Z 的 ISO 字符串会被严格模式拒绝。
function toSqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toIsoText(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function collectionBoxSqlValues(entry) {
  const normalized = normalizeCollectionBoxEntry(entry) || {};
  return COLLECTION_BOX_SQL_COLUMNS.map((column) => {
    if (column === "createdAt" || column === "updatedAt") return toSqlDateTime(normalized[column]);
    return normalized[column] === undefined ? "" : normalized[column];
  });
}

function hydrateCollectionBoxFromSqlRow(row) {
  if (!row) return null;
  return normalizeCollectionBoxEntry({
    id: row.id,
    source: row.source,
    sourcePlatform: row.sourcePlatform,
    sourceProductId: row.sourceProductId,
    sourceUrl: row.sourceUrl,
    collectBatchId: row.collectBatchId,
    title: row.title,
    sku: row.sku,
    imageUrl: row.imageUrl,
    aiImageStatus: row.aiImageStatus,
    publishStatus: row.publishStatus,
    publishMessage: row.publishMessage,
    publishProductId: row.publishProductId,
    shopId: row.shopId,
    collectedAt: row.collectedAt,
    createdAt: toIsoText(row.createdAt),
    updatedAt: toIsoText(row.updatedAt)
  });
}

function publishRecordSqlValues(record) {
  const normalized = normalizePublishRecordEntry(record) || {};
  return PUBLISH_RECORD_SQL_COLUMNS.map((column) => {
    if (column === "ts") return toSqlDateTime(normalized.ts);
    if (column === "statusCode") return Number(normalized.statusCode || 0) || 0;
    return normalized[column] === undefined ? "" : normalized[column];
  });
}

function hydratePublishRecordFromSqlRow(row) {
  if (!row) return null;
  return normalizePublishRecordEntry({
    id: row.id,
    ts: toIsoText(row.ts),
    actorUsername: row.actorUsername,
    result: row.result,
    statusCode: row.statusCode,
    message: row.message,
    productId: row.productId,
    sku: row.sku,
    title: row.title,
    shopId: row.shopId,
    shopName: row.shopName,
    platform: row.platform,
    publishStatus: row.publishStatus
  });
}

// 采集箱：按条目 upsert（同一条采集重复投递就更新那一行）。
async function saveCollectionBoxToSql(entries) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => String(entry?.id || "").trim());
  if (!rows.length) return;
  const placeholders = COLLECTION_BOX_SQL_COLUMNS.map(() => "?").join(", ");
  const updates = COLLECTION_BOX_SQL_COLUMNS.slice(1).map((column) => `${column} = VALUES(${column})`).join(", ");
  const sql = `INSERT INTO collection_box (${COLLECTION_BOX_SQL_COLUMNS.join(", ")}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  for (const entry of rows) {
    await getSqlPool().execute(sql, collectionBoxSqlValues(entry));
  }
}

async function deleteCollectionBoxFromSql(ids) {
  if (!isSqlReady() || !getSqlPool()) return;
  const list = (Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!list.length) return;
  const placeholders = list.map(() => "?").join(", ");
  await getSqlPool().execute(`DELETE FROM collection_box WHERE id IN (${placeholders})`, list);
}

// 上架记录：只追加，不覆盖历史。
async function savePublishRecordsToSql(records) {
  if (!isSqlReady() || !getSqlPool()) return;
  const rows = (Array.isArray(records) ? records : []).filter((record) => String(record?.id || "").trim());
  if (!rows.length) return;
  const placeholders = PUBLISH_RECORD_SQL_COLUMNS.map(() => "?").join(", ");
  const updates = PUBLISH_RECORD_SQL_COLUMNS.slice(1).map((column) => `${column} = VALUES(${column})`).join(", ");
  const sql = `INSERT INTO publish_records (${PUBLISH_RECORD_SQL_COLUMNS.join(", ")}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  for (const record of rows) {
    await getSqlPool().execute(sql, publishRecordSqlValues(record));
  }
}

async function loadPageStoreRowsFromSql() {
  if (!isSqlReady() || !getSqlPool()) return { collectionBox: [], publishRecords: [] };
  const [boxRows] = await getSqlPool().query("SELECT * FROM collection_box ORDER BY collectedAt DESC, createdAt DESC");
  const [recordRows] = await getSqlPool().query("SELECT * FROM publish_records ORDER BY ts DESC");
  return {
    collectionBox: (Array.isArray(boxRows) ? boxRows : []).map(hydrateCollectionBoxFromSqlRow).filter(Boolean),
    publishRecords: (Array.isArray(recordRows) ? recordRows : []).map(hydratePublishRecordFromSqlRow).filter(Boolean)
  };
}

  return {
    saveShopToSql, deleteShopFromSql, saveDatabaseToSql, saveShopsToSql,
    saveReviewRulesToSql, saveUsersToSql, deleteUserFromSql, saveSessionsToSql,
    hydrateOnlineProductFromSqlRow, onlineProductSqlValues, saveOnlineProductsToSql,
    saveOrdersToSql, saveSingleOrderPurchaseToSql, reviewRuleSqlValues,
    saveReviewRuleToSql, deleteReviewRuleFromSql,
    collectionBoxSqlValues, saveCollectionBoxToSql, deleteCollectionBoxFromSql,
    hydrateCollectionBoxFromSqlRow,
    publishRecordSqlValues, savePublishRecordsToSql, hydratePublishRecordFromSqlRow,
    ensureYandexCommissionCatalogTable, saveYandexCommissionCatalogToSql, loadYandexCommissionCatalogFromSql,
    loadPageStoreRowsFromSql
  };
}

module.exports = {
  createSqlWriters,
  buildAppStateSnapshot,
  YANDEX_COMMISSION_CATALOG_DDL,
  ORDER_PURCHASE_FIELDS
};
