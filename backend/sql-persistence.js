const { normalizeShopCurrency } = require("./yandex-publish-service");
const { normalizeOnlineProductRecord } = require("./publish-normalize");
const { normalizeReviewRule } = require("./settings-normalize");
const { sessionSqlValues, userSqlValues } = require("./sql-identity-store");

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
  const snapshot = serializeDatabase(getDb());
  delete snapshot.orders;
  delete snapshot.orderPurchaseOverrides;
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

  return {
    saveShopToSql, deleteShopFromSql, saveDatabaseToSql, saveShopsToSql,
    saveReviewRulesToSql, saveUsersToSql, deleteUserFromSql, saveSessionsToSql,
    hydrateOnlineProductFromSqlRow, onlineProductSqlValues, saveOnlineProductsToSql,
    saveOrdersToSql, saveSingleOrderPurchaseToSql, reviewRuleSqlValues,
    saveReviewRuleToSql, deleteReviewRuleFromSql
  };
}

module.exports = {
  createSqlWriters,
  ORDER_PURCHASE_FIELDS
};
