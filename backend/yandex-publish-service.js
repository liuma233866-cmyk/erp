const DEFAULT_YANDEX_API_BASE = "https://api.partner.market.yandex.ru";
const DEFAULT_BATCH_SIZE = 100;

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function text(value) {
  return String(value || "").trim();
}

function normalizeShopCurrency(value) {
  return text(value).toUpperCase() === "CNY" ? "CNY" : "RUR";
}

function formatYandexError(status, payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const description = text(first?.message || first?.description || first?.details || payload?.message || payload?.error);
  return description ? `Yandex API HTTP ${status}: ${description}` : `Yandex API HTTP ${status}`;
}

function createFailure(products, message, status = 502) {
  return {
    ok: false,
    status,
    message,
    success: 0,
    failed: products.map((product) => ({ offerId: text(product?.offerId), message }))
  };
}

function chunk(items, size = DEFAULT_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function buildOfferMappingsPayload(products) {
  return {
    offerMappings: products.map((product) => {
      const offer = {
        offerId: text(product.offerId),
        name: text(product.name)
      };
      if (text(product.vendor)) offer.vendor = text(product.vendor);
      if (text(product.vendorCode)) offer.vendorCode = text(product.vendorCode);
      if (asNumber(product.categoryId) > 0) offer.marketCategoryId = asNumber(product.categoryId);
      if (text(product.description)) offer.description = text(product.description);
      if (Array.isArray(product.images) && product.images.length) offer.pictures = product.images.map(text).filter(Boolean);
      if (text(product.url)) offer.urls = [text(product.url)];
      if (Array.isArray(product.barcodes) && product.barcodes.length) offer.barcodes = product.barcodes.map(text).filter(Boolean);
      if (asNumber(product.price) > 0) {
        offer.basicPrice = {
          value: asNumber(product.price),
          currencyId: text(product.currencyId) || "RUR",
          ...(asNumber(product.originalPrice) > asNumber(product.price) ? { discountBase: asNumber(product.originalPrice) } : {})
        };
      }
      const dimensions = product.dimensions || {};
      if (asNumber(product.weightKg) > 0 || (asNumber(dimensions.length) > 0 && asNumber(dimensions.width) > 0 && asNumber(dimensions.height) > 0)) {
        offer.weightDimensions = {
          ...(asNumber(product.weightKg) > 0 ? { weight: asNumber(product.weightKg) } : {}),
          ...(asNumber(dimensions.length) > 0 ? { length: asNumber(dimensions.length) } : {}),
          ...(asNumber(dimensions.width) > 0 ? { width: asNumber(dimensions.width) } : {}),
          ...(asNumber(dimensions.height) > 0 ? { height: asNumber(dimensions.height) } : {})
        };
      }
      if (Array.isArray(product.parameterValues) && product.parameterValues.length) offer.parameterValues = product.parameterValues;
      return { offer };
    })
  };
}

function buildPricesPayload(products) {
  return {
    offers: products.map((product) => {
      const value = asNumber(product.price, asNumber(product.purchasePriceRub));
      if (!(value > 0)) return null;
      return {
        offerId: text(product.offerId),
        price: {
          value,
          currencyId: text(product.currencyId) || "RUR",
          ...(asNumber(product.originalPrice) > value ? { discountBase: asNumber(product.originalPrice) } : {})
        }
      };
    }).filter(Boolean)
  };
}

function buildStocksPayload(products) {
  const updatedAt = new Date().toISOString();
  return {
    skus: products.map((product) => {
      const count = asNumber(product.stockCount, NaN);
      if (!Number.isFinite(count) || count < 0) return null;
      return { sku: text(product.offerId), items: [{ count: Math.floor(count), updatedAt }] };
    }).filter(Boolean)
  };
}

function mapOnlineProductToYandexPayload(product) {
  const source = product && typeof product === "object" ? product : {};
  const pictures = Array.isArray(source.pictures) ? source.pictures : [];
  const images = Array.from(new Set([
    ...pictures,
    ...(Array.isArray(source.images) ? source.images : []),
    source.imageUrl
  ].map(text).filter(Boolean)));
  return {
    offerId: text(source.offerId || source.shopSku || source.vendorCode),
    name: text(source.name || source.title),
    vendor: text(source.vendor),
    vendorCode: text(source.vendorCode || source.shopSku || source.offerId),
    categoryId: source.categoryId,
    description: text(source.description),
    images,
    url: text(Array.isArray(source.urls) ? source.urls[0] : source.url),
    barcodes: Array.isArray(source.barcodes) ? source.barcodes : [],
    price: source.salePrice,
    originalPrice: source.originalPrice,
    currencyId: text(source.currencyId) || "RUR",
    stockCount: source.stockCount ?? source.inventory,
    weightKg: source.weightKg,
    dimensions: {
      length: source.packageLengthCm,
      width: source.packageWidthCm,
      height: source.packageHeightCm
    },
    parameterValues: Array.isArray(source.parameterValues) ? source.parameterValues : []
  };
}

async function requestYandex(endpoint, apiKey, method, body, fetchImpl) {
  const timeoutMs = Math.max(1000, Number(process.env.YANDEX_REQUEST_TIMEOUT_MS || 30000));
  const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
  let lastFailure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { method, signal: controller.signal,
        headers: { Accept: "application/json", "Api-Key": apiKey, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { ok: true, status: response.status, data };
      lastFailure = { ok: false, status: response.status, data, message: formatYandexError(response.status, data) };
      if (!retryable.has(response.status) || attempt === 2) return lastFailure;
    } catch (error) {
      lastFailure = { ok: false, status: 502, message: `Yandex request failed: ${String(error?.message || error)}` };
      if (attempt === 2) return lastFailure;
    } finally { clearTimeout(timer); }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  return lastFailure || { ok: false, status: 502, message: "Yandex request failed" };
}

async function sendBatches({ endpoint, method, apiKey, products, createPayload, fetchImpl }) {
  const failed = [];
  let success = 0;
  let firstMessage = "";
  for (const batch of chunk(products)) {
    const result = await requestYandex(endpoint, apiKey, method, createPayload(batch), fetchImpl);
    if (result.ok) {
      success += batch.length;
      continue;
    }
    const message = result.message || "Yandex API request failed";
    if (!firstMessage) firstMessage = message;
    failed.push(...batch.map((product) => ({ offerId: text(product.offerId), message })));
  }
  return failed.length
    ? { ok: success > 0, status: 502, message: firstMessage, success, failed }
    : { ok: true, success, failed: [] };
}

/**
 * Publish a prepared ERP product list to the Yandex Market Partner API.
 * The caller may provide `enrichProducts` to turn ERP attribute terms into
 * Market category parameter values before the mapping request.
 */
async function publishYandexProducts({ shop, products, apiBase = DEFAULT_YANDEX_API_BASE, enrichProducts, fetchImpl = global.fetch }) {
  const businessId = text(shop?.businessId);
  const campaignId = text(shop?.campaignId);
  const apiKey = text(shop?.apiKey);
  const shopCurrency = normalizeShopCurrency(shop?.shopCurrency || shop?.listingCurrency);
  const sourceProducts = Array.isArray(products)
    ? products.filter((product) => text(product?.offerId)).map((product) => ({ ...product, currencyId: shopCurrency }))
    : [];
  if (!businessId || !apiKey) return createFailure(sourceProducts, "Yandex 店铺缺少 businessId 或 API Key", 400);
  if (!sourceProducts.length) return createFailure([], "没有可发布的 Yandex SKU", 400);
  if (typeof fetchImpl !== "function") return createFailure(sourceProducts, "服务端 fetch 不可用", 500);

  let enriched = sourceProducts;
  try {
    if (typeof enrichProducts === "function") enriched = await enrichProducts(sourceProducts, businessId, apiKey);
  } catch (error) {
    return createFailure(sourceProducts, `Yandex 类目属性处理失败: ${String(error?.message || error)}`);
  }
  const mapping = await sendBatches({
    endpoint: `${apiBase}/v2/businesses/${encodeURIComponent(businessId)}/offer-mappings/update`,
    method: "POST",
    apiKey,
    products: enriched,
    createPayload: buildOfferMappingsPayload,
    fetchImpl
  });
  if (!mapping.ok) return { ok: false, mapping, price: createFailure([], "未执行"), stock: createFailure([], "未执行") };

  const priceProducts = enriched.filter((product) => asNumber(product.price, asNumber(product.purchasePriceRub)) > 0);
  const price = priceProducts.length
    ? await sendBatches({
      endpoint: `${apiBase}/v2/businesses/${encodeURIComponent(businessId)}/offer-prices/updates`,
      method: "POST",
      apiKey,
      products: priceProducts,
      createPayload: buildPricesPayload,
      fetchImpl
    })
    : { ok: true, success: 0, failed: [] };

  const stockProducts = enriched.filter((product) => Number.isFinite(asNumber(product.stockCount, NaN)) && asNumber(product.stockCount, NaN) >= 0);
  const stock = campaignId && stockProducts.length
    ? await sendBatches({
      endpoint: `${apiBase}/v2/campaigns/${encodeURIComponent(campaignId)}/offers/stocks`,
      method: "PUT",
      apiKey,
      products: stockProducts,
      createPayload: buildStocksPayload,
      fetchImpl
    })
    : { ok: true, success: 0, failed: [] };

  return { ok: mapping.ok && price.ok && stock.ok, mapping, price, stock };
}

module.exports = {
  buildOfferMappingsPayload,
  buildPricesPayload,
  buildStocksPayload,
  mapOnlineProductToYandexPayload,
  normalizeShopCurrency,
  publishYandexProducts
};
