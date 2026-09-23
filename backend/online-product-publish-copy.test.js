const test = require("node:test");
const assert = require("node:assert/strict");
const { copyOnlineProductsToPublishDrafts, mapOnlineProductToPublishDraft } = require("./online-product-publish-copy");
const { convertPublishPricesToCurrency } = require("./rub-to-cny-publish-prices");

test("maps a Yandex online product into a non-published draft", () => {
  const item = mapOnlineProductToPublishDraft({
    id: "PRD-1", shopId: "SHP-1", offerId: "SKU-1", name: "Product",
    salePrice: 100, inventory: 4, categoryId: "10", imageUrl: "https://example.com/a.jpg"
  }, "2026-08-20T00:00:00.000Z");
  assert.equal(item.source, "yandex_online_product");
  assert.equal(item.publishStatus, "draft");
  assert.match(item.sku, /^PUB-SKU-1-[A-F0-9]{10}$/);
  assert.equal(item.systemSku, "");
  assert.equal(item.systemSkuPending, true);
  assert.equal(item.platformSku, item.sku);
  assert.equal(item.sourceSku, "SKU-1");
  assert.equal(item.sourceProductSnapshot.offerId, "SKU-1");
  assert.equal(item.stockCount, 4);
  assert.equal(item.marketCategoryId, "10");
  assert.deepEqual(item.images, ["https://example.com/a.jpg"]);
  assert.equal(item.description, "Product");
});

test("preserves a source description instead of using the title fallback", () => {
  const item = mapOnlineProductToPublishDraft({ id: "PRD-D", shopId: "SHP", shopSku: "D", name: "Title", description: "Detailed description" });
  assert.equal(item.description, "Detailed description");
});

test("copy is idempotent by target shop and source product and preserves publish history", () => {
  const existing = [{ id: "PUB-OLD", source: "yandex_online_product", sourceOnlineProductId: "PRD-1", shopId: "SHP-1", sku: "PUB-SKU-1-OLD", systemSku: "LIVE-SKU", systemSkuPending: false, title: "Old", publishStatus: "published", salePrice: 80, originalPrice: 96, priceConversion: { type: "RUB_TO_CNY", cnyRateRub: 12.5 }, aiTaskId: "AIT-OLD", aiImageStatus: "succeeded", lastPublishStatus: "success", lastPublishAt: "yesterday", createdAt: "before" }];
  const result = copyOnlineProductsToPublishDrafts({
    onlineProducts: [
      { id: "PRD-1", shopId: "SHP-1", shopSku: "SKU-1", name: "New", salePrice: 1000, originalPrice: 1200 },
      { id: "PRD-2", shopId: "SHP-2", shopSku: "SKU-1", name: "Other shop" }
    ],
    publishProducts: existing,
    normalize: (item) => item,
    makeId: () => "PUB-NEW",
    now: "today"
  });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.total, 2);
  const updated = result.items.find((item) => item.id === "PUB-OLD");
  assert.equal(updated.title, "New");
  assert.equal(updated.lastPublishStatus, "success");
  assert.equal(updated.publishStatus, "published");
  assert.deepEqual(updated.priceConversion, { type: "RUB_TO_CNY", cnyRateRub: 12.5 });
  assert.equal(updated.salePrice, 80);
  assert.equal(updated.originalPrice, 96);
  assert.equal(updated.sku, "PUB-SKU-1-OLD");
  assert.equal(updated.systemSku, "LIVE-SKU");
  assert.equal(updated.systemSkuPending, false);
  assert.equal(updated.aiTaskId, "AIT-OLD");
  assert.equal(updated.aiImageStatus, "succeeded");
  assert.equal(result.changedItems.length, 2);
  assert.ok(result.items.some((item) => item.id === "PUB-NEW" && item.shopId === "SHP-2"));
});

test("an empty selected product list copies nothing", () => {
  const result = copyOnlineProductsToPublishDrafts({ onlineProducts: [], publishProducts: [], now: "today" });
  assert.deepEqual({ created: result.created, updated: result.updated, skipped: result.skipped, total: result.total }, { created: 0, updated: 0, skipped: 0, total: 0 });
});

test("copies a source product into the selected target platform and shop", () => {
  const result = copyOnlineProductsToPublishDrafts({
    onlineProducts: [{ id: "PRD-1", shopId: "SOURCE", shopSku: "SKU-1", marketSku: "YANDEX-MARKET-SKU", name: "Product" }],
    publishProducts: [],
    target: { platform: "ozon", shopId: "OZON-TARGET", currencyId: "CNY" },
    makeId: () => "PUB-1",
    now: "today"
  });
  assert.equal(result.items[0].sourceShopId, "SOURCE");
  assert.equal(result.items[0].shopId, "OZON-TARGET");
  assert.equal(result.items[0].publishPlatform, "ozon");
  assert.equal(result.items[0].platformSku, result.items[0].sku);
  assert.equal(result.items[0].currencyId, "CNY");
});

test("copies every source field while protecting target publication identity", () => {
  const source = {
    id: "PRD-9", shopId: "SOURCE", shopSku: "原始 SKU 9", name: "Product",
    arbitraryFutureField: { nested: [1, 2, 3] }, attributes: [{ id: 10, value: "red" }]
  };
  const result = copyOnlineProductsToPublishDrafts({
    onlineProducts: [source], publishProducts: [], target: { platform: "yandex", shopId: "TARGET" }, makeId: () => "PUB-9", now: "today"
  });
  const copied = result.items[0];
  assert.deepEqual(copied.arbitraryFutureField, source.arbitraryFutureField);
  assert.deepEqual(copied.attributes, source.attributes);
  assert.deepEqual(copied.sourceProductSnapshot, source);
  assert.equal(copied.id, "PUB-9");
  assert.equal(copied.shopId, "TARGET");
  assert.notEqual(copied.sku, source.shopSku);
});

test("uses publication SKU settings for newly copied drafts", () => {
  const item = mapOnlineProductToPublishDraft(
    { id: "PRD-10", shopId: "SOURCE", shopSku: "SOURCE-10" },
    "today",
    { platform: "yandex", shopId: "TARGET", skuSettings: { skuPrefix: "YX", skuSeparator: "_", skuIncludeSourceSku: false } }
  );
  assert.match(item.sku, /^YX_[A-F0-9]{10}$/);
  assert.equal(item.sourceSku, "SOURCE-10");
});

test("uses a target shop SKU prefix before the default prefix", () => {
  const item = mapOnlineProductToPublishDraft(
    { id: "PRD-11", shopId: "SOURCE", shopSku: "SOURCE-11" },
    "today",
    { platform: "yandex", shopId: "TARGET", skuSettings: { skuPrefix: "PUB", skuPrefixByShopId: { TARGET: "SHOPA" } } }
  );
  assert.match(item.sku, /^SHOPA-SOURCE-11-[A-F0-9]{10}$/);
});

test("re-copying a converted draft does not divide its CNY price again", () => {
  const source = [{ id: "PRD-RUB", shopId: "RUB-SOURCE", shopSku: "SKU-RUB", salePrice: 1000, sourceCurrencyId: "RUR" }];
  const target = { platform: "yandex", shopId: "CNY-TARGET", currencyId: "CNY" };
  const first = copyOnlineProductsToPublishDrafts({ onlineProducts: source, publishProducts: [], target, makeId: () => "PUB-CNY", now: "first" });
  convertPublishPricesToCurrency(first.changedItems, { shopId: "CNY-TARGET", targetCurrencyId: "CNY", cnyRateRub: 12.5, now: "first" });
  assert.equal(first.items[0].salePrice, 80);

  const second = copyOnlineProductsToPublishDrafts({ onlineProducts: source, publishProducts: first.items, target, makeId: () => "UNUSED", now: "second" });
  convertPublishPricesToCurrency(second.changedItems, { shopId: "CNY-TARGET", targetCurrencyId: "CNY", cnyRateRub: 12.5, now: "second" });
  assert.equal(second.items[0].salePrice, 80);
  assert.equal(second.items[0].priceConversion.type, "RUB_TO_CNY");
});

test("copy options can preserve title and description on an existing draft", () => {
  const result = copyOnlineProductsToPublishDrafts({
    onlineProducts: [{ id: "P-OPTIONS", shopId: "SOURCE", shopSku: "SKU", name: "New title", description: "New description" }],
    publishProducts: [{ id: "PUB-OPTIONS", source: "yandex_online_product", sourceOnlineProductId: "P-OPTIONS", shopId: "TARGET", sku: "OLD", title: "Old title", name: "Old title", description: "Old description" }],
    target: { platform: "yandex", shopId: "TARGET", overwriteTitleDescription: false },
    normalize: (item) => item,
    now: "now"
  });
  const item = result.items.find((entry) => entry.id === "PUB-OPTIONS");
  assert.equal(item.title, "Old title");
  assert.equal(item.description, "Old description");
});
