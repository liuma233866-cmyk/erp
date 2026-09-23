const V2_PLATFORMS = new Set(["yandex", "ozon"]);
const CNY_CODES = new Set(["CNY", "RMB", "CNH", "CN¥", "¥"]);

function normalizeV2Platform(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.includes("yandex")) return "yandex";
  if (raw.includes("ozon")) return "ozon";
  return "";
}

function normalizeSettlementCurrency(value) {
  const raw = String(value || "").trim().toUpperCase();
  return CNY_CODES.has(raw) ? "CNY" : raw;
}

function resolveOrderV2Platform(order, shop) {
  return normalizeV2Platform(
    order?.platform || order?.provider || order?.source || shop?.provider || shop?.platform
  );
}

function resolveOrderV2Currency(order, shop) {
  return normalizeSettlementCurrency(
    order?.settlementCurrency || order?.currency || order?.currencyId || shop?.settlementCurrency
  );
}

function isOrderV2Eligible(order, shop) {
  return V2_PLATFORMS.has(resolveOrderV2Platform(order, shop)) && resolveOrderV2Currency(order, shop) === "CNY";
}

function toFiniteMoney(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.round(number * 100) / 100;
  }
  return null;
}

function normalizeOrderV2(order, shop) {
  const settlementCurrency = resolveOrderV2Currency(order, shop);
  const revenueRmb = toFiniteMoney(order?.revenueRmb, order?.settlementRevenue, order?.amount);
  const platformFeeRmb = toFiniteMoney(order?.platformFeeRmb, order?.platformCommissionRmb, order?.commissionRmb);
  const purchaseCostRmb = toFiniteMoney(order?.purchaseCostRmb, order?.purchasePriceRmb);
  const logisticsCostRmb = toFiniteMoney(order?.logisticsCostRmb, order?.shippingCostRmb);
  const estimatedProfitRmb = toFiniteMoney(
    order?.estimatedProfitRmb,
    order?.profitRmb,
    revenueRmb !== null && platformFeeRmb !== null && purchaseCostRmb !== null
      ? revenueRmb - platformFeeRmb - purchaseCostRmb - (logisticsCostRmb || 0)
      : null
  );
  return {
    ...order,
    platform: resolveOrderV2Platform(order, shop),
    settlementCurrency,
    shopName: String(order?.shopName || shop?.name || "").trim(),
    revenueRmb,
    platformFeeRmb,
    purchaseCostRmb,
    logisticsCostRmb,
    estimatedProfitRmb
  };
}

function matchesOrderV2Query(order, query = {}) {
  const platform = normalizeV2Platform(query.platform);
  if (platform && order.platform !== platform) return false;
  const shopId = String(query.shopId || "").trim();
  if (shopId && String(order.shopId || "") !== shopId) return false;
  const status = String(query.status || "").trim().toLowerCase();
  if (status) {
    const candidates = [order.customerReceiptCode, order.unifiedStatus, order.status, order.shopStatus]
      .map((value) => String(value || "").trim().toLowerCase());
    if (!candidates.includes(status)) return false;
  }
  const keyword = String(query.keyword || "").trim().toLowerCase();
  if (keyword) {
    const haystack = [order.id, order.shopOrderNo, order.orderNo, order.shopSku, order.name, order.productName]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

function buildOrderV2Summary(orders) {
  const summary = { total: 0, yandex: 0, ozon: 0, exceptions: 0, profitPending: 0 };
  for (const order of Array.isArray(orders) ? orders : []) {
    summary.total += 1;
    if (order.platform === "yandex") summary.yandex += 1;
    if (order.platform === "ozon") summary.ozon += 1;
    if (order.estimatedProfitRmb === null) summary.profitPending += 1;
    if (!order.shopSku || order.matchedOnlineProductWeightKg === null || order.matchedOnlineProductWeightKg === undefined) {
      summary.exceptions += 1;
    }
  }
  return summary;
}

module.exports = {
  buildOrderV2Summary,
  isOrderV2Eligible,
  matchesOrderV2Query,
  normalizeOrderV2,
  normalizeSettlementCurrency,
  normalizeV2Platform,
  resolveOrderV2Currency,
  resolveOrderV2Platform
};
