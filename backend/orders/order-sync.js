"use strict";
// 订单同步域。
//
// 从 server.js 拆出：定时调度、多店铺拉取、订单详情归并、采购/营收回填。
// 依赖全部通过 createOrderSyncService(deps) 注入，模块本身不直接访问 MySQL 或网络，
// 因此可以用假 fetcher 做单元测试。
//
// 关于并发：Yandex 对同一 campaign 限制「最多 6 个并发请求」，超过会返回
// HTTP 420 (METHOD_FAILURE, "Hit rate limit of 6 parallel requests")。
// 详情接口是必需调用（列表接口只给首个商品），因此这里把并发上限压到 5，
// 并对 420/429/5xx 做指数退避重试，避免详情拉取失败导致整单被静默跳过。

const DEFAULT_DETAIL_CONCURRENCY = 5;
const MAX_DETAIL_CONCURRENCY = 5;
const DETAIL_MAX_ATTEMPTS = 3;
const DETAIL_RETRY_BASE_DELAY_MS = 400;
// 可重试状态码与 yandex-http / yandex-publish-service 共用同一份定义，避免三处各写一份后走偏。
// 保留 RETRYABLE_HTTP_STATUS 这个名字，模块公开面不变。
const { RETRYABLE_YANDEX_STATUS } = require("../yandex-http");
const RETRYABLE_HTTP_STATUS = RETRYABLE_YANDEX_STATUS;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 从 "Yandex API HTTP 420: {...}" 这类错误文本里取出状态码。
function extractHttpStatus(message) {
  const match = String(message || "").match(/HTTP\s+(\d{3})/);
  return match ? Number(match[1]) : 0;
}

function resolveRetryableStatus(result) {
  const explicit = Number(result?.status) || 0;
  return explicit || extractHttpStatus(result?.message);
}

function parseOrderSyncDailyTime(value) {
  const match = String(value || "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return { hour: 6, minute: 0, valid: false };
  return { hour: Number(match[1]), minute: Number(match[2]), valid: true };
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

function createOrderSyncService(deps = {}) {
  const {
    getDb,
    saveDatabase = () => {},
    logInfo = () => {},
    logError = () => {},
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
    config = {}
  } = deps;

  if (typeof getDb !== "function") throw new TypeError("createOrderSyncService requires getDb");

  const enabled = config.enabled !== false;
  const dailyTime = String(config.dailyTime || "06:00").trim();
  const detailConcurrency = Math.max(
    1,
    Math.min(MAX_DETAIL_CONCURRENCY, Number(config.detailConcurrency) || DEFAULT_DETAIL_CONCURRENCY)
  );
  const detailMaxAttempts = Math.max(1, Number(config.detailMaxAttempts) || DETAIL_MAX_ATTEMPTS);
  const retryBaseDelayMs = Math.max(0, Number(config.retryBaseDelayMs ?? DETAIL_RETRY_BASE_DELAY_MS));

  const state = { running: false };
  let timer = null;

  // 带退避重试的订单详情拉取：420（Yandex 限流）过去会被当成永久失败。
  async function fetchOrderDetailWithRetry(shop, orderId) {
    let last = null;
    for (let attempt = 0; attempt < detailMaxAttempts; attempt += 1) {
      last = await fetchYandexOrderDetail(shop.campaignId, shop.apiKey, orderId);
      if (last?.ok) return last;
      const status = resolveRetryableStatus(last);
      if (!RETRYABLE_HTTP_STATUS.has(status) || attempt === detailMaxAttempts - 1) return last;
      logInfo(`Yandex order detail ${orderId} got HTTP ${status}; retry ${attempt + 1}/${detailMaxAttempts - 1} after backoff`);
      await sleep(retryBaseDelayMs * (2 ** attempt));
    }
    return last;
  }

  async function syncOrdersForShops(shops, options = {}) {
    const db = getDb();
    if (!Array.isArray(db.orders)) db.orders = [];
    const existingOrderByKey = new Map(
      db.orders
        .map((order) => [getOrderUniqueKey(order), order])
        .filter(([key]) => Boolean(key))
    );
    const seenOrderKeys = new Set();
    const targetShops = Array.isArray(shops) ? shops : [];
    const targetOrderNos = Array.isArray(options.orderNos)
      ? options.orderNos.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    const acceptOrder = (order) => {
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
        ...existingOrder,
        ...order,
        amount: resolvedAmount,
        updatedAt: new Date().toISOString(),
        purchasePriceRmb: hasTextValue(order.purchasePriceRmb) ? order.purchasePriceRmb : existingOrder.purchasePriceRmb || "",
        purchasePriceRub: hasTextValue(order.purchasePriceRub) ? order.purchasePriceRub : existingOrder.purchasePriceRub || "",
        purchaseLink: hasTextValue(order.purchaseLink) ? order.purchaseLink : existingOrder.purchaseLink || ""
      });
      return { action: changed ? "updated" : "skipped" };
    };

    const tally = (outcome) => {
      if (outcome.action === "added") added += 1;
      else if (outcome.action === "updated") updated += 1;
      else skipped += 1;
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
            const outcome = acceptOrder(mapOzonPostingToLocal(raw, shop));
            tally(outcome);
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
            const detail = await fetchOrderDetailWithRetry(shop, orderNo);
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
          if (result.partial) {
            // 只拉到部分时间区间：照常处理已拉到的订单，但把缺口显式记进本次同步的错误摘要，
            // 而不是静默按一次成功同步处理（过去正是这样丢单无人知晓）。
            errors.push({
              shopId: shop.id,
              message: `订单列表未拉全（部分时间区间拉取失败，已拉到的订单照常处理）：${result.message || "原因未知"}`
            });
          }
          // 列表接口可能只带首个商品，必须逐单拉详情才能落全量商品；
          // 并发受 Yandex「每 campaign 6 并发」限制，这里固定不超过 5 并带退避重试。
          const detailResults = await mapWithConcurrency(result.items || [], detailConcurrency, async (raw) => {
            const orderId = extractYandexOrderId(raw);
            if (!orderId) return { orderId: "", item: null, message: "订单缺少ID" };
            const detail = await fetchOrderDetailWithRetry(shop, orderId);
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
        // 订单详情接口常缺每个 SKU 的图片，用 ERP 自己的平台产品表补齐映射。
        offerMap = enrichYandexOfferMapWithOnlineProducts(offerMap, db.onlineProducts || [], shop);
        for (const raw of detailedOrders) {
          const order = mapYandexOrderToLocal(raw, shop, offerMap);
          const outcome = acceptOrder(order);
          tally(outcome);
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
    return {
      added,
      updated,
      skipped,
      errors,
      errorSummary: errors.map((item) => `店铺${item.shopId}: ${item.message}`).filter(Boolean)
    };
  }

  function clearScheduler() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function runScheduledOrderSync() {
    if (state.running) {
      logInfo("Order auto sync skipped: previous run still in progress.");
      return { skipped: true, reason: "running" };
    }
    state.running = true;
    try {
      const db = getDb();
      const enabledShops = Array.isArray(db?.shops) ? db.shops.filter((shop) => Boolean(shop.enabled)) : [];
      const summary = await syncOrdersForShops(enabledShops);
      logInfo(
        `Order auto sync done: added=${summary.added}, updated=${summary.updated}, skipped=${summary.skipped}, ` +
        `shops=${enabledShops.length}, errors=${summary.errors.length}`
      );
      return summary;
    } finally {
      state.running = false;
    }
  }

  function scheduleNextOrderSync() {
    clearScheduler();
    const parsed = parseOrderSyncDailyTime(dailyTime);
    const now = new Date();
    const next = new Date(now);
    next.setHours(parsed.hour, parsed.minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = Math.max(1000, next.getTime() - now.getTime());
    if (!parsed.valid) {
      logInfo(`Invalid ORDER_SYNC_DAILY_TIME="${dailyTime}", fallback to 06:00.`);
    }
    logInfo(`Order auto sync scheduled at ${next.toLocaleString()}.`);
    timer = setTimeout(async () => {
      try {
        await runScheduledOrderSync();
      } catch (error) {
        logError(`Order auto sync failed: ${String(error)}`);
      } finally {
        scheduleNextOrderSync();
      }
    }, delay);
  }

  function startScheduler() {
    if (!enabled) {
      logInfo("Order auto sync disabled (ORDER_SYNC_ENABLED=0).");
      return;
    }
    scheduleNextOrderSync();
  }

  return {
    state,
    syncOrdersForShops,
    startScheduler,
    scheduleNextOrderSync,
    runScheduledOrderSync,
    clearScheduler,
    getTimer: () => timer,
    detailConcurrency,
    fetchOrderDetailWithRetry
  };
}

module.exports = {
  DEFAULT_DETAIL_CONCURRENCY,
  MAX_DETAIL_CONCURRENCY,
  RETRYABLE_HTTP_STATUS,
  createOrderSyncService,
  extractHttpStatus,
  mapWithConcurrency,
  parseOrderSyncDailyTime
};
