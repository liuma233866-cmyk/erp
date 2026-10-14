"use strict";
// 刊登编排域单元测试：校验 429/400/403 分支、质量门禁、批量与 simulate 两条路径、Ozon。
// 全部用假实现，不接触 MySQL、网络或真实店铺。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createPublishService, isExistingPublishProduct, PUBLISH_QUALITY_MIN_SCORE } = require("./publish-service");
const { normalizePublishSettings } = require("../settings-normalize");

const YANDEX_SHOP = {
  id: "SHP-YM-1",
  provider: "yandex_market",
  enabled: true,
  businessId: "222",
  campaignId: "111",
  apiKey: "secret"
};

function makeItems(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `PUB-${index + 1}`,
    shopId: YANDEX_SHOP.id,
    sku: `SKU-${index + 1}`,
    title: `Product ${index + 1}`
  }));
}

function makeService(overrides = {}) {
  const db = {
    publishSettings: {},
    publishProducts: [],
    ...(overrides.db || {})
  };
  let saves = 0;
  const calls = { publishYandex: [], publishOzon: [], offerCards: [] };
  const service = createPublishService({
    getDb: () => db,
    saveDatabase: () => { saves += 1; },
    isSqlReady: () => false,
    getSqlPool: () => null,
    logError: () => {},
    normalizePublishSettings,
    validatePublishProductForYandex: () => ({ ok: true, missingFields: [], invalidFields: [], errors: [] }),
    expandPublishProductToYandexPayloads: (item) => (item?.sku ? [{ offerId: item.sku, name: item.title }] : []),
    resolvePublishTargetShopId: (actorUser, item, fallbackShopId, shops) => {
      const target = String(item?.shopId || fallbackShopId || "").trim();
      const shop = (shops || []).find((entry) => String(entry.id) === target);
      return shop ? { ok: true, shopId: target } : { ok: false, message: "Forbidden: no shop access" };
    },
    publishYandexProducts: async (payload) => {
      calls.publishYandex.push(payload);
      return {
        mapping: { ok: true, success: payload.products.length, failed: [] },
        price: { ok: true, success: payload.products.length, failed: [] },
        stock: { ok: true, success: payload.products.length, failed: [] }
      };
    },
    publishOzonProducts: async (shop, items) => {
      calls.publishOzon.push({ shop, items });
      return { ok: true, taskId: "T-1", items: items.map((item) => ({ offer_id: item.sku, status: "imported" })) };
    },
    enrichYandexItemsWithParameterValues: (items) => items,
    fetchYandexOfferCards: async (businessId, apiKey, options) => {
      calls.offerCards.push({ businessId, offerIds: options.offerIds });
      return { ok: true, offers: [] };
    },
    readCardQualityByOffers: async () => [],
    yandexMarketBaseUrl: "http://mock.invalid",
    ...overrides.deps
  });
  return { service, db, calls, getSaves: () => saves };
}

test("isExistingPublishProduct 只把 success/partial 视为老产品", () => {
  assert.equal(isExistingPublishProduct({ lastPublishStatus: "success" }), true);
  assert.equal(isExistingPublishProduct({ publishStatus: "partial" }), true);
  assert.equal(isExistingPublishProduct({ lastPublishStatus: "PENDING" }), false);
  assert.equal(isExistingPublishProduct({ lastPublishStatus: "failed" }), false);
  assert.equal(isExistingPublishProduct({}), false);
  assert.equal(PUBLISH_QUALITY_MIN_SCORE, 80);
});

test("超过每日刊登上限时返回 429 且不发起任何刊登", async () => {
  const today = new Date().toISOString();
  const { service, calls } = makeService({
    db: {
      publishSettings: { dailyPublishLimit: 2 },
      publishProducts: [
        { id: "A", lastPublishStatus: "success", lastPublishAt: today },
        { id: "B", lastPublishStatus: "success", lastPublishAt: today }
      ]
    }
  });
  const result = await service.executeProductPublish({}, makeItems(1), YANDEX_SHOP.id, [YANDEX_SHOP]);
  assert.equal(result.statusCode, 429);
  assert.match(result.payload.message, /每日刊登上限/);
  assert.equal(calls.publishYandex.length, 0);
});

test("店铺无权限时返回 403，店铺不存在时返回 400", async () => {
  const forbidden = makeService({
    deps: {
      resolvePublishTargetShopId: () => ({ ok: false, message: "Forbidden: shop not assigned" })
    }
  });
  const forbiddenResult = await forbidden.service.executeProductPublish({}, makeItems(1), "", [YANDEX_SHOP]);
  assert.equal(forbiddenResult.statusCode, 403);
  assert.equal(forbiddenResult.payload.errors.length, 1);

  const missing = makeService({
    deps: { resolvePublishTargetShopId: () => ({ ok: false, message: "请选择店铺" }) }
  });
  const missingResult = await missing.service.executeProductPublish({}, makeItems(1), "", [YANDEX_SHOP]);
  assert.equal(missingResult.statusCode, 400);
});

test("字段校验不通过时返回 400 并给出缺失字段", async () => {
  const { service, calls } = makeService({
    deps: {
      validatePublishProductForYandex: () => ({
        ok: false,
        missingFields: ["imageUrl", "marketCategoryId"],
        invalidFields: [],
        errors: [],
        message: "required: imageUrl, marketCategoryId"
      })
    }
  });
  const result = await service.executeProductPublish({}, makeItems(2), YANDEX_SHOP.id, [YANDEX_SHOP]);
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.errors.length, 2);
  assert.deepEqual(result.payload.errors[0].missingFields, ["imageUrl", "marketCategoryId"]);
  assert.equal(calls.publishYandex.length, 0);
});

test("质量门禁拦截全部 SKU 时标记 failed 且不调用 Yandex", async () => {
  const { service, calls } = makeService({
    db: { publishSettings: { qualityGateEnabled: true, qualityMinScore: 80 } },
    deps: {
      fetchYandexOfferCards: async () => ({ ok: true, offers: [{ offerId: "SKU-1", rating: 40 }] })
    }
  });
  const items = makeItems(1);
  const result = await service.executeProductPublish({}, items, YANDEX_SHOP.id, [YANDEX_SHOP]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.success, 0);
  assert.equal(result.payload.failed, 1);
  assert.equal(items[0].lastPublishStatus, "failed");
  assert.match(items[0].publishResultMessage, /卡片质量分低于 80/);
  assert.equal(calls.publishYandex.length, 0);
});

test("质量达标时按批量路径刊登，并回报 mapping/price/stock 明细", async () => {
  const { service, calls, getSaves } = makeService({
    db: { publishSettings: { qualityGateEnabled: true, qualityMinScore: 80 } },
    deps: {
      fetchYandexOfferCards: async () => ({ ok: true, offers: [{ offerId: "SKU-1", rating: 95 }] })
    }
  });
  const items = makeItems(1);
  const result = await service.executeProductPublish({}, items, YANDEX_SHOP.id, [YANDEX_SHOP]);

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.success, 1);
  assert.equal(result.payload.failed, 0);
  assert.equal(calls.publishYandex.length, 1);
  const row = result.payload.results[0];
  assert.equal(row.details.simulation, undefined);
  assert.equal(row.details.mapping.ok, true);
  assert.equal(row.details.price.ok, true);
  assert.equal(row.details.stock.ok, true);
  assert.equal(items[0].lastPublishStatus, "success");
  assert.equal(getSaves() >= 1, true);
});

test("simulate 模式走逐条串行路径并带 simulation 标记", async () => {
  const { service, calls } = makeService({
    db: { publishSettings: { simulateBackendPublishToYandex: true, publishIntervalSeconds: 0 } }
  });
  const items = makeItems(3);
  const result = await service.executeProductPublish({}, items, YANDEX_SHOP.id, [YANDEX_SHOP]);

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.success, 3);
  assert.equal(calls.publishYandex.length, 3, "simulate 模式应逐条调用");
  const row = result.payload.results[0];
  assert.equal(row.details.simulation, true);
  assert.equal(row.details.mode, "sequential_api");
  assert.match(row.message, /逐条调用 Yandex API/);
});

test("Yandex 店铺缺少 businessId/apiKey 时按店铺整体失败", async () => {
  const shop = { ...YANDEX_SHOP, businessId: "", apiKey: "" };
  const { service, calls } = makeService();
  const result = await service.executeProductPublish({}, makeItems(2), shop.id, [shop]);
  assert.equal(result.payload.success, 0);
  assert.equal(result.payload.failed, 2);
  assert.equal(result.payload.results[0].message, "缺少businessId或apiKey");
  assert.equal(calls.publishYandex.length, 0);
});

test("Ozon 刊登按返回状态分别计入 success / processing / failed", async () => {
  const ozonShop = { id: "SHP-OZ-1", provider: "ozon", enabled: true, campaignId: "999", apiKey: "key" };
  const { service } = makeService({
    deps: {
      publishOzonProducts: async (shop, items) => ({
        ok: true,
        taskId: "T-9",
        items: items.map((item, index) => ({
          offer_id: item.sku,
          ...(index === 0 ? { status: "imported" } : index === 1 ? { status: "processing" } : { status: "failed", errors: [{ message: "bad barcode" }] })
        }))
      })
    }
  });
  const items = makeItems(3).map((item) => ({ ...item, shopId: ozonShop.id }));
  const result = await service.executeOzonProductPublish({}, items, ozonShop.id, [ozonShop]);

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.success, 1);
  assert.equal(result.payload.processing, 1);
  assert.equal(result.payload.failed, 1);
  assert.equal(items[0].ozonTaskId, "T-9");
  assert.equal(items[2].ozonErrorMessage, "bad barcode");
  assert.equal(items[2].lastPublishStatus, "failed");
});

test("Ozon 店铺选择失败时不发起 Ozon 调用并计入 failed", async () => {
  const { service, calls } = makeService();
  const result = await service.executeOzonProductPublish({}, makeItems(1), "", []);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.failed, 1);
  assert.equal(calls.publishOzon.length, 0);
  assert.equal(result.payload.results.length, 1);
});

test("卡片质量接口失败且无历史快照时不拦截，只记录告警", async () => {
  const { service, calls } = makeService({
    db: { publishSettings: { qualityGateEnabled: true, qualityMinScore: 80 } },
    deps: { fetchYandexOfferCards: async () => ({ ok: false, message: "502 upstream" }) }
  });
  const items = makeItems(1);
  const result = await service.executeProductPublish({}, items, YANDEX_SHOP.id, [YANDEX_SHOP]);

  assert.equal(result.payload.success, 1, "拉不到质量分时不应拦截新品");
  assert.equal(calls.publishYandex.length, 1);
  const warning = result.payload.errors.find((entry) => entry.stage === "quality");
  assert.match(warning.message, /无法评估卡片质量/);
});
