(function attachProfitEstimate(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ProfitEstimate = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createProfitEstimate() {
  function toMoney(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function subtract(left, right) {
    return left !== null && right !== null
      ? Math.round((left - right + Number.EPSILON) * 100) / 100
      : null;
  }

  function buildPlatformProfitEstimate(record) {
    const provider = String(record?.provider || record?.platform || "").toLowerCase();
    if (!provider.includes("yandex")) return null;
    const revenueRub = toMoney(record?.revenueRub);
    const revenueRmb = toMoney(record?.revenueRmb);
    const feeRub = toMoney(record?.commissionRub);
    const feeRmb = toMoney(record?.commissionRmb);
    const platformSourced = toMoney(record?.matchedOnlineProductCommissionPercent) !== null;
    const hasKnownFee = feeRub !== null || feeRmb !== null;
    return {
      status: hasKnownFee ? "部分预估" : "待获取",
      source: platformSourced ? "Yandex tariffs/calculate（当前仅销售佣金）" : "ERP审单规则（非平台返回）",
      revenueRub,
      revenueRmb,
      feeRub,
      feeRmb,
      payoutRub: subtract(revenueRub, feeRub),
      payoutRmb: subtract(revenueRmb, feeRmb),
      erpProfitRub: toMoney(record?.profitRub),
      erpProfitRmb: toMoney(record?.profitRmb),
      complete: false
    };
  }

  return { buildPlatformProfitEstimate };
});
