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
const { applyOrderPurchaseOverrides, backfillOrderAmounts, backfillOrderPurchaseFields, buildOrderPurchasePayload, dedupeOrders, findOrderByRef, findOrderIndexByRef, hasTextValue, inferHistoricalOrderRevenue, restorePurchaseFromAuditLogs } = require("./order-backfill");;
const { buildDeliveryServiceMap, collectYandexOfferIds, enrichYandexOfferMapWithOnlineProducts, extractYandexOrderId, extractYandexTracking, firstItemSku, mapYandexOfferEntryToProduct, mapYandexOrderToLocal, normalizeItemCount } = require("./yandex-orders-map");;
const { attachShopIdsToOnlineProducts, attachShopIdsToOrders, filterOnlineProductsByAssignments, filterOrdersByAssignments, canUserAccessShop, getUserAssignedShopIds, normalizeShopAssignments, resolvePublishPlatformFromShopId, resolvePublishTargetShopId, resolveScopedDraftShopId } = require("./shop-scope");;
const { buildPublishProductKey, expandPublishProductToYandexPayloads, getPublishProductAttributeTerms, getPublishProductCategoryId, isLockedPublishProduct, normalizeOnlineProductRecord, normalizePublishProductRecord, validatePublishProductForYandex } = require("./publish-normalize");;
const { filterAuditLogs, filterOrders, hasFilterQuery } = require("./order-filters");;
const { YANDEX_LEGAL_RATE_URL_RU, YANDEX_LEGAL_RATE_URL_ZH, normalizeProductCategoryKnowledge, normalizeYandexCommissionCatalog } = require("./catalog-normalize");;
const { fetchAllYandexOfferCards, fetchYandexCampaign, fetchYandexCategoryIndex, fetchYandexDeliveryServices, fetchYandexOfferCards, fetchYandexOfferMappings, fetchYandexOfferMappingsPaged, fetchYandexOrderDetail, fetchYandexOrderLabels, fetchYandexOrders } = require("./yandex-fetch");;
const { buildLogCheckerReport, extractFreshLogEntries, formatAuditWarnings, readRecentLocalErrorTail, sanitizeAuditLogForClient, sanitizeProductPublishAuditPayload } = require("./log-checker");;
const { upsertCollectionBoxEntry, applyPublishOutcome, listCollectionBox, listPublishRecords, resetOwnedPageStoresOnce, normalizeCollectionBoxEntry, normalizePublishRecordEntry } = require("./page-stores");;
const { createAuthService } = require("./auth-service");;
const { createSqlWriters, ORDER_PURCHASE_FIELDS } = require("./sql-persistence");;
const { createRatesRoutes } = require("./routes/rates");;
const { createAuditRoutes } = require("./routes/audit");;
const { createMessagesRoutes } = require("./routes/messages");;
const { createUsersRoutes } = require("./routes/users");;
const { createShopsRoutes } = require("./routes/shops");;
const { createReviewRulesRoutes } = require("./routes/review-rules");;
const { createCategoryMappingRoutes } = require("./routes/category-mapping");;
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
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const BACKEND_DIR = __dirname;
const APP_ROOT = path.resolve(BACKEND_DIR, "..");
const DATA_DIR = path.resolve(APP_ROOT, String(process.env.DATA_DIR || APP_ROOT));
const LOG_DIR = path.resolve(APP_ROOT, String(process.env.LOG_DIR || APP_ROOT));
const APP_LOG_FILE = path.join(LOG_DIR, "server.out.log");
const APP_ERROR_LOG_FILE = path.join(LOG_DIR, "server.err.log");
const YANDEX_MARKET_BASE_URL = process.env.YANDEX_MARKET_BASE_URL || "https://api.partner.market.yandex.ru";
// 刊登前的卡片质量门槛：Yandex 官方建议把卡片质量保持在 80 分以上。
const PUBLISH_QUALITY_MIN_SCORE = 80;
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
let cachedRates = { ts: 0, payload: null };
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
let orderSyncTimer = null;
const orderSyncState = { running: false };
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
  listCollectionBox
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
  // 采集箱 / 上架记录 重新开始：旧数据一律清掉，不导入任何历史，
  // 之后只记录各自产生的新数据。跑一次记版本。
  try {
    if (resetOwnedPageStoresOnce(db)) await saveDatabase();
  } catch (error) {
    logError(`Resetting collection box / publish records failed: ${String(error)}`);
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
  if (orderSyncTimer) {
    clearTimeout(orderSyncTimer);
    orderSyncTimer = null;
  }
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
  startOrderSyncScheduler();
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
  respondApi(req, res, null, { ...auditBase, resourceType: "system" }, 404, { message: "Not found" });
}

function respondApi(req, res, actorUser, auditMeta, statusCode, payload) {
  sendJson(res, statusCode, payload);
  writeAudit(req, actorUser, auditMeta, statusCode, payload);
}


// 上架动作发生时，把结果写进「上架记录」自己的表，并同步采集箱条目的上架状态。
// 这两个页面只读写自己的数据，不依赖审计日志和刊登池是否还有商品。
function recordPublishOutcome(actorUser, items, options) {
  const outcome = applyPublishOutcome(db, actorUser, items, options);
  if (outcome.recorded) saveDatabase();
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
  if (!new Set(["read", "filter_query"]).has(String(auditMeta?.actionType || "read"))) {
    saveDatabase();
  }
}



function startOrderSyncScheduler() {
  if (!ORDER_SYNC_ENABLED) {
    console.log("Order auto sync disabled (ORDER_SYNC_ENABLED=0).");
    return;
  }
  scheduleNextOrderSync();
}

function parseOrderSyncDailyTime(value) {
  const match = String(value || "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return { hour: 6, minute: 0, valid: false };
  return { hour: Number(match[1]), minute: Number(match[2]), valid: true };
}

function scheduleNextOrderSync() {
  if (orderSyncTimer) {
    clearTimeout(orderSyncTimer);
    orderSyncTimer = null;
  }
  const parsed = parseOrderSyncDailyTime(ORDER_SYNC_DAILY_TIME);
  const now = new Date();
  const next = new Date(now);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const delay = Math.max(1000, next.getTime() - now.getTime());
  if (!parsed.valid) {
    console.log(`Invalid ORDER_SYNC_DAILY_TIME="${ORDER_SYNC_DAILY_TIME}", fallback to 06:00.`);
  }
  console.log(`Order auto sync scheduled at ${next.toLocaleString()}.`);
  orderSyncTimer = setTimeout(async () => {
    try {
      await runScheduledOrderSync();
    } catch (error) {
      console.error("Order auto sync failed:", error);
    } finally {
      scheduleNextOrderSync();
    }
  }, delay);
}

async function runScheduledOrderSync() {
  if (orderSyncState.running) {
    console.log("Order auto sync skipped: previous run still in progress.");
    return;
  }
  orderSyncState.running = true;
  try {
    const enabledShops = Array.isArray(db?.shops) ? db.shops.filter((s) => Boolean(s.enabled)) : [];
    const summary = await syncOrdersForShops(enabledShops);
    console.log(
      `Order auto sync done: added=${summary.added}, updated=${summary.updated}, skipped=${summary.skipped}, shops=${enabledShops.length}, errors=${summary.errors.length}`
    );
  } finally {
    orderSyncState.running = false;
  }
}

// 并发执行 worker，最多 limit 个同时在跑，保持输入顺序输出结果。
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runner = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const poolSize = Math.max(1, Math.min(16, Number(limit) || 4));
  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, () => runner()));
  return results;
}

async function syncOrdersForShops(shops, options = {}) {
  if (!Array.isArray(db.orders)) db.orders = [];
  const existingOrderByKey = new Map(
    db.orders
      .map((o) => [getOrderUniqueKey(o), o])
      .filter(([key]) => Boolean(key))
  );
  const seenOrderKeys = new Set();
  const targetShops = Array.isArray(shops) ? shops : [];
  const targetOrderNos = Array.isArray(options.orderNos) ? options.orderNos.map((item) => String(item || "").trim()).filter(Boolean) : [];

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  const acceptOrder = (order, shop) => {
    if (!order?.shopOrderNo) return { action: "skipped", message: "订单缺少: 订单号" };
    backfillOrderProductMatches([order], db.onlineProducts || []);
    backfillOrderPurchaseFields([order], db.onlineProducts || []);
    applyHistoricalRevenueFallback(order, inferHistoricalOrderRevenue(order, db.orders));
    const orderKey = getOrderUniqueKey(order);
    if (!orderKey) return { action: "skipped", message: "订单缺少唯一标识" };
    if (seenOrderKeys.has(orderKey)) return { action: "skipped" };
    seenOrderKeys.add(orderKey);
    const existingOrder = existingOrderByKey.get(orderKey);
    if (!existingOrder) {
      const newOrder = { ...order, updatedAt: new Date().toISOString() };
      db.orders.unshift(newOrder);
      existingOrderByKey.set(orderKey, newOrder);
      return { action: "added" };
    }
    const incomingAmount = Number(order.amount);
    const resolvedAmount = Number.isFinite(incomingAmount) && incomingAmount > 0 ? incomingAmount : Number(existingOrder.amount) || 0;
    const changed =
      Number(existingOrder.amount || 0) !== Number(resolvedAmount || 0) ||
      String(existingOrder.status || "") !== String(order.status || "") ||
      String(existingOrder.shopStatus || "") !== String(order.shopStatus || "") ||
      String(existingOrder.shopSubstatus || "") !== String(order.shopSubstatus || "") ||
      String(existingOrder.customerReceiptCode || "") !== String(order.customerReceiptCode || "") ||
      String(existingOrder.customerReceivedAt || "") !== String(order.customerReceivedAt || "") ||
      String(existingOrder.deadlineAt || "") !== String(order.deadlineAt || "") ||
      String(existingOrder.logistics || "") !== String(order.logistics || "") ||
      String(existingOrder.warehouse || "") !== String(order.warehouse || "") ||
      String(existingOrder.trackingNo || "") !== String(order.trackingNo || "") ||
      String(existingOrder.shopSku || "") !== String(order.shopSku || "") ||
      Number(existingOrder.itemCount || 0) !== Number(order.itemCount || 0) ||
      JSON.stringify(existingOrder.items || []) !== JSON.stringify(order.items || []);
    Object.assign(existingOrder, {
      ...existingOrder, ...order, amount: resolvedAmount, updatedAt: new Date().toISOString(),
      purchasePriceRmb: hasTextValue(order.purchasePriceRmb) ? order.purchasePriceRmb : existingOrder.purchasePriceRmb || "",
      purchasePriceRub: hasTextValue(order.purchasePriceRub) ? order.purchasePriceRub : existingOrder.purchasePriceRub || "",
      purchaseLink: hasTextValue(order.purchaseLink) ? order.purchaseLink : existingOrder.purchaseLink || ""
    });
    return { action: changed ? "updated" : "skipped" };
  };

  for (const shop of targetShops) {
    try {
      if (!shop.apiKey || !shop.campaignId) {
        skipped += 1;
        errors.push({ shopId: shop.id, message: "缺少apiKey或campaignId" });
        continue;
      }
      if (shop.provider === "ozon") {
        const result = await fetchOzonFbsOrders(shop.campaignId, shop.apiKey, {
          fromDate: options.fromDate || "",
          toDate: options.toDate || "",
          orderNos: targetOrderNos
        });
        if (!result.ok) {
          skipped += 1;
          errors.push({ shopId: shop.id, message: result.message || "Ozon订单拉取失败" });
          continue;
        }
        if (targetOrderNos.length && !result.items.length) {
          skipped += 1;
          errors.push({ shopId: shop.id, message: "指定订单号未在该店铺找到" });
          continue;
        }
        for (const raw of result.items) {
          const outcome = acceptOrder(mapOzonPostingToLocal(raw, shop), shop);
          if (outcome.action === "added") added += 1;
          else if (outcome.action === "updated") updated += 1;
          else skipped += 1;
          if (outcome.message) errors.push({ shopId: shop.id, message: outcome.message });
        }
        continue;
      }
      if (shop.provider !== "yandex_market") {
        skipped += 1;
        continue;
      }
      const detailedOrders = [];
      if (targetOrderNos.length > 0) {
        for (const orderNo of targetOrderNos) {
          const detail = await fetchYandexOrderDetail(shop.campaignId, shop.apiKey, orderNo);
          if (!detail.ok || !detail.item) {
            errors.push({
              shopId: shop.id,
              message: detail.message || "订单详情拉取失败，可能是 Api-Key 权限不足或已失效"
            });
            continue;
          }
          detailedOrders.push(detail.item);
        }
        if (!detailedOrders.length) {
          skipped += 1;
          errors.push({ shopId: shop.id, message: "指定订单号未在该店铺找到" });
          continue;
        }
      } else {
        const result = await fetchYandexOrders(shop.campaignId, shop.apiKey, {
          businessId: shop.businessId || "",
          fromDate: options.fromDate || "",
          toDate: options.toDate || ""
        });
        if (!result.ok) {
          skipped += 1;
          errors.push({
            shopId: shop.id,
            message: result.message || "拉取失败，可能是 Api-Key 权限不足、已过期或店铺范围不匹配"
          });
          continue;
        }
        // The list endpoint may include only the first item. Order detail is
        // required to persist every product in a multi-item order. Fetch the
        // details concurrently so a full sync does not stall on serial calls.
        const detailResults = await mapWithConcurrency(result.items || [], 8, async (raw) => {
          const orderId = extractYandexOrderId(raw);
          if (!orderId) return { orderId: "", item: null, message: "订单缺少ID" };
          const detail = await fetchYandexOrderDetail(shop.campaignId, shop.apiKey, orderId);
          return detail.ok && detail.item
            ? { orderId, item: detail.item, message: "" }
            : { orderId, item: null, message: detail.message || `订单${orderId}详情拉取失败，可能是 Api-Key 权限不足或已失效` };
        });
        for (const entry of detailResults) {
          if (!entry.item) {
            skipped += 1;
            errors.push({ shopId: shop.id, message: entry.message });
            continue;
          }
          detailedOrders.push(entry.item);
        }
      }

      const offerIds = collectYandexOfferIds(detailedOrders);
      let offerMap = {};
      if (offerIds.length && shop.businessId) {
        const offerResult = await fetchYandexOfferMappings(String(shop.businessId), shop.apiKey, offerIds);
        if (offerResult.ok) {
          offerMap = offerResult.map || {};
        } else {
          errors.push({
            shopId: shop.id,
            message: offerResult.message || "拉取商品映射失败，可能是 Api-Key 权限不足或已失效"
          });
        }
      }
      // The order-detail API often omits per-SKU pictures. Enrich its mapping
      // from the ERP's own platform-product table before building order items.
      offerMap = enrichYandexOfferMapWithOnlineProducts(offerMap, db.onlineProducts || [], shop);
      for (const raw of detailedOrders) {
        const order = mapYandexOrderToLocal(raw, shop, offerMap);
        const outcome = acceptOrder(order, shop);
        if (outcome.action === "added") added += 1;
        else if (outcome.action === "updated") updated += 1;
        else skipped += 1;
        if (outcome.message) errors.push({ shopId: shop.id, message: outcome.message });
      }
    } catch (error) {
      skipped += 1;
      errors.push({ shopId: shop.id, message: `店铺同步异常：${String(error)}` });
    }
  }

  db.orders = dedupeOrders(db.orders);
  applyOrderPurchaseOverrides(db.orders, db.orderPurchaseOverrides || []);
  saveDatabase();
  return { added, updated, skipped, errors, errorSummary: errors.map((item) => `店铺${item.shopId}: ${item.message}`).filter(Boolean) };
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


function getRecentAuditIssues(hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return (db.auditLogs || []).filter((item) => {
    const ts = new Date(item.ts).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) return false;
    return !item.success || String(item.warningMessage || "").trim();
  });
}









async function refreshOrderProfitSnapshots() {
  if (!sqlReady || !sqlPool) return 0;
  let rubPurchaseCostRate = 0;
  let cnyRateRub = 0;
  try {
    const [rows] = await sqlPool.query(
      `SELECT cnyRateRub, rubPurchaseCostRate
       FROM exchange_rates_daily
       WHERE (cnyRateRub IS NOT NULL AND cnyRateRub > 0) OR (rubPurchaseCostRate IS NOT NULL AND rubPurchaseCostRate > 0)
       ORDER BY rateDate DESC
       LIMIT 1`
    );
    const row = rows?.[0];
    cnyRateRub = normalizeNullableNumber(row?.cnyRateRub) || 0;
    rubPurchaseCostRate = normalizeNullableNumber(row?.rubPurchaseCostRate) || 0;
  } catch (error) {
    console.error("Order profit refresh: exchange rates unavailable:", String(error));
    return 0;
  }

  const rates = deriveRates(rubPurchaseCostRate, cnyRateRub);
  const rules = Array.isArray(db.reviewRules) ? db.reviewRules : [];
  const now = new Date().toISOString();
  let changed = 0;
  for (const order of Array.isArray(db.orders) ? db.orders : []) {
    const rule = findMatchingReviewRule(order, rules);
    if (!rule) continue;
    if (normalizeNullableNumber(order?.amount) === null) continue;
    if (order.profitUpdatedAt) continue;
    const profit = computeOrderProfit(order, rule, rates);
    order.profitRmb = profit.profitRmb;
    order.profitRub = profit.profitRub;
    order.profitUpdatedAt = now;
    Object.assign(order, {
      matchedRuleId: profit.matchedRuleId,
      matchedRuleName: profit.matchedRuleName,
      purchaseCostRmb: profit.purchaseCostRmb,
      purchaseCostRub: profit.purchaseCostRub,
      commissionPercent: profit.commissionPercent,
      commissionRmb: profit.commissionRmb,
      commissionRub: profit.commissionRub,
      logisticsFeeRmb: profit.logisticsFeeRmb,
      logisticsFeeRub: profit.logisticsFeeRub,
      otherFeeRmb: profit.otherFeeRmb,
      otherFeeRub: profit.otherFeeRub,
      packingFeeRmb: profit.packingFeeRmb,
      packingFeeRub: profit.packingFeeRub,
      withdrawPercent: profit.withdrawPercent,
      withdrawFeeRmb: profit.withdrawFeeRmb,
      withdrawFeeRub: profit.withdrawFeeRub,
      transferPercent: profit.transferPercent,
      transferFeeRmb: profit.transferFeeRmb,
      transferFeeRub: profit.transferFeeRub
    });
    changed += 1;
  }
  if (changed > 0) {
    await sqlWriters.saveOrdersToSql(db.orders);
  }
  return changed;
}



async function fetchCbrRate(currency) {
  const now = Date.now();
  if (cachedRates.payload && now - cachedRates.ts < 30 * 60 * 1000) {
    return mapCbrRate(cachedRates.payload, currency);
  }

  try {
    const result = await fetchJson(CBR_DAILY_JSON_URL);
    if (!result.ok || !result.data) {
      const stored = await fetchStoredCbrRate(currency);
      return stored.ok ? stored : { ok: false, status: result.status, message: "Failed to fetch CBR rates" };
    }
    cachedRates = { ts: now, payload: result.data };
    return mapCbrRate(result.data, currency);
  } catch (error) {
    const stored = await fetchStoredCbrRate(currency);
    return stored.ok ? stored : { ok: false, status: 502, message: String(error) };
  }
}

async function fetchStoredCbrRate(currency) {
  if (String(currency || "").trim().toUpperCase() !== "CNY" || !sqlReady || !sqlPool) {
    return { ok: false, status: 404, message: "Stored CBR rate unavailable" };
  }
  try {
    const [rows] = await sqlPool.query(
      `SELECT rateDate, cnyRateRub, source
       FROM exchange_rates_daily
       WHERE cnyRateRub IS NOT NULL AND cnyRateRub > 0
       ORDER BY rateDate DESC
       LIMIT 1`
    );
      const row = rows?.[0];
      const rate = normalizeNullableNumber(row?.cnyRateRub);
      if (rate !== null && rate > 0) {
        const rateDate = String(row.rateDate || "");
        const stale = !isExchangeRateFresh(rateDate, new Date(), CURRENCY_RATE_MAX_AGE_DAYS);
        return {
        ok: true,
        stale,
        warning: stale ? `Stored CBR rate is older than ${CURRENCY_RATE_MAX_AGE_DAYS} days` : "",
        data: {
          base: "RUB",
          currency: "CNY",
          rate,
          date: rateDate,
          source: String(row.source || "exchange_rates_daily")
        }
      };
    }
  } catch (error) {
    console.error("MySQL CBR snapshot unavailable:", String(error));
  }
  return { ok: false, status: 404, message: "Stored CBR rate unavailable" };
}

async function fetchRubPurchaseCostRate() {
  if (sqlReady && sqlPool) {
    try {
      const [rows] = await sqlPool.query(
        `SELECT rateDate, rubPurchaseCostRate, source
         FROM exchange_rates_daily
         WHERE rubPurchaseCostRate IS NOT NULL AND rubPurchaseCostRate > 0
         ORDER BY rateDate DESC
         LIMIT 1`
      );
      const row = rows?.[0];
      const rate = normalizeNullableNumber(row?.rubPurchaseCostRate);
      if (rate !== null && rate > 0) {
        return {
          ok: true,
          data: {
            rate,
            date: String(row.rateDate || ""),
            source: String(row.source || "exchange_rates_daily")
          }
        };
      }
    } catch (error) {
      console.error("MySQL exchange_rates_daily unavailable:", String(error));
    }
  }

  const cbr = await fetchCbrRate("CNY");
  const cnyRateRub = normalizeNullableNumber(cbr?.data?.rate);
  if (cbr.ok && cnyRateRub !== null && cnyRateRub > 0) {
    return {
      ok: true,
      data: {
        rate: 1 / cnyRateRub,
        date: String(cbr.data.date || ""),
        source: "cbr-derived"
      }
    };
  }
  return { ok: false, status: 502, message: "RUB purchase cost rate unavailable" };
}

function mapCbrRate(payload, currency) {
  if (!payload || !payload.Valute || !payload.Valute[currency]) {
    return { ok: false, status: 404, message: `Currency ${currency} not found` };
  }
  const item = payload.Valute[currency];
  const value = Number(item.Value);
  const nominal = Number(item.Nominal || 1);
  if (!Number.isFinite(value) || !Number.isFinite(nominal) || nominal <= 0) {
    return { ok: false, status: 500, message: "Invalid rate data" };
  }
  const rate = value / nominal;
  return {
    ok: true,
    data: {
      base: "RUB",
      currency,
      rate,
      date: payload.Date || payload.Timestamp || ""
    }
  };
}









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




















// 刊登前评估本次要刊登的 SKU 的卡片质量分。优先实时拉取 Yandex，拉不到时回退到
// 已存储的快照；既拉不到又没有快照的新品视为“无卡片可评估”，不拦截。
async function evaluatePublishQualityGate(shop, offerIds, minScore = PUBLISH_QUALITY_MIN_SCORE) {
  const ids = Array.from(new Set((Array.isArray(offerIds) ? offerIds : []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (!ids.length) {
    return { offerRatings: new Map(), blockedOfferIds: new Set(), evaluated: false, fetchFailed: false };
  }

  const offerRatings = new Map();
  let fetchFailed = false;
  try {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const chunk = ids.slice(offset, offset + 200);
      const result = await fetchYandexOfferCards(String(shop?.businessId || ""), shop?.apiKey, { offerIds: chunk });
      if (!result.ok) throw new Error(result.message || "offer cards failed");
      for (const offer of Array.isArray(result.offers) ? result.offers : []) {
        const offerId = String(offer?.offerId || "").trim();
        const rating = Number(offer?.rating);
        if (offerId && Number.isFinite(rating)) offerRatings.set(offerId, rating);
      }
    }
  } catch (error) {
    fetchFailed = true;
  }

  if (fetchFailed && isSqlReady() && getSqlPool() && String(shop?.id || "").trim()) {
    try {
      const stored = await readCardQualityByOffers(getSqlPool(), String(shop.id || ""), ids);
      for (const row of Array.isArray(stored) ? stored : []) {
        const offerId = String(row?.offerId || "").trim();
        const rating = Number(row?.rating);
        if (offerId && Number.isFinite(rating)) offerRatings.set(offerId, rating);
      }
    } catch (storedError) {
      console.error("[quality-gate] stored card quality fallback failed:", String(storedError));
    }
  }

  const blockedOfferIds = new Set();
  for (const [offerId, rating] of offerRatings.entries()) {
    if (rating < minScore) blockedOfferIds.add(offerId);
  }
  return { offerRatings, blockedOfferIds, evaluated: true, fetchFailed };
}

// 老产品不能动：只有已经成功/部分刊登过的才算老产品，不再参与质量拦截。
// 其余全部按新刊登处理（包括从产品库复制过来的），刊登前先评估卡片质量分。
function isExistingPublishProduct(item) {
  const status = String(item?.lastPublishStatus || item?.publishStatus || "").trim().toLowerCase();
  return status === "success" || status === "partial";
}

async function executeProductPublish(actorUser, items, fallbackShopId, shops, options = {}) {
  let sourceItems = Array.isArray(items) ? items.filter(Boolean) : [];
  for (const item of sourceItems) {
    if (String(item?.source || "") === "yandex_online_product" && !String(item?.description || "").trim()) {
      item.description = String(item?.title || item?.name || "").trim();
      item.updatedAt = new Date().toISOString();
    }
  }
  const enforceScope = options.enforceScope !== false;
  const publishSettings = normalizePublishSettings(db.publishSettings || {});
  const qualityMinScore = Number.isFinite(Number(publishSettings.qualityMinScore)) ? Number(publishSettings.qualityMinScore) : PUBLISH_QUALITY_MIN_SCORE;
  if (publishSettings.dailyPublishLimit > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const publishedToday = (db.publishProducts || []).filter((item) =>
      String(item?.lastPublishStatus || item?.publishStatus || "") === "success" &&
      String(item?.lastPublishAt || item?.publishAt || "").slice(0, 10) === today
    ).length;
    const remaining = Math.max(0, publishSettings.dailyPublishLimit - publishedToday);
    if (sourceItems.length > remaining) {
      return { statusCode: 429, payload: { message: `已达到每日刊登上限或本次数量超限：上限 ${publishSettings.dailyPublishLimit}，今日已刊登 ${publishedToday}，剩余 ${remaining}` } };
    }
  }
  const grouped = new Map();
  const shopResolveErrors = [];
  for (const item of sourceItems) {
    const resolvedShop = enforceScope
      ? resolvePublishTargetShopId(actorUser, item, fallbackShopId, shops)
      : resolvePublishTargetShopId(null, item, fallbackShopId, shops);
    if (!resolvedShop.ok) {
      shopResolveErrors.push({
        id: String(item?.id || "").trim(),
        sku: String(item?.sku || item?.vendorCode || "").trim(),
        title: String(item?.title || "").trim(),
        message: resolvedShop.message
      });
      continue;
    }
    item.shopId = resolvedShop.shopId;
    if (!grouped.has(resolvedShop.shopId)) grouped.set(resolvedShop.shopId, []);
    grouped.get(resolvedShop.shopId).push(item);
  }
  if (shopResolveErrors.length) {
    const statusCode = shopResolveErrors.some((entry) => entry.message.startsWith("Forbidden")) ? 403 : 400;
    const summary = shopResolveErrors
      .slice(0, 3)
      .map((entry) => `${entry.sku || entry.id || "Unnamed item"}: ${entry.message}`)
      .join(" | ");
    return {
      statusCode,
      payload: {
        message: `Publish failed: ${summary || "请选择店铺（shopId）"}`,
        errors: shopResolveErrors
      }
    };
  }

  const publishValidationErrors = sourceItems
    .map((item) => ({
      id: String(item?.id || "").trim(),
      sku: String(item?.sku || item?.vendorCode || "").trim(),
      title: String(item?.title || "").trim(),
      validation: validatePublishProductForYandex(item, { requirePositiveStock: false })
    }))
    .filter((entry) => !entry.validation.ok)
    .map((entry) => ({
      id: entry.id,
      sku: entry.sku,
      title: entry.title,
      missingFields: entry.validation.missingFields,
      invalidFields: entry.validation.invalidFields,
      variantErrors: entry.validation.errors || [],
      message: entry.validation.message
    }));
  if (publishValidationErrors.length) {
    const summary = publishValidationErrors
      .slice(0, 3)
      .map((entry) => `${entry.sku || entry.id || "Unnamed item"}: ${entry.message}`)
      .join(" | ");
    return {
      statusCode: 400,
      payload: {
        message: `Publish failed: ${summary}`,
        errors: publishValidationErrors
      }
    };
  }

  const rows = [];
  const errors = [];
  let success = 0;
  let failed = 0;
  for (const [shopId, groupedItems] of grouped.entries()) {
    const shop = (shops || []).find((x) => String(x.id || "") === shopId);
    if (!shop || shop.provider !== "yandex_market") {
      failed += groupedItems.length;
      const message = "店铺不存在或不是Yandex店铺";
      rows.push({ shopId, success: 0, failed: groupedItems.length, message });
      errors.push({ shopId, message });
      continue;
    }
    if (!shop.businessId || !shop.apiKey) {
      failed += groupedItems.length;
      const message = "缺少businessId或apiKey";
      rows.push({ shopId, success: 0, failed: groupedItems.length, message });
      errors.push({ shopId, message });
      continue;
    }
    const mapped = groupedItems.flatMap((item) => expandPublishProductToYandexPayloads(item));
    if (!mapped.length) {
      failed += groupedItems.length;
      const message = "缺少有效的SKU或标题";
      rows.push({ shopId, success: 0, failed: groupedItems.length, message });
      errors.push({ shopId, message });
      continue;
    }
    const newItems = groupedItems.filter((item) => !isExistingPublishProduct(item));
    const newMapped = newItems.flatMap((item) => expandPublishProductToYandexPayloads(item));
    const publishOfferIds = newMapped.map((entry) => String(entry.offerId || "").trim()).filter(Boolean);
    const qualityGate = publishSettings.qualityGateEnabled && newMapped.length
      ? await evaluatePublishQualityGate(shop, publishOfferIds, qualityMinScore)
      : { offerRatings: new Map(), blockedOfferIds: new Set(), evaluated: false, fetchFailed: false };
    const allowedMapped = groupedItems.flatMap((item) => {
      const itemMapped = expandPublishProductToYandexPayloads(item);
      return isExistingPublishProduct(item)
        ? itemMapped
        : itemMapped.filter((entry) => !qualityGate.blockedOfferIds.has(String(entry.offerId || "").trim()));
    });
    if (qualityGate.blockedOfferIds.size) {
      errors.push({
        shopId,
        message: `卡片质量分低于 ${qualityMinScore}，已拦截刊登`,
        stage: "quality",
        details: Array.from(qualityGate.blockedOfferIds).map((offerId) => ({
          offerId,
          rating: qualityGate.offerRatings.get(offerId)
        }))
      });
    } else if (qualityGate.fetchFailed && qualityGate.offerRatings.size === 0) {
      errors.push({
        shopId,
        message: "无法评估卡片质量（Yandex 拉取失败且无历史快照），本次未做质量拦截",
        stage: "quality"
      });
    }
    if (!allowedMapped.length) {
      failed += groupedItems.length;
      const nowIso = new Date().toISOString();
      for (const item of groupedItems) {
        item.lastPublishAt = nowIso;
        item.lastPublishStatus = "failed";
        item.publishAt = nowIso;
        item.publishStatus = "failed";
        item.publishResultMessage = `卡片质量分低于 ${qualityMinScore}，未刊登`;
        item.updatedAt = nowIso;
      }
      rows.push({ shopId, success: 0, failed: groupedItems.length, message: `卡片质量分低于 ${qualityMinScore}，全部拦截` });
      continue;
    }
    if (publishSettings.simulateBackendPublishToYandex) {
      const sequentialErrors = [];
      let sequentialSuccess = 0;
      let sequentialFailed = 0;
      for (const item of groupedItems) {
        if (sequentialSuccess + sequentialFailed > 0 && publishSettings.publishIntervalSeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, publishSettings.publishIntervalSeconds * 1000));
        }
        const itemMappedAll = expandPublishProductToYandexPayloads(item);
        const itemMapped = isExistingPublishProduct(item)
          ? itemMappedAll
          : itemMappedAll.filter((entry) => !qualityGate.blockedOfferIds.has(String(entry.offerId || "").trim()));
        if (itemMappedAll.length && !itemMapped.length) {
          sequentialFailed += 1;
          const nowIso = new Date().toISOString();
          item.lastPublishAt = nowIso;
          item.lastPublishStatus = "failed";
          item.publishAt = nowIso;
          item.publishStatus = "failed";
          item.publishResultMessage = `卡片质量分低于 ${qualityMinScore}，未刊登`;
          item.updatedAt = nowIso;
          sequentialErrors.push({
            shopId,
            message: `${String(item.sku || item.id || "Unnamed item")}: 卡片质量分低于 ${qualityMinScore}，未刊登`,
            stage: "quality"
          });
          continue;
        }
        if (!itemMapped.length) {
          sequentialFailed += 1;
          item.lastPublishAt = new Date().toISOString();
          item.lastPublishStatus = "failed";
          item.publishAt = item.lastPublishAt;
          item.publishStatus = "failed";
          item.publishResultMessage = "缺少有效的SKU或标题";
          item.updatedAt = item.lastPublishAt;
          sequentialErrors.push({
            shopId,
            message: `${String(item.sku || item.id || "Unnamed item")}: 缺少有效的SKU或标题`
          });
          continue;
        }
        const yandexPublishResult = await publishYandexProducts({
          shop,
          products: itemMapped,
          apiBase: YANDEX_MARKET_BASE_URL,
          enrichProducts: enrichYandexItemsWithParameterValues
        });
        const mappingResult = yandexPublishResult.mapping;
        if (!mappingResult.ok) {
          sequentialFailed += itemMapped.length;
          item.lastPublishAt = new Date().toISOString();
          item.lastPublishStatus = "failed";
          item.publishAt = item.lastPublishAt;
          item.publishStatus = "failed";
          item.publishResultMessage = mappingResult.message || "发布失败";
          item.updatedAt = item.lastPublishAt;
          sequentialErrors.push({
            shopId,
            message: `${String(item.sku || item.id || "Unnamed item")}: ${mappingResult.message || "发布失败"}`,
            stage: "mapping",
            details: mappingResult.failed || []
          });
          continue;
        }
        const priceResult = yandexPublishResult.price;
        const stockResult = yandexPublishResult.stock;
        const failedOfferIds = new Set([
          ...(Array.isArray(mappingResult.failed) ? mappingResult.failed.map((x) => String(x.offerId || "").trim()) : []),
          ...(Array.isArray(priceResult.failed) ? priceResult.failed.map((x) => String(x.offerId || "").trim()) : []),
          ...(Array.isArray(stockResult.failed) ? stockResult.failed.map((x) => String(x.offerId || "").trim()) : [])
        ].filter(Boolean));
        const itemFailed = failedOfferIds.size;
        const itemSuccess = Math.max(0, itemMapped.length - itemFailed);
        const nowIso = new Date().toISOString();
        item.lastPublishAt = nowIso;
        item.updatedAt = nowIso;
        item.lastPublishStatus = itemFailed === 0 ? "success" : itemSuccess > 0 ? "partial" : "failed";
        item.publishAt = nowIso;
        item.publishStatus = item.lastPublishStatus;
        item.publishResultMessage = itemFailed === 0 ? "发布成功" : itemSuccess > 0 ? "部分成功" : "发布失败";
        sequentialSuccess += itemSuccess;
        sequentialFailed += itemFailed;
        if (!priceResult.ok || !stockResult.ok || itemFailed > 0) {
          const stageMessages = [];
          if (!priceResult.ok) stageMessages.push(`price: ${priceResult.message || "price update failed"}`);
          if (!stockResult.ok) stageMessages.push(`stock: ${stockResult.message || "stock update failed"}`);
          sequentialErrors.push({
            shopId,
            message: `${String(item.sku || item.id || "Unnamed item")}: ${stageMessages.join(" | ") || "部分发布失败"}`,
            details: { failedOffers: Array.from(failedOfferIds) }
          });
        }
      }
      success += sequentialSuccess;
      failed += sequentialFailed;
      rows.push({
        shopId,
        success: sequentialSuccess,
        failed: sequentialFailed,
        message: sequentialErrors.length ? "已按手动上架风格逐条调用 Yandex API，存在部分失败" : "已按手动上架风格逐条调用 Yandex API",
        details: {
          simulation: true,
          mode: "sequential_api",
          itemCount: groupedItems.length,
          offerCount: allowedMapped.length
        }
      });
      if (sequentialErrors.length) {
        errors.push(...sequentialErrors);
      }
      continue;
    }
    const yandexPublishResult = await publishYandexProducts({
      shop,
      products: allowedMapped,
      apiBase: YANDEX_MARKET_BASE_URL,
      enrichProducts: enrichYandexItemsWithParameterValues
    });
    const mappingResult = yandexPublishResult.mapping;
    if (!mappingResult.ok) {
      failed += allowedMapped.length;
      const message = mappingResult.message || "发布失败";
      rows.push({ shopId, success: 0, failed: allowedMapped.length, message });
      errors.push({ shopId, message, stage: "mapping", details: mappingResult.failed || [] });
      continue;
    }
    const priceResult = yandexPublishResult.price;
    const stockResult = yandexPublishResult.stock;
    const failedOfferIds = new Set([
      ...(Array.isArray(mappingResult.failed) ? mappingResult.failed.map((x) => String(x.offerId || "").trim()) : []),
      ...(Array.isArray(priceResult.failed) ? priceResult.failed.map((x) => String(x.offerId || "").trim()) : []),
      ...(Array.isArray(stockResult.failed) ? stockResult.failed.map((x) => String(x.offerId || "").trim()) : [])
    ].filter(Boolean));
    const shopFailed = failedOfferIds.size;
    const shopSuccess = Math.max(0, allowedMapped.length - shopFailed);
    const stageMessages = [];
    if (!priceResult.ok) stageMessages.push(`price: ${priceResult.message || "price update failed"}`);
    if (!stockResult.ok) stageMessages.push(`stock: ${stockResult.message || "stock update failed"}`);
    const nowIso = new Date().toISOString();
    const message = stageMessages.length ? `部分失败: ${stageMessages.join(" | ")}` : "发布成功";
    for (const item of groupedItems) {
      const itemOfferIds = expandPublishProductToYandexPayloads(item).map((entry) => String(entry.offerId || "").trim()).filter(Boolean);
      const itemFailed = itemOfferIds.some((offerId) => failedOfferIds.has(offerId));
      const itemSuccess = itemOfferIds.length > 0 && itemOfferIds.every((offerId) => !failedOfferIds.has(offerId));
      const qualityBlockedCount = isExistingPublishProduct(item)
        ? 0
        : itemOfferIds.filter((offerId) => qualityGate.blockedOfferIds.has(offerId)).length;
      item.lastPublishAt = nowIso;
      item.lastPublishStatus = itemSuccess ? "success" : itemFailed ? "partial" : "failed";
      item.publishAt = nowIso;
      item.publishStatus = item.lastPublishStatus;
      item.publishResultMessage = itemSuccess ? "发布成功" : itemFailed ? message : "发布失败";
      if (qualityBlockedCount > 0) {
        const qualityMessage = `卡片质量分低于 ${qualityMinScore}，未刊登（拦截 ${qualityBlockedCount} 个SKU）`;
        item.publishResultMessage = itemSuccess ? qualityMessage : `${item.publishResultMessage}；${qualityMessage}`;
        if (qualityBlockedCount === itemOfferIds.length) {
          item.lastPublishStatus = "failed";
          item.publishStatus = "failed";
          item.publishResultMessage = qualityMessage;
        } else if (!itemFailed) {
          item.lastPublishStatus = "partial";
          item.publishStatus = "partial";
        }
      }
      item.updatedAt = nowIso;
    }
    success += shopSuccess;
    failed += shopFailed;
    rows.push({
      shopId,
      success: shopSuccess,
      failed: shopFailed,
      message,
      details: {
        mapping: { ok: mappingResult.ok, success: mappingResult.success || 0, failed: mappingResult.failed || [] },
        price: { ok: priceResult.ok, success: priceResult.success || 0, failed: priceResult.failed || [], message: priceResult.message || "" },
        stock: { ok: stockResult.ok, success: stockResult.success || 0, failed: stockResult.failed || [], message: stockResult.message || "" }
      }
    });
    if (stageMessages.length || shopFailed > 0) {
      errors.push({ shopId, message, details: { failedOffers: Array.from(failedOfferIds) } });
    }
  }
  saveDatabase();
  return {
    statusCode: 200,
    payload: {
      success,
      failed,
      results: rows,
      errors
    }
  };
}

async function executeOzonProductPublish(actorUser, items, fallbackShopId, shops) {
  const grouped = new Map();
  const errors = [];
  for (const item of Array.isArray(items) ? items : []) {
    const resolved = resolvePublishTargetShopId(actorUser, item, fallbackShopId, shops);
    const shop = resolved.ok ? (shops || []).find((entry) => String(entry?.id || "") === resolved.shopId) : null;
    if (!resolved.ok || !shop || String(shop.provider || "").toLowerCase() !== "ozon") {
      errors.push({ id: item.id, sku: item.sku || "", message: resolved.message || "缺少有效的 Ozon 店铺" });
      continue;
    }
    item.shopId = resolved.shopId;
    if (!grouped.has(resolved.shopId)) grouped.set(resolved.shopId, []);
    grouped.get(resolved.shopId).push(item);
  }
  let success = 0;
  let processing = 0;
  let failed = errors.length;
  const results = [];
  for (const [shopId, groupedItems] of grouped.entries()) {
    const shop = (shops || []).find((entry) => String(entry?.id || "") === shopId);
    const result = await publishOzonProducts(shop, groupedItems);
    const now = new Date().toISOString();
    if (!result.ok) {
      failed += groupedItems.length;
      groupedItems.forEach((item) => {
        item.ozonPublishStatus = "failed";
        item.ozonErrorMessage = result.message || "Ozon 发布失败";
        item.publishStatus = "failed";
        item.lastPublishStatus = "failed";
        item.lastPublishAt = now;
        item.publishAt = now;
        item.publishResultMessage = item.ozonErrorMessage;
        item.updatedAt = now;
      });
      results.push({ shopId, success: 0, processing: 0, failed: groupedItems.length, message: result.message, details: result.invalid || [] });
      continue;
    }
    const byOfferId = new Map((result.items || []).map((entry) => [String(entry.offer_id || entry.offerId || "").trim(), entry]));
    let shopSuccess = 0;
    let shopProcessing = 0;
    groupedItems.forEach((item) => {
      const detail = byOfferId.get(String(item.sku || item.offerId || item.vendorCode || "").trim());
      const detailStatus = String(detail?.status || detail?.state || "").toLowerCase();
      const itemFailed = ["failed", "error", "cancelled"].includes(detailStatus) || Boolean(detail?.errors?.length);
      const itemDone = ["imported", "success", "completed"].includes(detailStatus);
      const itemStatus = itemFailed ? "failed" : itemDone ? "success" : "processing";
      item.ozonPublishStatus = itemStatus;
      item.ozonTaskId = result.taskId;
      item.ozonProductId = detail?.product_id || detail?.productId || item.ozonProductId || "";
      item.ozonPlatformSku = detail?.offer_id || detail?.offerId || item.ozonPlatformSku || "";
      item.ozonErrorMessage = itemFailed ? (detail?.errors?.[0]?.message || detail?.error || "Ozon 发布失败") : "";
      item.publishStatus = itemStatus;
      item.lastPublishStatus = itemStatus;
      item.lastPublishAt = now;
      item.publishAt = now;
      item.publishResultMessage = itemFailed ? item.ozonErrorMessage : itemDone ? "Ozon 发布成功" : "Ozon 任务处理中";
      item.updatedAt = now;
      if (itemFailed) failed += 1;
      else if (itemDone) { success += 1; shopSuccess += 1; }
      else { processing += 1; shopProcessing += 1; }
    });
    results.push({ shopId, taskId: result.taskId, success: shopSuccess, processing: shopProcessing, failed: groupedItems.length - shopSuccess - shopProcessing, timedOut: result.timedOut });
  }
  results.push(...errors.map((entry) => ({ ...entry, failed: 1 })));
  saveDatabase();
  return { statusCode: 200, payload: { success, processing, failed, results } };
}








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
    // 采集箱 / 上架记录 各自的独立数据（不与其他模块互通，见 page-stores.js）。
    collectionBox: [],
    publishRecords: [],
    pageStoresResetVersion: "",
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
    collectionBox: (Array.isArray(loaded.collectionBox) ? loaded.collectionBox : [])
      .map(normalizeCollectionBoxEntry)
      .filter(Boolean),
    publishRecords: (Array.isArray(loaded.publishRecords) ? loaded.publishRecords : [])
      .map(normalizePublishRecordEntry)
      .filter(Boolean),
    pageStoresResetVersion: String(loaded.pageStoresResetVersion || ""),
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
      try {
        const [purchaseRows] = await sqlPool.query(
          `SELECT orderRef, orderId, shopOrderNo, purchasePlatform, purchaseLink, purchaseOrderNo,
                  purchaseExpressNo, purchaseIntlNo, purchasePriceRmb, purchasePriceRub,
                  purchaseUpdatedAt, updatedAt
           FROM order_purchases`
        );
        sqlPurchaseTableWasEmpty = Array.isArray(purchaseRows) && purchaseRows.length === 0;
        if (Array.isArray(purchaseRows) && purchaseRows.length) {
          const byRef = new Map();
          for (const order of db.orders || []) {
            byRef.set(String(order.id || "").trim(), order);
            byRef.set(String(order.shopOrderNo || "").trim(), order);
          }
          for (const row of purchaseRows) {
            const order = byRef.get(String(row.orderRef || row.orderId || row.shopOrderNo || "").trim()) || byRef.get(String(row.orderId || row.shopOrderNo || "").trim());
            if (!order) continue;
            for (const field of ORDER_PURCHASE_FIELDS) {
              const value = String(row[field] || "");
              if (value.trim()) order[field] = value;
            }
          }
        }
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
    const response = await fetch(links.ru, { headers: { "User-Agent": "Mozilla/5.0" } });
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

module.exports = {
  closeAppRuntime,
  coerceEnabledFlag,
  createApp,
  exportSerializedDatabaseForTest,
  extractFreshLogEntries,
  initializeAppRuntime,
  readMysqlPassword,
  readRecentLocalErrorTail,
  seedPublishProductForTest,
  seedShopForTest,
  seedUserForTest,
  startServer
};
