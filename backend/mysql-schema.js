const REQUIRED_TABLE_DDLS = [`CREATE TABLE IF NOT EXISTS yandex_card_quality_latest (
  shopId VARCHAR(128) NOT NULL, offerId VARCHAR(255) NOT NULL, cardStatus VARCHAR(64) NOT NULL DEFAULT '',
  fillRate DECIMAL(6,2) NULL, categoryAverageRating DECIMAL(6,2) NULL,
  payloadJson LONGTEXT NULL, fetchedAt DATETIME(3) NULL, createdAt DATETIME(3) NULL, updatedAt DATETIME(3) NULL,
  PRIMARY KEY (shopId, offerId), KEY idx_yandex_card_quality_latest_shop (shopId),
  KEY idx_yandex_card_quality_latest_rate (fillRate)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS yandex_card_quality_history (
  id BIGINT NOT NULL AUTO_INCREMENT, shopId VARCHAR(128) NOT NULL, offerId VARCHAR(255) NOT NULL,
  snapshotDate VARCHAR(10) NOT NULL DEFAULT '', cardStatus VARCHAR(64) NOT NULL DEFAULT '',
  fillRate DECIMAL(6,2) NULL, categoryAverageRating DECIMAL(6,2) NULL, payloadJson LONGTEXT NULL,
  fetchedAt DATETIME(3) NULL, createdAt DATETIME(3) NULL, updatedAt DATETIME(3) NULL,
  PRIMARY KEY (id), UNIQUE KEY uniq_yandex_card_quality_history (shopId, offerId, snapshotDate),
  KEY idx_yandex_card_quality_history_shop (shopId, snapshotDate)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(128) NOT NULL PRIMARY KEY, username VARCHAR(128) NOT NULL UNIQUE,
  passwordHash VARCHAR(256) NOT NULL, passwordSalt VARCHAR(128) NOT NULL DEFAULT '',
  role VARCHAR(64) NOT NULL DEFAULT '', companyId VARCHAR(128) NOT NULL DEFAULT '',
  companyName VARCHAR(255) NOT NULL DEFAULT '', createdAt VARCHAR(64) NOT NULL DEFAULT '',
  shopPermissions JSON NOT NULL, shopAssignments JSON NOT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS active_sessions (
  token VARCHAR(128) NOT NULL PRIMARY KEY, userId VARCHAR(128) NOT NULL,
  expiresAt BIGINT NOT NULL, payloadJson LONGTEXT NOT NULL,
  KEY idx_active_sessions_user (userId), KEY idx_active_sessions_expires (expiresAt)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS shops (
  id VARCHAR(128) NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL DEFAULT '', code VARCHAR(128) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1, provider VARCHAR(64) NOT NULL DEFAULT 'local', campaignId VARCHAR(128) NOT NULL DEFAULT '',
  businessId VARCHAR(128) NOT NULL DEFAULT '', shopCurrency VARCHAR(8) NOT NULL DEFAULT 'RUR', apiKeyEncrypted TEXT, companyName VARCHAR(255) NOT NULL DEFAULT '',
  companyId VARCHAR(128) NOT NULL DEFAULT '', apiKeyVerified TINYINT(1) NOT NULL DEFAULT 0,
  apiKeyVerifiedAt VARCHAR(64) NOT NULL DEFAULT '', apiKeyInvalidatedAt VARCHAR(64) NOT NULL DEFAULT '',
  apiKeyVerificationMessage TEXT, createdAt DATETIME(6) NULL, updatedAt DATETIME(6) NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS online_products (
  id VARCHAR(128) NOT NULL PRIMARY KEY, shopId VARCHAR(128), companyId VARCHAR(128), provider VARCHAR(64), shopName VARCHAR(255),
  campaignId VARCHAR(128), offerId VARCHAR(255), shopSku VARCHAR(255), name TEXT, vendor VARCHAR(255), vendorCode VARCHAR(255),
  marketSku VARCHAR(255), categoryId VARCHAR(128), status VARCHAR(64), inventory INT, salePrice DECIMAL(18,4),
  originalPrice DECIMAL(18,4), purchasePriceRmb DECIMAL(18,4), purchasePriceRub DECIMAL(18,4), commissionPercent DECIMAL(18,4),
  packageLengthCm DECIMAL(18,4), packageWidthCm DECIMAL(18,4), packageHeightCm DECIMAL(18,4), weightKg DECIMAL(18,4),
  sourceType VARCHAR(128), sourceNote TEXT, purchaseUrl TEXT, purchaseUrl2 TEXT, imageUrl TEXT, createdAt DATETIME(6) NULL,
  updatedAt DATETIME(6) NULL, payloadJson LONGTEXT, categoryName VARCHAR(255), stockCount INT, profitRub DECIMAL(18,4),
  profitRmb DECIMAL(18,4), profitRate DECIMAL(18,4), profitRateDate VARCHAR(64), profitRateRubToRmb DECIMAL(18,8),
  KEY idx_online_products_shop (shopId), KEY idx_online_products_updated (updatedAt)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, `CREATE TABLE IF NOT EXISTS review_rules (
  id VARCHAR(128) NOT NULL PRIMARY KEY, companyId VARCHAR(128), companyName VARCHAR(255), name VARCHAR(255), enabled TINYINT(1),
  priority INT, shopId VARCHAR(128), platform VARCHAR(64), shopSkuKeyword VARCHAR(255), titleKeyword VARCHAR(255),
  commissionPercent DECIMAL(18,4), logisticsFeeRub DECIMAL(18,4), logisticsFeeRmb DECIMAL(18,4), otherFeeRub DECIMAL(18,4),
  otherFeeRmb DECIMAL(18,4), notes TEXT, createdAt DATETIME(6) NULL, updatedAt DATETIME(6) NULL, payloadJson LONGTEXT,
  logisticsPerKgRub DECIMAL(18,4), logisticsPerKgRmb DECIMAL(18,4), registrationFeeRub DECIMAL(18,4), registrationFeeRmb DECIMAL(18,4),
  withdrawFeeRub DECIMAL(18,4), withdrawFeeRmb DECIMAL(18,4), transferFeeRub DECIMAL(18,4), transferFeeRmb DECIMAL(18,4),
  packingFeeRub DECIMAL(18,4), packingFeeRmb DECIMAL(18,4), withdrawPercent DECIMAL(18,4), transferPercent DECIMAL(18,4),
  applyToOrders TINYINT(1), applyToOnlineProducts TINYINT(1), KEY idx_review_rules_priority (priority), KEY idx_review_rules_updated (updatedAt)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`];

const REQUIRED_TABLE_DDL = REQUIRED_TABLE_DDLS.join(";\n");

module.exports = { REQUIRED_TABLE_DDL, REQUIRED_TABLE_DDLS };
