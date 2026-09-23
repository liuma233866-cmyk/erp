const { parseYandexDateTime } = require("./datetime");
const { normalizeMoney } = require("./money");
const { calculateYandexOrderPricing } = require("./order-pricing");
const { classifyYandexCustomerReceipt } = require("./order-receipt-status");
const { normalizeShopCurrency } = require("./yandex-publish-service");
const { buildStableOrderId, makeId } = require("./identity");
const { normalizeExternalImageUrl } = require("./publish-normalize");

// 从 server.js 拆出的 Yandex 订单映射（原始报文 -> 本地订单，纯函数）。

function extractYandexOrderId(raw) {
  if (!raw) return "";
  return String(raw.id || raw.orderId || raw.orderNo || raw.order?.id || raw.order?.orderId || "").trim();
}

function collectYandexImageCandidates(...values) {
  const result = [];
  const push = (value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = String(value || "").trim();
    if (!text) return;
    result.push(text);
  };
  for (const value of values) push(value);
  return result;
}

function pickYandexOrderImage(raw, firstItem, mapped = {}) {
  const candidates = collectYandexImageCandidates(
    firstItem?.image,
    firstItem?.imageUrl,
    firstItem?.picture,
    firstItem?.pictureUrl,
    firstItem?.photo,
    firstItem?.photoUrl,
    firstItem?.thumbnail,
    firstItem?.thumbnailUrl,
    firstItem?.previewImage,
    firstItem?.previewImageUrl,
    firstItem?.mainImage,
    firstItem?.mainImageUrl,
    firstItem?.images,
    firstItem?.pictures,
    raw?.image,
    raw?.imageUrl,
    raw?.picture,
    raw?.pictureUrl,
    raw?.photo,
    raw?.photoUrl,
    raw?.thumbnail,
    raw?.thumbnailUrl,
    raw?.previewImage,
    raw?.previewImageUrl,
    raw?.mainImage,
    raw?.mainImageUrl,
    raw?.images,
    raw?.pictures,
    raw?.offer?.image,
    raw?.offer?.imageUrl,
    raw?.offer?.images,
    raw?.offer?.pictures,
    mapped?.image
  );
  return normalizeExternalImageUrl(candidates[0] || "");
}

function getYandexItemSubsidy(rawItem) {
  const subsidies = Array.isArray(rawItem?.subsidies) ? rawItem.subsidies : [];
  const listTotal = subsidies.reduce((sum, item) => {
    const amount = normalizeMoney(item?.amount);
    return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
  }, 0);
  if (listTotal > 0) return listTotal;
  const direct = normalizeMoney(rawItem?.subsidy);
  return Number.isFinite(direct) && direct > 0 ? direct : 0;
}

function mapYandexOrderToLocal(raw, shop, offerMap = {}) {
  if (!raw) return null;
  const orderId = extractYandexOrderId(raw);
  if (!orderId) return null;

  const createdAt = parseYandexDateTime(raw.creationDate || raw.creationDateTime || raw.createdAt || "");
  const shipment = raw.delivery?.shipments?.[0] || raw.shipments?.[0] || null;
  const shipmentDate = shipment?.shipmentDate || shipment?.shipmentDateTime || "";
  const shipmentTime = shipment?.shipmentTime || "";
  const deadlineAt = parseYandexDateTime(shipmentDate, shipmentTime);

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const firstItem = rawItems.length ? rawItems[0] : {};
  const offerId = String(firstItem.offerId || raw.offerId || firstItem.shopSku || raw.shopSku || "").trim();
  const shopSku = String(firstItem.shopSku || raw.shopSku || offerId || "").trim();
  const mapped = offerId ? offerMap[offerId] || {} : {};
  const title = String(firstItem.offerName || raw.offerName || raw.title || mapped.name || "").trim();
  const items = rawItems.map((rawItem) => {
    const itemOfferId = String(rawItem?.offerId || rawItem?.shopSku || rawItem?.sku || "").trim();
    const itemMapped = itemOfferId ? offerMap[itemOfferId] || {} : {};
    const itemCount = Math.max(1, normalizeItemCount(rawItem?.count, rawItem?.quantity, rawItem?.itemCount));
    const buyerPrice = normalizeMoney(rawItem?.buyerPrice ?? rawItem?.price);
    const price = normalizeMoney(rawItem?.price ?? rawItem?.buyerPrice);
    const subsidy = getYandexItemSubsidy(rawItem);
    return {
      offerId: itemOfferId,
      shopSku: String(rawItem?.shopSku || itemOfferId || "").trim(),
      name: String(rawItem?.offerName || rawItem?.title || itemMapped.name || "").trim(),
      count: itemCount,
      quantity: itemCount,
      buyerPrice: Number.isFinite(buyerPrice) ? buyerPrice : undefined,
      price: Number.isFinite(price) ? price : undefined,
      subsidy,
      unitPrice: Number.isFinite(price) ? price + subsidy : buyerPrice,
      imageUrl: pickYandexOrderImage(raw, rawItem, itemMapped)
    };
  });
  const pricing = calculateYandexOrderPricing(
    items,
    [raw.buyerTotal, raw.itemsTotal, raw.buyerItemsTotal, raw.total, raw.paymentAmount],
    normalizeMoney
  );
  const quantity = items.length ? pricing.quantity : normalizeItemCount(raw.itemsCount, raw.totalItems);
  const computedAmount = pricing.amount;
  const finalUnitPrice = pricing.unitPrice;

  const shopStatus = String(raw.status || raw.orderStatus || "").trim();
  const shopSubstatus = String(
    raw.substatus || raw.subStatus || raw.delivery?.substatus || raw.delivery?.subStatus || ""
  ).trim();
  const customerReceipt = classifyYandexCustomerReceipt(shopStatus, shopSubstatus);
  const reportedDeliveryDate = String(
    raw.delivery?.dates?.realDeliveryDate || raw.delivery?.realDeliveryDate || raw.realDeliveryDate || ""
  ).trim();
  const customerReceivedAt = customerReceipt.received ? reportedDeliveryDate : "";
  const statusSignals = collectYandexOrderStatusSignals(raw);
  const localStatus = mapYandexStatusToLocal(statusSignals.join(" "));

  const imageUrl = pickYandexOrderImage(raw, firstItem, mapped);
  const order = {
    customerName: "店铺订单",
    amount: computedAmount,
    status: localStatus,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sellerOrderAt: createdAt || "",
    deadlineAt: deadlineAt || "",
    currency: normalizeShopCurrency(shop?.shopCurrency || raw.currency || raw.buyerTotal?.currency || raw.itemsTotal?.currency || raw.total?.currency),
    platform: "Yandex",
    provider: "yandex_market",
    shopId: String(shop.id || ""),
    shopName: String(shop.name || "").trim(),
    shopSku,
    itemCount: quantity || 0,
    shopOrderNo: orderId,
    shopStatus,
    shopSubstatus,
    customerReceiptCode: customerReceipt.code,
    customerReceiptZh: customerReceipt.labelZh,
    customerReceiptEn: customerReceipt.labelEn,
    customerReceived: customerReceipt.received,
    customerReceivedAt,
    trackingNo: orderId,
    logistics: String(raw.delivery?.serviceName || raw.delivery?.deliveryServiceName || "").trim(),
    warehouse: String(raw.delivery?.warehouse?.name || raw.warehouse || "").trim(),
    productName: title,
    unitPrice: Number.isFinite(finalUnitPrice) ? finalUnitPrice : undefined,
    imageUrl,
    items,
    account: String(shop.campaignId || "")
  };
  order.id = buildStableOrderId(order) || makeId("ORD");
  return order;
}

function mapYandexStatusToLocal(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("CANCEL")) return "cancelled";
  if (value.includes("DELIVER") || value.includes("SHIP") || value.includes("PICKUP")) return "shipped";
  if (["DELIVERED", "DELIVERY", "SHIPPED", "PICKUP"].includes(value)) return "shipped";
  if (["CANCELLED", "CANCELED"].includes(value)) return "cancelled";
  return "pending";
}

function collectYandexOrderStatusSignals(raw) {
  if (!raw || typeof raw !== "object") return [];
  const signals = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    signals.push(text);
  };

  push(raw.status);
  push(raw.orderStatus);
  push(raw.substatus);
  push(raw.subStatus);
  push(raw.delivery?.status);
  push(raw.delivery?.substatus);
  push(raw.delivery?.subStatus);

  const rootTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const rootShipments = Array.isArray(raw.shipments) ? raw.shipments : [];
  const deliveryTracks = Array.isArray(raw.delivery?.tracks) ? raw.delivery.tracks : [];
  const deliveryShipments = Array.isArray(raw.delivery?.shipments) ? raw.delivery.shipments : [];
  for (const track of [...rootTracks, ...deliveryTracks]) {
    push(track?.status);
    push(track?.statusText);
  }
  for (const shipment of [...rootShipments, ...deliveryShipments]) {
    push(shipment?.status);
    push(shipment?.shipmentStatus);
    if (Array.isArray(shipment?.tracks)) {
      for (const track of shipment.tracks) {
        push(track?.status);
        push(track?.statusText);
      }
    }
  }
  return signals;
}

function firstItemSku(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const first = items[0] || {};
  return String(first.shopSku || first.offerId || first.sku || "");
}

function normalizeItemCount(...inputs) {
  const candidates = inputs.slice(0, 3);
  for (const raw of candidates) {
    // null/undefined/"" are "missing", not zero — skip them instead of
    // returning 0 and silently wiping the item count.
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  const items = inputs[3];
  if (Array.isArray(items) && items.length > 0) {
    return items.reduce((sum, item) => {
      const n = Number(item.count ?? item.quantity ?? item.itemCount ?? 1);
      return sum + (Number.isFinite(n) && n > 0 ? n : 1);
    }, 0);
  }

  return 1;
}

function extractYandexOrders(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.orders)) return payload.orders;
  if (Array.isArray(payload.result?.orders)) return payload.result.orders;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function extractYandexDeliveryServices(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.deliveryServices)) return payload.deliveryServices;
  if (Array.isArray(payload.deliveryService)) return payload.deliveryService;
  if (Array.isArray(payload.result?.deliveryServices)) return payload.result.deliveryServices;
  if (Array.isArray(payload.result?.deliveryService)) return payload.result.deliveryService;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function buildDeliveryServiceMap(services) {
  const map = new Map();
  for (const item of services || []) {
    const id = String(item.id ?? item.serviceId ?? item.deliveryServiceId ?? "").trim();
    if (!id) continue;
    map.set(id, {
      name: String(item.name || item.serviceName || item.deliveryServiceName || "").trim(),
      type: String(item.type || item.serviceType || "").trim()
    });
  }
  return map;
}

function extractYandexTracking(orderDetail, serviceMap) {
  const tracks = [];
  const delivery = orderDetail?.delivery || orderDetail?.deliveryInfo || {};
  const rootShipments = Array.isArray(orderDetail?.shipments) ? orderDetail.shipments : [];
  const rootTracks = Array.isArray(orderDetail?.tracks) ? orderDetail.tracks : [];
  const pushTrack = (track, meta = {}) => {
    if (!track || typeof track !== "object") return;
    const trackCode = String(track.trackCode || track.code || track.trackingNumber || "").trim();
    const serviceId = String(track.deliveryServiceId || track.serviceId || track.deliveryService || "").trim();
    if (!trackCode && !serviceId) return;
    const service = serviceId && serviceMap?.get(serviceId) ? serviceMap.get(serviceId) : null;
    tracks.push({
      trackCode,
      serviceId,
      serviceName: service?.name || "",
      serviceType: service?.type || "",
      status: String(track.status || track.statusText || "").trim(),
      statusText: String(track.statusText || "").trim(),
      updatedAt: String(track.statusUpdatedAt || track.updatedAt || "").trim(),
      shipmentId: String(meta.shipmentId || "").trim(),
      shipmentDate: String(meta.shipmentDate || "").trim(),
      shipmentTime: String(meta.shipmentTime || "").trim()
    });
  };

  if (Array.isArray(delivery.tracks)) {
    for (const track of delivery.tracks) pushTrack(track);
  }
  if (Array.isArray(rootTracks)) {
    for (const track of rootTracks) pushTrack(track);
  }
  if (Array.isArray(delivery.shipments)) {
    for (const shipment of delivery.shipments) {
      const meta = {
        shipmentId: shipment.id || shipment.shipmentId || "",
        shipmentDate: shipment.shipmentDate || shipment.date || "",
        shipmentTime: shipment.shipmentTime || ""
      };
      if (Array.isArray(shipment.tracks)) {
        for (const track of shipment.tracks) pushTrack(track, meta);
      }
    }
  }
  if (Array.isArray(rootShipments)) {
    for (const shipment of rootShipments) {
      const meta = {
        shipmentId: shipment.id || shipment.shipmentId || "",
        shipmentDate: shipment.shipmentDate || shipment.date || "",
        shipmentTime: shipment.shipmentTime || ""
      };
      if (Array.isArray(shipment.tracks)) {
        for (const track of shipment.tracks) pushTrack(track, meta);
      }
    }
  }

  const primary = tracks.find((t) => t.trackCode) || tracks[0] || {};
  return {
    primaryTrackCode: primary.trackCode || "",
    primaryServiceName: primary.serviceName || primary.serviceId || "",
    tracks
  };
}



// 从 server.js 拆出的 offer 映射辅助函数。

function collectYandexOfferIds(items) {
  if (!Array.isArray(items)) return [];
  const set = new Set();
  for (const raw of items) {
    const firstItem = Array.isArray(raw.items) && raw.items.length ? raw.items[0] : {};
    const offerId = String(firstItem.offerId || raw.offerId || firstItem.shopSku || raw.shopSku || "").trim();
    if (offerId) set.add(offerId);
  }
  return Array.from(set);
}

function enrichYandexOfferMapWithOnlineProducts(offerMap, products, shop) {
  const next = { ...(offerMap || {}) };
  const shopId = String(shop?.id || "").trim();
  for (const product of Array.isArray(products) ? products : []) {
    if (shopId && String(product?.shopId || "").trim() !== shopId) continue;
    const offerId = String(product?.offerId || product?.shopSku || product?.sku || "").trim();
    if (!offerId) continue;
    const productImages = Array.isArray(product?.images)
      ? product.images
      : Array.isArray(product?.pictures)
        ? product.pictures
        : [];
    const image = normalizeExternalImageUrl(product?.imageUrl || productImages[0] || "");
    const name = String(product?.name || product?.title || "").trim();
    const existing = next[offerId] || {};
    next[offerId] = {
      ...existing,
      name: String(existing.name || name || "").trim(),
      image: String(existing.image || image || "").trim()
    };
  }
  return next;
}

function mapYandexOfferEntryToProduct(entry, shop) {
  const offer = entry.offer || entry.mapping?.offer || entry.offerMapping?.offer || {};
  const mapping = entry.mapping || entry.offerMapping || {};
  const canonicalSku = String(offer.offerId || offer.shopSku || offer.vendorCode || offer.id || entry.offerId || "").trim();
  const pictures = Array.isArray(offer.pictures)
    ? offer.pictures
    : Array.isArray(offer.images)
      ? offer.images
      : Array.isArray(offer.picturesUrls)
        ? offer.picturesUrls
        : [];
  const urls = Array.isArray(offer.urls)
    ? offer.urls
    : offer.url
      ? [offer.url]
      : [];
  const showcaseUrls = Array.isArray(mapping.showcaseUrls) ? mapping.showcaseUrls : [];
  const barcodes = Array.isArray(offer.barcodes)
    ? offer.barcodes
    : offer.barcode
      ? [offer.barcode]
      : [];
  const inventoryRaw = offer.stockCount ?? offer.availableCount ?? offer.stock ?? offer.count ?? mapping.stockCount;
  const inventoryValue = Number(inventoryRaw);
  const basicPrice = offer.basicPrice || mapping.basicPrice || entry.basicPrice || {};
  const dimensions = offer.weightDimensions || mapping.weightDimensions || entry.weightDimensions || {};
  const status =
    String(entry.offerProcessingState?.status || entry.processingStatus || entry.status || offer.status || "")
      .trim();
  return {
    id: makeId("PRD"),
    provider: "yandex_market",
    shopId: String(shop.id || ""),
    shopName: String(shop.name || "").trim(),
    companyId: String(shop.companyId || ""),
    campaignId: String(shop.campaignId || "").trim(),
    offerId: canonicalSku,
    shopSku: canonicalSku,
    name: String(offer.name || offer.offerName || "").trim(),
    vendor: String(offer.vendor || "").trim(),
    vendorCode: canonicalSku,
    marketSku: mapping.marketSku !== undefined && mapping.marketSku !== null ? String(mapping.marketSku) : "",
    categoryId: String(mapping.marketCategoryId ?? mapping.categoryId ?? offer.marketCategoryId ?? offer.categoryId ?? "").trim(),
    categoryName: String(mapping.marketCategoryName || mapping.categoryName || offer.marketCategoryName || offer.categoryName || "").trim(),
    salePrice: Number(basicPrice.value ?? offer.price ?? offer.salePrice ?? entry.price ?? 0) || 0,
    currencyId: normalizeShopCurrency(shop?.shopCurrency || basicPrice.currencyId || basicPrice.currency),
    packageLengthCm: Number(dimensions.length ?? offer.length ?? 0) || 0,
    packageWidthCm: Number(dimensions.width ?? offer.width ?? 0) || 0,
    packageHeightCm: Number(dimensions.height ?? offer.height ?? 0) || 0,
    weightKg: Number(dimensions.weight ?? offer.weight ?? 0) || 0,
    barcodes: barcodes.filter(Boolean).map(String),
    urls: [...urls, ...showcaseUrls].filter(Boolean).map(String),
    pictures: pictures.filter(Boolean).map(String),
    imageUrl: pictures.length ? String(pictures[0] || "").trim() : "",
    inventory: Number.isFinite(inventoryValue) ? inventoryValue : 0,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildDeliveryServiceMap,
  collectYandexImageCandidates,
  collectYandexOfferIds,
  collectYandexOrderStatusSignals,
  extractYandexDeliveryServices,
  extractYandexOrderId,
  extractYandexOrders,
  enrichYandexOfferMapWithOnlineProducts,
  extractYandexTracking,
  firstItemSku,
  getYandexItemSubsidy,
  mapYandexOfferEntryToProduct,
  mapYandexOrderToLocal,
  mapYandexStatusToLocal,
  normalizeItemCount,
  pickYandexOrderImage,
};
