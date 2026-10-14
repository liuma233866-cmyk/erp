const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { URL } = require("url");;
const { createAiConfigModule } = require("./ai-config");;
const { createAiMainModule } = require("./ai-main");;
const { createAiImageTasksModule } = require("./ai-image-tasks");;
const { createAiImagePromptsModule } = require("./ai-image-prompts");;
const { publishOzonProducts } = require("./ozon-publish");;
const { fetchOzonFbsOrders, mapOzonPostingToLocal } = require("./ozon-orders");;
const { mapOnlineProductToYandexPayload, normalizeShopCurrency, publishYandexProducts } = require("./yandex-publish-service");;
const { copyOnlineProductsToPublishDrafts } = require("./online-product-publish-copy");;
const { createCopyAiImageTasks } = require("./copy-ai-image-tasks");;
const { prepareCopyProductsWithCurrency } = require("./publish-copy-currency");;
const { isExchangeRateFresh, normalizeCopyOptions } = require("./product-copy-options");;
const { convertPublishPricesToCurrency } = require("./rub-to-cny-publish-prices");;
const { MysqlCentralCatalogRepository } = require("../backend-v2/central/mysqlCatalogRepository");;
const { CentralCatalogService } = require("../backend-v2/central/catalogService");;
const { applyHistoricalRevenueFallback } = require("./order-pricing");;
;
const { backfillOrderProductMatches } = require("./order-product-matcher");;
const { buildOrderV2Summary, isOrderV2Eligible, normalizeOrderV2 } = require("./orders-v2");;
const { buildOrderSummary } = require("./order-summary");;
const { buildRequestedOrderSyncPlan, normalizeOrderSyncOptions } = require("./order-sync-routing");;
const { getShopOrderWorkspace, normalizeOrderWorkspace, orderBelongsToWorkspace } = require("./shop-order-workspace");;
const { resolveInitialDatabase } = require("./database-bootstrap");;
const { REQUIRED_TABLE_DDLS } = require("./mysql-schema");;
const { hydratePayloadRow } = require("./sql-identity-store");;
;
const { buildStableOrderId, getOrderUniqueKey, isDedicatedAdminUser, isValidOrderStatus, makeId, normalizeCompanyId, normalizeCompanyName, parseBooleanPermission, sameCompanyEntity } = require("./identity");;
;
const { normalizePartnerTokenInput } = require("./yandex-http");;
const { buildCommissionKeywords, buildZhCategoryFromRuEn, normalizeCategoryLevelsWithDash, parseYandexLegalCommissionCatalogFromHtml } = require("./yandex-category-text");;
const { findMatchingReviewRule, normalizeNullableNumber, normalizePublishSettings, normalizeReviewRule } = require("./settings-normalize");;
const { buildSessionCookie, fetchJson, getBearerToken, parseJsonBody, parseRawBody, sendJson, serveStaticFile, setApiCorsHeaders } = require("./http-utils");;
const { withFetchTimeout } = require("./http-timeout");;
const { applyOrderPurchaseOverrides, backfillOrderAmounts, backfillOrderPurchaseFields, buildOrderPurchaseOverridesFromRows, buildOrderPurchasePayload, dedupeOrders, findOrderByRef, findOrderIndexByRef, hasTextValue, inferHistoricalOrderRevenue, restorePurchaseFromAuditLogs } = require("./order-backfill");;
const { buildDeliveryServiceMap, collectYandexOfferIds, enrichYandexOfferMapWithOnlineProducts, extractYandexOrderId, extractYandexTracking, firstItemSku, mapYandexOfferEntryToProduct, mapYandexOrderToLocal, normalizeItemCount } = require("./yandex-orders-map");;
const { attachShopIdsToOnlineProducts, attachShopIdsToOrders, filterOnlineProductsByAssignments, filterOrdersByAssignments, canUserAccessShop, getUserAssignedShopIds, normalizeShopAssignments, resolvePublishPlatformFromShopId, resolvePublishTargetShopId, resolveScopedDraftShopId } = require("./shop-scope");;
const { buildPublishProductKey, expandPublishProductToYandexPayloads, getPublishProductAttributeTerms, getPublishProductCategoryId, isLockedPublishProduct, normalizeOnlineProductRecord, normalizePublishProductRecord, validatePublishProductForYandex } = require("./publish-normalize");;
const { filterAuditLogs, filterOrders, hasFilterQuery } = require("./order-filters");;
const { YANDEX_LEGAL_RATE_URL_RU, YANDEX_LEGAL_RATE_URL_ZH, normalizeProductCategoryKnowledge, normalizeYandexCommissionCatalog } = require("./catalog-normalize");;
const { fetchAllYandexOfferCards, fetchYandexCampaign, fetchYandexCategoryIndex, fetchYandexDeliveryServices, fetchYandexOfferCards, fetchYandexOfferMappings, fetchYandexOfferMappingsPaged, fetchYandexOrderDetail, fetchYandexOrderLabels, fetchYandexOrders } = require("./yandex-fetch");;
const { buildLogCheckerReport, extractFreshLogEntries, formatAuditWarnings, readRecentLocalErrorTail, sanitizeAuditLogForClient, sanitizeProductPublishAuditPayload } = require("./log-checker");;
const { upsertCollectionBoxEntry, applyPublishOutcome, listCollectionBox, listPublishRecords } = require("./page-stores");;
const { createAuthService } = require("./auth-service");;
const { createSqlWriters, YANDEX_COMMISSION_CATALOG_DDL } = require("./sql-persistence");;
const { createOrderSyncService } = require("./orders/order-sync");
const { createPublishService } = require("./publish/publish-service");
const { createReportingService } = require("./reporting/reporting-service");
const { createAuditStore, AUDIT_TABLE_DDL } = require("./audit/audit-store");
const { createRatesRoutes } = require("./routes/rates");;
const { createAuditRoutes } = require("./routes/audit");;
const { createMessagesRoutes } = require("./routes/messages");;
const { createUsersRoutes } = require("./routes/users");;
const { createShopsRoutes } = require("./routes/shops");;
const { createReviewRulesRoutes } = require("./routes/review-rules");;
const { createCategoryMappingRoutes } = require("./routes/category-mapping");;
const { createSystemCategoryRoutes } = require("./routes/system-categories");
const { createUploadRoutes } = require("./routes/uploads");
const { createPdevLinkRoutes } = require("./routes/pdev-links");
const { createCommissionRoutes } = require("./routes/commission");;
const { createYandexQualityRoutes } = require("./routes/yandex-quality");;
const { createYandexCategoryParamsRoutes } = require("./routes/yandex-category-params");;
const { createOnlineProductsRoutes } = require("./routes/online-products");;
const { createPublishRoutes } = require("./routes/publish");;
const { createOrdersRoutes } = require("./routes/orders");;
const { createAuthRoutes } = require("./routes/auth");;
const { createAiRoutes } = require("./routes/ai");;
const { createMarketCommissionRoutes } = require("./routes/market-commissions");;
const { createCollectorRoutes } = require("./routes/collector");;
const { createCollectionBoxRoutes } = require("./routes/collection-box");;
const { createPublishRecordsRoutes } = require("./routes/publish-records");;
const { createPdevRepository } = require("./product-dev/pdev-repository");;
const { createPdevService } = require("./product-dev/pdev-service");;
const { createPdevRoutes } = require("./product-dev/pdev-routes");;
const { ensurePdevTables } = require("./product-dev/pdev-schema");;
const { buildOnlineProductKey, calculateYandexOnlineProductFees } = require("./yandex-tariffs");;
const { enrichYandexItemsWithParameterValues, fetchYandexCategoryParameters } = require("./yandex-parameter-values");;
const {
  createPasswordHash,
  generateBootstrapPassword,
  hashPassword,
  hashSessionToken,
  maskSensitive,
  rotateInsecureDefaultAdmins: rotateInsecureDefaultAdminsPure,
  validateAppSecretKey,
  validateCredentials,
  validateLoginCredentials,
  verifyPassword: verifyPasswordPure
} = require("./security");;
const { resolveClientIp } = require("./network-safety");;
const { ENC_PREFIX, deriveAppKey: deriveAppKeyFromSecret, decryptSecret: decryptSecretWithKey, encryptSecret: encryptSecretWithKey } = require("./crypto");;
const { computeOrderProfit, deriveRates } = require("./order-profit");;
const {
  ALL_ROLES,
  ROLE_ADMIN,
  ROLE_FINANCE,
  ROLE_OPERATIONS,
  ROLE_SUPERVISOR,
  ROLE_SUPPORT,
  getEffectiveShopPermissions: getEffectiveShopPermissionsPure,
  getRoleShopPermissionDefaults,
  isShopRestrictedRole,
  normalizeRole: normalizeRolePure,
  normalizeShopPermissions
} = require("./permissions");;
const { checkRateLimit, pruneRateLimitBuckets } = require("./rate-limit");;
const { paginateItems, readPositiveIntParam, validateNonEmptyString } = require("./pagination");;
const { validateOptionalExternalHttpUrl } = require("./url-safety");;
;
const {
  readCardQualityByOffers,
  readCardQualityTrend,
  readStoredCardQuality,
  saveCardQualitySnapshot,
  trimCardQualityHistory
} = require("./card-quality-store");;
const {
  normalizeCategoryParameters: normalizeCategoryParametersPure,
  summarizeValidation: summarizeCategoryValidationPure,
  validateProductAgainstParameters: validateProductAgainstParametersPure
} = require("./yandex-category-parameters");;
let PDFLib = null;
let mysql = null;
let XLSX = null;

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (error) {
    console.error(`Failed to load env file ${filePath}:`, error);
  }
}

loadEnvFile(path.resolve(__dirname, "..", ".env"));

try {
  PDFLib = require("pdf-lib");
} catch {
  PDFLib = null;
}

try {
  mysql = require("mysql2/promise");
} catch {
  mysql = null;
}

try {
  XLSX = require("xlsx");
} catch {
  XLSX = null;
}

function ignoreBrokenPipe(stream) {
  if (!stream || typeof stream.on !== "function") return;
  stream.on("error", (error) => {
    if (String(error?.code || "") === "EPIPE") return;
    throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
// 【task-25】登录有效期（会话 token TTL）改为可配置：AUTH_TOKEN_TTL_HOURS（单位：小时）。
//   未配置 / 空 / 非法 / 负数 / NaN → 一律回落 2 小时（与改动前行为完全一致），且不抛异常。
//   这里算出的 TOKEN_TTL_MS 是**唯一来源**：登录接口既用它算 token 过期时间，也用它算 Cookie 的
//   Max-Age（routes/auth.js 里 Math.floor(TOKEN_TTL_MS / 1000)），代码里不再有写死的秒数。
const AUTH_TOKEN_TTL_HOURS_DEFAULT = 2;
const AUTH_TOKEN_TTL_HOURS = (function (raw) {
  const parsed = Number(String(raw === undefined || raw === null ? "" : raw).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AUTH_TOKEN_TTL_HOURS_DEFAULT;
})(process.env.AUTH_TOKEN_TTL_HOURS);
const TOKEN_TTL_MS = Math.round(AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000);
const BACKEND_DIR = __dirname;
const APP_ROOT = path.resolve(BACKEND_DIR, "..");
const DATA_DIR = path.resolve(APP_ROOT, String(process.env.DATA_DIR || APP_ROOT));
const LOG_DIR = path.resolve(APP_ROOT, String(process.env.LOG_DIR || APP_ROOT));
const APP_LOG_FILE = path.join(LOG_DIR, "server.out.log");
const APP_ERROR_LOG_FILE = path.join(LOG_DIR, "server.err.log");
const YANDEX_MARKET_BASE_URL = process.env.YANDEX_MARKET_BASE_URL || "https://api.partner.market.yandex.ru";
// 刊登编排域已拆到 backend/publish/publish-service.js：这里只做依赖注入与别名，
// 保持 routes/publish.js 使用的 executeProductPublish / executeOzonProductPublish 名称不变。
const publishService = createPublishService({
  getDb: () => db,
  saveDatabase: () => saveDatabase(),
  isSqlReady: () => sqlReady,
  getSqlPool: () => sqlPool,
  logError,
  normalizePublishSettings,
  validatePublishProductForYandex,
  expandPublishProductToYandexPayloads,
  resolvePublishTargetShopId,
  publishYandexProducts,
  publishOzonProducts,
  enrichYandexItemsWithParameterValues,
  fetchYandexOfferCards,
  readCardQualityByOffers,
  yandexMarketBaseUrl: YANDEX_MARKET_BASE_URL
});
const executeProductPublish = publishService.executeProductPublish;
const executeOzonProductPublish = publishService.executeOzonProductPublish;
const OPENAI_API_BASE_URL = "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CBR_DAILY_JSON_URL = "https://www.cbr-xml-daily.com/daily_json.js";
const AUDIT_MAX_RECORDS = 10000;
const REGISTER_DEFAULT_ROLE = "support";
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || "dev-insecure-secret-change-me";
// Trust X-Forwarded-For only when a reverse proxy overwrites it (TRUST_PROXY=1).
// When untrusted, rate limiting uses the raw socket address so clients cannot
// spoof an arbitrary IP to bypass login/API rate limits.
const TRUST_PROXY = String(process.env.TRUST_PROXY || "0").trim() === "1";
if (!validateAppSecretKey(APP_SECRET_KEY).ok) {
  console.error("[FATAL] APP_SECRET_KEY is missing, too short, or uses a public placeholder. Set a unique random secret in .env (e.g. `openssl rand -hex 32`) before starting.");
  process.exit(1);
}
const MYSQL_HOST = String(process.env.MYSQL_HOST || "").trim();
const MYSQL_DATABASE = String(process.env.MYSQL_DATABASE || "").trim();
const MYSQL_USER = String(process.env.MYSQL_USER || "").trim();
const MYSQL_PASSWORD_FILE = String(process.env.MYSQL_PASSWORD_FILE || "").trim();
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const SQL_STATE_KEY = "app_state_v1";
const LEGACY_PASSWORD_SALT = "order-admin-salt";
const ORDER_SYNC_DAILY_TIME = String(process.env.ORDER_SYNC_DAILY_TIME || "06:00").trim();
const ORDER_SYNC_ENABLED = String(process.env.ORDER_SYNC_ENABLED || "1").trim() !== "0";
const PRODUCT_CATEGORY_MATCH_MIN_CONFIDENCE = Math.max(0.2, Math.min(0.95, Number(process.env.PRODUCT_CATEGORY_MATCH_MIN_CONFIDENCE || 0.5) || 0.5));
const PRODUCT_CATEGORY_FORCE_ASSIGN_ON_LOW_CONFIDENCE = String(process.env.PRODUCT_CATEGORY_FORCE_ASSIGN_ON_LOW_CONFIDENCE || "0").trim() !== "0";
const YANDEX_ENABLE_DEPRECATED_SUGGESTIONS = String(process.env.YANDEX_ENABLE_DEPRECATED_SUGGESTIONS || "0").trim() === "1";
const LOGIN_RATE_LIMIT_WINDOW_MS = Math.max(60 * 1000, Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000) || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX = Math.max(3, Number(process.env.LOGIN_RATE_LIMIT_MAX || 10) || 10);
const API_RATE_LIMIT_WINDOW_MS = Math.max(10 * 1000, Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000) || 60 * 1000);
const API_RATE_LIMIT_MAX = Math.max(60, Number(process.env.API_RATE_LIMIT_MAX || 600) || 600);
const CURRENCY_RATE_MAX_AGE_DAYS = Math.max(0, Number(process.env.CURRENCY_RATE_MAX_AGE_DAYS || 3) || 3);
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || "admin").trim() || "admin";
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || "").trim();
const CENTRAL_CATALOG_ENABLED = String(process.env.CENTRAL_CATALOG_ENABLED || "1").trim() !== "0";

let db;
let bootstrapAdminNotice = null;
let sqlPool = null;
let sqlReady = false;
const sqlWriters = createSqlWriters({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  getDb: () => db,
  serializeDatabase,
  encryptSecret,
  stateKey: SQL_STATE_KEY
});
let centralCatalogService = null;
let sqlOrdersTableWasEmpty = false;
let sqlPurchaseTableWasEmpty = false;
// 审计日志已改增量写 audit_logs 表，不再进 AppState 快照（归属由 backend/persistence/store-manifest.js 声明）。
const auditStore = createAuditStore({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  logError
});
// 报表/费率/审计洞察域已拆到 backend/reporting/reporting-service.js。
const reportingService = createReportingService({
  getDb: () => db,
  isSqlReady: () => sqlReady,
  getSqlPool: () => sqlPool,
  sqlWriters,
  logError,
  fetchJson,
  normalizeNullableNumber,
  isExchangeRateFresh,
  findMatchingReviewRule,
  computeOrderProfit,
  deriveRates,
  cbrDailyJsonUrl: CBR_DAILY_JSON_URL,
  currencyRateMaxAgeDays: CURRENCY_RATE_MAX_AGE_DAYS
});
const getRecentAuditIssues = reportingService.getRecentAuditIssues;
const refreshOrderProfitSnapshots = reportingService.refreshOrderProfitSnapshots;
const fetchCbrRate = reportingService.fetchCbrRate;
const fetchStoredCbrRate = reportingService.fetchStoredCbrRate;
const fetchRubPurchaseCostRate = reportingService.fetchRubPurchaseCostRate;
const mapCbrRate = reportingService.mapCbrRate;
// 订单同步域已拆到 backend/orders/order-sync.js：这里只做依赖注入与状态别名，
// 保持 routes/orders.js 与 /health 使用的 syncOrdersForShops / orderSyncState 名称不变。
const orderSyncService = createOrderSyncService({
  getDb: () => db,
  saveDatabase: () => saveDatabase(),
  logInfo,
  logError,
  fetchOzonFbsOrders,
  mapOzonPostingToLocal,
  fetchYandexOrders,
  fetchYandexOrderDetail,
  extractYandexOrderId,
  collectYandexOfferIds,
  fetchYandexOfferMappings,
  enrichYandexOfferMapWithOnlineProducts,
  mapYandexOrderToLocal,
  backfillOrderProductMatches,
  backfillOrderPurchaseFields,
  hasTextValue,
  applyHistoricalRevenueFallback,
  inferHistoricalOrderRevenue,
  getOrderUniqueKey,
  dedupeOrders,
  applyOrderPurchaseOverrides,
  config: {
    enabled: ORDER_SYNC_ENABLED,
    dailyTime: ORDER_SYNC_DAILY_TIME,
    detailConcurrency: Number(process.env.YANDEX_ORDER_DETAIL_CONCURRENCY || 5)
  }
});
const orderSyncState = orderSyncService.state;
const syncOrdersForShops = orderSyncService.syncOrdersForShops;
let databaseWriteQueue = Promise.resolve();
const loginRateBuckets = new Map();
const apiRateBuckets = new Map();

function ensureDirExists(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function readMysqlPassword() {
  if (MYSQL_PASSWORD_FILE) {
    const passwordPath = path.resolve(APP_ROOT, MYSQL_PASSWORD_FILE);
    if (fs.existsSync(passwordPath)) {
      return String(fs.readFileSync(passwordPath, "utf8")).replace(/\r?\n$/, "");
    }
  }
  return String(process.env.MYSQL_PASSWORD || "").trim();
}

function getCentralCatalogService() {
  if (!CENTRAL_CATALOG_ENABLED || !sqlReady || !sqlPool) return null;
  if (!centralCatalogService) centralCatalogService = new CentralCatalogService({ repository: new MysqlCentralCatalogRepository({ pool: sqlPool }) });
  return centralCatalogService;
}

function isCentralCatalogUnavailable(error) {
  const message = String(error?.message || error || "");
  return /(?:doesn't exist|does not exist|unknown table|table .* not found|central_products|central_product_sources)/i.test(message);
}

async function ingestCollectorProductIntoCentral(item, companyId) {
  const service = getCentralCatalogService();
  if (!service) return { ok: false, skipped: true, status: "unavailable", message: "中央产品库未挂载或未启用" };
  const sourcePlatform = String(item?.sourcePlatform || "").trim().toLowerCase();
  const sourceProductId = String(item?.sourceProductId || item?.sku || "").trim();
  const canonicalSku = String(item?.sku || item?.vendorCode || sourceProductId).trim();
  try {
    const result = await service.ingestCollectedItem({
      companyId: String(companyId || "system").trim() || "system",
      sourcePlatform,
      sourceProductId,
      sourceUrl: item.sourceUrl || item.collectUrl || null,
      canonicalSku,
      title: item.title || item.name,
      description: item.description || "",
      brand: item.brand || item.vendor || "",
      categoryId: item.categoryId || item.ozonCategoryId || "",
      purchasePrice: item.purchasePriceRmb ?? item.purchasePrice ?? null,
      currency: "CNY",
      packageLengthCm: item.packageLengthCm ?? null,
      packageWidthCm: item.packageWidthCm ?? null,
      packageHeightCm: item.packageHeightCm ?? null,
      weightKg: item.weightKg ?? null,
      stockCount: item.stockCount ?? 0,
      status: "collected",
      rawPayload: item,
      variants: Array.isArray(item.variants) ? item.variants.map((variant) => ({
        systemSku: String(variant?.sku || variant?.offerId || "").trim() || canonicalSku,
        attributes: variant?.attributes || {},
        stockCount: variant?.stockCount ?? item.stockCount ?? 0
      })) : []
    });
    return { ok: true, status: result.kind || "created", centralProductId: result.centralProductId || result.product?.publicId || "", result };
  } catch (error) {
    if (isCentralCatalogUnavailable(error)) return { ok: false, skipped: true, status: "unavailable", message: "中央产品库表尚未迁移，已回退刊登草稿" };
    return { ok: false, skipped: false, status: "failed", message: "中央产品库写入失败" };
  }
}

ensureDirExists(DATA_DIR);
ensureDirExists(LOG_DIR);

function appendRuntimeLog(targetFile, message) {
  try {
    const maxBytes = 5 * 1024 * 1024;
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > maxBytes) {
      const rotated = `${targetFile}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch {}
      try { fs.renameSync(targetFile, rotated); } catch {}
    }
    fs.appendFileSync(targetFile, `${new Date().toISOString()} ${message}${os.EOL}`);
  } catch {}
}

function logInfo(message) {
  console.log(message);
  appendRuntimeLog(APP_LOG_FILE, message);
}

function logError(message) {
  console.error(message);
  appendRuntimeLog(APP_ERROR_LOG_FILE, message);
}

function writeBootstrapAdminNotice(notice) {
  let target = path.join(DATA_DIR, "bootstrap-admin-credentials.txt");
  if (fs.existsSync(target)) target = path.join(DATA_DIR, `bootstrap-admin-credentials-${Date.now()}.txt`);
  fs.writeFileSync(target, `${notice}${os.EOL}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  logInfo(`Bootstrap administrator credentials were rotated; one-time credentials were written to ${target}.`);
  bootstrapAdminNotice = null;
}

function isAddressInUseError(error) {
  return String(error?.code || "").trim() === "EADDRINUSE";
}

process.on("uncaughtException", (error) => {
  if (isAddressInUseError(error)) {
    logInfo(`Server not started: ${HOST}:${PORT} is already in use`);
    process.exit(1);
    return;
  }
  logError(`uncaughtException: ${String(error?.stack || error)}`);
});

process.on("unhandledRejection", (reason) => {
  logError(`unhandledRejection: ${String(reason?.stack || reason)}`);
});

const authService = createAuthService({
  getDb: () => db,
  saveDatabase,
  toPublicUser,
  respondApi
});
const ratesRoutes = createRatesRoutes({
  authService,
  respondApi,
  fetchCbrRate,
  fetchRubPurchaseCostRate
});
const auditRoutes = createAuditRoutes({
  authService,
  respondApi,
  getDb: () => db,
  filterAuditLogs,
  sanitizeAuditLogForClient,
  paginateItems,
  buildLogCheckerReport,
  getRecentAuditIssues
});
const onlineProductsRoutes = createOnlineProductsRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  getUserAssignedShopIds,
  filterOnlineProductsByAssignments,
  canUserAccessShop,
  fetchYandexOfferMappings,
  fetchYandexOfferMappingsPaged,
  mapYandexOfferEntryToProduct,
  buildOnlineProductKey,
  normalizeOnlineProductRecord,
  attachShopIdsToOnlineProducts,
  validateOptionalExternalHttpUrl,
  publishYandexProducts,
  mapOnlineProductToYandexPayload,
  enrichYandexItemsWithParameterValues,
  XLSX,
  writeAudit,
  YANDEX_MARKET_BASE_URL,
});
const yandexCategoryParamsRoutes = createYandexCategoryParamsRoutes({
  authService,
  respondApi,
  getDb: () => db,
  canUserAccessShop,
  fetchYandexCategoryParameters,
  normalizeCategoryParametersPure,
  getPublishProductCategoryId,
  validateProductAgainstParametersPure,
  getPublishProductAttributeTerms,
  summarizeCategoryValidationPure,
});
const yandexQualityRoutes = createYandexQualityRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  canUserAccessShop,
  readPositiveIntParam,
  readStoredCardQuality,
  readCardQualityTrend,
  readCardQualityByOffers,
  fetchAllYandexOfferCards,
  saveCardQualitySnapshot,
  trimCardQualityHistory,
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
});
const commissionRoutes = createCommissionRoutes({
  authService,
  respondApi,
  getDb: () => db,
  normalizeYandexCommissionCatalog,
  readPositiveIntParam,
  syncYandexCommissionCatalogFromOnlineProducts,
});
const categoryMappingRoutes = createCategoryMappingRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  normalizeProductCategoryKnowledge,
  getUserAssignedShopIds,
  resolveScopedDraftShopId,
  makeId,
});
const systemCategoryRoutes = createSystemCategoryRoutes({
  // 注意：这里必须【惰性引用】——getSqlPool 在文件后面才声明，顶层裸引用会 TDZ 导致整个文件加载失败
  getSqlPool: () => sqlPool,
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  normalizeProductCategoryKnowledge,
  getUserAssignedShopIds,
  resolveScopedDraftShopId,
  makeId,
})
const uploadRoutes = createUploadRoutes({ authService, respondApi, parseJsonBody })
const pdevLinkRoutes = createPdevLinkRoutes({ authService, respondApi, parseJsonBody, getSqlPool: () => sqlPool });;;
const reviewRulesRoutes = createReviewRulesRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  getUserAssignedShopIds,
  normalizeRole,
  ROLE_ADMIN,
  sameCompanyEntity,
  normalizeReviewRule,
  resolveScopedDraftShopId,
  makeId,
  normalizeCompanyId,
  normalizeCompanyName,
  sqlWriters,
});
const shopsRoutes = createShopsRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  makeId,
  ROLE_ADMIN,
  normalizeCompanyName,
  normalizeCompanyId,
  sameCompanyEntity,
  normalizePartnerTokenInput,
  fetchYandexCampaign,
  encryptSecret,
  normalizeShopCurrency,
  sqlWriters,
  normalizeOrderWorkspace,
  getShopOrderWorkspace,
  crypto,
  paginateItems,
});
const usersRoutes = createUsersRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  paginateItems,
  toPublicUser,
  makeId,
  ROLE_ADMIN,
  ROLE_SUPERVISOR,
  ALL_ROLES,
  REGISTER_DEFAULT_ROLE,
  normalizeCompanyName,
  normalizeCompanyId,
  sameCompanyEntity,
  resolveCompanyIdByName,
  validateCredentials,
  createPasswordHash,
  getRoleShopPermissionDefaults,
  isShopRestrictedRole,
  getEffectiveShopPermissions,
  parseBooleanPermission,
  normalizeShopAssignments,
  isDedicatedAdminUser,
  sqlWriters,
});
const messagesRoutes = createMessagesRoutes({
  authService,
  respondApi,
  getDb: () => db,
  paginateItems,
  parseJsonBody,
  maskSensitive,
  validateNonEmptyString,
  makeId,
  saveDatabase
});
const aiConfigModule = createAiConfigModule({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  getDataDir: () => DATA_DIR,
  makeId,
  encryptSecret,
  decryptSecret,
  checkPermission: authService.checkPermission,
  requireAuth: authService.requireAuth,
  respondApi,
  parseJsonBody
});

const aiMainModule = createAiMainModule({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  getDataDir: () => DATA_DIR,
  decryptSecret,
  checkPermission: authService.checkPermission,
  requireAuth: authService.requireAuth,
  respondApi,
  parseJsonBody
});

async function syncAiImageTaskResultToProduct(task, outcome) {
  const productId = String(task?.productId || task?.sourceId || "").trim();
  const item = (db?.publishProducts || []).find((candidate) => String(candidate?.id || "").trim() === productId);
  if (!item) return { changed: false };
  let taskMetadata = {};
  try { taskMetadata = JSON.parse(String(task?.metadataJson || "{}")); } catch {}
  const variantSku = String(taskMetadata?.variantSku || "").trim();
  const targetVariant = variantSku && Array.isArray(item.variants)
    ? item.variants.find((variant) => String(variant?.sku || "").trim() === variantSku)
    : null;
  const now = new Date().toISOString();
  if (outcome === "succeeded") {
    const resultImageUrl = String(task?.resultImageUrl || "").trim();
    if (!resultImageUrl) throw new Error("AI 图任务成功但没有结果图片地址");
    const imageTarget = targetVariant || item;
    const alreadySynchronized = String(imageTarget.imageUrl || "").trim() === resultImageUrl
      && String(imageTarget.aiImageStatus || item.aiImageStatus || "").trim() === "succeeded"
      && String(item.publishStatus || "").trim() !== "blocked";
    if (alreadySynchronized) return { changed: false };
    const replacedImageUrl = String(task?.sourceImageUrl || imageTarget.imageUrl || "").trim();
    const originalImages = Array.isArray(imageTarget.imageUrls) ? imageTarget.imageUrls : Array.isArray(imageTarget.images) ? imageTarget.images : Array.isArray(imageTarget.pictures) ? imageTarget.pictures : [];
    const retainedImages = originalImages
      .map((value) => typeof value === "string" ? value : String(value?.url || ""))
      .filter((value) => value && value !== resultImageUrl && value !== imageTarget.imageUrl && value !== replacedImageUrl);
    imageTarget.imageUrl = resultImageUrl;
    imageTarget.imageUrls = [resultImageUrl, ...retainedImages];
    imageTarget.images = imageTarget.imageUrls;
    imageTarget.pictures = imageTarget.imageUrls.slice();
    imageTarget.aiImageStatus = "succeeded";
    item.aiImageStatus = "succeeded";
    item.aiTaskId = String(task.id || item.aiTaskId || "").trim();
    item.aiTaskCode = item.aiTaskId;
    item.aiProcessedAt = now;
    item.aiImageError = "";
    if (item.publishStatus === "blocked") {
      item.publishStatus = "draft";
      item.publishResultMessage = "";
    }
  } else {
    if (targetVariant) {
      targetVariant.aiImageStatus = "failed";
      targetVariant.aiImageError = String(task?.errorMessage || "AI 图片处理失败").trim();
    }
    item.aiImageStatus = "failed";
    item.aiTaskId = String(task?.id || item.aiTaskId || "").trim();
    item.aiTaskCode = item.aiTaskId;
    item.aiImageError = String(task?.errorMessage || "AI 图片处理失败").trim();
    item.publishStatus = "blocked";
    item.publishResultMessage = `AI 图片处理失败：${item.aiImageError}`;
  }
  item.updatedAt = now;
  writeAudit(
    { method: "SYSTEM", url: `/internal/product-publish/${encodeURIComponent(productId)}/ai-image`, headers: { host: "localhost" }, socket: {} },
    { id: "system", username: "AI图片任务", role: "system" },
    {
      actionType: "ai_image",
      resourceType: "product_publish",
      resourceId: productId,
      requestBodyMasked: { taskId: String(task?.id || ""), sourceImageUrl: String(task?.sourceImageUrl || "") },
      responseBodyMasked: outcome === "succeeded"
        ? { status: "succeeded", resultImageUrl: String(task?.resultImageUrl || "") }
        : { status: "failed", errorMessage: item.aiImageError }
    },
    outcome === "succeeded" ? 200 : 422,
    outcome === "succeeded" ? { message: "AI 图片生成成功" } : { message: item.aiImageError }
  );
  await saveDatabase();
  return { changed: true };
}

function buildAiImageTaskCode(product) {
  const sku = String(product?.systemSku || product?.sku || product?.sourceProductId || "product").trim();
  const visibleSku = sku
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "product";
  const scope = [product?.sourcePlatform, product?.shopId, product?.sourceProductId, sku]
    .map((value) => String(value || "").trim())
    .join("|");
  const suffix = crypto.createHash("sha1").update(scope).digest("hex").slice(0, 10).toUpperCase();
  return `AIT-${visibleSku}-${suffix}`;
}

const aiImagePromptsModule = createAiImagePromptsModule({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  getDataDir: () => DATA_DIR,
  makeId,
  checkPermission: authService.checkPermission,
  requireAuth: authService.requireAuth,
  respondApi,
  parseJsonBody
});

const aiImageTasksModule = createAiImageTasksModule({
  getSqlPool: () => sqlPool,
  isSqlReady: () => sqlReady,
  getDataDir: () => DATA_DIR,
  makeId,
  checkPermission: authService.checkPermission,
  requireAuth: authService.requireAuth,
  respondApi,
  parseJsonBody,
  getMysqlPassword: readMysqlPassword,
  runImageTask: (task, reportEvent) => aiMainModule.runImageTask(task, reportEvent),
  resolvePromptForModel: (companyId, modelId) => aiImagePromptsModule.getDefaultPrompt(companyId, modelId),
  onTaskSucceeded: (task) => syncAiImageTaskResultToProduct(task, "succeeded"),
  onTaskFailed: (task) => syncAiImageTaskResultToProduct(task, "failed")
});

const collectorRoutes = createCollectorRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  normalizePublishProductRecord,
  makeId,
  buildAiImageTaskCode,
  aiImageTasksModule,
  aiImagePromptsModule,
  ingestCollectorProductIntoCentral,
  normalizePublishSettings,
  executeOzonProductPublish,
  CENTRAL_CATALOG_ENABLED,
  ROLE_ADMIN,
  saveDatabase,
  upsertCollectionBoxEntry,
  listCollectionBox,
  persistCollectionBoxEntries,
});
const marketCommissionRoutes = createMarketCommissionRoutes({
  authService,
  respondApi,
  getDb: () => db,
  readPositiveIntParam,
  normalizeYandexCommissionCatalog,
  parseJsonBody,
  maskSensitive,
  syncYandexCommissionCatalogFromOnlineProducts,
  saveDatabase,
});
const collectionBoxRoutes = createCollectionBoxRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  saveDatabase,
  writeAudit,
  getUserAssignedShopIds,
  canUserAccessShop,
  paginateItems,
  readPositiveIntParam,
  listCollectionBox,
  deleteCollectionBoxEntries
});
const publishRecordsRoutes = createPublishRecordsRoutes({
  authService,
  respondApi,
  getDb: () => db,
  getUserAssignedShopIds,
  canUserAccessShop,
  paginateItems,
  readPositiveIntParam,
  listPublishRecords
});
const productDevService = createPdevService({ repository: createPdevRepository({ getPool: () => sqlPool }) });
const productDevRoutes = createPdevRoutes({ pdevService: productDevService, authService, respondApi, parseJsonBody, maskSensitive, getDb: () => db, sanitizeAuditLogForClient, auditStore });
const aiRoutes = createAiRoutes({
  aiConfigModule,
  aiImagePromptsModule,
  aiImageTasksModule,
  aiMainModule,
});
const authRoutes = createAuthRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  maskSensitive,
  checkRateLimit,
  loginRateBuckets,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LOGIN_RATE_LIMIT_MAX,
  validateLoginCredentials,
  verifyPassword,
  hashPassword,
  LEGACY_PASSWORD_SALT,
  createPasswordHash,
  saveDatabase,
  crypto,
  TOKEN_TTL_MS,
  buildSessionCookie,
  toPublicUser,
  getBearerToken,
  normalizeCompanyName,
  normalizeCompanyId,
  getEffectiveShopPermissions,
  normalizeShopAssignments,
  hashSessionToken,
});
const ordersRoutes = createOrdersRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  parseRawBody,
  maskSensitive,
  saveDatabase,
  writeAudit,
  XLSX,
  getUserAssignedShopIds,
  filterOrdersByAssignments,
  orderBelongsToWorkspace,
  filterOrders,
  paginateItems,
  hasFilterQuery,
  normalizeOrderSyncOptions,
  buildRequestedOrderSyncPlan,
  syncOrdersForShops,
  orderSyncState: orderSyncState,
  validateNonEmptyString,
  isValidOrderStatus,
  makeId,
  getShopOrderWorkspace,
  isOrderV2Eligible,
  normalizeOrderV2,
  buildOrderV2Summary,
  buildOrderSummary,
  findOrderIndexByRef,
  findOrderByRef,
  canUserAccessShop,
  findShopForOrder,
  ROLE_ADMIN,
  ROLE_OPERATIONS,
  ROLE_SUPERVISOR,
  ROLE_FINANCE,
  ROLE_SUPPORT,
  buildOrderPurchasePayload,
  upsertOrderPurchaseOverride,
  sqlWriters,
  fetchYandexOrderLabels,
  fetchYandexOrderDetail,
  fetchYandexDeliveryServices,
  buildDeliveryServiceMap,
  extractYandexTracking,
  PDFLib,
  findMatchingReviewRule,
  normalizeNullableNumber,
  readPositiveIntParam,
});
const publishRoutes = createPublishRoutes({
  authService,
  respondApi,
  getDb: () => db,
  parseJsonBody,
  parseRawBody,
  maskSensitive,
  saveDatabase,
  writeAudit,
  XLSX,
  normalizeRole,
  ROLE_ADMIN,
  buildPublishProductKey,
  resolveScopedDraftShopId,
  normalizePublishProductRecord,
  resolvePublishPlatformFromShopId,
  isLockedPublishProduct,
  makeId,
  normalizePublishSettings,
  normalizeCopyOptions,
  prepareCopyProductsWithCurrency,
  fetchStoredCbrRate,
  copyOnlineProductsToPublishDrafts,
  convertPublishPricesToCurrency,
  aiImagePromptsModule,
  aiImageTasksModule,
  createCopyAiImageTasks,
  buildAiImageTaskCode,
  canUserAccessShop,
  getUserAssignedShopIds,
  normalizeShopCurrency,
  sanitizeAuditLogForClient,
  executeProductPublish,
  executeOzonProductPublish,
  publishOzonProducts,
  recordPublishOutcome,
});

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/health" || pathname === "/ready") {
      let mysqlHealthy = false;
      if (sqlReady && sqlPool) {
        try { await sqlPool.query("SELECT 1"); mysqlHealthy = true; } catch {}
      }
      sendJson(res, 200, {
        ok: mysqlHealthy,
        status: mysqlHealthy ? "ok" : "degraded",
        time: new Date().toISOString(),
        host: HOST,
        port: PORT,
        storage: "mysql",
        sqlReady,
        mysqlHealthy,
        orderSyncRunning: orderSyncState.running
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStaticFile(res, pathname);
  } catch (error) {
    const message = String(error?.message || "");
    let statusCode = Number(error?.statusCode) || 500;
    if (!Number.isFinite(statusCode) || statusCode < 100) statusCode = 500;
    if (statusCode === 500 && message === "Invalid JSON") statusCode = 400;
    if (statusCode === 500 && message === "Body too large") statusCode = 413;
    if (statusCode >= 500) {
      logError(`request_error ${req.method || "GET"} ${req.url || "/"} -> ${statusCode}: ${String(error?.stack || error)}`);
      sendJson(res, statusCode, { message: "Internal server error" });
      return;
    }
    sendJson(res, statusCode, { message: message || "Bad request" });
  }
}

const server = http.createServer(handleRequest);

// Initializes the shared runtime state (database, SQL persistence, modules,
// sessions) without binding a port. Exposed so tests can run against an
// isolated database.
async function initializeAppRuntime(options = {}) {
  db = options.database || createRuntimeDatabase();
  await initSqlPersistence();
  // 采集箱 / 上架记录 有自己的表（collection_box / publish_records），
  // 启动时从表里读，不读 AppState 快照，也不导入任何历史数据。
  try {
    const pageStoreRows = await sqlWriters.loadPageStoreRowsFromSql();
    db.collectionBox = pageStoreRows.collectionBox;
    db.publishRecords = pageStoreRows.publishRecords;
  } catch (error) {
    logError(`Loading collection box / publish records failed: ${String(error)}`);
    db.collectionBox = [];
    db.publishRecords = [];
  }
  rotateInsecureDefaultAdmins(db);
  await aiConfigModule.initialize();
  await aiImagePromptsModule.initialize();
  await aiImageTasksModule.initialize();
  authService.hydrateSessionsFromDatabase();
}

// Returns the request handler for the current runtime state. Used by tests to
// serve the app on an ephemeral port.
function createApp(options = {}) {
  if (options.database) db = options.database;
  return handleRequest;
}

async function closeAppRuntime() {
  if (sqlPool) {
    try { await sqlPool.end(); } catch {}
    sqlPool = null;
  }
  sqlReady = false;
}

// 限流 bucket 每 10 分钟清理一次过期条目，避免长期运行内存增长。
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let rateLimitCleanupTimer = null;

function startRateLimitCleanup() {
  if (rateLimitCleanupTimer) return;
  rateLimitCleanupTimer = setInterval(() => {
    try {
      pruneRateLimitBuckets(loginRateBuckets, LOGIN_RATE_LIMIT_WINDOW_MS);
      pruneRateLimitBuckets(apiRateBuckets, API_RATE_LIMIT_WINDOW_MS);
    } catch (error) {
      logError(`Rate limit cleanup failed: ${String(error)}`);
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
  if (typeof rateLimitCleanupTimer.unref === "function") rateLimitCleanupTimer.unref();
}

let shutdownInProgress = false;

// 优雅关闭：停止接收新请求 → 等写入队列落库 → 关闭连接池。
// 强制退出定时器兜底，避免残留 keep-alive 连接把进程吊住。
async function shutdownGracefully(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  logInfo(`Received ${signal}, shutting down...`);
  const forceExit = setTimeout(() => {
    logError("Shutdown timed out, forcing exit.");
    process.exit(1);
  }, 5000);
  if (typeof forceExit.unref === "function") forceExit.unref();
  orderSyncService.clearScheduler();
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
  try {
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  } catch (error) {
    logError(`Closing HTTP server failed: ${String(error)}`);
  }
  try {
    await databaseWriteQueue;
  } catch (error) {
    logError(`Flushing database writes failed: ${String(error)}`);
  }
  await closeAppRuntime();
  clearTimeout(forceExit);
  logInfo("Shutdown complete.");
  process.exit(0);
}

async function startServer() {
  await initializeAppRuntime();
  orderSyncService.startScheduler();
  startRateLimitCleanup();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      logInfo(`Server running at http://${HOST}:${PORT}`);
      logInfo(`Data dir: ${DATA_DIR}`);
      logInfo(`Log dir: ${LOG_DIR}`);
      if (bootstrapAdminNotice) writeBootstrapAdminNotice(bootstrapAdminNotice);
      resolve();
    });
  }).catch((error) => {
    if (isAddressInUseError(error)) {
      logInfo(`Server not started: ${HOST}:${PORT} is already in use`);
      process.exit(1);
      return;
    }
    throw error;
  });
}

async function handleApi(req, res, url) {
  setApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = url.pathname;
  const clientIp = readClientIp(req);
  const apiRateResult = checkRateLimit(apiRateBuckets, `${clientIp}:api`, API_RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX);
  if (!apiRateResult.ok) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((apiRateResult.retryAfterMs || API_RATE_LIMIT_WINDOW_MS) / 1000))));
    sendJson(res, 429, { message: "Too many requests, please try again later" });
    return;
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const auditBase = {
    actionType: "read",
    resourceType: "system",
    resourceId: "",
    query,
    requestBodyMasked: null
  };

  for (const route of ratesRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of auditRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of messagesRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }

  for (const route of usersRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of shopsRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of reviewRulesRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of categoryMappingRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }

for (const route of systemCategoryRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
for (const route of uploadRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
for (const route of pdevLinkRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname);
      return;
    }
  }
  for (const route of commissionRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  for (const route of yandexQualityRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  for (const route of yandexCategoryParamsRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  for (const route of onlineProductsRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  for (const route of publishRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  for (const route of ordersRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }






  for (const route of authRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      return;
    }
  }










  for (const route of aiRoutes) {
    if (route.matches(pathname, req.method)) {
      const handled = await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      if (handled) return;
    }
  }





















  for (const route of marketCommissionRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      return;
    }
  }




























  for (const route of collectorRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      return;
    }
  }
  for (const route of collectionBoxRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      return;
    }
  }
  for (const route of publishRecordsRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url, clientIp);
      return;
    }
  }
  for (const route of productDevRoutes) {
    if (route.matches(pathname, req.method)) {
      await route.handler(req, res, query, auditBase, pathname, url);
      return;
    }
  }
  respondApi(req, res, null, { ...auditBase, resourceType: "system" }, 404, { message: "Not found" });
}

function respondApi(req, res, actorUser, auditMeta, statusCode, payload) {
  sendJson(res, statusCode, payload);
  writeAudit(req, actorUser, auditMeta, statusCode, payload);
}


// 采集箱 / 上架记录 都写进自己的表；AppState 快照里不再放这两个集合。
function persistCollectionBoxEntries(entries) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!rows.length) return Promise.resolve();
  return Promise.resolve()
    .then(() => sqlWriters.saveCollectionBoxToSql(rows))
    .catch((error) => logError(`Saving collection box failed: ${String(error)}`));
}

function deleteCollectionBoxEntries(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => String(id || "").trim()).filter(Boolean);
  if (!list.length) return Promise.resolve();
  return Promise.resolve()
    .then(() => sqlWriters.deleteCollectionBoxFromSql(list))
    .catch((error) => logError(`Deleting collection box rows failed: ${String(error)}`));
}

function persistPublishRecords(records) {
  const rows = (Array.isArray(records) ? records : []).filter(Boolean);
  if (!rows.length) return Promise.resolve();
  return Promise.resolve()
    .then(() => sqlWriters.savePublishRecordsToSql(rows))
    .catch((error) => logError(`Saving publish records failed: ${String(error)}`));
}

// 上架动作发生时，把结果写进「上架记录」自己的表，并同步采集箱条目的上架状态。
// 这两个页面只读写自己的数据，不依赖审计日志和刊登池是否还有商品。
function recordPublishOutcome(actorUser, items, options) {
  const outcome = applyPublishOutcome(db, actorUser, items, options);
  if (outcome.recorded) {
    persistPublishRecords(outcome.records);
    persistCollectionBoxEntries(outcome.boxEntries);
    saveDatabase();
  }
  return outcome;
}

function writeAudit(req, actorUser, auditMeta, statusCode, payload) {
  const warningMessage = formatAuditWarnings(payload);
  const requestBodyMasked = sanitizeProductPublishAuditPayload(auditMeta, auditMeta.requestBodyMasked);
  const responseBodyMasked = sanitizeProductPublishAuditPayload(auditMeta, auditMeta.responseBodyMasked);
  const entry = {
    id: makeId("AUD"),
    ts: new Date().toISOString(),
    actorUserId: actorUser ? actorUser.id : "",
    actorUsername: actorUser ? actorUser.username : "anonymous",
    actorRole: actorUser ? actorUser.role : "anonymous",
    ip: readClientIp(req),
    method: req.method,
    path: new URL(req.url, `http://${req.headers.host}`).pathname,
    query: auditMeta.query || {},
    actionType: auditMeta.actionType || "read",
    resourceType: auditMeta.resourceType || "system",
    resourceId: auditMeta.resourceId || "",
    requestBodyMasked,
    responseBodyMasked,
    statusCode,
    success: statusCode < 400,
    errorMessage: statusCode >= 400 ? String(payload.message || "") : "",
    warningMessage
  };

  if (!Array.isArray(db.auditLogs)) {
    db.auditLogs = [];
  }
  db.auditLogs.push(entry);
  if (db.auditLogs.length > AUDIT_MAX_RECORDS) {
    db.auditLogs = db.auditLogs.slice(db.auditLogs.length - AUDIT_MAX_RECORDS);
  }
  // 增量落表（fire-and-forget，内部串行队列保证顺序）；审计不再依赖快照持久化。
  auditStore.insert(entry);
  if (!new Set(["read", "filter_query"]).has(String(auditMeta?.actionType || "read"))) {
    saveDatabase();
  }
}



function readClientIp(req) {
  return resolveClientIp(req.headers["x-forwarded-for"], req.socket?.remoteAddress || "", TRUST_PROXY);
}







// A UTF-8 BOM (EF BB BF) legitimately decodes to "\uFEFF", which trims to itself:
// String.prototype.trim() does not treat U+FEFF as whitespace. A log file holding
// nothing but a BOM must therefore never be reported as having error content.

// Local error logs are append-only and may be months old, so entries older than the
// current server start must not be reported as recent problems.
//
// appendRuntimeLog() prefixes every record it writes with an ISO timestamp, so a
// timestamped line anchors a record and any following lines without one are its
// continuation (for example a stack trace). Records are only considered fresh when
// their anchor parses and is at or after sinceTs: non-timestamped lines never stand
// alone, and a timestamp that cannot be parsed is treated as stale rather than fresh.


function rotateInsecureDefaultAdmins(database) {
  const result = rotateInsecureDefaultAdminsPure(database, {
    adminRole: ROLE_ADMIN,
    defaultAdminPassword: DEFAULT_ADMIN_PASSWORD,
    legacyPasswordSalt: LEGACY_PASSWORD_SALT,
    normalizeRole
  });
  if (result.notice) bootstrapAdminNotice = result.notice;
  return result.rotated;
}

function verifyPassword(user, password) {
  return verifyPasswordPure(user, password, LEGACY_PASSWORD_SALT);
}

function deriveAppKey() {
  return deriveAppKeyFromSecret(APP_SECRET_KEY);
}

function encryptSecret(value) {
  return encryptSecretWithKey(value, APP_SECRET_KEY);
}

function decryptSecret(value) {
  return decryptSecretWithKey(value, APP_SECRET_KEY);
}



function normalizeOrderRecord(order) {
  order.shopName = String(order.shopName || order.storeName || order.campaignName || "未命名店铺");
  order.shopSku = String(order.shopSku || firstItemSku(order.items) || "-");
  order.itemCount = normalizeItemCount(order.itemCount, order.itemsCount, order.totalItems, order.items);
  order.shopOrderNo = String(order.shopOrderNo || order.externalOrderId || order.orderNo || order.id || "");
  const stableId = buildStableOrderId(order);
  if (stableId) {
    order.id = stableId;
  } else if (!order.id) {
    order.id = makeId("ORD");
  }
}





// The attribute bag a publish product would actually send to Yandex. It lives under
// `attributeTerms`; `variantAttributes`/`attributes` are accepted as older spellings.

// Collects the category ids a product claims, so the caller can group requirements.




















function upsertOrderPurchaseOverride(orderRef, payload) {
  if (!db || typeof db !== "object") return null;
  if (!Array.isArray(db.orderPurchaseOverrides)) db.orderPurchaseOverrides = [];
  const ref = String(orderRef || "").trim();
  if (!ref) return null;

  const next = {
    orderRef: ref,
    purchasePlatform: String(payload?.purchasePlatform || "").trim(),
    purchaseLink: String(payload?.purchaseLink || "").trim(),
    purchaseOrderNo: String(payload?.purchaseOrderNo || "").trim(),
    purchaseExpressNo: String(payload?.purchaseExpressNo || "").trim(),
    purchaseIntlNo: String(payload?.purchaseIntlNo || "").trim(),
    purchasePriceRmb: String(payload?.purchasePriceRmb || "").trim(),
    purchasePriceRub: String(payload?.purchasePriceRub || "").trim(),
    purchaseUpdatedAt: String(payload?.purchaseUpdatedAt || new Date().toISOString()).trim(),
    updatedAt: new Date().toISOString()
  };
  const index = db.orderPurchaseOverrides.findIndex((item) => String(item?.orderRef || "").trim() === ref);
  if (index >= 0) {
    db.orderPurchaseOverrides[index] = next;
  } else {
    db.orderPurchaseOverrides.push(next);
  }
  return next;
}






































function findShopForOrder(order) {
  const campaignId = String(order?.account || order?.shopAccount || "").trim();
  let shop = null;
  if (campaignId) {
    shop = (db.shops || []).find((s) => String(s.campaignId || "") === campaignId);
  }
  if (!shop) {
    const shopName = String(order?.shopName || "").trim();
    shop = (db.shops || []).find((s) => String(s.name || "").trim() === shopName);
  }
  return shop;
}

function buildMockShopOrder(shop, existingShopOrderNos) {
  const campaignId = String(shop.campaignId || "").trim();
  const shopName = String(shop.name || "店铺").trim();
  // Include a random segment so orders generated within the same millisecond
  // cannot collide and get silently dropped.
  const baseOrderNo = campaignId
    ? `YM-${campaignId}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`
    : `SHOP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const orderNo = existingShopOrderNos.has(baseOrderNo) ? `${baseOrderNo}-${Math.floor(Math.random() * 1000)}` : baseOrderNo;
  if (existingShopOrderNos.has(orderNo)) return null;
  existingShopOrderNos.add(orderNo);

  const createdAt = new Date().toISOString();
  return {
    id: makeId("ORD"),
    customerName: "店铺订单",
    amount: Number((Math.random() * 200 + 20).toFixed(2)),
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    shopName,
    shopSku: campaignId ? `SKU-${campaignId}` : "SKU-DEFAULT",
    itemCount: 1,
    shopOrderNo: orderNo,
    shopStatus: "",
    trackingNo: "",
    logistics: "",
    warehouse: "",
    productName: "",
    imageUrl: "",
    account: campaignId || "-"
  };
}



function normalizeRole(role, username) {
  return normalizeRolePure(role, username, REGISTER_DEFAULT_ROLE);
}

function resolveCompanyIdByName(companyName) {
  const name = normalizeCompanyName(companyName);
  if (!name) return makeId("CMP");
  for (const user of Array.isArray(db?.users) ? db.users : []) {
    if (normalizeCompanyName(user?.companyName) === name && normalizeCompanyId(user?.companyId)) return normalizeCompanyId(user.companyId);
  }
  for (const shop of Array.isArray(db?.shops) ? db.shops : []) {
    if (normalizeCompanyName(shop?.companyName) === name && normalizeCompanyId(shop?.companyId)) return normalizeCompanyId(shop.companyId);
  }
  return makeId("CMP");
}

function getEffectiveShopPermissions(user) {
  return getEffectiveShopPermissionsPure(user, REGISTER_DEFAULT_ROLE);
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    companyName: normalizeCompanyName(user.companyName || ""),
    companyId: normalizeCompanyId(user.companyId || ""),
    createdAt: user.createdAt,
    shopPermissions: getEffectiveShopPermissions(user),
    shopAssignments: normalizeShopAssignments(user.shopAssignments, db.shops || [], user)
  };
}

function createDefaultDatabase() {
  const bootstrapPassword = DEFAULT_ADMIN_PASSWORD || generateBootstrapPassword();
  const adminCreds = createPasswordHash(bootstrapPassword);
  bootstrapAdminNotice = `Bootstrap admin created. Username: ${DEFAULT_ADMIN_USERNAME}; password: ${bootstrapPassword}. Change it after the first login.`;
  return {
    users: [
      {
        id: makeId("USR"),
        username: DEFAULT_ADMIN_USERNAME,
        passwordHash: adminCreds.passwordHash,
        passwordSalt: adminCreds.passwordSalt,
        role: ROLE_ADMIN,
        companyName: "系统",
        companyId: "system",
        shopPermissions: getRoleShopPermissionDefaults(ROLE_ADMIN),
        shopAssignments: [],
        createdAt: new Date().toISOString()
      }
    ],
    orders: [
      {
        id: "ORD-20260215-001",
        customerName: "Alice Chen",
        amount: 399,
        status: "pending",
        shopName: "默认店铺",
        shopSku: "SKU-10001",
        itemCount: 2,
        shopOrderNo: "SHOP-20260215-001",
        createdAt: "2026-02-14T10:15:00Z",
        updatedAt: "2026-02-14T10:15:00Z"
      },
      {
        id: "ORD-20260215-002",
        customerName: "Bob Wang",
        amount: 1299,
        status: "paid",
        shopName: "默认店铺",
        shopSku: "SKU-10002",
        itemCount: 1,
        shopOrderNo: "SHOP-20260215-002",
        createdAt: "2026-02-14T14:30:00Z",
        updatedAt: "2026-02-14T14:30:00Z"
      },
      {
        id: "ORD-20260215-003",
        customerName: "Carol Li",
        amount: 79,
        status: "shipped",
        shopName: "默认店铺",
        shopSku: "SKU-10003",
        itemCount: 3,
        shopOrderNo: "SHOP-20260215-003",
        createdAt: "2026-02-15T01:20:00Z",
        updatedAt: "2026-02-15T01:20:00Z"
      }
    ],
    onlineProducts: [],
    publishProducts: [],
    orderPurchaseOverrides: [],
    shops: [
      {
        id: "SHP-DEFAULT-001",
        name: "默认店铺",
        code: "DEFAULT",
        enabled: true,
        provider: "local",
        campaignId: "",
        businessId: "",
        companyId: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    messages: [
      {
        id: "MSG-DEFAULT-001",
        title: "系统通知",
        content: "欢迎使用消息管理模块。",
        createdAt: new Date().toISOString(),
        createdBy: {
          userId: "system",
          username: "system",
          role: "system"
        }
      }
    ],
    activeSessions: [],
    auditLogs: [],
    publishSettings: normalizePublishSettings({}),
    reviewRules: [],
    productCategoryKnowledge: normalizeProductCategoryKnowledge({}),
    yandexCommissionCatalog: normalizeYandexCommissionCatalog({})
  };
}

function serializeDatabase(source) {
  const safe = JSON.parse(JSON.stringify(source || {}));
  safe.publishSettings = normalizePublishSettings(safe.publishSettings || {});
  safe.productCategoryKnowledge = normalizeProductCategoryKnowledge(safe.productCategoryKnowledge || {});
  safe.yandexCommissionCatalog = normalizeYandexCommissionCatalog(safe.yandexCommissionCatalog || {});
  if (!Array.isArray(safe.shops)) safe.shops = [];
  for (const shop of safe.shops) {
    const plainApiKey = String(shop.apiKey || "").trim();
    const encApiKey = String(shop.apiKeyEncrypted || "").trim();
    if (plainApiKey) {
      shop.apiKeyEncrypted = encryptSecret(plainApiKey);
    } else if (encApiKey.startsWith(ENC_PREFIX)) {
      shop.apiKeyEncrypted = encApiKey;
    } else {
      shop.apiKeyEncrypted = "";
    }
    delete shop.apiKey;
  }
  return safe;
}

const DISABLED_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

// `enabled` arrives from several shapes: JSON snapshots use booleans, while the MySQL
// shops table stores TINYINT(1) and mysql2 hands back the numbers 0 and 1. Treating
// anything that is not a boolean as "enabled" silently re-enabled every disabled shop
// on each load, so a disabled shop started syncing orders again after a restart.
function coerceEnabledFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : true;
  if (typeof value === "string") return !DISABLED_FLAG_VALUES.has(value.trim().toLowerCase());
  return true;
}

function normalizeDatabase(loaded) {
  const next = {
    users: Array.isArray(loaded.users) ? loaded.users : [],
    orders: Array.isArray(loaded.orders) ? loaded.orders : [],
    onlineProducts: Array.isArray(loaded.onlineProducts) ? loaded.onlineProducts : [],
    publishProducts: Array.isArray(loaded.publishProducts) ? loaded.publishProducts : [],
    orderPurchaseOverrides: Array.isArray(loaded.orderPurchaseOverrides) ? loaded.orderPurchaseOverrides : [],
    shops: Array.isArray(loaded.shops) ? loaded.shops : [],
    shopOrderWorkspaceOverrides: loaded.shopOrderWorkspaceOverrides && typeof loaded.shopOrderWorkspaceOverrides === "object"
      ? { ...loaded.shopOrderWorkspaceOverrides }
      : {},
    messages: Array.isArray(loaded.messages) ? loaded.messages : [],
    activeSessions: Array.isArray(loaded.activeSessions) ? loaded.activeSessions : [],
    auditLogs: Array.isArray(loaded.auditLogs) ? loaded.auditLogs : [],
    publishSettings: normalizePublishSettings(loaded.publishSettings || {}),
    reviewRules: Array.isArray(loaded.reviewRules) ? loaded.reviewRules.map(normalizeReviewRule).filter((item) => item.id) : [],
    productCategoryKnowledge: normalizeProductCategoryKnowledge(loaded.productCategoryKnowledge || {}),
    yandexCommissionCatalog: normalizeYandexCommissionCatalog(loaded.yandexCommissionCatalog || {})
  };

  next.activeSessions = next.activeSessions
    .map((s) => {
      // Persist only the SHA-256 hash of the token. Legacy plaintext rows are
      // hashed here so plaintext tokens never round-trip through storage.
      const legacyToken = String(s?.token || "").trim();
      const tokenHash = String(s?.tokenHash || "").trim() || (legacyToken ? hashSessionToken(legacyToken) : "");
      return {
        tokenHash,
        userId: String(s?.userId || "").trim(),
        expiresAt: Number(s?.expiresAt || 0) || 0
      };
    })
    .filter((s) => s.tokenHash && s.userId && s.expiresAt > Date.now());

  const companyIdByName = new Map();
  const registerCompanyId = (companyName, companyId) => {
    const name = normalizeCompanyName(companyName);
    const id = normalizeCompanyId(companyId);
    if (!name || !id) return;
    if (!companyIdByName.has(name)) companyIdByName.set(name, id);
  };

  for (const user of next.users) {
    user.role = normalizeRole(user.role, user.username);
    user.companyName = normalizeCompanyName(user.companyName || (user.role === ROLE_ADMIN ? "系统" : ""));
    user.shopPermissions = normalizeShopPermissions(user.shopPermissions, user.role);
    if (!user.passwordSalt) {
      user.passwordSalt = "";
    }
    const normalizedCompanyName = user.role === ROLE_ADMIN ? "系统" : user.companyName;
    let companyId = normalizeCompanyId(user.companyId || "");
    if (!companyId) {
      companyId = user.role === ROLE_ADMIN ? "system" : (companyIdByName.get(normalizedCompanyName) || makeId("CMP"));
    }
    user.companyId = companyId;
    registerCompanyId(normalizedCompanyName, companyId);
  }

  for (const order of next.orders) {
    if (!order.updatedAt) {
      order.updatedAt = order.createdAt || new Date().toISOString();
    }
    normalizeOrderRecord(order);
  }

  next.orderPurchaseOverrides = next.orderPurchaseOverrides
    .map((item) => ({
      orderRef: String(item?.orderRef || "").trim(),
      purchasePlatform: String(item?.purchasePlatform || "").trim(),
      purchaseLink: String(item?.purchaseLink || "").trim(),
      purchaseOrderNo: String(item?.purchaseOrderNo || "").trim(),
      purchaseExpressNo: String(item?.purchaseExpressNo || "").trim(),
      purchaseIntlNo: String(item?.purchaseIntlNo || "").trim(),
      purchasePriceRmb: String(item?.purchasePriceRmb || "").trim(),
      purchasePriceRub: String(item?.purchasePriceRub || "").trim(),
      purchaseUpdatedAt: String(item?.purchaseUpdatedAt || "").trim(),
      updatedAt: String(item?.updatedAt || item?.purchaseUpdatedAt || "").trim()
    }))
    .filter((item) => item.orderRef);

  for (const product of next.onlineProducts) {
    normalizeOnlineProductRecord(product);
  }
  for (const item of next.publishProducts) {
    const normalized = normalizePublishProductRecord(item);
    Object.assign(item, normalized);
    if (!item.id) item.id = makeId("PUB");
    if (!item.createdAt) item.createdAt = new Date().toISOString();
    if (!item.updatedAt) item.updatedAt = item.createdAt;
  }

  attachShopIdsToOrders(next.orders, next.shops);
  attachShopIdsToOnlineProducts(next.onlineProducts, next.shops);
  restorePurchaseFromAuditLogs(next.orders, next.auditLogs);
  applyOrderPurchaseOverrides(next.orders, next.orderPurchaseOverrides);
  backfillOrderAmounts(next.orders);

  for (const shop of next.shops) {
    shop.enabled = coerceEnabledFlag(shop.enabled);
    if (!shop.createdAt) {
      shop.createdAt = new Date().toISOString();
    }
    if (!shop.updatedAt) {
      shop.updatedAt = shop.createdAt;
    }
    if (shop.code === undefined || shop.code === null) {
      shop.code = "";
    }
    if (!shop.provider) {
      shop.provider = "local";
    }
    if (shop.campaignId === undefined || shop.campaignId === null) {
      shop.campaignId = "";
    }
    if (shop.businessId === undefined || shop.businessId === null) {
      shop.businessId = "";
    }
    shop.shopCurrency = normalizeShopCurrency(shop.shopCurrency || shop.listingCurrency);
    delete shop.listingCurrency;
    shop.companyName = normalizeCompanyName(shop.companyName);
    let companyId = normalizeCompanyId(shop.companyId || "");
    if (!companyId) {
      const normalizedCompanyName = shop.companyName;
      companyId = normalizedCompanyName === "系统" ? "system" : (companyIdByName.get(normalizedCompanyName) || makeId("CMP"));
      registerCompanyId(normalizedCompanyName, companyId);
    }
    shop.companyId = companyId;
    const storedApiKeyEncrypted = shop.apiKeyEncrypted || "";
    shop.apiKey = decryptSecret(shop.apiKey || storedApiKeyEncrypted || "");
    if (shop.apiKey) {
      shop.apiKeyEncrypted = encryptSecret(shop.apiKey);
    } else {
      // Never clear an undecryptable stored ciphertext: clearing it here gets
      // persisted back to MySQL on the next snapshot save and permanently
      // destroys the key. Keep it so it can be recovered once the matching
      // APP_SECRET_KEY is restored.
      shop.apiKeyEncrypted = storedApiKeyEncrypted;
      if (storedApiKeyEncrypted) {
        console.error(
          `[secrets] 店铺 ${String(shop.id || shop.name || "?")} 的 API Key 解密失败，已保留原密文不覆盖（APP_SECRET_KEY 可能已更换，重新录入密钥后请不要再改 APP_SECRET_KEY）。`
        );
      }
    }
  }


  for (const message of next.messages) {
    if (!message.id) message.id = makeId("MSG");
    if (!message.title) message.title = "";
    if (!message.content) message.content = "";
    if (!message.createdAt) message.createdAt = new Date().toISOString();
    if (!message.createdBy || typeof message.createdBy !== "object") {
      message.createdBy = { userId: "", username: "system", role: "system" };
    }
  }

  if (next.auditLogs.length > AUDIT_MAX_RECORDS) {
    next.auditLogs = next.auditLogs.slice(next.auditLogs.length - AUDIT_MAX_RECORDS);
  }

  for (const user of next.users) {
    user.shopAssignments = normalizeShopAssignments(user.shopAssignments, next.shops, user);
  }

  return next;
}

function createRuntimeDatabase() {
  // The application is MySQL-only. This object exists only until the
  // persisted AppState and dedicated tables have been loaded from MySQL.
  return normalizeDatabase({});
}

function saveDatabase() {
  if (!sqlReady || !sqlPool) {
    console.error("MySQL is not ready; data was not persisted.");
    return Promise.resolve();
  }
  databaseWriteQueue = databaseWriteQueue
    .then(() => sqlWriters.saveDatabaseToSql())
    .catch((error) => { console.error("MySQL save failed:", String(error)); });
  return databaseWriteQueue;
}



function isSqlConfigured() {
  return Boolean(mysql && MYSQL_HOST && MYSQL_DATABASE && MYSQL_USER && readMysqlPassword());
}

// order_purchases 是 orderPurchaseOverrides 的唯一载体：归属清单
// （persistence/store-manifest.js）把这个键从 AppState 快照里剔除了，所以启动时必须由这张表
// 重建内存数组。只把表行贴到「已存在」的订单上是不够的 —— 那样重启后覆盖集恒为空，
// order-sync 的 applyOrderPurchaseOverrides 成为空操作，延迟采购单（为尚未同步到的订单预先
// 登记的采购信息）在订单后来出现时贴不回去。
//
// 单独成函数，是为了让测试能**只重跑这段 hydrate**，而不必 closeAppRuntime() + 重跑整个
// initializeAppRuntime()：那会关掉共享连接池，在 --test-isolation=none 下干扰同进程的其他
// 测试文件（表现为间歇性的 "Pool is closed"）。
async function hydrateOrderPurchaseOverridesFromSql() {
  const [purchaseRows] = await sqlPool.query(
    `SELECT orderRef, orderId, shopOrderNo, purchasePlatform, purchaseLink, purchaseOrderNo,
            purchaseExpressNo, purchaseIntlNo, purchasePriceRmb, purchasePriceRub,
            purchaseUpdatedAt, updatedAt
     FROM order_purchases`
  );
  sqlPurchaseTableWasEmpty = Array.isArray(purchaseRows) && purchaseRows.length === 0;
  db.orderPurchaseOverrides = buildOrderPurchaseOverridesFromRows(purchaseRows);
  applyOrderPurchaseOverrides(db.orders || [], db.orderPurchaseOverrides);
}

async function initSqlPersistence() {
  if (!isSqlConfigured()) {
    throw new Error("MySQL persistence is required but MYSQL_* configuration is incomplete.");
  }
  try {
    sqlPool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: readMysqlPassword(),
      database: MYSQL_DATABASE,
      charset: "utf8mb4",
      timezone: "Z",
      waitForConnections: true,
      connectionLimit: 5,
      // Return DECIMAL columns as JS numbers so hydrating rows does not turn
      // numeric fields (prices, weights, commissions) into strings.
      decimalNumbers: true
    });

    await sqlPool.query(`
      CREATE TABLE IF NOT EXISTS AppState (
        stateKey VARCHAR(128) NOT NULL PRIMARY KEY,
        stateJson LONGTEXT NOT NULL,
        updatedAt TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    `);

    await sqlPool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        shopOrderNo VARCHAR(128) NOT NULL DEFAULT '',
        shopId VARCHAR(128) NOT NULL DEFAULT '',
        companyId VARCHAR(128) NOT NULL DEFAULT '',
        status VARCHAR(64) NOT NULL DEFAULT '',
        amount DECIMAL(18, 4) NOT NULL DEFAULT 0,
        createdAt DATETIME(6) NULL,
        updatedAt DATETIME(6) NULL,
        payloadJson LONGTEXT NULL,
        KEY idx_orders_shopOrderNo (shopOrderNo),
        KEY idx_orders_shopId (shopId),
        KEY idx_orders_updatedAt (updatedAt)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    `);
    await sqlPool.query(`
      CREATE TABLE IF NOT EXISTS order_purchases (
        orderRef VARCHAR(128) NOT NULL PRIMARY KEY,
        orderId VARCHAR(128) NOT NULL DEFAULT '',
        shopOrderNo VARCHAR(128) NOT NULL DEFAULT '',
        purchasePlatform VARCHAR(128) NOT NULL DEFAULT '',
        purchaseLink TEXT NOT NULL,
        purchaseOrderNo VARCHAR(128) NOT NULL DEFAULT '',
        purchaseExpressNo VARCHAR(128) NOT NULL DEFAULT '',
        purchaseIntlNo VARCHAR(128) NOT NULL DEFAULT '',
        purchasePriceRmb VARCHAR(64) NOT NULL DEFAULT '',
        purchasePriceRub VARCHAR(64) NOT NULL DEFAULT '',
        purchaseUpdatedAt VARCHAR(64) NOT NULL DEFAULT '',
        updatedAt VARCHAR(64) NOT NULL DEFAULT '',
        KEY idx_order_purchases_order_id (orderId),
        KEY idx_order_purchases_shop_order_no (shopOrderNo),
        KEY idx_order_purchases_updated_at (updatedAt)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    `);
    for (const statement of REQUIRED_TABLE_DDLS) await sqlPool.query(statement);
    await ensurePdevTables(sqlPool);
    // 审计日志与费率目录的建表必须发生在任何 saveDatabase() 之前：saveDatabaseToSql() 会向
    // 这两张表写入。这里直接用连接池执行 DDL（不能用 auditStore.ensureTable 之类的方法，
    // 它们在 sqlReady 置真前会直接跳过）。
    await sqlPool.query(AUDIT_TABLE_DDL);
    await sqlPool.query(YANDEX_COMMISSION_CATALOG_DDL);
    const compatibilityAlters = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS shopPermissions JSON NOT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS shopAssignments JSON NOT NULL",
      "ALTER TABLE shops ADD COLUMN IF NOT EXISTS apiKeyVerified TINYINT(1) NOT NULL DEFAULT 0",
      "ALTER TABLE shops ADD COLUMN IF NOT EXISTS apiKeyVerifiedAt VARCHAR(64) NOT NULL DEFAULT ''",
      "ALTER TABLE shops ADD COLUMN IF NOT EXISTS apiKeyInvalidatedAt VARCHAR(64) NOT NULL DEFAULT ''",
      "ALTER TABLE shops ADD COLUMN IF NOT EXISTS apiKeyVerificationMessage TEXT"
    ];
    for (const statement of compatibilityAlters) {
      try { await sqlPool.query(statement); } catch (error) {
        if (!/duplicate|exists|1060/i.test(String(error?.message || error))) throw error;
      }
    }
    const [shopCurrencyColumns] = await sqlPool.query("SHOW COLUMNS FROM shops LIKE 'shopCurrency'");
    if (!Array.isArray(shopCurrencyColumns) || !shopCurrencyColumns.length) {
      await sqlPool.query("ALTER TABLE shops ADD COLUMN shopCurrency VARCHAR(8) NOT NULL DEFAULT 'RUR' AFTER businessId");
      const [legacyCurrencyColumns] = await sqlPool.query("SHOW COLUMNS FROM shops LIKE 'listingCurrency'");
      if (Array.isArray(legacyCurrencyColumns) && legacyCurrencyColumns.length) {
        await sqlPool.query("UPDATE shops SET shopCurrency = listingCurrency WHERE listingCurrency IN ('RUR', 'CNY')");
      }
    }

    const [rows] = await sqlPool.execute(
      `
      SELECT stateJson
      FROM AppState
      WHERE stateKey = ?
      LIMIT 1;
    `,
      [SQL_STATE_KEY]
    );

    if (rows && rows.length > 0) {
      const row = rows[0];
      const parsed = JSON.parse(String(row.stateJson || "{}"));
      db = resolveInitialDatabase([parsed], { createDefaultDatabase, normalizeDatabase }).database;
      const [userRows] = await sqlPool.query("SELECT * FROM users ORDER BY createdAt ASC");
      if (Array.isArray(userRows) && userRows.length) {
        db.users = normalizeDatabase({ ...db, users: userRows.map(hydratePayloadRow).filter(Boolean) }).users;
      }
      const [sessionRows] = await sqlPool.query("SELECT * FROM active_sessions WHERE expiresAt > ?", [Date.now()]);
      if (Array.isArray(sessionRows) && sessionRows.length) {
        db.activeSessions = sessionRows.map(hydratePayloadRow).filter(Boolean);
      }
      try {
        const [shopRows] = await sqlPool.query(
          `SELECT id, name, code, enabled, provider, campaignId, businessId, shopCurrency, apiKeyEncrypted, companyName, companyId, createdAt, updatedAt,
                  apiKeyVerified, apiKeyVerifiedAt, apiKeyInvalidatedAt, apiKeyVerificationMessage
           FROM shops`
        );
        if (Array.isArray(shopRows) && shopRows.length) {
          db.shops = normalizeDatabase({ ...db, shops: shopRows }).shops;
          attachShopIdsToOrders(db.orders, db.shops);
          attachShopIdsToOnlineProducts(db.onlineProducts, db.shops);
        }
      } catch (shopError) {
        console.error("MySQL shops table unavailable, keeping AppState shops:", String(shopError));
      }
      try {
        const [reviewRuleRows] = await sqlPool.query(
          `SELECT * FROM review_rules ORDER BY priority ASC, updatedAt DESC`
        );
        if (Array.isArray(reviewRuleRows) && reviewRuleRows.length) {
          db.reviewRules = reviewRuleRows.map(normalizeReviewRule).filter((item) => item.id);
        }
      } catch (reviewRuleError) {
        console.error("MySQL review_rules table unavailable, keeping AppState review rules:", String(reviewRuleError));
      }
      try {
        const [orderRows] = await sqlPool.query(
          `SELECT id, shopOrderNo, shopId, companyId, status, amount, createdAt, updatedAt, payloadJson
           FROM orders
           ORDER BY updatedAt DESC`
      );
        sqlOrdersTableWasEmpty = Array.isArray(orderRows) && orderRows.length === 0;
        const fallbackOrdersFromState = Array.isArray(db.orders) ? db.orders : [];
        if (Array.isArray(orderRows) && orderRows.length) {
          const localOrdersByKey = new Map(
            (db.orders || []).map((order) => [String(order.shopOrderNo || order.id || ""), order])
          );
          db.orders = orderRows.map((row) => {
            let payload = {};
            try {
              payload = row.payloadJson ? JSON.parse(String(row.payloadJson)) : {};
            } catch {}
            const key = String(row.shopOrderNo || row.id || "");
            const local = localOrdersByKey.get(key);
            const order = { ...(payload && typeof payload === "object" ? payload : {}) };
            if (local && typeof local === "object") {
              for (const [field, value] of Object.entries(local)) {
                if (!Object.prototype.hasOwnProperty.call(order, field)) order[field] = value;
              }
            }
            Object.assign(order, {
              id: String(row.id || order.id || ""),
              shopOrderNo: String(row.shopOrderNo || order.shopOrderNo || ""),
              shopId: String(row.shopId || order.shopId || ""),
              companyId: String(row.companyId || order.companyId || ""),
              status: String(row.status || order.status || ""),
              amount: Number(row.amount),
              createdAt: String(row.createdAt || order.createdAt || ""),
              updatedAt: String(row.updatedAt || order.updatedAt || "")
            });
            normalizeOrderRecord(order);
            return order;
          });
          attachShopIdsToOrders(db.orders, db.shops || []);
        } else if (Array.isArray(orderRows)) {
          db.orders = fallbackOrdersFromState;
        }
      } catch (orderError) {
        console.error("MySQL orders table unavailable, keeping AppState orders:", String(orderError));
      }
      // 审计日志有自己的表（唯一归属），启动时取最近 AUDIT_MAX_RECORDS 条回内存。
      // 因为已从快照剔除，normalizeDatabase 里的采购恢复拿不到日志，这里 hydrate 后必须重跑一次。
      try {
        const auditRows = await auditStore.loadRecent(AUDIT_MAX_RECORDS);
        if (auditRows.length) {
          db.auditLogs = auditRows;
          restorePurchaseFromAuditLogs(db.orders, db.auditLogs);
        }
        await auditStore.trimTo(AUDIT_MAX_RECORDS);
      } catch (auditError) {
        console.error("MySQL audit_logs table unavailable, keeping AppState audit logs:", String(auditError));
      }
      // Yandex 合法费率目录已改存单行表（不再进快照）。老库首次启动时表还是空的，
      // 此时保留快照里的值，下一次 saveDatabase() 会把它写进表并从快照剔除。
      try {
        const catalog = await sqlWriters.loadYandexCommissionCatalogFromSql();
        if (catalog) db.yandexCommissionCatalog = normalizeYandexCommissionCatalog(catalog);
      } catch (catalogError) {
        console.error("MySQL yandex_commission_catalog table unavailable, keeping AppState catalog:", String(catalogError));
      }
      try {
        await hydrateOrderPurchaseOverridesFromSql();
      } catch (purchaseError) {
        console.error("MySQL order_purchases table unavailable, keeping order purchase fields:", String(purchaseError));
      }
      try {
        // online_products is the authoritative product store. AppState is only
        // a compatibility snapshot and may contain fields from an old sync.
        const [onlineProductRows] = await sqlPool.query("SELECT * FROM online_products ORDER BY updatedAt DESC");
        if (Array.isArray(onlineProductRows) && onlineProductRows.length) {
          db.onlineProducts = onlineProductRows.map(sqlWriters.hydrateOnlineProductFromSqlRow).filter(Boolean);
          attachShopIdsToOnlineProducts(db.onlineProducts, db.shops || []);
        }
      } catch (onlineProductError) {
        console.error("MySQL online_products table unavailable, keeping AppState online products:", String(onlineProductError));
      }
      backfillOrderAmounts(db.orders || []);
      backfillOrderProductMatches(db.orders || [], db.onlineProducts || []);
      backfillOrderPurchaseFields(db.orders || [], db.onlineProducts || []);
      console.log("Loaded state from MySQL.");
    } else {
      db = resolveInitialDatabase([], { createDefaultDatabase, normalizeDatabase }).database;
      sqlReady = true;
      await sqlWriters.saveDatabaseToSql();
      console.log("Initialized MySQL state from local data.");
    }

    sqlReady = true;
    await refreshOrderProfitSnapshots();
    if (sqlOrdersTableWasEmpty && Array.isArray(db.orders) && db.orders.length) {
      await sqlWriters.saveOrdersToSql(db.orders);
      sqlOrdersTableWasEmpty = false;
    }
    if (sqlPurchaseTableWasEmpty) sqlPurchaseTableWasEmpty = false;
    await sqlWriters.saveDatabaseToSql();
  } catch (error) {
    sqlReady = false;
    sqlPool = null;
    throw new Error(`MySQL initialization failed: ${String(error?.message || error)}`);
  }
}







































async function enrichCommissionCatalogChinese(items) {
  // TODO: Chinese category-name enrichment is not implemented yet. Passthrough
  // keeps the legal-page sync path functional instead of throwing
  // ReferenceError when this dead-but-referenced path gets wired up.
  return Array.isArray(items) ? items : [];
}

async function syncYandexLegalCommissionCatalog() {
  const links = { ru: YANDEX_LEGAL_RATE_URL_RU, zh: YANDEX_LEGAL_RATE_URL_ZH };
  let items = [];
  let source = "yandex_legal";
  let warning = "";
  try {
    const response = await fetch(links.ru, withFetchTimeout({ headers: { "User-Agent": "Mozilla/5.0" } }));
    if (!response.ok) {
      warning = `Legal page fetch failed: ${response.status}`;
    } else {
      const html = await response.text();
      const parsedItems = parseYandexLegalCommissionCatalogFromHtml(html);
      items = await enrichCommissionCatalogChinese(parsedItems);
      if (items.length < 200) {
        warning = `Legal page parsed only ${items.length} rows, fallback to Yandex API full category sync`;
      }
    }
  } catch (error) {
    warning = `Legal page fetch error: ${String(error)}`;
  }

  if (!items.length || items.length < 200) {
    const fallback = await syncYandexCommissionCatalogFromApiFallback(items);
    if (!fallback.ok) {
      return { ok: false, status: fallback.status || 502, message: fallback.message || warning || "Commission sync failed" };
    }
    items = fallback.items || [];
    source = "yandex_api_fallback";
    warning = [warning, fallback.warning].filter(Boolean).join(" | ");
  }

  if (!items.length) return { ok: false, status: 502, message: warning || "No commission rows available" };
  db.yandexCommissionCatalog = normalizeYandexCommissionCatalog({
    source,
    links,
    fetchedAt: new Date().toISOString(),
    itemCount: items.length,
    items,
    warning
  });
  saveDatabase();
  return { ok: true, data: db.yandexCommissionCatalog };
}

async function syncYandexCommissionCatalogFromApiFallback(seedItems = []) {
  const yandexShops = (db.shops || []).filter((s) => String(s?.provider || "").toLowerCase() === "yandex_market" && s?.enabled && s?.apiKey);
  if (!yandexShops.length) {
    return { ok: false, status: 400, message: "No enabled Yandex shop with apiKey for fallback sync" };
  }
  const shop = yandexShops[0];
  const tree = await fetchYandexCategoryIndex(shop.apiKey, "RU");
  if (!tree.ok || !tree.index) {
    return { ok: false, status: tree.status || 502, message: tree.message || "Yandex category tree fetch failed" };
  }
  let zhById = new Map();
  let enById = new Map();
  for (const lang of ["ZH", "ZH_CN", "CN"]) {
    const zhTree = await fetchYandexCategoryIndex(shop.apiKey, lang);
    if (!zhTree.ok || !zhTree.index) continue;
    const zhLeaves = Array.isArray(zhTree.index.leaves) ? zhTree.index.leaves : [];
    const hasZhText = zhLeaves.some((leaf) => /[\u3400-\u9fff]/.test(String(leaf?.pathText || leaf?.name || "")));
    if (!hasZhText) continue;
    zhById = new Map(
      zhLeaves
        .map((leaf) => [String(leaf?.id || "").trim(), normalizeCategoryLevelsWithDash(String(leaf?.pathText || leaf?.name || ""))])
        .filter((x) => x[0] && /[\u3400-\u9fff]/.test(x[1]))
    );
    if (zhById.size) break;
  }
  const enTree = await fetchYandexCategoryIndex(shop.apiKey, "EN");
  if (enTree.ok && enTree.index) {
    const enLeaves = Array.isArray(enTree.index.leaves) ? enTree.index.leaves : [];
    enById = new Map(
      enLeaves
        .map((leaf) => [String(leaf?.id || "").trim(), normalizeCategoryLevelsWithDash(String(leaf?.pathText || leaf?.name || ""))])
        .filter((x) => x[0] && /[A-Za-z]/.test(x[1]))
    );
  }
  const leaves = Array.isArray(tree.index.leaves) ? tree.index.leaves : [];
  if (!leaves.length) {
    return { ok: false, status: 502, message: "Yandex category tree is empty" };
  }
  const seed = Array.isArray(seedItems) ? seedItems : [];
  const seedByRu = new Map(seed.map((x) => [String(x.categoryRu || "").trim().toLowerCase(), Number(x.commissionPercent || 0) || 0]));
  const seedPrefix = seed
    .map((x) => ({
      ru: normalizeCategoryLevelsWithDash(String(x.categoryRu || "").trim()),
      commissionPercent: Number(x.commissionPercent || 0) || 0
    }))
    .filter((x) => x.ru && x.commissionPercent > 0)
    .map((x) => ({
      ...x,
      levels: x.ru.toLowerCase().split("-").map((s) => s.trim()).filter(Boolean)
    }))
    .sort((a, b) => b.levels.length - a.levels.length);
  const matchCommissionByPrefix = (categoryRu) => {
    const levels = String(categoryRu || "").toLowerCase().split("-").map((s) => s.trim()).filter(Boolean);
    if (!levels.length) return 0;
    for (const rule of seedPrefix) {
      if (rule.levels.length > levels.length) continue;
      let ok = true;
      for (let i = 0; i < rule.levels.length; i += 1) {
        if (levels[i] !== rule.levels[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return rule.commissionPercent;
    }
    return 0;
  };
  const items = leaves.map((leaf) => {
    const leafId = String(leaf?.id || "").trim();
    const categoryRu = normalizeCategoryLevelsWithDash(String(leaf?.pathText || leaf?.name || ""));
    const categoryEn = enById.get(leafId) || "";
    const commissionPercent = seedByRu.get(categoryRu.toLowerCase()) || matchCommissionByPrefix(categoryRu) || 0;
    const categoryZh = zhById.get(leafId) || normalizeCategoryLevelsWithDash(buildZhCategoryFromRuEn(categoryRu, categoryEn));
    return {
      categoryRu,
      categoryZh,
      categoryEn,
      commissionPercent,
      keywords: buildCommissionKeywords({ categoryRu, categoryZh, categoryEn })
    };
  });
  const zhCoverage = items.filter((x) => /[\u3400-\u9fff]/.test(String(x.categoryZh || ""))).length;
  return {
    ok: true,
    items,
    warning: `Used Yandex /v2/categories fallback with ${items.length} categories; zh coverage ${zhCoverage}/${items.length}; commission inherited from legal seed when matched`
  };
}










async function syncYandexCommissionCatalogFromOnlineProducts() {
  const yandexShops = (db.shops || []).filter((shop) => String(shop?.provider || "").toLowerCase() === "yandex_market" && shop?.enabled && shop?.apiKey && shop?.campaignId);
  const allProducts = Array.isArray(db.onlineProducts) ? db.onlineProducts : [];
  const catalogItems = [];
  const errors = [];
  let calculated = 0;
  let skipped = 0;
  let refreshed = 0;
  const now = new Date().toISOString();
  for (const shop of yandexShops) {
    if (!shop.businessId) {
      errors.push({ shopId: shop.id, message: "缺少 businessId，无法读取商品参数" });
      continue;
    }
    // Calculate from a fresh mapping response. It supplies the real leaf
    // category, price and package attributes required by /v2/tariffs/calculate.
    const mappingResult = await fetchYandexOfferMappingsPaged(shop.businessId, shop.apiKey);
    if (!mappingResult.ok) {
      errors.push({ shopId: shop.id, message: mappingResult.message || "无法读取 Yandex 商品参数" });
      continue;
    }
    const existingByKey = new Map(
      allProducts
        .filter((product) => String(product?.shopId || "") === String(shop.id || ""))
        .map((product) => [buildOnlineProductKey(product), product])
    );
    for (const entry of mappingResult.items || []) {
      const incoming = mapYandexOfferEntryToProduct(entry, shop);
      if (!incoming.shopSku) continue;
      const key = buildOnlineProductKey(incoming);
      const existing = existingByKey.get(key);
      if (existing) {
        Object.assign(existing, incoming, { id: existing.id, createdAt: existing.createdAt || incoming.createdAt, updatedAt: now });
      } else {
        allProducts.push(incoming);
        existingByKey.set(key, incoming);
      }
      refreshed += 1;
    }
    const products = allProducts.filter((product) => String(product?.shopId || "") === String(shop.id || ""));
    if (!products.length) {
      errors.push({ shopId: shop.id, message: "该店铺没有已同步的在线产品" });
      continue;
    }
    const result = await calculateYandexOnlineProductFees(shop, products);
    calculated += result.calculated;
    skipped += result.skipped;
    errors.push(...(result.errors || []));
    for (const product of products) {
      const fee = result.byKey.get(String(product.id || buildOnlineProductKey(product)));
      if (!fee?.ok) {
        product.commissionStatus = fee?.message ? "pending" : "unavailable";
        product.commissionError = String(fee?.message || "未计算");
        product.commissionFetchedAt = now;
        continue;
      }
      product.commissionPercent = fee.percent;
      product.commissionAmountRub = fee.amount;
      product.commissionSource = "yandex_tariffs_calculate";
      product.commissionStatus = "calculated";
      product.commissionError = "";
      product.commissionFetchedAt = now;
      catalogItems.push({
        shopId: String(shop.id || ""),
        shopName: String(shop.name || ""),
        categoryId: String(product.categoryId || ""),
        categoryRu: String(product.categoryName || product.categoryId || ""),
        categoryZh: "",
        categoryEn: "",
        commissionPercent: fee.percent,
        fetchedAt: now,
        keywords: []
      });
    }
  }
  const deduped = Array.from(new Map(catalogItems.map((item) => [`${item.shopId}::${item.categoryId}::${item.commissionPercent}`, item])).values());
  db.yandexCommissionCatalog = normalizeYandexCommissionCatalog({
    source: "yandex_tariffs_calculate",
    fetchedAt: now,
    itemCount: deduped.length,
    items: deduped,
    warning: errors.length || skipped ? `已刷新 ${refreshed} 个商品并计算 ${calculated} 个；待补字段 ${skipped} 个；接口失败批次 ${errors.length} 个` : ""
  });
  saveDatabase();
  if (!yandexShops.length) return { ok: false, status: 400, message: "没有已启用且已配置 API Key、campaignId 的 Yandex 店铺" };
  return { ok: calculated > 0, status: calculated > 0 ? 200 : 502, message: calculated > 0 ? "" : (errors[0]?.message || "没有可计算佣金的商品"), data: db.yandexCommissionCatalog, refreshed, calculated, skipped };
}


























// Reads the per-card content status from
// POST /v2/businesses/{businessId}/offer-cards: how complete each card is, which
// recommendations Yandex returns to improve it, and the average rating of cards in
// the same category. Read-only; never called during publish.

// Walks every page of a shop's cards so one user action captures the whole catalog.


if (require.main === module) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shutdownGracefully(signal).catch((error) => {
        logError(`Shutdown failed: ${String(error)}`);
        process.exit(1);
      });
    });
  }
  startServer().catch((error) => {
    console.error("Server startup failed:", String(error?.stack || error));
    process.exitCode = 1;
  });
}

// Test hook: returns the exact shape that sqlWriters.saveDatabaseToSql() writes to MySQL, so a
// test can assert what would be persisted without mutating the live database.
function exportSerializedDatabaseForTest() {
  return serializeDatabase(db);
}

// Test hook: adds a shop to the live in-memory database so a request handler can
// resolve it. Mutates the array in place, which keeps every other reference to
// db.shops valid.
function seedShopForTest(shop) {
  if (!Array.isArray(db.shops)) db.shops = [];
  const id = String(shop?.id || "").trim();
  if (!id) throw new Error("seedShopForTest requires a shop id");
  const index = db.shops.findIndex((entry) => String(entry?.id || "") === id);
  if (index >= 0) db.shops[index] = shop;
  else db.shops.push(shop);
  return shop;
}

// Test hook: adds a publish product to the live in-memory database so a request
// handler can resolve it. Mutates the array in place.
function seedPublishProductForTest(item) {
  if (!Array.isArray(db.publishProducts)) db.publishProducts = [];
  const id = String(item?.id || "").trim();
  if (!id) throw new Error("seedPublishProductForTest requires an id");
  const index = db.publishProducts.findIndex((entry) => String(entry?.id || "") === id);
  if (index >= 0) db.publishProducts[index] = item;
  else db.publishProducts.push(item);
  return item;
}

// Test hook: `authService.findUserByUsername` only reads the in-memory list, so an operator the
// test needs must be added there (a row written straight to MySQL is invisible).
function seedUserForTest(user) {
  if (!Array.isArray(db.users)) db.users = [];
  const username = String(user?.username || "").trim();
  if (!username) throw new Error("seedUserForTest requires a username");
  const index = db.users.findIndex((entry) => String(entry?.username || "").toLowerCase() === username.toLowerCase());
  if (index >= 0) db.users[index] = user;
  else db.users.push(user);
  return user;
}

// Test hook: orderPurchaseOverrides 是表属主实体，serializeDatabase() 的快照里按归属清单
// 剔除了它，所以「启动是否真的把 order_purchases 回填进内存」这件事只能单独读取来断言。
function exportOrderPurchaseOverridesForTest() {
  return Array.isArray(db?.orderPurchaseOverrides) ? db.orderPurchaseOverrides : [];
}

module.exports = {
  closeAppRuntime,
  coerceEnabledFlag,
  createApp,
  exportOrderPurchaseOverridesForTest,
  exportSerializedDatabaseForTest,
  hydrateOrderPurchaseOverridesFromSql,
  extractFreshLogEntries,
  initializeAppRuntime,
  readMysqlPassword,
  readRecentLocalErrorTail,
  seedPublishProductForTest,
  seedShopForTest,
  seedUserForTest,
  startServer
};
