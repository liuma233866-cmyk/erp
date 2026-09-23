const crypto = require("crypto");

function text(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function generatePublishSku(product, target = {}) {
  const settings = target.skuSettings && typeof target.skuSettings === "object" ? target.skuSettings : {};
  const shopPrefix = settings.skuPrefixByShopId && typeof settings.skuPrefixByShopId === "object"
    ? settings.skuPrefixByShopId[text(target.shopId)]
    : "";
  const prefix = text(shopPrefix || settings.skuPrefix || "PUB").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 16) || "PUB";
  const separator = new Set(["-", "_", "."]).has(text(settings.skuSeparator)) ? text(settings.skuSeparator) : "-";
  const sourceSku = text(product?.shopSku || product?.offerId || product?.vendorCode || product?.id || "PRODUCT");
  const visible = sourceSku
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "PRODUCT";
  const scope = [target.platform, target.shopId, product?.shopId, product?.id, sourceSku].map(text).join("|");
  const suffix = crypto.createHash("sha1").update(scope).digest("hex").slice(0, 10).toUpperCase();
  return settings.skuIncludeSourceSku === false
    ? `${prefix}${separator}${suffix}`
    : `${prefix}${separator}${visible}${separator}${suffix}`;
}

function uniqueText(values) {
  return Array.from(new Set(values.map(text).filter(Boolean)));
}

function mapOnlineProductToPublishDraft(product, now = new Date().toISOString(), target = {}) {
  const source = product && typeof product === "object" ? product : {};
  const sourceSku = text(source.shopSku || source.offerId || source.vendorCode || source.id);
  const sku = generatePublishSku(source, target);
  const publishPlatform = text(target.platform || "yandex").toLowerCase();
  const targetShopId = text(target.shopId || source.shopId);
  const pictures = uniqueText([
    ...(Array.isArray(source.pictures) ? source.pictures : []),
    ...(Array.isArray(source.images) ? source.images : []),
    source.imageUrl
  ]);
  return {
    ...cloneJson(source),
    source: "yandex_online_product",
    sourceOnlineProductId: text(source.id),
    sourceShopId: text(source.shopId),
    sourceSku,
    sourceProductSnapshot: cloneJson(source),
    shopId: targetShopId,
    publishPlatform,
    publishStatus: "draft",
    sku,
    systemSku: "",
    systemSkuPending: true,
    platformSku: sku,
    platformSkuPending: false,
    offerId: sku,
    vendorCode: text(source.vendorCode || sku),
    title: text(source.name || source.title),
    name: text(source.name || source.title),
    vendor: text(source.vendor),
    brand: text(source.vendor),
    description: text(source.description || source.name || source.title),
    pictures,
    images: pictures.slice(),
    imageUrl: pictures[0] || "",
    salePrice: source.salePrice,
    originalPrice: source.originalPrice,
    purchasePriceRmb: source.purchasePriceRmb,
    purchasePriceRub: source.purchasePriceRub,
    packageLengthCm: source.packageLengthCm,
    packageWidthCm: source.packageWidthCm,
    packageHeightCm: source.packageHeightCm,
    weightKg: source.weightKg,
    stockCount: source.stockCount ?? source.inventory,
    marketCategoryId: text(source.categoryId),
    marketCategoryName: text(source.categoryName),
    purchaseUrl: text(source.purchaseUrl),
    purchaseUrl2: text(source.purchaseUrl2),
    collectedAt: text(source.updatedAt || source.createdAt || now),
    sourceCurrencyId: text(source.sourceCurrencyId || source.currencyId) || "RUR",
    currencyId: target.preserveSourceCurrency
      ? (text(source.sourceCurrencyId || source.currencyId) || "RUR")
      : (text(target.currencyId || source.currencyId) || "RUR"),
    priceConversion: null
  };
}

function copyOnlineProductsToPublishDrafts({ onlineProducts, publishProducts, normalize, makeId, target = {}, now = new Date().toISOString() }) {
  const drafts = Array.isArray(publishProducts) ? publishProducts : [];
  const sourceKey = (item) => `${text(item.shopId)}::${text(item.source)}::${text(item.sourceOnlineProductId)}`;
  const byKey = new Map(drafts.filter((item) => text(item.sourceOnlineProductId)).map((item) => [sourceKey(item), item]));
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const changedItems = [];

  for (const product of Array.isArray(onlineProducts) ? onlineProducts : []) {
    const mapped = mapOnlineProductToPublishDraft(product, now, target);
    if (!mapped.shopId || !mapped.sku) {
      skipped += 1;
      continue;
    }
    const key = sourceKey(mapped);
    const existing = byKey.get(key);
    const normalized = typeof normalize === "function" ? normalize({ ...(existing || {}), ...mapped }) : { ...(existing || {}), ...mapped };
    if (existing) {
      const previousConversion = existing.priceConversion && typeof existing.priceConversion === "object" ? existing.priceConversion : null;
      const mappedSourcePrice = Number(mapped.salePrice ?? mapped.price);
      const previousSourcePrice = Number(previousConversion?.sourceSalePrice);
      const sourcePriceChanged = previousConversion && Number.isFinite(mappedSourcePrice) && Number.isFinite(previousSourcePrice)
        ? Math.abs(mappedSourcePrice - previousSourcePrice) > 0.000001
        : false;
      const preserved = {
        sku: existing.sku,
        systemSku: existing.systemSku || "",
        systemSkuPending: existing.systemSkuPending === true,
        platformSku: existing.platformSku || existing.sku,
        platformSkuPending: existing.platformSkuPending === true,
        offerId: existing.offerId || existing.sku,
        publishStatus: existing.publishStatus || "draft",
        ...(previousConversion && !sourcePriceChanged ? { priceConversion: cloneJson(existing.priceConversion) } : {}),
        ...(previousConversion && !sourcePriceChanged ? {
          salePrice: existing.salePrice,
          price: existing.price,
          originalPrice: existing.originalPrice,
          discountPrice: existing.discountPrice,
          discountBase: existing.discountBase,
          currencyId: existing.currencyId
        } : {}),
        aiTaskId: existing.aiTaskId,
        aiTaskCode: existing.aiTaskCode,
        aiImageStatus: existing.aiImageStatus,
        aiProcessedAt: existing.aiProcessedAt,
        aiImageError: existing.aiImageError
        ,...(target.overwriteTitleDescription === false ? {
          title: existing.title,
          name: existing.name,
          description: existing.description
        } : {})
      };
      Object.assign(existing, normalized, {
        ...preserved,
        id: existing.id,
        createdAt: existing.createdAt || now,
        updatedAt: now,
        lastPublishStatus: existing.lastPublishStatus || "",
        lastPublishAt: existing.lastPublishAt || ""
      });
      changedItems.push(existing);
      updated += 1;
    } else {
      const item = {
        ...normalized,
        id: typeof makeId === "function" ? makeId("PUB") : `PUB-${created + 1}`,
        createdAt: now,
        updatedAt: now
      };
      drafts.unshift(item);
      byKey.set(key, item);
      changedItems.push(item);
      created += 1;
    }
  }
  return { items: drafts, changedItems, created, updated, skipped, total: drafts.length };
}

module.exports = { copyOnlineProductsToPublishDrafts, generatePublishSku, mapOnlineProductToPublishDraft };
