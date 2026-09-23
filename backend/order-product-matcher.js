function backfillOrderProductMatches(orders, products) {
  if (!Array.isArray(orders) || !Array.isArray(products)) return false;
  const byShopSku = new Map();
  for (const product of products) {
    const shopId = String(product?.shopId || "").trim();
    const sku = String(product?.shopSku || product?.offerId || product?.vendorCode || "").trim();
    if (!shopId || !sku) continue;
    const key = `${shopId}::${sku}`;
    const list = byShopSku.get(key) || [];
    list.push(product);
    byShopSku.set(key, list);
  }
  let changed = false;
  for (const order of orders) {
    const shopId = String(order?.shopId || "").trim();
    const sku = String(order?.shopSku || order?.offerId || order?.vendorCode || "").trim();
    const candidates = byShopSku.get(`${shopId}::${sku}`) || [];
    if (candidates.length !== 1) continue;
    const product = candidates[0];
    const next = {
      matchedOnlineProductId: String(product.id || ""),
      matchedOnlineProductName: String(product.name || ""),
      matchedOnlineProductSku: String(product.shopSku || product.offerId || product.vendorCode || ""),
      matchedOnlineProductWeightKg: product.weightKg ?? null,
      matchedOnlineProductCommissionPercent: product.commissionPercent ?? product.commission ?? product.feeRate ?? null
    };
    for (const [field, value] of Object.entries(next)) {
      if (String(order[field] ?? "") === String(value ?? "")) continue;
      order[field] = value;
      changed = true;
    }
  }
  return changed;
}

module.exports = { backfillOrderProductMatches };
