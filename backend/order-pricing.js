function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateYandexOrderPricing(items, totalCandidates = [], normalizeMoney = Number) {
  const sourceItems = Array.isArray(items) ? items : [];
  const normalizedItems = sourceItems.map((item) => {
    const rawCount = Number(item?.count ?? item?.quantity ?? 1);
    const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1;
    const basePrice = normalizeMoney(item?.price ?? item?.unitPrice);
    const rawSubsidy = normalizeMoney(item?.subsidy);
    const subsidy = Number.isFinite(rawSubsidy) && rawSubsidy > 0 ? rawSubsidy : 0;
    const unitPrice = Number.isFinite(basePrice) ? basePrice + subsidy : NaN;
    return { count, unitPrice };
  });
  const quantity = normalizedItems.length
    ? normalizedItems.reduce((sum, item) => sum + item.count, 0)
    : 1;
  const hasCompleteItemPrices = normalizedItems.length > 0 && normalizedItems.every(
    (item) => Number.isFinite(item.unitPrice) && item.unitPrice >= 0
  );
  const itemTotal = normalizedItems.reduce(
    (sum, item) => sum + (Number.isFinite(item.unitPrice) ? item.unitPrice * item.count : 0),
    0
  );
  const apiTotal = totalCandidates
    .map((value) => normalizeMoney(value))
    .find((value) => Number.isFinite(value) && value > 0);
  const amount = hasCompleteItemPrices && itemTotal > 0
    ? roundMoney(itemTotal)
    : Number.isFinite(apiTotal)
      ? roundMoney(apiTotal)
      : itemTotal > 0
        ? roundMoney(itemTotal)
        : 0;
  const unitPrice = amount > 0 ? roundMoney(amount / Math.max(1, quantity)) : undefined;
  return { quantity, amount, unitPrice };
}

function applyHistoricalRevenueFallback(order, historicalRevenue) {
  if (!order || typeof order !== "object") return order;
  const currentAmount = Number(order.amount);
  const historyAmount = Number(historicalRevenue);
  const quantity = Math.max(1, Number(order.itemCount) || 1);
  if (Number.isFinite(currentAmount) && currentAmount > 0) {
    order.revenueRub = currentAmount;
    if (!Number.isFinite(Number(order.unitPrice)) || Number(order.unitPrice) <= 0) {
      order.unitPrice = roundMoney(currentAmount / quantity);
    }
    return order;
  }
  if (Number.isFinite(historyAmount) && historyAmount > 0) {
    order.amount = roundMoney(historyAmount);
    order.revenueRub = roundMoney(historyAmount);
    order.unitPrice = roundMoney(historyAmount / quantity);
  }
  return order;
}

module.exports = {
  calculateYandexOrderPricing,
  applyHistoricalRevenueFallback
};
