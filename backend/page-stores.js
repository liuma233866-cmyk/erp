// 采集箱 / 上架记录 各自的独立数据。
//
// 这两个页面自成一套数据，不与其他模块互通：
// - 采集箱（db.collectionBox）：浏览器扩展投递进来的条目，删除只删采集箱自己，
//   不动刊登工作台（publishProducts）、产品库或在线产品。
// - 上架记录（db.publishRecords）：上架动作发生时写下的记录快照，带上当时的
//   SKU/标题/店铺/平台，不读审计日志，也不依赖刊登池里商品是否还在。
//
// 历史数据只在升级时一次性导入（见 seedOwnedPageStoresOnce），之后两个页面
// 的数据由自己产生、只被自己读取。

const { makeId } = require("./identity");
const { formatAuditWarnings } = require("./log-checker");

const PAGE_STORE_MAX_RECORDS = 5000;
const BLOCKED_PATTERN = /拦截|已拦|被拦|低于\s*\d+/;
// 采集箱历史导入的版本号：改导入口径时把它 +1，启动时会自动补齐缺失的条目。
const COLLECTION_BOX_SEED_VERSION = "2";

function text(value) {
  return String(value ?? "").trim();
}

// 采集条目的唯一键：来源平台 + 来源商品 ID（没有来源 ID 时退化成 SKU）+ 目标店铺。
// 同一款商品采集到两个店铺算两条，不会互相覆盖。
function collectorKey(item) {
  const platform = text(item?.sourcePlatform).toLowerCase();
  const sourceId = text(item?.sourceProductId) || text(item?.sku);
  const shopId = text(item?.shopId);
  return `${platform}::${sourceId}::${shopId}`;
}

// 只有浏览器扩展/采集器送进来的条目才算采集箱的。
function isCollectorSourced(item) {
  const source = text(item?.source).toLowerCase();
  if (source.includes("collector")) return true;
  if (source === "browser_extension" || source === "collector_extension") return true;
  return Boolean(text(item?.collectBatchId));
}

function normalizeCollectionBoxEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id);
  if (!id) return null;
  const status = text(raw.publishStatus) || "draft";
  return {
    id,
    source: text(raw.source),
    sourcePlatform: text(raw.sourcePlatform).toLowerCase(),
    sourceProductId: text(raw.sourceProductId),
    sourceUrl: text(raw.sourceUrl || raw.collectUrl),
    collectBatchId: text(raw.collectBatchId),
    title: text(raw.title),
    sku: text(raw.sku),
    imageUrl: text(raw.imageUrl),
    aiImageStatus: text(raw.aiImageStatus),
    publishStatus: status,
    publishMessage: text(raw.publishMessage),
    // 指向刊登池里的对应商品，仅用于「去刊登」跳转。
    publishProductId: text(raw.publishProductId),
    shopId: text(raw.shopId),
    collectedAt: text(raw.collectedAt),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt)
  };
}

function normalizePublishRecordEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id);
  if (!id) return null;
  const result = ["success", "failed", "blocked", "pending"].includes(text(raw.result))
    ? text(raw.result)
    : (raw.success === false ? "failed" : "success");
  return {
    id,
    ts: text(raw.ts),
    actorUsername: text(raw.actorUsername),
    result,
    statusCode: Number(raw.statusCode || 0) || 0,
    message: text(raw.message),
    productId: text(raw.productId),
    sku: text(raw.sku),
    title: text(raw.title),
    shopId: text(raw.shopId),
    shopName: text(raw.shopName),
    platform: text(raw.platform),
    publishStatus: text(raw.publishStatus)
  };
}

function listCollectionBox(db) {
  if (!Array.isArray(db.collectionBox)) db.collectionBox = [];
  return db.collectionBox;
}

function listPublishRecords(db) {
  if (!Array.isArray(db.publishRecords)) db.publishRecords = [];
  return db.publishRecords;
}

// 采集器投递时调用：存在的条目就地更新，新的条目插到最前面。
function upsertCollectionBoxEntry(box, payload) {
  const list = Array.isArray(box) ? box : [];
  const now = new Date().toISOString();
  const key = collectorKey(payload);
  const existing = list.find((entry) => collectorKey(entry) === key);
  if (existing) {
    const merged = normalizeCollectionBoxEntry({
      ...existing,
      ...payload,
      id: existing.id,
      createdAt: existing.createdAt || now,
      updatedAt: now
    });
    Object.assign(existing, merged);
    return existing;
  }
  const created = normalizeCollectionBoxEntry({
    ...payload,
    id: text(payload?.id) || makeId("CB"),
    createdAt: text(payload?.createdAt) || now,
    updatedAt: now
  });
  if (!created) return null;
  list.unshift(created);
  return created;
}

function appendPublishRecord(records, payload) {
  const list = Array.isArray(records) ? records : [];
  const entry = normalizePublishRecordEntry({ ...payload, id: text(payload?.id) || makeId("PR") });
  if (!entry) return null;
  list.unshift(entry);
  if (list.length > PAGE_STORE_MAX_RECORDS) list.length = PAGE_STORE_MAX_RECORDS;
  return entry;
}

function resolvePublishResultGroup(options) {
  const statusCode = Number(options?.statusCode || 0) || 0;
  if (options?.success === false || statusCode >= 400) return "failed";
  if (BLOCKED_PATTERN.test(text(options?.message))) return "blocked";
  return "success";
}

function getPlatformLabel(shopId, shops) {
  const shop = (Array.isArray(shops) ? shops : []).find((entry) => text(entry?.id) === text(shopId));
  const provider = text(shop?.provider).toLowerCase();
  if (provider === "yandex_market" || provider === "yandex") return "Yandex";
  if (provider === "ozon") return "Ozon";
  return provider || "-";
}

// Ozon 一次提交里每条商品的结果各不相同（成功/失败/处理中），按自己的状态记。
function resolveItemResult(item, batchResult, options) {
  if (!options?.perItemStatuses) return batchResult;
  const status = text(item?.publishStatus || item?.lastPublishStatus).toLowerCase();
  if (["failed", "error", "cancelled"].includes(status)) return "failed";
  if (["success", "completed", "imported", "published"].includes(status)) return "success";
  if (status === "blocked") return "blocked";
  return "pending";
}

// 上架动作发生时调用：写下记录快照，并同步采集箱里对应条目的上架状态。
function applyPublishOutcome(db, actor, items, options) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { recorded: 0, result: "" };
  const message = text(options?.message)
    || formatAuditWarnings(options?.payload)
    || text(options?.payload?.message);
  const statusCode = Number(options?.statusCode || 0) || 0;
  const result = resolvePublishResultGroup({ success: statusCode < 400, statusCode, message });
  const ts = new Date().toISOString();
  const records = listPublishRecords(db);
  const box = listCollectionBox(db);
  const actorUsername = text(actor?.username);
  const shops = Array.isArray(db.shops) ? db.shops : [];
  for (const item of list) {
    const productId = text(item?.id);
    const sku = text(item?.platformSku) || text(item?.sku) || text(item?.shopSku);
    const title = text(item?.title) || text(item?.name);
    const shopId = text(item?.shopId);
    const shopName = text(item?.shopName)
      || text(shops.find((entry) => text(entry?.id) === shopId)?.name);
    const itemResult = resolveItemResult(item, result, options);
    const itemMessage = text(item?.publishResultMessage) || message;
    appendPublishRecord(records, {
      ts,
      actorUsername,
      result: itemResult,
      statusCode,
      message: itemMessage,
      productId,
      sku,
      title,
      shopId,
      shopName,
      platform: getPlatformLabel(shopId, shops),
      publishStatus: text(item?.publishStatus) || text(item?.lastPublishStatus)
    });
    const key = collectorKey(item);
    for (const entry of box) {
      const linked = productId && text(entry.publishProductId) === productId;
      if (!linked && collectorKey(entry) !== key) continue;
      entry.publishStatus = itemResult;
      entry.publishMessage = itemMessage;
      if (!entry.publishProductId && productId) entry.publishProductId = productId;
      if (!entry.shopId && shopId) entry.shopId = shopId;
      entry.updatedAt = ts;
    }
  }
  return { recorded: list.length, result };
}

// 一次性导入：现有采集条目搬进采集箱自己的表。版本号变了会再跑一次，
// 只补缺失的条目，已经搬过的不动。
function seedCollectionBoxOnce(db) {
  if (text(db.collectionBoxSeededAt) && text(db.collectionBoxSeedVersion) === COLLECTION_BOX_SEED_VERSION) return 0;
  const products = Array.isArray(db.publishProducts) ? db.publishProducts : [];
  const box = listCollectionBox(db);
  let added = 0;
  for (const item of products) {
    if (!isCollectorSourced(item)) continue;
    if (box.some((entry) => collectorKey(entry) === collectorKey(item))) continue;
    const entry = upsertCollectionBoxEntry(box, {
      source: item.source,
      sourcePlatform: item.sourcePlatform,
      sourceProductId: item.sourceProductId,
      sourceUrl: item.sourceUrl || item.collectUrl,
      collectBatchId: item.collectBatchId,
      title: item.title || item.name,
      sku: item.sku || item.shopSku,
      imageUrl: item.imageUrl,
      aiImageStatus: item.aiImageStatus,
      publishStatus: item.publishStatus || item.lastPublishStatus || "draft",
      publishMessage: item.publishResultMessage,
      publishProductId: item.id,
      shopId: item.shopId,
      collectedAt: item.collectedAt || item.createdAt,
      createdAt: item.createdAt
    });
    if (entry) added += 1;
  }
  db.collectionBoxSeededAt = new Date().toISOString();
  db.collectionBoxSeedVersion = COLLECTION_BOX_SEED_VERSION;
  return added;
}

// 一次性导入：历史上架动作搬进上架记录自己的表（含当时的结果与商品信息）。
function seedPublishRecordsOnce(db) {
  if (text(db.publishRecordsSeededAt)) return 0;
  const logs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
  const productsById = new Map(
    (Array.isArray(db.publishProducts) ? db.publishProducts : []).map((item) => [text(item?.id), item])
  );
  const records = listPublishRecords(db);
  const seen = new Set(records.map((entry) => text(entry?.id)));
  let added = 0;
  for (const log of logs) {
    if (text(log?.resourceType) !== "product_publish") continue;
    if (text(log?.actionType) !== "publish") continue;
    const productId = text(log?.resourceId);
    if (!productId) continue;
    const auditId = text(log?.id);
    if (auditId && seen.has(auditId)) continue;
    const product = productsById.get(productId);
    const message = text(log?.errorMessage) || text(log?.warningMessage);
    const result = resolvePublishResultGroup({ success: log?.success !== false, statusCode: log?.statusCode, message });
    const shopId = text(product?.shopId);
    const shop = (Array.isArray(db.shops) ? db.shops : []).find((entry) => text(entry?.id) === shopId);
    appendPublishRecord(records, {
      ts: log?.ts,
      actorUsername: log?.actorUsername,
      result,
      statusCode: log?.statusCode,
      message,
      productId,
      sku: product?.sku || product?.shopSku || log?.requestBodyMasked?.sku,
      title: product?.title || log?.requestBodyMasked?.title,
      shopId,
      shopName: product?.shopName || shop?.name,
      platform: getPlatformLabel(shopId, db.shops),
      publishStatus: product?.publishStatus || product?.lastPublishStatus
    });
    if (auditId) seen.add(auditId);
    added += 1;
  }
  db.publishRecordsSeededAt = new Date().toISOString();
  return added;
}

// 升级时跑一次：两个页面的历史数据各归各表。返回是否有改动需要落库。
function seedOwnedPageStoresOnce(db) {
  const collectionBoxAdded = seedCollectionBoxOnce(db);
  const publishRecordsAdded = seedPublishRecordsOnce(db);
  return { collectionBoxAdded, publishRecordsAdded, changed: Boolean(collectionBoxAdded || publishRecordsAdded) };
}

module.exports = {
  collectorKey,
  isCollectorSourced,
  normalizeCollectionBoxEntry,
  normalizePublishRecordEntry,
  listCollectionBox,
  listPublishRecords,
  upsertCollectionBoxEntry,
  appendPublishRecord,
  resolvePublishResultGroup,
  applyPublishOutcome,
  seedOwnedPageStoresOnce
};
