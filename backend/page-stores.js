// 采集箱 / 上架记录 各自的独立数据。
//
// 这两个页面自成一套数据，不与其他模块互通：
// - 采集箱（db.collectionBox）：浏览器扩展投递进来的条目，删除只删采集箱自己，
//   不动刊登工作台（publishProducts）、产品库或在线产品。
// - 上架记录（db.publishRecords）：上架动作发生时写下的记录快照，带上当时的
//   SKU/标题/店铺/平台，不读审计日志，也不依赖刊登池里商品是否还在。
//
// 这两个页面从零开始：不导入任何历史数据（刊登池、审计日志一律不搬），
// 只有「新的采集投递」和「新的上架动作」才会产生记录。

const { makeId } = require("./identity");
const { formatAuditWarnings } = require("./log-checker");

const PAGE_STORE_MAX_RECORDS = 5000;
const BLOCKED_PATTERN = /拦截|已拦|被拦|低于\s*\d+/;
// 清空历史导入的版本号：跑过一次就不再跑。
const PAGE_STORE_RESET_VERSION = "1";

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

// 清空旧导入：这两个页面只认自己产生的新数据，历史一律不要。跑一次就记版本。
function resetOwnedPageStoresOnce(db) {
  if (text(db.pageStoresResetVersion) === PAGE_STORE_RESET_VERSION) return false;
  db.collectionBox = [];
  db.publishRecords = [];
  db.pageStoresResetVersion = PAGE_STORE_RESET_VERSION;
  return true;
}

module.exports = {
  collectorKey,
  normalizeCollectionBoxEntry,
  normalizePublishRecordEntry,
  listCollectionBox,
  listPublishRecords,
  upsertCollectionBoxEntry,
  appendPublishRecord,
  resolvePublishResultGroup,
  applyPublishOutcome,
  resetOwnedPageStoresOnce
};
