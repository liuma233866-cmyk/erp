function closeProfitDetailModal() {
  if (profitDetailModalMask) profitDetailModalMask.classList.add("hidden");
}

function onProfitDetailMaskClick(event) {
  if (event.target === profitDetailModalMask) closeProfitDetailModal();
}

function buildProfitDetailRows(order) {
  return [
    { label: "订单收入", rmb: order?.revenueRmb, rub: order?.revenueRub },
    { label: "采购成本", rmb: order?.purchaseCostRmb, rub: order?.purchaseCostRub },
    { label: "物流成本", rmb: order?.logisticsFeeRmb, rub: order?.logisticsFeeRub },
    { label: "包装费", rmb: order?.packingFeeRmb, rub: order?.packingFeeRub },
    { label: "提现费", rmb: order?.withdrawFeeRmb, rub: order?.withdrawFeeRub },
    { label: "转账费", rmb: order?.transferFeeRmb, rub: order?.transferFeeRub },
    { label: "其他成本", rmb: order?.otherFeeRmb, rub: order?.otherFeeRub },
    { label: "平台佣金", rmb: order?.commissionRmb, rub: order?.commissionRub }
  ];
}

function renderPlatformProfitEstimate(estimate) {
  if (!estimate) return "";
  const rows = [
    { label: "卖家订单收入", rmb: estimate.revenueRmb, rub: estimate.revenueRub },
    { label: "已获取平台费用", rmb: estimate.feeRmb, rub: estimate.feeRub },
    { label: "Yandex 预估到账", rmb: estimate.payoutRmb, rub: estimate.payoutRub },
    { label: "ERP 暂估利润", rmb: estimate.erpProfitRmb, rub: estimate.erpProfitRub }
  ];
  return `
    <section class="profit-estimate-panel">
      <div class="profit-estimate-head">
        <div>
          <strong>Yandex 平台预估</strong>
        </div>
        <div class="profit-estimate-total">
          <b>${escapeHtml(estimate.status)}</b>
          <span>${escapeHtml(formatNullableFinanceMoney(estimate.payoutRmb))} RMB</span>
          <span>${escapeHtml(formatNullableFinanceMoney(estimate.payoutRub))} RUB</span>
        </div>
      </div>
      <div class="profit-detail-grid profit-estimate-grid">
        <div class="profit-detail-row profit-detail-row-head">
          <span>项目</span><span>RMB</span><span>RUB</span>
        </div>
        ${rows.map((row) => `
          <div class="profit-detail-row">
            <span>${escapeHtml(row.label)}</span>
            <span>${escapeHtml(formatNullableFinanceMoney(row.rmb))}</span>
            <span>${escapeHtml(formatNullableFinanceMoney(row.rub))}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function buildProfitDetailSubtitle(record, recordType, rateText) {
  if (recordType === "online_product") {
    const productLabel = String(record?.shopSku || record?.offerId || record?.vendorCode || record?.id || "").trim();
    const productName = String(record?.name || record?.title || "").trim();
    const shopName = String(record?.shopName || record?.shopId || "").trim();
    return [productLabel, productName, shopName, rateText].filter(Boolean).join(" · ");
  }
  return `${String(record?.shopOrderNo || record?.id || "").trim()} · ${String(record?.shopName || "").trim()}${rateText ? ` · ${rateText}` : ""}`;
}

function openProfitDetailModal(record, currency = "rmb", recordType = "order") {
  if (!record || !profitDetailModalMask || !profitDetailContent) return;
  const rows = buildProfitDetailRows(record);
  const preferredCurrency = currency === "rub" ? "rub" : "rmb";
  const currentProfit = preferredCurrency === "rub" ? record?.profitRub : record?.profitRmb;
  const summaryLabel = preferredCurrency === "rub" ? "利润(卢布)" : "利润(RMB)";
  const commissionPercent = normalizeCommissionPercent(record?.profitCommissionPercent ?? record?.commissionPercent);
  const platformEstimate = window.ProfitEstimate?.buildPlatformProfitEstimate(record) || null;
  const qtyValue = Number(record?.itemCount ?? 0);
  const totalQtyText = recordType === "online_product"
    ? "1"
    : (record?.itemCount !== undefined && record?.itemCount !== null ? String(record.itemCount) : "-");
  const singleWeightValue = Number(recordType === "online_product" ? record?.weightKg : record?.matchedOnlineProductWeightKg ?? null);
  const singleWeightText = Number.isFinite(singleWeightValue) && singleWeightValue > 0
    ? `${singleWeightValue.toFixed(3).replace(/\.?0+$/, "")} kg`
    : "-";
  const effectiveQty = recordType === "online_product" ? 1 : (Number.isFinite(qtyValue) && qtyValue > 0 ? qtyValue : 0);
  const totalWeightText = Number.isFinite(singleWeightValue) && singleWeightValue > 0 && effectiveQty > 0
    ? `${(singleWeightValue * effectiveQty).toFixed(3).replace(/\.?0+$/, "")} kg`
    : "-";
  const storedRubToRmb = Number(record?.profitRateRubToRmb || 0);
  const storedCnyToRub = Number(record?.profitRateRubPerCny || 0);
  const rateDateText = String(record?.profitRateDate || "").trim();
  const rateText = storedRubToRmb > 0
    ? `${rateDateText || "当日"}汇率 1 RUB = ${storedRubToRmb.toFixed(4)} RMB`
    : (storedCnyToRub > 0
      ? `${rateDateText || "当日"}汇率 1 CNY = ${storedCnyToRub.toFixed(4)} RUB`
        : (Number(state.rubPurchaseCostRate || 0) > 0
        ? `购汇汇率 1 RUB = ${Number(state.rubPurchaseCostRate).toFixed(4)} RMB`
        : (Number(state.cnyRateRub || 0) > 0 ? `CBR 汇率 1 CNY = ${Number(state.cnyRateRub).toFixed(4)} RUB` : "")));
  if (profitDetailModalSubtitle) {
    profitDetailModalSubtitle.textContent = buildProfitDetailSubtitle(record, recordType, rateText);
  }
  profitDetailContent.innerHTML = `
    <div class="profit-detail-summary">
      <div class="profit-detail-summary-card">
        <span>当前查看</span>
        <strong>${summaryLabel}</strong>
        <b>${escapeHtml(formatNullableFinanceMoney(currentProfit))}</b>
      </div>
      <div class="profit-detail-summary-card">
        <span>命中规则</span>
        <strong>${escapeHtml(String(record.matchedRuleName || "未命中规则"))}</strong>
        <b>${escapeHtml(String(record.matchedRuleId || "-"))}</b>
      </div>
      <div class="profit-detail-summary-card">
        <span>平台佣金</span>
        <strong>${commissionPercent !== null ? escapeHtml(formatNullableFinanceMoney(commissionPercent)) : "-" }%</strong>
        <b>${escapeHtml(formatNullableFinanceMoney(record.commissionRub))} RUB</b>
      </div>
      <div class="profit-detail-summary-card meta-card">
        <span>${recordType === "online_product" ? "计算数量" : "产品总数量"}</span>
        <strong>${recordType === "online_product" ? "在线产品按 1 件计算" : "订单商品总件数"}</strong>
        <b>${escapeHtml(totalQtyText)}</b>
      </div>
      <div class="profit-detail-summary-card meta-card">
        <span>单个重量 / 总重量</span>
        <strong>${escapeHtml(singleWeightText)}</strong>
        <b>${escapeHtml(totalWeightText)}</b>
      </div>
    </div>
    <div class="profit-detail-columns${platformEstimate ? "" : " profit-detail-columns-single"}">
      ${renderPlatformProfitEstimate(platformEstimate)}
      <div class="profit-detail-grid profit-detail-main-grid">
        <div class="profit-detail-row profit-detail-row-head">
          <span>项目</span>
          <span>RMB</span>
          <span>RUB</span>
        </div>
        ${rows.map((row) => `
          <div class="profit-detail-row">
            <span>${escapeHtml(row.label)}</span>
            <span>${escapeHtml(formatNullableFinanceMoney(row.rmb))}</span>
            <span>${escapeHtml(formatNullableFinanceMoney(row.rub))}</span>
          </div>
        `).join("")}
        <div class="profit-detail-row profit-detail-row-total">
          <span>最终利润</span>
          <span>${escapeHtml(formatNullableFinanceMoney(record.profitRmb))}</span>
          <span>${escapeHtml(formatNullableFinanceMoney(record.profitRub))}</span>
        </div>
      </div>
    </div>
  `;
  profitDetailModalMask.classList.remove("hidden");
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const profitDetailModalMask = document.getElementById("profitDetailModalMask");
const closeProfitDetailModalBtn = document.getElementById("closeProfitDetailModalBtn");
const profitDetailModalSubtitle = document.getElementById("profitDetailModalSubtitle");
const profitDetailContent = document.getElementById("profitDetailContent");

function bindProfitDetailEvents() {
  if (closeProfitDetailModalBtn) closeProfitDetailModalBtn.addEventListener("click", closeProfitDetailModal);
  if (profitDetailModalMask) profitDetailModalMask.addEventListener("click", onProfitDetailMaskClick);
}
