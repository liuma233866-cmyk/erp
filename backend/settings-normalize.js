// 从 server.js 拆出的发布设置与审单规则归一化（纯函数，无共享状态）。

function normalizePublishSettings(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const qualityMinScore = Number(data.qualityMinScore);
  const skuPrefixByShopId = {};
  if (data.skuPrefixByShopId && typeof data.skuPrefixByShopId === "object" && !Array.isArray(data.skuPrefixByShopId)) {
    for (const [shopId, prefixValue] of Object.entries(data.skuPrefixByShopId)) {
      const normalizedShopId = String(shopId || "").trim();
      const normalizedPrefix = String(prefixValue || "").trim().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 16);
      if (normalizedShopId && normalizedPrefix) skuPrefixByShopId[normalizedShopId] = normalizedPrefix;
    }
  }
  return {
    erpAutoPublishToYandex: data.erpAutoPublishToYandex !== false,
    erpAutoPublishToOzon: Boolean(data.erpAutoPublishToOzon),
    simulateBackendPublishToYandex: Boolean(data.simulateBackendPublishToYandex),
    skuPrefix: String(data.skuPrefix || "PUB").trim().replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 16) || "PUB",
    skuPrefixByShopId,
    skuSeparator: new Set(["-", "_", "."]).has(String(data.skuSeparator || "-")) ? String(data.skuSeparator || "-") : "-",
    skuIncludeSourceSku: data.skuIncludeSourceSku !== false,
    publishIntervalSeconds: Math.max(0, Math.min(3600, Math.floor(Number(data.publishIntervalSeconds || 0) || 0))),
    dailyPublishLimit: Math.max(0, Math.min(100000, Math.floor(Number(data.dailyPublishLimit || 0) || 0))),
    qualityGateEnabled: data.qualityGateEnabled !== false,
    qualityMinScore: Number.isFinite(qualityMinScore) ? Math.max(0, Math.min(100, Math.floor(qualityMinScore))) : 80
  };
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeReviewRule(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const boolValue = (value, fallback = true) => {
    if (value === undefined || value === null || value === "") return fallback;
    return !(value === false || value === 0 || value === "0" || value === "false");
  };
  const toIso = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toISOString();
  };
  return {
    id: String(data.id || "").trim(),
    companyId: String(data.companyId || "").trim(),
    companyName: String(data.companyName || "").trim(),
    name: String(data.name || "未命名规则").trim() || "未命名规则",
    enabled: boolValue(data.enabled, true),
    priority: Math.max(1, Math.min(100000, Number(data.priority || 100) || 100)),
    shopId: String(data.shopId || "").trim(),
    platform: String(data.platform || "yandex_market").trim().toLowerCase() || "yandex_market",
    shopSkuKeyword: String(data.shopSkuKeyword || "").trim(),
    titleKeyword: String(data.titleKeyword || "").trim(),
    commissionPercent: normalizeNullableNumber(data.commissionPercent),
    logisticsFeeRub: normalizeNullableNumber(data.logisticsFeeRub),
    logisticsFeeRmb: normalizeNullableNumber(data.logisticsFeeRmb),
    otherFeeRub: normalizeNullableNumber(data.otherFeeRub),
    otherFeeRmb: normalizeNullableNumber(data.otherFeeRmb),
    notes: String(data.notes || "").trim(),
    createdAt: toIso(data.createdAt, new Date().toISOString()),
    updatedAt: toIso(data.updatedAt, new Date().toISOString()),
    logisticsPerKgRub: normalizeNullableNumber(data.logisticsPerKgRub),
    logisticsPerKgRmb: normalizeNullableNumber(data.logisticsPerKgRmb),
    registrationFeeRub: normalizeNullableNumber(data.registrationFeeRub),
    registrationFeeRmb: normalizeNullableNumber(data.registrationFeeRmb),
    withdrawFeeRub: normalizeNullableNumber(data.withdrawFeeRub),
    withdrawFeeRmb: normalizeNullableNumber(data.withdrawFeeRmb),
    transferFeeRub: normalizeNullableNumber(data.transferFeeRub),
    transferFeeRmb: normalizeNullableNumber(data.transferFeeRmb),
    packingFeeRub: normalizeNullableNumber(data.packingFeeRub),
    packingFeeRmb: normalizeNullableNumber(data.packingFeeRmb),
    withdrawPercent: normalizeNullableNumber(data.withdrawPercent),
    transferPercent: normalizeNullableNumber(data.transferPercent),
    applyToOrders: boolValue(data.applyToOrders, true),
    applyToOnlineProducts: boolValue(data.applyToOnlineProducts, true)
  };
}

function findMatchingReviewRule(order, rules) {
  const skuText = String(order?.shopSku || "").toLowerCase();
  const titleText = String(order?.productName || order?.title || "").toLowerCase();
  const shopId = String(order?.shopId || "").trim();
  const platform = String(order?.provider || order?.shopProvider || "yandex_market").trim().toLowerCase();
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule.enabled !== false && rule.applyToOrders !== false)
    .sort((a, b) => (Number(a.priority || 100) || 100) - (Number(b.priority || 100) || 100))
    .find((rule) => {
      if (rule.shopId && String(rule.shopId) !== shopId) return false;
      if (rule.platform && String(rule.platform).toLowerCase() !== platform) return false;
      if (rule.shopSkuKeyword && !skuText.includes(String(rule.shopSkuKeyword).toLowerCase())) return false;
      if (rule.titleKeyword && !titleText.includes(String(rule.titleKeyword).toLowerCase())) return false;
      return true;
    }) || null;
}

module.exports = {
  findMatchingReviewRule,
  normalizeNullableNumber,
  normalizePublishSettings,
  normalizeReviewRule
};
