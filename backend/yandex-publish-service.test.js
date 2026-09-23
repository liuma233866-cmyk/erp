const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapOnlineProductToYandexPayload,
  normalizeShopCurrency,
  publishYandexProducts
} = require("./yandex-publish-service");

test("normalizes shop currency with RUR as the backward-compatible default", () => {
  assert.equal(normalizeShopCurrency("CNY"), "CNY");
  assert.equal(normalizeShopCurrency("cny"), "CNY");
  assert.equal(normalizeShopCurrency("RUB"), "RUR");
  assert.equal(normalizeShopCurrency(""), "RUR");
});

test("online product edits map sale price, stock and package measurements to Yandex", () => {
  const payload = mapOnlineProductToYandexPayload({
    shopSku: "SKU-100",
    name: "Test product",
    salePrice: 1299,
    originalPrice: 1499,
    inventory: 7,
    packageLengthCm: 20,
    packageWidthCm: 10,
    packageHeightCm: 5,
    weightKg: 0.75,
    imageUrl: "https://example.com/a.jpg"
  });

  assert.deepEqual(payload, {
    offerId: "SKU-100",
    name: "Test product",
    vendor: "",
    vendorCode: "SKU-100",
    categoryId: undefined,
    description: "",
    images: ["https://example.com/a.jpg"],
    url: "",
    barcodes: [],
    price: 1299,
    originalPrice: 1499,
    currencyId: "RUR",
    stockCount: 7,
    weightKg: 0.75,
    dimensions: { length: 20, width: 10, height: 5 },
    parameterValues: []
  });
});

test("online product edit calls Yandex mapping, price and stock APIs", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const product = mapOnlineProductToYandexPayload({
    offerId: "SKU-200",
    name: "Edited product",
    salePrice: 2500,
    stockCount: 11,
    packageLengthCm: 30,
    packageWidthCm: 20,
    packageHeightCm: 10,
    weightKg: 1.2
  });

  const result = await publishYandexProducts({
    shop: { businessId: "business-1", campaignId: "campaign-1", apiKey: "secret" },
    products: [product],
    apiBase: "https://yandex.test",
    fetchImpl
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requests.map((entry) => [entry.method, entry.url]), [
    ["POST", "https://yandex.test/v2/businesses/business-1/offer-mappings/update"],
    ["POST", "https://yandex.test/v2/businesses/business-1/offer-prices/updates"],
    ["PUT", "https://yandex.test/v2/campaigns/campaign-1/offers/stocks"]
  ]);
  assert.equal(requests[0].body.offerMappings[0].offer.weightDimensions.weight, 1.2);
  assert.equal(requests[1].body.offers[0].price.value, 2500);
  assert.equal(requests[2].body.skus[0].items[0].count, 11);
});

test("shop currency overrides a draft's legacy currency in Yandex requests", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await publishYandexProducts({
    shop: { businessId: "business-1", campaignId: "campaign-1", apiKey: "secret", shopCurrency: "CNY" },
    products: [{ offerId: "SKU-CNY", name: "CNY product", price: 99, stockCount: 1, currencyId: "RUR" }],
    apiBase: "https://yandex.test",
    fetchImpl
  });
  assert.equal(requests[0].body.offerMappings[0].offer.basicPrice.currencyId, "CNY");
  assert.equal(requests[1].body.offers[0].price.currencyId, "CNY");
});
