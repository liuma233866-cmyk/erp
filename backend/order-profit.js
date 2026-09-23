// Backend port of the frontend order-profit estimator. This is the single
// authoritative source for the order-level profit snapshot so the
// /api/orders/profit-issues detector no longer flags every order as missing.

function toNullableMoneyNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const amount = Number(String(value).replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
}

function sumNullableMoney(values) {
  const list = (Array.isArray(values) ? values : [values])
    .map((value) => toNullableMoneyNumber(value))
    .filter((value) => value !== null);
  if (!list.length) return null;
  return list.reduce((total, value) => total + value, 0);
}

function normalizeCommissionPercent(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 0 && num < 1) return num * 100;
  return num;
}

function deriveRates(rubPurchaseCostRate, cnyRateRub) {
  const purchaseRate = Number(rubPurchaseCostRate || 0);
  let rubToRmbRate = 0;
  if (purchaseRate > 0) {
    rubToRmbRate = purchaseRate;
  } else {
    const cbrRate = Number(cnyRateRub || 0);
    rubToRmbRate = cbrRate > 0 ? 1 / cbrRate : 0;
  }
  const rmbToRubRate = rubToRmbRate > 0
    ? 1 / rubToRmbRate
    : (Number(cnyRateRub || 0) > 0 ? Number(cnyRateRub) : 0);
  return { rubToRmbRate, rmbToRubRate };
}

function deriveMoneyPair(rmbValue, rubValue, rates) {
  let rmb = toNullableMoneyNumber(rmbValue);
  let rub = toNullableMoneyNumber(rubValue);
  const hasPositiveRmb = rmb !== null && rmb > 0;
  const hasPositiveRub = rub !== null && rub > 0;
  if (!hasPositiveRmb && hasPositiveRub && rates.rubToRmbRate > 0) rmb = rub * rates.rubToRmbRate;
  if (!hasPositiveRub && hasPositiveRmb && rates.rmbToRubRate > 0) rub = rmb * rates.rmbToRubRate;
  return { rmb, rub };
}

function emptyProfit() {
  return {
    matchedRuleId: "",
    matchedRuleName: "",
    revenueRmb: null,
    revenueRub: null,
    purchaseCostRmb: null,
    purchaseCostRub: null,
    profitRmb: null,
    profitRub: null,
    commissionPercent: null
  };
}

function computeOrderProfit(order, rule, rates) {
  if (!rule) return emptyProfit();

  const currency = String(order?.currency || "RUB").trim().toUpperCase();
  let revenueRmb = null;
  let revenueRub = null;
  const amount = toNullableMoneyNumber(order?.amount);
  if (amount !== null) {
    if (currency === "CNY" || currency === "RMB") {
      revenueRmb = amount;
      if (rates.rmbToRubRate > 0) revenueRub = amount * rates.rmbToRubRate;
    } else {
      revenueRub = amount;
      if (rates.rubToRmbRate > 0) revenueRmb = amount * rates.rubToRmbRate;
    }
  }

  const purchase = deriveMoneyPair(order?.purchasePriceRmb, order?.purchasePriceRub, rates);
  const weightKg = toNullableMoneyNumber(order?.matchedOnlineProductWeightKg);
  const itemCount = Math.max(1, Number(order?.itemCount || 1) || 1);
  const totalWeightKg = weightKg !== null ? weightKg * itemCount : null;
  const logisticsPerKg = deriveMoneyPair(rule.logisticsPerKgRmb, rule.logisticsPerKgRub, rates);
  const registrationFee = deriveMoneyPair(rule.registrationFeeRmb, rule.registrationFeeRub, rates);
  const logistics = deriveMoneyPair(
    sumNullableMoney([
      totalWeightKg !== null && logisticsPerKg.rmb !== null ? totalWeightKg * logisticsPerKg.rmb : null,
      registrationFee.rmb
    ]),
    sumNullableMoney([
      totalWeightKg !== null && logisticsPerKg.rub !== null ? totalWeightKg * logisticsPerKg.rub : null,
      registrationFee.rub
    ]),
    rates
  );
  const other = deriveMoneyPair(rule.otherFeeRmb, rule.otherFeeRub, rates);
  const packing = deriveMoneyPair(rule.packingFeeRmb, rule.packingFeeRub, rates);
  const withdrawPercent = toNullableMoneyNumber(rule.withdrawPercent) ?? 0;
  const transferPercent = toNullableMoneyNumber(rule.transferPercent) ?? 0;
  const withdraw = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * withdrawPercent / 100 : null,
    revenueRub !== null ? revenueRub * withdrawPercent / 100 : null,
    rates
  );
  const transfer = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * transferPercent / 100 : null,
    revenueRub !== null ? revenueRub * transferPercent / 100 : null,
    rates
  );
  const extraCosts = deriveMoneyPair(
    sumNullableMoney([other.rmb, packing.rmb, withdraw.rmb, transfer.rmb]),
    sumNullableMoney([other.rub, packing.rub, withdraw.rub, transfer.rub]),
    rates
  );
  const commissionPercent = normalizeCommissionPercent(order?.matchedOnlineProductCommissionPercent)
    ?? normalizeCommissionPercent(rule.commissionPercent)
    ?? 0;
  const commission = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * commissionPercent / 100 : null,
    revenueRub !== null ? revenueRub * commissionPercent / 100 : null,
    rates
  );

  const profitRub = revenueRub !== null
    ? revenueRub - (purchase.rub || 0) - (logistics.rub || 0) - (extraCosts.rub || 0) - (commission.rub || 0)
    : null;
  const profitRmb = revenueRmb !== null
    ? revenueRmb - (purchase.rmb || 0) - (logistics.rmb || 0) - (extraCosts.rmb || 0) - (commission.rmb || 0)
    : null;

  return {
    matchedRuleId: String(rule.id || ""),
    matchedRuleName: String(rule.name || ""),
    revenueRmb,
    revenueRub,
    purchaseCostRmb: purchase.rmb,
    purchaseCostRub: purchase.rub,
    commissionPercent,
    commissionRub: commission.rub,
    commissionRmb: commission.rmb,
    logisticsFeeRub: logistics.rub,
    logisticsFeeRmb: logistics.rmb,
    otherFeeRub: other.rub,
    otherFeeRmb: other.rmb,
    withdrawPercent,
    withdrawFeeRub: withdraw.rub,
    withdrawFeeRmb: withdraw.rmb,
    transferPercent,
    transferFeeRub: transfer.rub,
    transferFeeRmb: transfer.rmb,
    packingFeeRub: packing.rub,
    packingFeeRmb: packing.rmb,
    profitRub,
    profitRmb
  };
}

module.exports = {
  computeOrderProfit,
  deriveRates,
  normalizeCommissionPercent,
  sumNullableMoney,
  toNullableMoneyNumber
};
