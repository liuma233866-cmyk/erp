async function ensureProfitRateLoaded(silent = true) {
  const [cbrRate, rubPurchaseRate] = await Promise.all([
    getCbrRateCny({ silent }),
    getRubPurchaseCostRate({ silent: true })
  ]);
  state.cnyRateRub = Number.isFinite(Number(cbrRate)) && Number(cbrRate) > 0 ? Number(cbrRate) : null;
  state.rubPurchaseCostRate = Number.isFinite(Number(rubPurchaseRate)) && Number(rubPurchaseRate) > 0 ? Number(rubPurchaseRate) : null;
  return state.cnyRateRub;
}

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

function getRubToRmbRate() {
  const purchaseRate = Number(state.rubPurchaseCostRate || 0);
  if (purchaseRate > 0) return purchaseRate;
  const cbrRate = Number(state.cnyRateRub || 0);
  return cbrRate > 0 ? 1 / cbrRate : 0;
}

function getRmbToRubRate() {
  const rubToRmbRate = getRubToRmbRate();
  if (rubToRmbRate > 0) return 1 / rubToRmbRate;
  const cbrRate = Number(state.cnyRateRub || 0);
  return cbrRate > 0 ? cbrRate : 0;
}

function deriveMoneyPair(rmbValue, rubValue) {
  let rmb = toNullableMoneyNumber(rmbValue);
  let rub = toNullableMoneyNumber(rubValue);
  const rubToRmbRate = getRubToRmbRate();
  const rmbToRubRate = getRmbToRubRate();
  const hasPositiveRmb = rmb !== null && rmb > 0;
  const hasPositiveRub = rub !== null && rub > 0;
  if (!hasPositiveRmb && hasPositiveRub && rubToRmbRate > 0) rmb = rub * rubToRmbRate;
  if (!hasPositiveRub && hasPositiveRmb && rmbToRubRate > 0) rub = rmb * rmbToRubRate;
  return { rmb, rub };
}

function getMatchedReviewRule(order) {
  const rules = Array.isArray(state.reviewRules) ? state.reviewRules : [];
  const skuText = String(order?.shopSku || "").toLowerCase();
  const titleText = String(order?.productName || order?.title || "").toLowerCase();
  const shopId = String(order?.shopId || "").trim();
  const platform = String(order?.provider || order?.shopProvider || "yandex_market").trim().toLowerCase();
  return rules
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

function computeOrderProfit(order) {
  const rule = getMatchedReviewRule(order);
  if (!rule) {
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

  const currency = String(order?.currency || "RUB").trim().toUpperCase();
  let revenueRmb = null;
  let revenueRub = null;
  const amount = toNullableMoneyNumber(order?.amount);
  const rubToRmbRate = getRubToRmbRate();
  const rmbToRubRate = getRmbToRubRate();
  if (amount !== null) {
    if (currency === "CNY" || currency === "RMB") {
      revenueRmb = amount;
      if (rmbToRubRate > 0) revenueRub = amount * rmbToRubRate;
    } else {
      revenueRub = amount;
      if (rubToRmbRate > 0) revenueRmb = amount * rubToRmbRate;
    }
  }

  const purchase = deriveMoneyPair(order?.purchasePriceRmb, order?.purchasePriceRub);
  const weightKg = toNullableMoneyNumber(order?.matchedOnlineProductWeightKg);
  const itemCount = Math.max(1, Number(order?.itemCount || 1) || 1);
  const totalWeightKg = weightKg !== null ? weightKg * itemCount : null;
  const logisticsPerKg = deriveMoneyPair(rule.logisticsPerKgRmb, rule.logisticsPerKgRub);
  const registrationFee = deriveMoneyPair(rule.registrationFeeRmb, rule.registrationFeeRub);
  const logistics = deriveMoneyPair(
    sumNullableMoney([
      totalWeightKg !== null && logisticsPerKg.rmb !== null ? totalWeightKg * logisticsPerKg.rmb : null,
      registrationFee.rmb
    ]),
    sumNullableMoney([
      totalWeightKg !== null && logisticsPerKg.rub !== null ? totalWeightKg * logisticsPerKg.rub : null,
      registrationFee.rub
    ])
  );
  const other = deriveMoneyPair(rule.otherFeeRmb, rule.otherFeeRub);
  const packing = deriveMoneyPair(rule.packingFeeRmb, rule.packingFeeRub);
  const withdrawPercent = toNullableMoneyNumber(rule.withdrawPercent) ?? 0;
  const transferPercent = toNullableMoneyNumber(rule.transferPercent) ?? 0;
  const withdraw = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * withdrawPercent / 100 : null,
    revenueRub !== null ? revenueRub * withdrawPercent / 100 : null
  );
  const transfer = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * transferPercent / 100 : null,
    revenueRub !== null ? revenueRub * transferPercent / 100 : null
  );
  const extraCosts = deriveMoneyPair(
    sumNullableMoney([other.rmb, packing.rmb, withdraw.rmb, transfer.rmb]),
    sumNullableMoney([other.rub, packing.rub, withdraw.rub, transfer.rub])
  );
  const commissionPercent = normalizeCommissionPercent(order?.matchedOnlineProductCommissionPercent)
    ?? normalizeCommissionPercent(rule.commissionPercent)
    ?? 0;
  const commission = deriveMoneyPair(
    revenueRmb !== null ? revenueRmb * commissionPercent / 100 : null,
    revenueRub !== null ? revenueRub * commissionPercent / 100 : null
  );
  const commissionRub = commission.rub;
  const commissionRmb = commission.rmb;

  const profitRub = revenueRub !== null
    ? revenueRub - (purchase.rub || 0) - (logistics.rub || 0) - (extraCosts.rub || 0) - (commissionRub || 0)
    : null;
  const profitRmb = revenueRmb !== null
    ? revenueRmb - (purchase.rmb || 0) - (logistics.rmb || 0) - (extraCosts.rmb || 0) - (commissionRmb || 0)
    : null;

  return {
    matchedRuleId: String(rule.id || ""),
    matchedRuleName: String(rule.name || ""),
    revenueRmb,
    revenueRub,
    purchaseCostRmb: purchase.rmb,
    purchaseCostRub: purchase.rub,
    commissionPercent,
    commissionRub,
    commissionRmb,
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

function refreshOrderProfitData() {
  state.orders = (state.orders || []).map((order) => ({
    ...order,
    ...((order && (order.profitUpdatedAt || order.profitRateDate))
      ? {}
      : computeOrderProfit(order))
  }));
  state.filteredOrders = Array.isArray(state.orders) ? [...state.orders] : [];
}


function mapProfitIssueReason(reason) {
  const key = String(reason || "").trim();
  if (key === "missing_review_rule") return "未命中审单规则";
  if (key === "missing_order_amount") return "缺少订单金额";
  if (key === "missing_profit_snapshot") return "缺少利润快照";
  return key || "-";
}

async function loadProfitIssues() {
  if (profitIssueMessage) {
    profitIssueMessage.style.color = "#2f3d63";
    profitIssueMessage.textContent = "正在检查利润异常...";
  }
  const result = await apiRequest("/api/orders/profit-issues?page=1&pageSize=20", { method: "GET" });
  if (!result.ok) {
    state.profitIssues = [];
    state.profitIssueSummary = { total: 0, byReason: {} };
    renderProfitIssues();
    if (profitIssueMessage) {
      profitIssueMessage.style.color = "#c02030";
      profitIssueMessage.textContent = result.error || "利润异常检查失败";
    }
    return false;
  }
  state.profitIssues = Array.isArray(result.data?.items) ? result.data.items : [];
  state.profitIssueSummary = result.data?.summary || { total: 0, byReason: {} };
  renderProfitIssues();
  return true;
}

function renderProfitIssues() {
  const summary = state.profitIssueSummary || { total: 0, byReason: {} };
  const byReason = summary.byReason || {};
  const total = Number(summary.total || 0) || 0;
  if (profitIssueCount) profitIssueCount.textContent = String(total);
  if (profitIssueMissingRuleCount) profitIssueMissingRuleCount.textContent = String(Number(byReason.missing_review_rule || 0) || 0);
  if (profitIssueMissingSnapshotCount) profitIssueMissingSnapshotCount.textContent = String(Number(byReason.missing_profit_snapshot || 0) || 0);

  if (profitIssueMessage) {
    if (total > 0) {
      profitIssueMessage.style.color = "#b45c00";
      profitIssueMessage.textContent = `最近发现 ${total} 条利润异常订单，请优先检查未命中规则和缺少利润快照的订单`;
    } else {
      profitIssueMessage.style.color = "#1d6f3a";
      profitIssueMessage.textContent = "当前没有利润异常订单";
    }
  }

  if (!profitIssueTableBody) return;
  if (!state.profitIssues.length) {
    profitIssueTableBody.innerHTML = "<tr><td colspan='6'>暂无利润异常</td></tr>";
    return;
  }
  profitIssueTableBody.innerHTML = state.profitIssues.map((item) => `
    <tr>
      <td>${escapeHtml(item.shopOrderNo || item.orderId || "-")}</td>
      <td>${escapeHtml(item.shopName || "-")}</td>
      <td>${escapeHtml(mapProfitIssueReason(item.reason))}</td>
      <td title="${escapeHtml(item.matchedOnlineProductName || "")}">${escapeHtml(item.matchedOnlineProductName || item.matchedOnlineProductId || "-")}</td>
      <td>${escapeHtml(item.matchedRuleName || "-")}</td>
      <td>${escapeHtml(formatDateTime(item.profitUpdatedAt || item.updatedAt))}</td>
    </tr>
  `).join("");
}
