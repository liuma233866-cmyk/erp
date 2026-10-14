"use strict";
// 订单同步域单元测试：并发上限、420 退避重试、幂等、错误路径。
// 全部使用假 fetcher 与内存 db，不接触 MySQL 或网络。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createOrderSyncService, mapWithConcurrency, parseOrderSyncDailyTime, extractHttpStatus } = require("./order-sync");
const { getOrderUniqueKey } = require("../identity");
const {
  applyOrderPurchaseOverrides,
  backfillOrderPurchaseFields,
  dedupeOrders,
  hasTextValue,
  inferHistoricalOrderRevenue
} = require("../order-backfill");
const { backfillOrderProductMatches } = require("../order-product-matcher");
const { applyHistoricalRevenueFallback } = require("../order-pricing");

const YANDEX_SHOP = {
  id: "SHP-TEST-1",
  name: "test shop",
  provider: "yandex_market",
  enabled: true,
  campaignId: "111",
  businessId: "222",
  apiKey: "secret"
};

function makeService(overrides = {}) {
  const db = overrides.db || { orders: [], onlineProducts: [], shops: [YANDEX_SHOP], orderPurchaseOverrides: [] };
  let saves = 0;
  const logs = [];
  const service = createOrderSyncService({
    getDb: () => db,
    saveDatabase: () => { saves += 1; },
    logInfo: (message) => logs.push(String(message)),
    logError: () => {},
    fetchOzonFbsOrders: async () => ({ ok: true, items: [] }),
    mapOzonPostingToLocal: (raw, shop) => ({
      id: `ORD-OZON-${raw.posting_number}`, shopOrderNo: raw.posting_number, shopId: shop.id, provider: "ozon", amount: 10, items: []
    }),
    fetchYandexOrders: async () => ({ ok: true, items: [] }),
    fetchYandexOrderDetail: async () => ({ ok: false, message: "not stubbed" }),
    extractYandexOrderId: (raw) => String(raw?.id || ""),
    collectYandexOfferIds: () => [],
    fetchYandexOfferMappings: async () => ({ ok: true, map: {} }),
    enrichYandexOfferMapWithOnlineProducts: (offerMap) => offerMap,
    mapYandexOrderToLocal: (raw, shop) => ({
      id: `ORD-YM-${raw.id}`, shopOrderNo: `NO-${raw.id}`, shopId: shop.id, provider: "yandex_market", amount: 100, items: []
    }),
    backfillOrderProductMatches,
    backfillOrderPurchaseFields,
    hasTextValue,
    applyHistoricalRevenueFallback,
    inferHistoricalOrderRevenue,
    getOrderUniqueKey,
    dedupeOrders,
    applyOrderPurchaseOverrides,
    config: { detailConcurrency: 5, retryBaseDelayMs: 1, ...(overrides.config || {}) },
    ...overrides.deps
  });
  return { service, db, logs, getSaves: () => saves };
}

test("mapWithConcurrency 保持输入顺序且不超过并发上限", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, index) => index);
  const results = await mapWithConcurrency(items, 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, items.map((value) => value * 2));
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test("parseOrderSyncDailyTime 与 extractHttpStatus 处理边界输入", () => {
  assert.deepEqual(parseOrderSyncDailyTime("06:30"), { hour: 6, minute: 30, valid: true });
  assert.deepEqual(parseOrderSyncDailyTime("23:59"), { hour: 23, minute: 59, valid: true });
  assert.deepEqual(parseOrderSyncDailyTime("24:00"), { hour: 6, minute: 0, valid: false });
  assert.deepEqual(parseOrderSyncDailyTime(""), { hour: 6, minute: 0, valid: false });
  assert.equal(extractHttpStatus("Yandex API HTTP 420: {...}"), 420);
  assert.equal(extractHttpStatus("boom"), 0);
});

test("detailConcurrency 被钳制在 1..5（Yandex 每 campaign 上限 6）", () => {
  assert.equal(makeService({ config: { detailConcurrency: 50 } }).service.detailConcurrency, 5);
  assert.equal(makeService({ config: { detailConcurrency: 0 } }).service.detailConcurrency, 5);
  assert.equal(makeService({ config: { detailConcurrency: 2 } }).service.detailConcurrency, 2);
  assert.equal(makeService({ config: { detailConcurrency: -3 } }).service.detailConcurrency, 1);
});

test("详情接口返回 420 时会退避重试，且并发不超过 5", async () => {
  const orders = Array.from({ length: 12 }, (_, index) => ({ id: `D${index}` }));
  let active = 0;
  let peak = 0;
  let detailCalls = 0;
  const attempts = new Map();
  const { service, db, getSaves } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: orders }),
      fetchYandexOrderDetail: async (campaignId, apiKey, orderId) => {
        active += 1;
        peak = Math.max(peak, active);
        detailCalls += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, 4));
          const attempt = (attempts.get(orderId) || 0) + 1;
          attempts.set(orderId, attempt);
          if (attempt === 1) {
            return { ok: false, status: 420, message: "Yandex API HTTP 420: Hit rate limit of 6 parallel requests" };
          }
          return { ok: true, item: { id: orderId } };
        } finally {
          active -= 1;
        }
      }
    }
  });

  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);

  assert.equal(summary.added, 12, "every order should be persisted after the retry");
  assert.equal(summary.errors.length, 0);
  assert.equal(detailCalls, 24, "each order should be fetched twice (420 then success)");
  assert.ok(peak <= 5, `peak concurrency was ${peak}, Yandex allows at most 6`);
  assert.equal(db.orders.length, 12);
  assert.ok(getSaves() >= 1, "sync should persist at least once");
});

test("420 重试耗尽后该订单被跳过并记录错误，不影响其他订单", async () => {
  const orders = [{ id: "OK1" }, { id: "BAD" }, { id: "OK2" }];
  const { service, db } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: orders }),
      fetchYandexOrderDetail: async (campaignId, apiKey, orderId) => {
        if (orderId === "BAD") return { ok: false, status: 420, message: "Yandex API HTTP 420: rate limit" };
        return { ok: true, item: { id: orderId } };
      }
    }
  });

  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);

  assert.equal(summary.added, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0].message, /420|详情拉取失败/);
  assert.deepEqual(db.orders.map((order) => order.shopOrderNo).sort(), ["NO-OK1", "NO-OK2"]);
});

test("不可重试的错误（如 403 权限不足）只请求一次", async () => {
  let calls = 0;
  const { service } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: [{ id: "X1" }] }),
      fetchYandexOrderDetail: async () => {
        calls += 1;
        return { ok: false, status: 403, message: "Yandex API HTTP 403: forbidden" };
      }
    }
  });
  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);
  assert.equal(calls, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors.length, 1);
});

test("缺少 apiKey 或 campaignId 的店铺被跳过并给出错误", async () => {
  const { service } = makeService();
  const summary = await service.syncOrdersForShops([{ id: "SHP-BAD", provider: "yandex_market", campaignId: "", apiKey: "" }]);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.errors, [{ shopId: "SHP-BAD", message: "缺少apiKey或campaignId" }]);
});

test("重复同步同一批订单不会重复新增", async () => {
  const orders = [{ id: "A" }, { id: "B" }];
  const { service, db } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: orders }),
      fetchYandexOrderDetail: async (campaignId, apiKey, orderId) => ({ ok: true, item: { id: orderId } })
    }
  });

  const first = await service.syncOrdersForShops([YANDEX_SHOP]);
  const second = await service.syncOrdersForShops([YANDEX_SHOP]);

  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 0, "unchanged orders must not be reported as updated");
  assert.equal(db.orders.length, 2);
});

test("Ozon 店铺走 FBS 订单路径", async () => {
  const ozonShop = { id: "SHP-OZON", provider: "ozon", enabled: true, campaignId: "999", apiKey: "key" };
  const { service, db } = makeService({
    deps: { fetchOzonFbsOrders: async () => ({ ok: true, items: [{ posting_number: "P-1" }, { posting_number: "P-2" }] }) }
  });

  const summary = await service.syncOrdersForShops([ozonShop]);

  assert.equal(summary.added, 2);
  assert.equal(db.orders.length, 2);
  assert.equal(db.orders[0].provider, "ozon");
});

test("Ozon 拉取失败时跳过并记录店铺错误", async () => {
  const ozonShop = { id: "SHP-OZON", provider: "ozon", enabled: true, campaignId: "999", apiKey: "key" };
  const { service } = makeService({
    deps: { fetchOzonFbsOrders: async () => ({ ok: false, message: "Ozon 401" }) }
  });
  const summary = await service.syncOrdersForShops([ozonShop]);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.errors, [{ shopId: "SHP-OZON", message: "Ozon 401" }]);
});

test("ORDER_SYNC_ENABLED=0 时不排定定时任务", () => {
  const { service, logs } = makeService({ config: { enabled: false } });
  service.startScheduler();
  assert.equal(service.getTimer(), null);
  assert.ok(logs.some((line) => line.includes("disabled")), `logs were ${JSON.stringify(logs)}`);
});

test("详情返回的订单缺少订单号时跳过并记录原因", async () => {
  const { service, db } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: [{ id: "N1" }] }),
      fetchYandexOrderDetail: async () => ({ ok: true, item: { id: "N1" } }),
      mapYandexOrderToLocal: (raw, shop) => ({ id: "ORD-X", shopOrderNo: "", shopId: shop.id, provider: "yandex_market" })
    }
  });
  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);
  assert.equal(summary.added, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.orders.length, 0);
  assert.match(summary.errors[0].message, /订单号/);
});

test("列表未拉全（partial）时照常处理已拉到的订单，并把缺口记进错误摘要", async () => {
  const { service } = makeService({
    deps: {
      fetchYandexOrders: async () => ({
        ok: true,
        items: [{ id: "P1" }],
        partial: true,
        message: "Yandex API HTTP 400: invalid date range"
      }),
      fetchYandexOrderDetail: async (campaignId, apiKey, orderId) => ({ ok: true, item: { id: orderId } })
    }
  });
  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);
  assert.equal(summary.added, 1, "已拉到的订单照常入库，不能因为缺口就整批丢弃");
  assert.equal(summary.errors.length, 1, "缺口必须出现在错误摘要里，而不是静默成功");
  assert.match(summary.errors[0].message, /订单列表未拉全/);
});

test("列表完整（无 partial）时不产生额外错误", async () => {
  const { service } = makeService({
    deps: {
      fetchYandexOrders: async () => ({ ok: true, items: [{ id: "C1" }] }),
      fetchYandexOrderDetail: async (campaignId, apiKey, orderId) => ({ ok: true, item: { id: orderId } })
    }
  });
  const summary = await service.syncOrdersForShops([YANDEX_SHOP]);
  assert.equal(summary.added, 1);
  assert.equal(summary.errors.length, 0);
});
