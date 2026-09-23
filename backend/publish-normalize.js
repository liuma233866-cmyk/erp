const { makeId } = require("./identity");
const { normalizeMoney } = require("./money");
const { normalizeExternalHttpUrl } = require("./url-safety");

// 从 server.js 拆出的在线产品/发布商品归一化与 Yandex 校验（纯函数）。

function normalizeOnlineProductRecord(product) {
  if (!product || typeof product !== "object") return;
  if (!product.id) product.id = makeId("PRD");
  const canonicalSku = String(product.shopSku || product.offerId || product.vendorCode || "").trim();
  product.shopId = String(product.shopId || "");
  product.shopName = String(product.shopName || "");
  product.offerId = canonicalSku;
  product.shopSku = canonicalSku;
  product.name = String(product.name || product.title || "");
  product.vendor = String(product.vendor || "");
  product.vendorCode = canonicalSku;
  product.marketSku = product.marketSku !== undefined && product.marketSku !== null ? String(product.marketSku) : "";
  product.categoryId = product.categoryId !== undefined && product.categoryId !== null ? String(product.categoryId) : "";
  product.status = String(product.status || "");
  let inventoryValue = Number(product.inventory);
  if (!Number.isFinite(inventoryValue)) {
    const stockFallback = Number(product.stockCount);
    inventoryValue = Number.isFinite(stockFallback) ? stockFallback : 0;
  }
  product.inventory = inventoryValue;
  for (const field of ["salePrice", "originalPrice", "purchasePriceRmb", "purchasePriceRub", "commissionPercent", "packageLengthCm", "packageWidthCm", "packageHeightCm", "weightKg", "stockCount", "profitRub", "profitRmb", "profitRate", "profitRateRubToRmb"]) {
    if (product[field] === undefined || product[field] === null || product[field] === "") continue;
    const num = Number(product[field]);
    if (Number.isFinite(num)) product[field] = num;
  }
  if (!Array.isArray(product.barcodes)) {
    const v = String(product.barcodes || "").trim();
    product.barcodes = v ? [v] : [];
  }
  if (!Array.isArray(product.urls)) {
    const v = String(product.urls || "").trim();
    product.urls = v ? [v] : [];
  }
  if (!Array.isArray(product.pictures)) {
    const v = String(product.pictures || "").trim();
    product.pictures = v ? [v] : [];
  }
  if (!product.imageUrl && product.pictures.length) {
    product.imageUrl = product.pictures[0];
  }
  if (!product.createdAt) {
    product.createdAt = product.updatedAt || new Date().toISOString();
  }
  if (!product.updatedAt) {
    product.updatedAt = product.createdAt;
  }
}

function normalizePublishProductRecord(item) {
  const source = item && typeof item === "object" ? item : {};
  const next = { ...source };
  const normalizedBrand = String(source.vendor || source.brand || "").trim();
  const canonicalSku = String(source.sku || source.shopSku || source.offerId || source.vendorCode || source.productId || "").trim();
  const publishPlatform = String(source.publishPlatform || source.platform || source.marketplace || "").trim().toLowerCase();
  const rawSystemSku = String(source.systemSku || source.system_sku || "").trim();
  const copiedSystemSkuNeedsClearing = String(source.source || "") === "yandex_online_product" && (
    source.systemSkuPending === true ||
    (source.systemSkuPending === undefined && rawSystemSku && rawSystemSku === canonicalSku)
  );
  next.source = String(source.source || "").trim();
  next.shopId = String(source.shopId || source.storeId || source.campaignShopId || "").trim();
  next.systemSku = copiedSystemSkuNeedsClearing
    ? ""
    : rawSystemSku;
  if (copiedSystemSkuNeedsClearing) next.systemSkuPending = true;
  next.platformSku = source.platformSkuPending === true
    ? ""
    : String(
        source.platformSku ||
          source.marketSku ||
          source.offerId ||
          source.platformOfferId ||
          source.ozonSku ||
          source.yandexSku ||
          canonicalSku
      ).trim() || canonicalSku;
  next.publishPlatform = publishPlatform || String(source.publishPlatform || source.platform || "").trim();
  next.publishStatus = String(source.publishStatus || source.lastPublishStatus || "draft").trim() || "draft";
  next.publishResultMessage = String(source.publishResultMessage || source.publishMessage || "").trim();
  next.publishAt = String(source.publishAt || source.lastPublishAt || "").trim();
  const rawPictures = []
    .concat(Array.isArray(source.pictures) ? source.pictures : [])
    .concat(Array.isArray(source.images) ? source.images : [])
    .concat([source.imageUrl, source.image, source.mainImage]);
  next.pictures = normalizePublishImageUrls(rawPictures);
  next.images = next.pictures.slice();
  next.imageUrl = normalizePublishImageUrls([source.imageUrl, source.image, source.mainImage])[0] || "";
  if (!next.imageUrl && next.pictures.length) next.imageUrl = next.pictures[0];
  next.collectUrl = normalizeExternalHttpUrl(source.collectUrl || source.sourceUrl || source.crawlUrl);
  next.purchaseUrl = normalizeExternalHttpUrl(source.purchaseUrl || source.buyUrl || source.supplierUrl);
  next.purchaseUrl2 = normalizeExternalHttpUrl(source.purchaseUrl2 || source.purchaseUrlAlt || source.purchaseUrlBackup || source.buyUrl2);
  next.sku = canonicalSku;
  next.title = String(source.title || source.name || source.productTitle || "").trim();
  next.salePrice = normalizeMoney(source.salePrice ?? source.price ?? source.sellingPrice);
  next.originalPrice = normalizeMoney(source.originalPrice ?? source.oldPrice ?? source.priceBeforeDiscount ?? source.listPrice);
  next.purchasePriceRmb = normalizeMoney(source.purchasePriceRmb ?? source.costRmb ?? source.priceRmb);
  next.purchasePriceRub = normalizeMoney(source.purchasePriceRub ?? source.costRub ?? source.priceRub);
  next.packageLengthCm = normalizeMoney(source.packageLengthCm ?? source.lengthCm ?? source.length);
  next.packageWidthCm = normalizeMoney(source.packageWidthCm ?? source.widthCm ?? source.width);
  next.packageHeightCm = normalizeMoney(source.packageHeightCm ?? source.heightCm ?? source.height);
  next.weightKg = normalizeMoney(source.weightKg ?? source.weight ?? source.weight_kg);
  next.description = String(source.description || source.desc || "").trim();
  next.collectedAt = String(source.collectedAt || source.collectTime || source.crawledAt || "").trim();
  if (!next.collectedAt) next.collectedAt = new Date().toISOString();
  next.marketCategoryId = String(source.marketCategoryId || source.categoryId || "").trim();
  next.marketCategoryName = String(source.marketCategoryName || source.categoryName || "").trim();
  next.vendor = normalizedBrand;
  next.brand = normalizedBrand;
  next.vendorCode = canonicalSku || String(source.article || source.vendor_code || "").trim();
  const stock = Number(source.stockCount ?? source.stock ?? source.quantity);
  next.stockCount = Number.isFinite(stock) && stock >= 0 ? Math.floor(stock) : 0;
  next.currencyId = String(source.currencyId || "RUR").trim() || "RUR";
  next.lastPublishStatus = String(source.lastPublishStatus || "").trim();
  next.lastPublishAt = String(source.lastPublishAt || "").trim();
  next.variants = normalizePublishProductVariants(source, next);
  next.variantCount = next.variants.length;
  next.hasVariants = next.variantCount > 0;
  if (!next.imageUrl && next.variants.length) next.imageUrl = String(next.variants[0].imageUrl || "").trim();
  if ((!next.images || !next.images.length) && next.variants.length) {
    next.images = normalizePublishImageUrls(next.variants.flatMap((variant) => variant.images || []));
    next.pictures = next.images.slice();
  }
  if (!(next.salePrice > 0) && next.variants.length) {
    next.salePrice = normalizeMoney(next.variants[0].salePrice);
  }
  if (!(next.weightKg > 0) && next.variants.length) {
    next.weightKg = normalizeMoney(next.variants[0].weightKg);
  }
  if (!(next.packageLengthCm > 0) && next.variants.length) {
    next.packageLengthCm = normalizeMoney(next.variants[0].packageLengthCm);
  }
  if (!(next.packageWidthCm > 0) && next.variants.length) {
    next.packageWidthCm = normalizeMoney(next.variants[0].packageWidthCm);
  }
  if (!(next.packageHeightCm > 0) && next.variants.length) {
    next.packageHeightCm = normalizeMoney(next.variants[0].packageHeightCm);
  }
  if (!next.publishPlatform && next.shopId) {
    next.publishPlatform = "";
  }
  if (!next.publishAt && next.lastPublishAt) {
    next.publishAt = next.lastPublishAt;
  }
  if (!next.publishStatus && next.lastPublishStatus) {
    next.publishStatus = next.lastPublishStatus;
  }
  return next;
}

function normalizeVariantAttributeTerms(value) {
  if (!value || typeof value !== "object") return {};
  const next = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || "").trim();
    const normalizedValue = String(rawValue || "").trim();
    if (!key || !normalizedValue) continue;
    next[key] = normalizedValue;
  }
  return next;
}

function buildVariantAttributeSummary(attributeTerms) {
  return Object.entries(normalizeVariantAttributeTerms(attributeTerms))
    .map(([key, value]) => `${key}: ${value}`)
    .join(" / ");
}

function getPublishProductAttributeTerms(item) {
  const source = item && typeof item === "object" ? item : {};
  return normalizeVariantAttributeTerms(
    source.attributeTerms || source.variantAttributes || source.attributes || {}
  );
}

function getPublishProductCategoryId(item) {
  const source = item && typeof item === "object" ? item : {};
  const raw = source.categoryId ?? source.marketCategoryId ?? source.typeId;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizePublishVariantRecord(rawVariant, baseItem, index) {
  const source = rawVariant && typeof rawVariant === "object" ? rawVariant : {};
  const base = baseItem && typeof baseItem === "object" ? baseItem : {};
  const attributeTerms = normalizeVariantAttributeTerms(source.attributeTerms || source.variantAttributes || source.attributes || {});
  const attributeSummary = buildVariantAttributeSummary(attributeTerms);
  const fallbackSku = String(base.sku || base.vendorCode || base.id || "").trim();
  const fallbackTitle = String(base.title || "").trim();
  const variantSku = String(source.sku || source.offerId || source.vendorCode || "").trim() || (fallbackSku ? `${fallbackSku}-V${index + 1}` : `VARIANT-${index + 1}`);
  const variantTitle = String(source.title || source.name || "").trim() || [fallbackTitle, attributeSummary].filter(Boolean).join(" / ");
  const rawPictures = []
    .concat(Array.isArray(source.pictures) ? source.pictures : [])
    .concat(Array.isArray(source.images) ? source.images : [])
    .concat(Array.isArray(source.attributeImages) ? source.attributeImages : [])
    .concat([source.imageUrl, source.image, source.mainImage]);
  const normalizedPictures = normalizePublishImageUrls(rawPictures);
  const stock = Number(source.stockCount ?? source.stock ?? source.quantity ?? base.stockCount);

  return {
    source: String(source.source || base.source || "").trim(),
    shopId: String(source.shopId || base.shopId || "").trim(),
    parentSku: fallbackSku,
    sku: variantSku,
    offerId: variantSku,
    vendorCode: variantSku,
    title: variantTitle,
    name: variantTitle,
    vendor: String(source.vendor || source.brand || base.vendor || base.brand || "").trim(),
    brand: String(source.vendor || source.brand || base.vendor || base.brand || "").trim(),
    images: normalizedPictures.length ? normalizedPictures : normalizePublishImageUrls(base.images || base.pictures || [base.imageUrl]),
    pictures: normalizedPictures.length ? normalizedPictures.slice() : normalizePublishImageUrls(base.images || base.pictures || [base.imageUrl]),
    imageUrl: normalizedPictures[0] || String(base.imageUrl || "").trim(),
    collectUrl: normalizeExternalHttpUrl(source.collectUrl || source.sourceUrl || base.collectUrl),
    purchaseUrl: normalizeExternalHttpUrl(source.purchaseUrl || source.buyUrl || base.purchaseUrl),
    purchaseUrl2: normalizeExternalHttpUrl(source.purchaseUrl2 || source.purchaseUrlAlt || source.purchaseUrlBackup || source.buyUrl2 || base.purchaseUrl2),
    salePrice: normalizeMoney(source.salePrice ?? source.price ?? base.salePrice),
    originalPrice: normalizeMoney(source.originalPrice ?? source.oldPrice ?? base.originalPrice),
    purchasePriceRmb: normalizeMoney(source.purchasePriceRmb ?? base.purchasePriceRmb),
    purchasePriceRub: normalizeMoney(source.purchasePriceRub ?? base.purchasePriceRub),
    packageLengthCm: normalizeMoney(source.packageLengthCm ?? source.lengthCm ?? source.length ?? base.packageLengthCm),
    packageWidthCm: normalizeMoney(source.packageWidthCm ?? source.widthCm ?? source.width ?? base.packageWidthCm),
    packageHeightCm: normalizeMoney(source.packageHeightCm ?? source.heightCm ?? source.height ?? base.packageHeightCm),
    weightKg: normalizeMoney(source.weightKg ?? source.weight ?? source.weight_kg ?? base.weightKg),
    description: String(source.description || base.description || "").trim(),
    collectedAt: String(source.collectedAt || base.collectedAt || new Date().toISOString()).trim(),
    marketCategoryId: String(source.marketCategoryId || base.marketCategoryId || "").trim(),
    marketCategoryName: String(source.marketCategoryName || base.marketCategoryName || "").trim(),
    stockCount: Number.isFinite(stock) && stock >= 0 ? Math.floor(stock) : 0,
    currencyId: String(source.currencyId || base.currencyId || "RUR").trim() || "RUR",
    attributeTerms,
    attributeSummary,
    attributes: normalizeVariantAttributeTerms(source.attributes || {}),
    matchScore: Number(source.matchScore ?? base.matchScore ?? 0) || 0,
    matchType: String(source.matchType || base.matchType || "").trim()
  };
}

function normalizePublishProductVariants(source, baseItem) {
  const variants = Array.isArray(source?.variants)
    ? source.variants
    : Array.isArray(source?.offers)
      ? source.offers
      : Array.isArray(source?.skus)
        ? source.skus
        : [];
  return variants
    .map((variant, index) => normalizePublishVariantRecord(variant, baseItem, index))
    .filter((variant) => String(variant.sku || "").trim());
}

function findLinkOrContactHitText(text) {
  const raw = String(text || "");
  if (!raw) return "";

  const normalized = raw.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim();

  const urlMatch =
    normalized.match(/\bhttps?\s*:\s*\/\s*\/\s*\S+/i) ||
    normalized.match(/\bhttps?:\/\/\s*\S+/i) ||
    normalized.match(/\bwww\s*\.\s*\S+/i) ||
    normalized.match(/\bmailto\s*:\s*\S+/i);
  if (urlMatch?.[0]) return String(urlMatch[0]).trim();

  const emailMatch = normalized.match(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i);
  if (emailMatch?.[0]) return String(emailMatch[0]).trim();

  const candidates = normalized.match(/\+?\d[\d\s\-().]{6,}\d/g) || [];
  for (const candidate of candidates) {
    const hit = String(candidate || "").trim();
    if (!hit) continue;
    const digits = hit.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 16) continue;
    if (!/[ \-().+]/.test(hit)) continue;
    return hit;
  }

  return "";
}

function validateMappedYandexOffer(item, options = {}) {
  const requirePositiveStock = options.requirePositiveStock === true;
  const title = String(item.name || "").trim();
  const sku = String(item.offerId || "").trim();
  const imageUrl = String(Array.isArray(item.images) ? item.images[0] || "" : item.imageUrl || "").trim();
  const brand = String(item.vendor || "").trim();
  const description = String(item.description || "").trim();
  const categoryPath = String(item.categoryName || item.categoryId || "").trim();
  const salePrice = normalizeMoney(item.price);
  const originalPrice = normalizeMoney(item.originalPrice);
  const stockCount = Number(item.stockCount);
  const lengthCm = normalizeMoney(item.dimensions?.length);
  const widthCm = normalizeMoney(item.dimensions?.width);
  const heightCm = normalizeMoney(item.dimensions?.height);
  const weightKg = normalizeMoney(item.weightKg);
  const missingFields = [];
  const invalidFields = [];
  const promoWords = /скидка|распродажа|дешевый|дёшево|подарок|бесплатно|акция|специальная цена|новинка|хит|аналог|заказ|sale|discount|free|new/i;
  const skuPattern = /^(?=.*\S.*)[^\x00-\x08\x0A-\x1F\x7F]{1,255}$/;

  if (!title) missingFields.push("title");
  if (!sku) missingFields.push("sku");
  if (!imageUrl) missingFields.push("image");
  if (!brand) missingFields.push("brand");
  if (!description) missingFields.push("description");
  if (!(salePrice > 0)) missingFields.push("salePrice");
  if (Number.isFinite(originalPrice) && originalPrice > 0 && originalPrice <= salePrice) invalidFields.push("originalPrice must be greater than salePrice");
  if (!(lengthCm > 0)) missingFields.push("packageLengthCm");
  if (!(widthCm > 0)) missingFields.push("packageWidthCm");
  if (!(heightCm > 0)) missingFields.push("packageHeightCm");
  if (!(weightKg > 0)) missingFields.push("weightKg");
  if (!categoryPath) missingFields.push("yandexCategory");
  if (Number.isFinite(stockCount) && stockCount < 0) invalidFields.push("stockCount must not be negative");
  if (requirePositiveStock && !(stockCount > 0)) invalidFields.push("stockCount must be greater than 0 for publish");

  if (title) {
    if (title.length > 256) invalidFields.push("title must be <= 256 chars");
    if (promoWords.test(title)) invalidFields.push("title must not contain promo words");
  }
  if (sku && !skuPattern.test(sku)) {
    invalidFields.push("sku must be 1-255 chars and must not contain control characters");
  }
  if (imageUrl) {
    if (!/^https?:\/\//i.test(imageUrl)) invalidFields.push("image must be a full http/https URL");
    if (imageUrl.length > 2000) invalidFields.push("image URL must be <= 2000 chars");
  }
  if (brand) {
    if (brand.length > 256) invalidFields.push("brand must be <= 256 chars");
    const hit = findLinkOrContactHitText(brand);
    if (hit) invalidFields.push(`brand must not contain links or contact info (${hit.slice(0, 60)})`);
  }
  if (description) {
    if (promoWords.test(description)) invalidFields.push("description must not contain promo words");
    const hit = findLinkOrContactHitText(description);
    if (hit) invalidFields.push(`description must not contain links or contact info (${hit.slice(0, 60)})`);
  }

  return {
    ok: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
    message: [
      missingFields.length ? `required: ${missingFields.join(", ")}` : "",
      invalidFields.length ? `invalid: ${invalidFields.join("; ")}` : ""
    ].filter(Boolean).join("; ")
  };
}

function expandPublishProductToYandexPayloads(item) {
  const normalized = normalizePublishProductRecord(item);
  const sources = normalized.variants.length ? normalized.variants : [normalized];
  return sources
    .map((source) => mapPublishProductToYandexPayload(source, normalized))
    .filter((entry) => String(entry.offerId || "").trim() && String(entry.name || "").trim());
}

function normalizePublishImageUrls(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = sanitizePublishImageUrl(value);
    if (!normalized) continue;
    const key = canonicalizePublishImageUrl(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function sanitizePublishImageUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  if (/[<>{}]/.test(raw) || /(?:\);|url\(|box-shadow:|background-image:)/i.test(raw)) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  const full = parsed.href;
  const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  if (/(?:^|[\/_-])(favicon|logo|sprite|icon)(?:[\/_.-]|$)/i.test(path)) return "";
  if (/(?:apple-touch-icon|android-chrome|mstile|sitewebmanifest)/i.test(path)) return "";
  return full;
}

function normalizeExternalImageUrl(value) {
  const sanitized = sanitizePublishImageUrl(value);
  if (!sanitized) return "";
  try {
    const parsed = new URL(sanitized);
    if (parsed.protocol === "http:" && !/^(127\.0\.0\.1|localhost)$/i.test(parsed.hostname)) {
      parsed.protocol = "https:";
      return parsed.href;
    }
  } catch {}
  return sanitized;
}

function canonicalizePublishImageUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (/avatars\.mds\.yandex\.net$/i.test(parsed.hostname)) {
      parsed.pathname = parsed.pathname.replace(/\/(?:orig|9hq|hq|hqdefault|preview|small|medium|large)$/i, "");
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function validatePublishProductForYandex(rawItem, options = {}) {
  const item = normalizePublishProductRecord(rawItem);
  const expandedItems = expandPublishProductToYandexPayloads(item);
  if (!expandedItems.length) {
    return {
      ok: false,
      item,
      missingFields: ["variants"],
      invalidFields: [],
      errors: [],
      message: "required: variants"
    };
  }
  const errors = expandedItems
    .map((entry, index) => ({
      index,
      offerId: String(entry.offerId || "").trim(),
      name: String(entry.name || "").trim(),
      validation: validateMappedYandexOffer(entry, options)
    }))
    .filter((entry) => !entry.validation.ok)
    .map((entry) => ({
      index: entry.index,
      offerId: entry.offerId,
      name: entry.name,
      missingFields: entry.validation.missingFields,
      invalidFields: entry.validation.invalidFields,
      message: entry.validation.message
    }));

  return {
    ok: errors.length === 0,
    item,
    missingFields: errors.flatMap((entry) => entry.missingFields || []),
    invalidFields: errors.flatMap((entry) => entry.invalidFields || []),
    errors,
    message: errors.slice(0, 3).map((entry) => `${entry.offerId || `variant-${entry.index + 1}`}: ${entry.message}`).join(" | ")
  };
}

function isLockedPublishProduct(item) {
  if (!item || typeof item !== "object") return false;
  const collectUrl = String(item.collectUrl || "").trim().toLowerCase();
  if (collectUrl.includes("ozon.ru/product/") || collectUrl.includes("ozon.kz/product/")) return true;
  return false;
}

function buildPublishProductKey(item) {
  if (!item || typeof item !== "object") return "";
  const shopId = String(item.shopId || "").trim();
  const sku = String(item.sku || "").trim();
  if (shopId && sku) return `${shopId}::${sku}`;
  if (sku) return `::${sku}`;
  const purchaseUrl = String(item.purchaseUrl || "").trim();
  if (purchaseUrl) return `url::${purchaseUrl}`;
  return "";
}

function mapPublishProductToYandexPayload(item, baseItem = null) {
  const source = baseItem ? { ...baseItem, ...item } : item;
  const canonicalSku = String(source.sku || source.offerId || source.vendorCode || source.id || "").trim();
  const length = normalizeMoney(source.packageLengthCm);
  const width = normalizeMoney(source.packageWidthCm);
  const height = normalizeMoney(source.packageHeightCm);
  const images = Array.from(
    new Set(
      []
        .concat(Array.isArray(source.pictures) ? source.pictures : [])
        .concat(Array.isArray(source.images) ? source.images : [])
        .concat([source.imageUrl])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
  return {
    offerId: canonicalSku,
    name: String(source.title || source.name || "").trim(),
    vendor: String(source.vendor || source.brand || "").trim(),
    vendorCode: canonicalSku,
    categoryId: Number(String(source.marketCategoryId || "").trim()) || 0,
    categoryName: String(source.marketCategoryName || "").trim(),
    description: String(source.description || "").trim(),
    images,
    url: String(source.collectUrl || source.purchaseUrl || source.purchaseUrl2 || "").trim(),
    barcodes: [],
    weightKg: normalizeMoney(source.weightKg),
    dimensions: {
      length,
      width,
      height
    },
    purchasePriceRub: normalizeMoney(source.purchasePriceRub),
    originalPrice: normalizeMoney(source.originalPrice),
    price: normalizeMoney(source.salePrice),
    stockCount: Number(source.stockCount || 0),
    currencyId: String(source.currencyId || "RUR").trim() || "RUR",
    attributeTerms: normalizeVariantAttributeTerms(source.attributeTerms || {}),
    parentSku: String(source.parentSku || source.sku || "").trim()
  };
}

module.exports = {
  buildPublishProductKey,
  buildVariantAttributeSummary,
  canonicalizePublishImageUrl,
  expandPublishProductToYandexPayloads,
  findLinkOrContactHitText,
  getPublishProductAttributeTerms,
  getPublishProductCategoryId,
  isLockedPublishProduct,
  mapPublishProductToYandexPayload,
  normalizeExternalImageUrl,
  normalizeOnlineProductRecord,
  normalizePublishImageUrls,
  normalizePublishProductRecord,
  normalizePublishProductVariants,
  normalizePublishVariantRecord,
  normalizeVariantAttributeTerms,
  sanitizePublishImageUrl,
  validateMappedYandexOffer,
  validatePublishProductForYandex,
};
