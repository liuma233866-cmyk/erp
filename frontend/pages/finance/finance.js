function formatFinanceMoney(value) {
  const amount = Number(value || 0);
  return amount.toFixed(2);
}

// 财务页面需要的是全量订单聚合；订单管理页的 state.orders 只保存当前一页，
// 直接复用会导致利润/采购只统计到当前页（曾因此看起来「数据丢失」）。
function getFinanceOrders() {
  return Array.isArray(state.financeOrders) && state.financeOrders.length
    ? state.financeOrders
    : (state.orders || []);
}

async function loadFinanceOrders() {
  if (!can("orderRead")) {
    state.financeOrders = [];
    return false;
  }
  const result = await apiRequest("/api/orders", { method: "GET" });
  state.financeOrders = result.ok && Array.isArray(result.data?.items)
    ? result.data.items.map(normalizeOrderForView)
    : [];
  return result.ok;
}

function applyFinanceProfitFallback() {
  state.financeOrders = (state.financeOrders || []).map((order) => ({
    ...order,
    ...((order && (order.profitUpdatedAt || order.profitRateDate))
      ? {}
      : computeOrderProfit(order))
  }));
}

function buildFinancePurchaseView() {
  const filters = state.financePurchaseFilters || {};
  const orderNoText = String(filters.orderNo || "").trim().toLowerCase();
  const skuText = String(filters.sku || "").trim().toLowerCase();
  const platformText = String(filters.purchasePlatform || "").trim().toLowerCase();
  const rows = getFinanceOrders()
    .filter(hasPurchaseInfo)
    .filter((order) => {
      if (orderNoText) {
        const haystack = `${order.shopOrderNo || ""} ${order.id || ""}`.toLowerCase();
        if (!haystack.includes(orderNoText)) return false;
      }
      if (skuText && !String(order.shopSku || "").toLowerCase().includes(skuText)) return false;
      if (platformText && !String(order.purchasePlatform || "").toLowerCase().includes(platformText)) return false;
      return true;
    })
    .map((order) => ({
      ...order,
      purchasePriceRmbValue: toMoneyNumber(order.purchasePriceRmb),
      purchasePriceRubValue: toMoneyNumber(order.purchasePriceRub),
      purchaseTs: getPurchaseTimestamp(order)
    }))
    .sort((a, b) => (b.purchaseTs || 0) - (a.purchaseTs || 0));

  state.financePurchaseRows = rows;
  state.financePurchasePage = 1;
  renderFinancePurchaseSummary(rows);
  renderFinancePurchaseTable(rows);
}

function onFinancePurchaseFilterSubmit(event) {
  event.preventDefault();
  state.financePurchaseFilters = {
    orderNo: String(financePurchaseFilterOrderNo?.value || "").trim(),
    sku: String(financePurchaseFilterSku?.value || "").trim(),
    purchasePlatform: String(financePurchaseFilterPlatform?.value || "").trim()
  };
  buildFinancePurchaseView();
}

function onFinancePurchaseFilterReset() {
  if (financePurchaseFilterForm) financePurchaseFilterForm.reset();
  state.financePurchaseFilters = { orderNo: "", sku: "", purchasePlatform: "" };
  buildFinancePurchaseView();
}

function renderFinancePurchaseSummary(rows) {
  const now = new Date();
  const dayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now).getTime();

  const totals = {
    dayRmb: 0,
    dayRub: 0,
    weekRmb: 0,
    weekRub: 0,
    monthRmb: 0,
    monthRub: 0
  };

  for (const row of rows) {
    const ts = Number(row.purchaseTs || 0);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts >= dayStart) {
      totals.dayRmb += row.purchasePriceRmbValue;
      totals.dayRub += row.purchasePriceRubValue;
    }
    if (ts >= weekStart) {
      totals.weekRmb += row.purchasePriceRmbValue;
      totals.weekRub += row.purchasePriceRubValue;
    }
    if (ts >= monthStart) {
      totals.monthRmb += row.purchasePriceRmbValue;
      totals.monthRub += row.purchasePriceRubValue;
    }
  }

  if (financeDayPurchaseRmb) financeDayPurchaseRmb.textContent = formatFinanceMoney(totals.dayRmb);
  if (financeDayPurchaseRub) financeDayPurchaseRub.textContent = formatFinanceMoney(totals.dayRub);
  if (financeWeekPurchaseRmb) financeWeekPurchaseRmb.textContent = formatFinanceMoney(totals.weekRmb);
  if (financeWeekPurchaseRub) financeWeekPurchaseRub.textContent = formatFinanceMoney(totals.weekRub);
  if (financeMonthPurchaseRmb) financeMonthPurchaseRmb.textContent = formatFinanceMoney(totals.monthRmb);
  if (financeMonthPurchaseRub) financeMonthPurchaseRub.textContent = formatFinanceMoney(totals.monthRub);
}

function renderFinancePurchaseTable(rows) {
  if (!financePurchaseTableBody) return;
  const pageSize = Math.max(1, Math.min(200, Number(state.financePurchasePageSize || 20) || 20));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Number(state.financePurchasePage || 1) || 1), totalPages);
  state.financePurchasePageSize = pageSize;
  state.financePurchaseTotalPages = totalPages;
  state.financePurchasePage = page;
  if (!rows.length) {
    financePurchaseTableBody.innerHTML = "<tr><td colspan='9'>暂无采购订单</td></tr>";
    renderFinancePurchasePagination();
    return;
  }

  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  financePurchaseTableBody.innerHTML = pageRows
    .map((order) => {
      const title = String(order.title || order.productTitle || order.itemName || "").trim();
      const purchaseAt = Number.isFinite(order.purchaseTs) && order.purchaseTs > 0
        ? new Date(order.purchaseTs).toLocaleString("zh-CN")
        : "-";
      return `
        <tr>
          <td>${escapeHtml(order.shopOrderNo || order.id || "-")}</td>
          <td>${escapeHtml(order.shopName || "-")}</td>
          <td>${escapeHtml(order.shopSku || "-")}</td>
          <td>${escapeHtml(title || "-")}</td>
          <td>${escapeHtml(order.purchasePlatform || "-")}</td>
          <td>${escapeHtml(order.purchaseOrderNo || "-")}</td>
          <td>${escapeHtml(order.purchasePriceRmb || "-")}</td>
          <td>${escapeHtml(order.purchasePriceRub || "-")}</td>
          <td>${escapeHtml(purchaseAt)}</td>
        </tr>
      `;
    })
    .join("");
  renderFinancePurchasePagination();
}

function renderFinancePurchasePagination() {
  const page = state.financePurchasePage || 1;
  const totalPages = Math.max(1, Number(state.financePurchaseTotalPages || 1) || 1);
  if (financePurchasePaginationInfo) financePurchasePaginationInfo.textContent = `${page} / ${totalPages}`;
  if (financePurchasePrevPageBtn) financePurchasePrevPageBtn.disabled = page <= 1;
  if (financePurchaseNextPageBtn) financePurchaseNextPageBtn.disabled = page >= totalPages;
  if (financePurchaseGotoPage) financePurchaseGotoPage.value = String(page);
  if (financePurchasePageSize) financePurchasePageSize.value = String(state.financePurchasePageSize || 20);
}

function changeFinancePurchasePage(nextPage) {
  const totalPages = Math.max(1, Number(state.financePurchaseTotalPages || 1) || 1);
  const page = Math.min(Math.max(1, Number(nextPage) || 1), totalPages);
  if (page === (state.financePurchasePage || 1)) return;
  state.financePurchasePage = page;
  renderFinancePurchaseTable(state.financePurchaseRows || []);
}

function onFinancePurchaseGotoPage() {
  if (!financePurchaseGotoPage) return;
  const target = Number(financePurchaseGotoPage.value);
  if (!Number.isFinite(target)) {
    renderFinancePurchasePagination();
    return;
  }
  changeFinancePurchasePage(target);
}

function onFinancePurchasePageSizeChange() {
  if (!financePurchasePageSize) return;
  const size = Number(financePurchasePageSize.value);
  if (!Number.isFinite(size) || size < 1) return;
  state.financePurchasePageSize = Math.max(1, Math.min(200, size));
  state.financePurchasePage = 1;
  renderFinancePurchaseTable(state.financePurchaseRows || []);
}

function onFinanceProfitTableClick(event) {
  const button = event.target.closest("[data-finance-profit-index]");
  if (!button) return;
  const index = Number(button.getAttribute("data-finance-profit-index"));
  if (!Number.isInteger(index) || index < 0) return;
  const row = Array.isArray(state.financeProfitRows) ? state.financeProfitRows[index] : null;
  if (!row) return;
  openProfitDetailModal(row, String(button.dataset.profitCurrency || "rmb").trim().toLowerCase(), "order");
}

function formatNullableFinanceMoney(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "-";
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "-";
}

function buildFinanceProfitView() {
  const filters = state.financeProfitFilters || {};
  const orderNoText = String(filters.orderNo || "").trim().toLowerCase();
  const skuText = String(filters.sku || "").trim().toLowerCase();
  const receiptCodeText = String(filters.receiptCode || "").trim().toLowerCase();
  const profitMinText = String(filters.profitMin ?? "").trim();
  const profitMaxText = String(filters.profitMax ?? "").trim();
  const matchedRows = getFinanceOrders()
    .filter((order) => order.matchedRuleName);
  const rows = matchedRows
    .filter((order) => {
      if (orderNoText) {
        const haystack = `${order.shopOrderNo || ""} ${order.id || ""}`.toLowerCase();
        if (!haystack.includes(orderNoText)) return false;
      }
      if (skuText && !String(order.shopSku || "").toLowerCase().includes(skuText)) return false;
      if (receiptCodeText) {
        const orderCode = String(order.customerReceiptCode || "").toLowerCase();
        if (receiptCodeText === "returned") {
          if (orderCode !== "returned" && orderCode !== "partially_returned") return false;
        } else if (orderCode !== receiptCodeText) {
          return false;
        }
      }
      const profit = Number(order.profitRub);
      if (profitMinText !== "") {
        const min = Number(profitMinText);
        if (Number.isFinite(min) && !(profit >= min)) return false;
      }
      if (profitMaxText !== "") {
        const max = Number(profitMaxText);
        if (Number.isFinite(max) && !(profit <= max)) return false;
      }
      return true;
    })
    .map((order) => ({
      ...order,
      effectivePurchasePriceRmb: order.purchasePriceRmb,
      effectivePurchasePriceRub: order.purchasePriceRub,
      profitRmbValue: toNullableMoneyNumber(order.profitRmb),
      profitRubValue: toNullableMoneyNumber(order.profitRub)
    }))
    .sort((a, b) => {
      const ta = new Date(a.sellerOrderAt || a.createdAt || 0).getTime();
      const tb = new Date(b.sellerOrderAt || b.createdAt || 0).getTime();
      return tb - ta;
    });

  state.financeProfitRows = rows;
  let totalRmb = 0;
  let totalRub = 0;
  for (const row of rows) {
    totalRmb += Number(row.profitRmbValue || 0);
    totalRub += Number(row.profitRubValue || 0);
  }
  if (financeProfitMatchedCount) financeProfitMatchedCount.textContent = String(rows.length);
  if (financeProfitTotalRmb) financeProfitTotalRmb.textContent = formatFinanceMoney(totalRmb);
  if (financeProfitTotalRub) financeProfitTotalRub.textContent = formatFinanceMoney(totalRub);
  if (financeProfitMessage) {
    financeProfitMessage.style.color = "#2f3d63";
    const filtered = Boolean(orderNoText || skuText || receiptCodeText || profitMinText !== "" || profitMaxText !== "");
    financeProfitMessage.textContent = rows.length
      ? `当前按 ${rows.length}${filtered ? ` / ${matchedRows.length}` : ""} 条命中规则的订单计算利润${filtered ? "（已筛选）" : ""}`
      : (matchedRows.length ? "当前筛选条件下没有订单" : "当前还没有命中审单规则的订单");
  }
  const pageSize = Math.max(1, Math.min(200, Number(state.financeProfitPageSize || 20) || 20));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Number(state.financeProfitPage || 1) || 1), totalPages);
  state.financeProfitPageSize = pageSize;
  state.financeProfitTotalPages = totalPages;
  state.financeProfitPage = page;
  if (!financeProfitTableBody) return;
  if (!rows.length) {
    financeProfitTableBody.innerHTML = "<tr><td colspan='10'>暂无利润数据</td></tr>";
    renderFinanceProfitPagination();
    return;
  }
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  financeProfitTableBody.innerHTML = pageRows.map((row, offset) => {
    const index = start + offset;
    // 与订单管理页保持同一份状态数据与展示（customerReceiptCode → 中/英状态）。
    const customerOrderStatus = getCustomerOrderStatusDisplay(row);
    const receiptClass = customerOrderStatus?.positive ? "status-ok" : "status-muted";
    const receiptText = customerOrderStatus
      ? `${customerOrderStatus.zh} / ${customerOrderStatus.en}`
      : "-";
    return `
    <tr>
      <td>${escapeHtml(row.shopOrderNo || row.id || "-")}</td>
      <td>${escapeHtml(row.shopName || "-")}</td>
      <td>${escapeHtml(row.shopSku || "-")}</td>
      <td>${escapeHtml(row.matchedRuleName || "-")}</td>
      <td>${escapeHtml(formatNullableFinanceMoney(row.amount))}</td>
      <td>${escapeHtml(formatNullableFinanceMoney(row.effectivePurchasePriceRmb))}</td>
      <td>${escapeHtml(formatNullableFinanceMoney(row.effectivePurchasePriceRub))}</td>
      <td><button type="button" class="profit-detail-trigger" data-finance-profit-index="${index}" data-profit-currency="rmb">${escapeHtml(formatNullableFinanceMoney(row.profitRmb))}</button></td>
      <td><button type="button" class="profit-detail-trigger" data-finance-profit-index="${index}" data-profit-currency="rub">${escapeHtml(formatNullableFinanceMoney(row.profitRub))}</button></td>
      <td><span class="status ${receiptClass}">${escapeHtml(receiptText)}</span></td>
    </tr>
  `;
  }).join("");
  renderFinanceProfitPagination();
}

function renderFinanceProfitPagination() {
  const page = state.financeProfitPage || 1;
  const totalPages = Math.max(1, Number(state.financeProfitTotalPages || 1) || 1);
  if (financeProfitPaginationInfo) financeProfitPaginationInfo.textContent = `${page} / ${totalPages}`;
  if (financeProfitPrevPageBtn) financeProfitPrevPageBtn.disabled = page <= 1;
  if (financeProfitNextPageBtn) financeProfitNextPageBtn.disabled = page >= totalPages;
  if (financeProfitGotoPage) financeProfitGotoPage.value = String(page);
  if (financeProfitPageSize) financeProfitPageSize.value = String(state.financeProfitPageSize || 20);
}

function changeFinanceProfitPage(nextPage) {
  const totalPages = Math.max(1, Number(state.financeProfitTotalPages || 1) || 1);
  const target = Math.max(1, Math.min(totalPages, Number(nextPage) || 1));
  if (target === (state.financeProfitPage || 1)) return;
  state.financeProfitPage = target;
  buildFinanceProfitView();
}

function onFinanceProfitGotoPage() {
  if (!financeProfitGotoPage) return;
  const target = Number(financeProfitGotoPage.value);
  if (!Number.isFinite(target) || target < 1) {
    financeProfitGotoPage.value = String(state.financeProfitPage || 1);
    return;
  }
  changeFinanceProfitPage(target);
}

function onFinanceProfitPageSizeChange() {
  if (!financeProfitPageSize) return;
  const size = Number(financeProfitPageSize.value);
  if (!Number.isFinite(size) || size < 1) return;
  state.financeProfitPageSize = Math.max(1, Math.min(200, size));
  state.financeProfitPage = 1;
  buildFinanceProfitView();
}

function onFinanceProfitFilterSubmit(event) {
  event.preventDefault();
  state.financeProfitFilters = {
    orderNo: String(financeProfitFilterOrderNo?.value || "").trim(),
    sku: String(financeProfitFilterSku?.value || "").trim(),
    receiptCode: String(financeProfitFilterReceipt?.value || "").trim(),
    profitMin: String(financeProfitFilterMin?.value || "").trim(),
    profitMax: String(financeProfitFilterMax?.value || "").trim()
  };
  state.financeProfitPage = 1;
  buildFinanceProfitView();
}

function onFinanceProfitFilterReset() {
  if (financeProfitFilterForm) financeProfitFilterForm.reset();
  state.financeProfitFilters = { orderNo: "", sku: "", receiptCode: "", profitMin: "", profitMax: "" };
  state.financeProfitPage = 1;
  buildFinanceProfitView();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const financeDayPurchaseRmb = document.getElementById("financeDayPurchaseRmb");
const financeDayPurchaseRub = document.getElementById("financeDayPurchaseRub");
const financeWeekPurchaseRmb = document.getElementById("financeWeekPurchaseRmb");
const financeWeekPurchaseRub = document.getElementById("financeWeekPurchaseRub");
const financeMonthPurchaseRmb = document.getElementById("financeMonthPurchaseRmb");
const financeMonthPurchaseRub = document.getElementById("financeMonthPurchaseRub");
const financePurchaseTableBody = document.getElementById("financePurchaseTableBody");
const financePurchasePrevPageBtn = document.getElementById("financePurchasePrevPageBtn");
const financePurchaseNextPageBtn = document.getElementById("financePurchaseNextPageBtn");
const financePurchasePaginationInfo = document.getElementById("financePurchasePaginationInfo");
const financePurchaseGotoPage = document.getElementById("financePurchaseGotoPage");
const financePurchasePageSize = document.getElementById("financePurchasePageSize");
const financePurchaseFilterForm = document.getElementById("financePurchaseFilterForm");
const financePurchaseFilterOrderNo = document.getElementById("financePurchaseFilterOrderNo");
const financePurchaseFilterSku = document.getElementById("financePurchaseFilterSku");
const financePurchaseFilterPlatform = document.getElementById("financePurchaseFilterPlatform");
const financePurchaseFilterResetBtn = document.getElementById("financePurchaseFilterResetBtn");
const financeProfitMessage = document.getElementById("financeProfitMessage");
const financeProfitMatchedCount = document.getElementById("financeProfitMatchedCount");
const financeProfitTotalRmb = document.getElementById("financeProfitTotalRmb");
const financeProfitTotalRub = document.getElementById("financeProfitTotalRub");
const financeProfitTableBody = document.getElementById("financeProfitTableBody");
const profitIssueCount = document.getElementById("profitIssueCount");
const profitIssueMissingRuleCount = document.getElementById("profitIssueMissingRuleCount");
const profitIssueMissingSnapshotCount = document.getElementById("profitIssueMissingSnapshotCount");
const profitIssueMessage = document.getElementById("profitIssueMessage");
const profitIssueTableBody = document.getElementById("profitIssueTableBody");
const financeProfitPrevPageBtn = document.getElementById("financeProfitPrevPageBtn");
const financeProfitNextPageBtn = document.getElementById("financeProfitNextPageBtn");
const financeProfitPaginationInfo = document.getElementById("financeProfitPaginationInfo");
const financeProfitGotoPage = document.getElementById("financeProfitGotoPage");
const financeProfitPageSize = document.getElementById("financeProfitPageSize");
const financeProfitFilterForm = document.getElementById("financeProfitFilterForm");
const financeProfitFilterOrderNo = document.getElementById("financeProfitFilterOrderNo");
const financeProfitFilterSku = document.getElementById("financeProfitFilterSku");
const financeProfitFilterReceipt = document.getElementById("financeProfitFilterReceipt");
const financeProfitFilterMin = document.getElementById("financeProfitFilterMin");
const financeProfitFilterMax = document.getElementById("financeProfitFilterMax");
const financeProfitFilterResetBtn = document.getElementById("financeProfitFilterResetBtn");

function bindFinanceEvents() {
  if (financeProfitTableBody) financeProfitTableBody.addEventListener("click", onFinanceProfitTableClick);
  if (financePurchaseFilterForm) financePurchaseFilterForm.addEventListener("submit", onFinancePurchaseFilterSubmit);
  if (financePurchaseFilterResetBtn) financePurchaseFilterResetBtn.addEventListener("click", onFinancePurchaseFilterReset);
  if (financePurchasePrevPageBtn) financePurchasePrevPageBtn.addEventListener("click", () => changeFinancePurchasePage((state.financePurchasePage || 1) - 1));
  if (financePurchaseNextPageBtn) financePurchaseNextPageBtn.addEventListener("click", () => changeFinancePurchasePage((state.financePurchasePage || 1) + 1));
  if (financePurchaseGotoPage) financePurchaseGotoPage.addEventListener("change", onFinancePurchaseGotoPage);
  if (financePurchasePageSize) financePurchasePageSize.addEventListener("change", onFinancePurchasePageSizeChange);
  if (financeProfitFilterForm) financeProfitFilterForm.addEventListener("submit", onFinanceProfitFilterSubmit);
  if (financeProfitFilterResetBtn) financeProfitFilterResetBtn.addEventListener("click", onFinanceProfitFilterReset);
  if (financeProfitPrevPageBtn) financeProfitPrevPageBtn.addEventListener("click", () => changeFinanceProfitPage((state.financeProfitPage || 1) - 1));
  if (financeProfitNextPageBtn) financeProfitNextPageBtn.addEventListener("click", () => changeFinanceProfitPage((state.financeProfitPage || 1) + 1));
  if (financeProfitGotoPage) financeProfitGotoPage.addEventListener("change", onFinanceProfitGotoPage);
  if (financeProfitPageSize) financeProfitPageSize.addEventListener("change", onFinanceProfitPageSizeChange);
}
