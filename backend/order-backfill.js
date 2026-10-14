const { buildStableOrderId, getOrderUniqueKey } = require("./identity");

// 从 server.js 拆出的订单采购回填与订单查找（纯函数，无共享状态）。

// 采购字段清单：与 order_purchases 的列、以及 sql-persistence.js 的 ORDER_PURCHASE_FIELDS
// 三者保持一致。内联在此是为了避免 order-backfill 与 sql-persistence 互相 require。
const ORDER_PURCHASE_OVERRIDE_FIELDS = [
  "purchasePlatform",
  "purchaseLink",
  "purchaseOrderNo",
  "purchaseExpressNo",
  "purchaseIntlNo",
  "purchasePriceRmb",
  "purchasePriceRub",
  "purchaseUpdatedAt"
];

function extractOrderIdFromPurchasePath(pathValue) {
  const text = String(pathValue || "");
  const match = text.match(/\/api\/orders\/([^/]+)\/purchase/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function restorePurchaseFromAuditLogs(orders, auditLogs) {
  if (!Array.isArray(orders) || !Array.isArray(auditLogs)) return;
  const latestByOrderRef = new Map();
  for (const log of auditLogs) {
    if (!log || !log.path) continue;
    if (String(log.method || "").toUpperCase() !== "PUT") continue;
    const orderRef = extractOrderIdFromPurchasePath(log.path);
    if (!orderRef) continue;
    const body = log.requestBodyMasked;
    if (!body || typeof body !== "object") continue;
    const ts = new Date(log.ts || 0).getTime();
    if (!Number.isFinite(ts)) continue;
    const hasAny = ["purchasePlatform", "purchaseLink", "purchaseOrderNo", "purchaseExpressNo", "purchaseIntlNo", "purchasePriceRmb", "purchasePriceRub"]
      .some((key) => String(body[key] || "").trim() !== "");
    if (!hasAny) continue;
    const prev = latestByOrderRef.get(orderRef);
    if (!prev || ts > prev.ts) {
      latestByOrderRef.set(orderRef, { ts, body });
    }
  }

  const fields = [
    "purchasePlatform",
    "purchaseLink",
    "purchaseOrderNo",
    "purchaseExpressNo",
    "purchaseIntlNo",
    "purchasePriceRmb",
    "purchasePriceRub"
  ];
  for (const [orderRef, record] of latestByOrderRef.entries()) {
    const order = findOrderByRef(orders, orderRef);
    if (!order) continue;
    const body = record.body || {};
    let touched = false;
    for (const field of fields) {
      const current = order[field];
      const next = body[field];
      const currentEmpty = current === undefined || current === null || String(current).trim() === "";
      const nextValue = next === undefined || next === null ? "" : String(next).trim();
      if (currentEmpty && nextValue !== "") {
        order[field] = nextValue;
        touched = true;
      }
    }
    if (touched && !order.updatedAt) {
      order.updatedAt = new Date().toISOString();
    }
  }
}

function buildOrderPurchasePayload(body = {}) {
  return {
    purchasePlatform: String(body.purchasePlatform || "").trim(),
    purchaseLink: String(body.purchaseLink || "").trim(),
    purchaseOrderNo: String(body.purchaseOrderNo || "").trim(),
    purchaseExpressNo: String(body.purchaseExpressNo || "").trim(),
    purchaseIntlNo: String(body.purchaseIntlNo || "").trim(),
    purchasePriceRmb: String(body.purchasePriceRmb || "").trim(),
    purchasePriceRub: String(body.purchasePriceRub || "").trim(),
    purchaseUpdatedAt: new Date().toISOString()
  };
}

function applyOrderPurchaseOverrides(orders, overrides) {
  if (!Array.isArray(orders) || !Array.isArray(overrides)) return;
  for (const item of overrides) {
    const orderRef = String(item?.orderRef || "").trim();
    if (!orderRef) continue;
    const order = findOrderByRef(orders, orderRef);
    if (!order) continue;
    for (const field of ORDER_PURCHASE_OVERRIDE_FIELDS) {
      const value = item[field];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        order[field] = value;
      }
    }
    // Do NOT overwrite order.updatedAt with the purchase timestamp: the order
    // may have been modified later (status change, remark, etc.) and a
    // "rolled back" updatedAt corrupts latest-record detection in dedupe and
    // amount backfill after every restart.
  }
}

// order_purchases 表行 → db.orderPurchaseOverrides 的标准形状。
//
// orderPurchaseOverrides 是「表属主」实体（见 persistence/store-manifest.js），AppState
// 快照里按归属清单剔除了这个键，所以它**只能**由这张表回填。过去启动时只把表行按 orderRef
// 贴到「已存在」的订单对象上、却没有重建这个数组，导致每次重启数组恒为空，
// order-sync 里的 applyOrderPurchaseOverrides 成了空操作：为「尚未同步到的订单」预先登记的
// 延迟采购单（routes/orders.js 的 deferred 分支）在订单后来出现时贴不回去。
function buildOrderPurchaseOverridesFromRows(rows) {
  const overrides = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const orderRef = String(row?.orderRef || row?.orderId || row?.shopOrderNo || "").trim();
    if (!orderRef) continue;
    const override = { orderRef };
    for (const field of ORDER_PURCHASE_OVERRIDE_FIELDS) {
      override[field] = String(row?.[field] ?? "").trim();
    }
    override.updatedAt = String(row?.updatedAt || override.purchaseUpdatedAt || "").trim();
    overrides.push(override);
  }
  return overrides;
}

function hasTextValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function getOrderAmountBackfillKey(order) {
  const shopId = String(order?.shopId || "").trim();
  const sku = String(order?.shopSku || order?.matchedOnlineProductSku || order?.offerId || order?.vendorCode || "").trim();
  if (!shopId || !sku) return "";
  const itemCount = Number(order?.itemCount || 1);
  const safeCount = Number.isFinite(itemCount) && itemCount > 0 ? Math.floor(itemCount) : 1;
  return `${shopId}::${sku}::${safeCount}`;
}

function backfillOrderAmounts(orders) {
  if (!Array.isArray(orders) || !orders.length) return false;
  const latestAmountByKey = new Map();

  for (const order of orders) {
    if (!order || typeof order !== "object") continue;
    const amount = Number(order.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = getOrderAmountBackfillKey(order);
    if (!key) continue;
    const updatedAt = new Date(order.updatedAt || order.createdAt || 0).getTime();
    const current = latestAmountByKey.get(key);
    if (!current || updatedAt > current.updatedAt) {
      latestAmountByKey.set(key, { amount, updatedAt });
    }
  }

  let changed = false;
  for (const order of orders) {
    if (!order || typeof order !== "object") continue;
    const amount = Number(order.amount);
    if (Number.isFinite(amount) && amount > 0) continue;
    const key = getOrderAmountBackfillKey(order);
    if (!key) continue;
    const fallback = latestAmountByKey.get(key);
    if (fallback && fallback.amount > 0) {
      order.amount = fallback.amount;
      changed = true;
    }
  }

  return changed;
}

function inferHistoricalOrderRevenue(order, orders) {
  if (!order || typeof order !== "object" || !Array.isArray(orders)) return 0;
  const shopId = String(order.shopId || "").trim();
  const shopSku = String(order.shopSku || "").trim();
  if (!shopId || !shopSku) return 0;
  const candidates = orders
    .filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (String(item.shopId || "").trim() !== shopId) return false;
      if (String(item.shopSku || "").trim() !== shopSku) return false;
      if (String(item.shopOrderNo || "").trim() === String(order.shopOrderNo || "").trim()) return false;
      const revenue = Number(item.revenueRub);
      const amount = Number(item.amount);
      const count = Math.max(1, Number(item.itemCount) || 1);
      return (Number.isFinite(revenue) && revenue > 0) || (Number.isFinite(amount) && amount > 0);
    })
    .map((item) => {
      const revenue = Number(item.revenueRub);
      const amount = Number(item.amount);
      const count = Math.max(1, Number(item.itemCount) || 1);
      const total = Number.isFinite(revenue) && revenue > 0 ? revenue : amount;
      return {
        unit: Math.round((total / count) * 100) / 100,
        updatedAt: new Date(item.updatedAt || item.sellerOrderAt || item.createdAt || 0).getTime()
      };
    })
    .filter((item) => Number.isFinite(item.unit) && item.unit > 0);
  if (!candidates.length) return 0;
  const frequency = new Map();
  for (const candidate of candidates) {
    const key = candidate.unit.toFixed(2);
    const current = frequency.get(key) || { unit: candidate.unit, count: 0, latest: 0 };
    current.count += 1;
    current.latest = Math.max(current.latest, candidate.updatedAt || 0);
    frequency.set(key, current);
  }
  const selected = [...frequency.values()].sort((a, b) => b.count - a.count || b.latest - a.latest)[0];
  const quantity = Math.max(1, Number(order.itemCount) || 1);
  return Math.round(selected.unit * quantity * 100) / 100;
}

function extractOrderPurchaseFields(source) {
  if (!source || typeof source !== "object") return null;
  const purchasePriceRmb = hasTextValue(source.purchasePriceRmb) ? String(source.purchasePriceRmb).trim() : "";
  const purchasePriceRub = hasTextValue(source.purchasePriceRub) ? String(source.purchasePriceRub).trim() : "";
  const purchaseLink = hasTextValue(source.purchaseLink) ? String(source.purchaseLink).trim() : "";
  const purchasePlatform = hasTextValue(source.purchasePlatform) ? String(source.purchasePlatform).trim() : "";
  const purchaseOrderNo = hasTextValue(source.purchaseOrderNo) ? String(source.purchaseOrderNo).trim() : "";
  const purchaseExpressNo = hasTextValue(source.purchaseExpressNo) ? String(source.purchaseExpressNo).trim() : "";
  const purchaseIntlNo = hasTextValue(source.purchaseIntlNo) ? String(source.purchaseIntlNo).trim() : "";
  const purchaseUpdatedAt = hasTextValue(source.purchaseUpdatedAt) ? String(source.purchaseUpdatedAt).trim() : "";
  if (!purchasePriceRmb && !purchasePriceRub && !purchaseLink && !purchasePlatform && !purchaseOrderNo && !purchaseExpressNo && !purchaseIntlNo) {
    return null;
  }
  return {
    purchasePlatform,
    purchaseLink,
    purchaseOrderNo,
    purchaseExpressNo,
    purchaseIntlNo,
    purchasePriceRmb,
    purchasePriceRub,
    purchaseUpdatedAt
  };
}

function normalizeOrderPurchaseCandidates(order, sourceOrders = [], sourceProducts = []) {
  // Intentional no-op: purchase information may only come from the order's own
  // exact entry, never backfilled from other orders/products. The candidate
  // construction below is kept for documentation; the function always returns
  // null so callers fall through to the no-backfill contract.
  const candidates = [];
  const shopId = String(order?.shopId || "").trim();
  const skus = new Set(
    [order?.shopSku, order?.offerId, order?.matchedOnlineProductSku, order?.vendorCode]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  if (!shopId || !skus.size) return null;

  const addCandidate = (source, kind, weight = 0) => {
    if (!source || typeof source !== "object") return;
    const candidateShopId = String(source.shopId || "").trim();
    if (candidateShopId && candidateShopId !== shopId) return;
    const candidateSku = String(source.shopSku || source.offerId || source.vendorCode || source.matchedOnlineProductSku || "").trim();
    if (!candidateSku || !skus.has(candidateSku)) return;
    const purchase = extractOrderPurchaseFields(source);
    if (!purchase) return;
    const updatedAt = new Date(String(source.updatedAt || source.purchaseUpdatedAt || source.createdAt || 0)).getTime();
    const orderNo = Number(String(source.shopOrderNo || "").trim());
    candidates.push({
      kind,
      weight,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      orderNo: Number.isFinite(orderNo) ? orderNo : 0,
      purchase
    });
  };

  // 订单采购信息只能来自当前订单的精确录入；不从其他订单或产品记录回填。
  return null;
}

function backfillOrderPurchaseFields(orders, sourceProducts = []) {
  if (!Array.isArray(orders) || !orders.length) return false;
  let changed = false;
  for (const order of orders) {
    if (!order || typeof order !== "object") continue;
    const purchase = normalizeOrderPurchaseCandidates(order, orders, sourceProducts);
    if (!purchase) continue;
    for (const field of ["purchasePlatform", "purchaseLink", "purchaseOrderNo", "purchaseExpressNo", "purchaseIntlNo", "purchasePriceRmb", "purchasePriceRub", "purchaseUpdatedAt"]) {
      if (!hasTextValue(order[field]) && hasTextValue(purchase[field])) {
        order[field] = purchase[field];
        changed = true;
      }
    }
  }
  return changed;
}

function findOrderIndexByRef(orders, ref) {
  const text = String(ref || "").trim();
  if (!text || !Array.isArray(orders)) return -1;
  let index = orders.findIndex((order) => String(order.id || "").trim() === text);
  if (index >= 0) return index;
  index = orders.findIndex((order) => String(order.shopOrderNo || "").trim() === text);
  if (index >= 0) return index;
  index = orders.findIndex((order) => buildStableOrderId(order) === text);
  return index;
}

function findOrderByRef(orders, ref) {
  const index = findOrderIndexByRef(orders, ref);
  return index >= 0 ? orders[index] : null;
}

function dedupeOrders(orders) {
  const map = new Map();
  const uniques = [];
  for (const order of orders || []) {
    const key = getOrderUniqueKey(order) || String(order.shopOrderNo || order.id || "").trim();
    if (!key) {
      uniques.push(order);
      continue;
    }
    const existing = map.get(key);
    if (!existing) {
      map.set(key, order);
      uniques.push(order);
      continue;
    }
    const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
    const nextTime = new Date(order.updatedAt || order.createdAt || 0).getTime();
    if (nextTime >= existingTime) {
      const idx = uniques.indexOf(existing);
      if (idx >= 0) uniques[idx] = order;
      map.set(key, order);
    }
  }
  return uniques;
}

module.exports = {
  applyOrderPurchaseOverrides,
  backfillOrderAmounts,
  backfillOrderPurchaseFields,
  buildOrderPurchaseOverridesFromRows,
  buildOrderPurchasePayload,
  dedupeOrders,
  extractOrderIdFromPurchasePath,
  extractOrderPurchaseFields,
  findOrderByRef,
  findOrderIndexByRef,
  getOrderAmountBackfillKey,
  hasTextValue,
  inferHistoricalOrderRevenue,
  normalizeOrderPurchaseCandidates,
  restorePurchaseFromAuditLogs,
};
