async function loadOrders() {
  orderMessage.style.color = "#c02030";
  orderMessage.textContent = "正在加载订单...";
  if (ordersList) ordersList.innerHTML = "<div class='message small'>正在加载...</div>";
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Number(state.currentPage || 1) || 1)));
  params.set("pageSize", String(PAGE_SIZE));
  [
    "orderId",
    "shopName",
    "shopSku",
    "itemCount",
    "shopOrderNo",
    "shopStatus",
    "trackingNo",
    "domesticTrackingNo",
    "purchaseOrderNo",
    "purchasePlatform",
    "purchaseStatus",
    "customerReceiptCode",
    "sellerOrderDate",
    "status"
  ].forEach((key) => {
    const value = String(state.filters?.[key] || "").trim();
    if (value) params.set(key, value);
  });
  const ordersEndpoint = state.orderWorkspace === "v2" ? "/api/orders-v2" : "/api/orders";
  const result = await apiRequest(`${ordersEndpoint}?${params.toString()}`, { method: "GET" });
  if (!result.ok) {
    orderMessage.textContent = result.error || "订单加载失败";
    return false;
  }

  state.orders = (result.data.items || []).map(normalizeOrderForView);
  const pagination = result.data?.pagination || {};
  state.ordersPagination = {
    page: Number(pagination.page || state.currentPage || 1) || 1,
    pageSize: Number(pagination.pageSize || PAGE_SIZE) || PAGE_SIZE,
    total: Number(pagination.total || state.orders.length || 0) || 0,
    totalPages: Number(pagination.totalPages || 1) || 1
  };
  state.currentPage = state.ordersPagination.page;
  refreshOrderProfitData();
  applyFiltersAndRender();
  orderMessage.textContent = "";
  return true;
}

async function onFilterSubmit(event) {
  event.preventDefault();
  const form = new FormData(orderFilterForm);
  state.filters.orderId = String(form.get("orderId") || "").trim();
  state.filters.shopName = String(form.get("shopName") || "").trim();
  state.filters.shopSku = String(form.get("shopSku") || "").trim();
  state.filters.itemCount = String(form.get("itemCount") || "").trim();
  state.filters.shopOrderNo = String(form.get("shopOrderNo") || "").trim();
  state.filters.shopStatus = String(form.get("shopStatus") || "").trim();
  state.filters.trackingNo = String(form.get("trackingNo") || "").trim();
  state.filters.domesticTrackingNo = String(form.get("domesticTrackingNo") || "").trim();
  state.filters.purchaseOrderNo = String(form.get("purchaseOrderNo") || "").trim();
  state.filters.purchasePlatform = String(form.get("purchasePlatform") || "").trim();
  state.filters.purchaseStatus = String(form.get("purchaseStatus") || "").trim();
  state.filters.customerReceiptCode = String(form.get("customerReceiptCode") || "").trim();
  state.filters.sellerOrderDate = String(form.get("sellerOrderDate") || "").trim();
  state.currentPage = 1;
  await loadOrders();
}

async function onFilterReset() {
  if (orderFilterForm) orderFilterForm.reset();
  const currentStatus = state.filters.status;
  state.filters = {
    orderId: "",
    shopName: "",
    shopSku: "",
    itemCount: "",
    shopOrderNo: "",
    shopStatus: "",
    trackingNo: "",
    domesticTrackingNo: "",
    purchaseOrderNo: "",
    purchasePlatform: "",
    purchaseStatus: "",
    customerReceiptCode: "",
    sellerOrderDate: "",
    status: currentStatus
  };
  state.currentPage = 1;
  await loadOrders();
}

async function onOrderStatusMenuClick(event) {
  const button = event.target.closest("button[data-status-menu]");
  if (!button) return;
  const status = String(button.dataset.statusMenu || "").trim();
  if (!status) return;

  // Keep receipt_* values verbatim: applyClientFilters routes them through
  // getReceiptGroup; pre-mapping to received/not_received/returned made the
  // receipt filter branch unreachable and the list always empty.
  state.filters.status = status === "all" ? "" : status;
  state.currentPage = 1;
  await loadOrders();
}

function applyFiltersAndRender() {
  pruneSelectedOrders();
  state.filteredOrders = applyClientFilters(Array.isArray(state.orders) ? state.orders : [], state.filters || {});
  renderOrdersTable();
  renderPagination();
  syncOrderStatusMenu();
  syncOrderSelectionUi();
}

function syncOrderStatusMenu() {
  if (!orderStatusMenu) return;
  const current = state.filters.status || "all";
  orderStatusMenu.querySelectorAll("button[data-status-menu]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.statusMenu === current);
  });
}

function applyClientFilters(items, filters) {
  let result = [...items];
  const orderId = String(filters.orderId || "").toLowerCase();
  if (orderId) {
    result = result.filter((order) => {
      const idText = String(order.id || "").toLowerCase();
      const shopOrderNo = String(order.shopOrderNo || "").toLowerCase();
      return idText.includes(orderId) || shopOrderNo.includes(orderId);
    });
  }
  if (filters.shopName) {
    result = result.filter((order) => String(order.shopName || "") === String(filters.shopName || ""));
  }
  if (filters.shopSku) {
    const skuText = String(filters.shopSku || "").toLowerCase();
    result = result.filter((order) => String(order.shopSku || "").toLowerCase().includes(skuText));
  }
  if (filters.itemCount) {
    const count = Number(filters.itemCount);
    if (Number.isFinite(count)) {
      result = result.filter((order) => Number(order.itemCount || 0) === count);
    }
  }
  if (filters.domesticTrackingNo) {
    const text = String(filters.domesticTrackingNo || "").toLowerCase();
    result = result.filter((order) => String(order.purchaseExpressNo || "").toLowerCase().includes(text));
  }
  if (filters.purchaseOrderNo) {
    const text = String(filters.purchaseOrderNo || "").toLowerCase();
    result = result.filter((order) => String(order.purchaseOrderNo || "").toLowerCase().includes(text));
  }
  if (filters.purchasePlatform) {
    const text = String(filters.purchasePlatform || "").toLowerCase();
    result = result.filter((order) => String(order.purchasePlatform || "").toLowerCase().includes(text));
  }
  if (filters.purchaseStatus) {
    const statusValue = String(filters.purchaseStatus || "").toLowerCase();
    result = result.filter((order) => {
      const hasPurchase =
        Boolean(
          order.purchaseOrderNo ||
            order.purchasePlatform ||
            order.purchasePriceRmb ||
            order.purchasePriceRub ||
            order.purchaseLink ||
            order.purchaseExpressNo ||
            order.purchaseIntlNo
        );
      if (statusValue === "purchased") return hasPurchase;
      if (statusValue === "unpurchased") return !hasPurchase;
      return true;
    });
  }
  if (filters.customerReceiptCode) {
    const receiptCode = String(filters.customerReceiptCode || "").toLowerCase();
    result = result.filter((order) => {
      const orderCode = String(order.customerReceiptCode || "").toLowerCase();
      if (receiptCode === "returned") return orderCode === "returned" || orderCode === "partially_returned";
      return orderCode === receiptCode;
    });
  }
  if (filters.sellerOrderDate) {
    const dateValue = String(filters.sellerOrderDate || "").trim();
    if (dateValue) {
      result = result.filter((order) => {
        const rawDate = order.sellerOrderAt || order.createdAt;
        if (!rawDate) return false;
        const date = new Date(rawDate);
        if (Number.isNaN(date.getTime())) return false;
        const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
        return localDate === dateValue;
      });
    }
  }
  if (filters.shopOrderNo) {
    const shopOrderText = String(filters.shopOrderNo || "").toLowerCase();
    result = result.filter((order) => String(order.shopOrderNo || "").toLowerCase().includes(shopOrderText));
  }
  if (filters.shopStatus) {
    const statusText = String(filters.shopStatus || "").toLowerCase();
    result = result.filter((order) => String(order.shopStatus || "").toLowerCase().includes(statusText));
  }
  if (filters.trackingNo) {
    const trackText = String(filters.trackingNo || "").toLowerCase();
    result = result.filter((order) => String(order.trackingNo || order.trackingId || "").toLowerCase().includes(trackText));
  }
  if (["receipt_signed", "receipt_unsigned", "receipt_exception"].includes(filters.status)) {
    const targetGroup = filters.status.replace(/^receipt_/, "");
    result = result.filter((order) => getReceiptGroup(order) === targetGroup);
  } else if (filters.status) {
    result = result.filter((order) => order.status === filters.status);
  }
  result.sort((a, b) => {
    return getLatestOrderTimestamp(b) - getLatestOrderTimestamp(a);
  });
  return result;
}

function getReceiptGroup(order) {
  const receiptCode = String(order?.customerReceiptCode || "").trim().toLowerCase();
  if (receiptCode === "received") return "signed";
  if (["not_received", "returned", "partially_returned"].includes(receiptCode)) return "exception";
  if (["ready_for_pickup", "in_delivery"].includes(receiptCode)) return "unsigned";
  if (!receiptCode && String(order?.status || "").trim().toLowerCase() === "shipped") return "unsigned";
  return "";
}

function getLatestOrderTimestamp(order) {
  const candidates = [order?.sellerOrderAt, order?.createdAt, order?.updatedAt];
  for (const value of candidates) {
    const time = new Date(value || 0).getTime();
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}

function normalizeOrderForView(raw) {
  const id = String(raw.id || raw.orderId || raw.orderNo || "-");
  const status = normalizeOrderStatus(raw.status);
  const itemCount = extractOrderItemCount(raw);
  const shopSku = extractShopSku(raw);
  const shopOrderNo = String(raw.shopOrderNo || raw.shopOrderId || raw.externalOrderId || raw.orderNo || id || "-");
  const shopName = String(raw.shopName || raw.storeName || raw.campaignName || "未命名店铺");
  const amount = raw.amount !== undefined && raw.amount !== null ? Number(raw.amount) : undefined;
  const stableId = raw.provider === "yandex_market" && shopOrderNo && raw.shopId
    ? `ORD-YM-${String(raw.shopId).replace(/[^\w-]+/g, "_")}-${String(shopOrderNo).replace(/[^\w-]+/g, "_")}`
    : id;
  return {
    ...raw,
    id: stableId,
    status,
    shopName,
    shopSku: shopSku || "-",
    itemCount,
    shopOrderNo,
    amount,
    matchedOnlineProductId: String(raw.matchedOnlineProductId || "").trim(),
    matchedOnlineProductName: String(raw.matchedOnlineProductName || "").trim(),
    matchedOnlineProductSku: String(raw.matchedOnlineProductSku || "").trim(),
    matchedOnlineProductShopId: String(raw.matchedOnlineProductShopId || "").trim(),
    matchedOnlineProductPurchasePriceRmb: raw.matchedOnlineProductPurchasePriceRmb,
    matchedOnlineProductPurchasePriceRub: raw.matchedOnlineProductPurchasePriceRub,
    matchedOnlineProductCommissionPercent: raw.matchedOnlineProductCommissionPercent,
    matchedOnlineProductWeightKg: raw.matchedOnlineProductWeightKg,
    matchType: String(raw.matchType || "").trim(),
    matchConfidence: Number(raw.matchConfidence || 0) || 0,
    matchUpdatedAt: String(raw.matchUpdatedAt || "").trim()
  };
}

function getOrderRequestRef(order) {
  return String(order?.shopOrderNo || order?.id || "").trim();
}

function normalizeOrderStatus(status) {
  const text = String(status || "").trim().toLowerCase();
  if (["cancelled", "canceled", "cancel", "void", "voided"].includes(text)) return "cancelled";
  if (["shipped", "delivery", "delivered", "pickup", "processing_delivered"].includes(text)) return "shipped";
  return "pending";
}

function getCustomerOrderStatusDisplay(order) {
  const code = String(order?.customerReceiptCode || "").trim();
  const labels = {
    received: { zh: "已收货", en: "Received", positive: true },
    ready_for_pickup: { zh: "待顾客取件", en: "Ready for pickup", positive: false },
    in_delivery: { zh: "配送中", en: "In delivery", positive: false },
    not_received: { zh: "顾客未收到", en: "Customer not received", positive: false },
    returned: { zh: "已退货", en: "Returned", positive: false },
    partially_returned: { zh: "已退货", en: "Returned", positive: false }
  };
  return labels[code] || null;
}

function extractShopSku(raw) {
  if (raw.shopSku) return String(raw.shopSku);
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    const first = raw.items[0] || {};
    return String(first.shopSku || first.offerId || first.sku || "");
  }
  return "";
}

function extractOrderItemCount(raw) {
  const direct = Number(raw.itemCount ?? raw.itemsCount ?? raw.totalItems);
  if (Number.isFinite(direct) && direct >= 0) return Math.floor(direct);
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.reduce((sum, item) => {
      const count = Number(item.count ?? item.quantity ?? item.itemCount ?? 1);
      return sum + (Number.isFinite(count) && count > 0 ? count : 1);
    }, 0);
  }
  return 1;
}

function getCurrentPageItems() {
  return Array.isArray(state.filteredOrders) ? state.filteredOrders : [];
}

function renderOrdersTable() {
  const items = getCurrentPageItems();
  if (!items.length) {
    if (ordersList) ordersList.innerHTML = "<div class='message small'>暂无订单</div>";
    syncOrderSelectionUi();
    return;
  }
  if (!ordersList) return;
  const selectedSet = new Set(state.selectedOrderIds || []);

  ordersList.innerHTML = items
    .map((order) => {
      const shopOrder = escapeHtml(order.shopOrderNo || "");
      const topStatus = escapeHtml(String(order.shopStatus || ""));
      const customerOrderStatus = getCustomerOrderStatusDisplay(order);
      const receiptClass = customerOrderStatus?.positive ? "status-ok" : "status-muted";
      const receiptText = customerOrderStatus
        ? `${escapeHtml(customerOrderStatus.zh)} / ${escapeHtml(customerOrderStatus.en)}`
        : "-";
      const receivedAt = order.customerReceivedAt ? escapeHtml(String(order.customerReceivedAt)) : "";
      const createdAt = order.createdAt ? formatDateTime(order.createdAt) : "";
      const deadline = order.deadlineAt ? formatDateTime(order.deadlineAt) : "";
      const remaining = "";
      const trackingNo = escapeHtml(order.trackingNo || order.trackingId || "");
      const logistics = escapeHtml(order.logistics || order.carrier || "");
      const warehouse = escapeHtml(order.warehouse || "");
      const currency = String(order.currency || "").trim().toUpperCase();
      const totalPriceValue = Number(order.amount);
      const totalPrice = Number.isFinite(totalPriceValue) ? totalPriceValue : null;
      const shopName = escapeHtml(order.shopName || order.account || order.shopAccount || "未命名店铺");
      const sku = escapeHtml(order.shopSku || "");
      const qtyValue = Number(order.itemCount ?? 0);
      const qty = order.itemCount !== undefined && order.itemCount !== null ? escapeHtml(String(order.itemCount)) : "";
      const unitPriceValue = Number(order.unitPrice ?? order.price ?? order.unitPriceRmb ?? null);
      const unitPrice = Number.isFinite(totalPriceValue) && Number.isFinite(qtyValue) && qtyValue > 0
        ? totalPriceValue / qtyValue
        : (Number.isFinite(unitPriceValue) ? unitPriceValue : null);
      const titleText = escapeHtml(order.productName || order.title || "");
      const imageUrl = escapeHtml(order.imageUrl || order.image || "");
      // Yandex details may contain several order lines.  Keep the old flat
      // fields as a fallback for historical orders, but never hide the rest
      // of a newly synced order behind its first item.
      const orderItems = Array.isArray(order.items) && order.items.length
        ? order.items
        : [{
            name: order.productName || order.title || "",
            shopSku: order.shopSku || "",
            count: order.itemCount,
            unitPrice: unitPrice,
            imageUrl: order.imageUrl || order.image || ""
          }];
      const productLinesHtml = orderItems.map((item, itemIndex) => {
        const itemTitle = escapeHtml(item?.name || item?.title || order.productName || order.title || "");
        const itemSku = escapeHtml(item?.shopSku || item?.offerId || item?.sku || order.shopSku || "");
        const itemQuantityValue = Number(item?.count ?? item?.quantity ?? item?.itemCount ?? 1);
        const itemQuantity = Number.isFinite(itemQuantityValue) && itemQuantityValue > 0 ? itemQuantityValue : 1;
        const itemPriceValue = Number(item?.unitPrice ?? item?.price ?? null);
        const itemPrice = Number.isFinite(itemPriceValue) ? itemPriceValue : null;
        // A multi-item order must never borrow the first item's image for the
        // other SKUs. Missing per-item images are shown as an explicit
        // placeholder instead of a misleading duplicate product picture.
        const fallbackImage = orderItems.length === 1 ? (order.imageUrl || order.image || "") : "";
        const itemImage = escapeHtml(safeImageUrl(item?.imageUrl || item?.image || fallbackImage));
        return `<div class="order-product order-product-line" data-order-item-index="${itemIndex}">
          <div class="order-product-image-wrap">
            ${itemImage
              ? `<img src="${itemImage}" alt="商品图片" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="80" height="80" data-action="preview-image" />`
              : `<div class="order-image-placeholder" aria-label="暂无商品图片">暂无图片</div>`}
          </div>
          <div class="order-product-meta">
            <div class="order-product-item order-product-item-full">
              <span class="order-section-title">商品${orderItems.length > 1 ? ` ${itemIndex + 1}` : ""}:</span>
              <span class="order-title-text">${itemTitle}</span>
            </div>
            <div class="order-product-item"><span>店铺SKU:</span><span class="value">${itemSku}</span></div>
            <div class="order-product-item"><span>数量:</span><span class="value">${itemQuantity}</span></div>
            <div class="order-product-item"><span>单价:</span><span class="value">${formatCurrency(itemPrice, currency)}</span></div>
          </div>
        </div>`;
      }).join("");
      const purchaseHtml = order.purchaseInfo ? `<div class="order-purchase">${escapeHtml(order.purchaseInfo)}</div>` : "";
      const hasPurchase =
        Boolean(
          order.purchaseOrderNo ||
            order.purchasePlatform ||
            order.purchasePriceRmb ||
            order.purchasePriceRub ||
            order.purchaseLink ||
            order.purchaseExpressNo ||
            order.purchaseIntlNo
        );
      const purchaseStatusText = hasPurchase ? "已采购" : "未采购";
      const purchaseStatusClass = hasPurchase ? "status-ok" : "status-muted";
      const checked = selectedSet.has(String(order.id || "")) ? "checked" : "";
      const isSyncingCurrentOrder = syncingSingleOrderRefs.has(getOrderRequestRef(order));
      const platformLabel = escapeHtml(order.platform || order.provider || order.shopProvider || "Yandex");
      return `<article class="order-card" data-order-id="${escapeHtml(getOrderRequestRef(order))}">
        <div class="order-top">
          <input class="order-check" type="checkbox" data-order-check="${escapeHtml(order.id)}" ${checked} />
          <span class="badge">${platformLabel}</span>
          <div>
            店铺订单: <span class="value">${shopOrder}</span>
            <span style="margin-left:8px;">店铺订单状态: <span class="status">${topStatus}</span></span>
          </div>
          <div>
            买家下单: ${createdAt}
            <span style="margin-left:8px;">截止出货: <span class="status">${deadline}</span></span>
            <span style="margin-left:8px;">发货剩余: <span class="status remaining-time" data-deadline="${escapeHtml(order.deadlineAt || "")}">${remaining}</span></span>
            <span style="margin-left:8px;">采购状态: <span class="status ${purchaseStatusClass}">${purchaseStatusText}</span></span>
          </div>
        </div>
        <div class="order-body">
          <div class="order-products">
            ${productLinesHtml}
            <div class="order-profit-summary">
              <span>利润(RMB): <button type="button" class="link-btn profit-detail-trigger" data-action="profit-detail" data-profit-currency="rmb">${escapeHtml(formatNullableFinanceMoney(order.profitRmb))}</button></span>
              <span>利润(卢布): <button type="button" class="link-btn profit-detail-trigger" data-action="profit-detail" data-profit-currency="rub">${escapeHtml(formatNullableFinanceMoney(order.profitRub))}</button></span>
            </div>
            <div class="order-customer-status">
              <span>订单状态:</span>
              <span class="status ${receiptClass}">${receiptText}${customerOrderStatus?.positive && receivedAt ? ` · ${receivedAt}` : ""}</span>
            </div>
          </div>
          <div class="order-info">
            <div class="order-info-col">
              <div>运单条码: <button type="button" class="link-btn" data-action="tracking">${trackingNo || "-"}</button></div>
              <div>物流: <span class="value">${logistics}</span></div>
              <div>备货仓库: <span class="value">${warehouse}</span></div>
              <div>总价: <span class="value">${formatCurrency(totalPrice, currency)}</span></div>
              <div>店铺名称: <span class="value">${shopName}</span></div>
              <div>店铺: <span class="value">${shopName}</span></div>
              <div>总数: <span class="value">${qty}</span></div>
            </div>
            <div class="order-info-col">
              <div class="order-purchase-grid">
                <div>采购平台: <span class="value">${escapeHtml(order.purchasePlatform || "")}</span></div>
                <div>采购链接: <span class="value">${escapeHtml(order.purchaseLink || "")}</span></div>
                <div>采购单号: <span class="value">${escapeHtml(order.purchaseOrderNo || "")}</span></div>
                <div>采购运单号: <span class="value">${escapeHtml(order.purchaseIntlNo || order.purchaseExpressNo || "")}</span></div>
                <div>采购价格人民币: <span class="value">${escapeHtml(order.purchasePriceRmb || "")}</span></div>
                <div>采购价格卢布: <span class="value">${escapeHtml(order.purchasePriceRub || "")}</span></div>
              </div>
            </div>
            ${purchaseHtml}
          </div>
          <div class="order-actions">
            <button class="small-btn" data-action="purchase-info">采购信息</button>
            <button class="small-btn" data-action="match-product">匹配产品</button>
            <button class="small-btn" data-action="sync-order" ${isSyncingCurrentOrder ? "disabled" : ""}>${isSyncingCurrentOrder ? "同步中..." : "同步当前订单"}</button>
            <button class="small-btn" data-action="sync-label">同步面单</button>
            <button class="small-btn" data-action="remark">订单备注</button>
            <button class="small-btn danger-btn" data-action="void">废弃订单</button>
            <button class="small-btn primary-btn" data-action="print">打印面单</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
  syncOrderSelectionUi();
  updateRemainingTimes();
}

function renderPagination() {
  const totalPages = Math.max(1, Number(state.ordersPagination?.totalPages || 1) || 1);
  const total = Math.max(0, Number(state.ordersPagination?.total || 0) || 0);
  if (state.currentPage > totalPages) state.currentPage = totalPages;

  paginationInfo.textContent = `第 ${state.currentPage} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  prevPageBtn.disabled = state.currentPage <= 1;
  nextPageBtn.disabled = state.currentPage >= totalPages;
}

function syncOrderSelectionUi() {
  if (orderSelectedCount) {
    orderSelectedCount.textContent = `已选 ${state.selectedOrderIds.length} 条`;
  }
  if (!orderSelectAll) return;
  const pageIds = getCurrentPageItems().map((order) => String(order.id || "")).filter(Boolean);
  if (!pageIds.length) {
    orderSelectAll.checked = false;
    orderSelectAll.indeterminate = false;
    return;
  }
  const selectedSet = new Set(state.selectedOrderIds);
  const checkedCount = pageIds.filter((id) => selectedSet.has(id)).length;
  orderSelectAll.checked = checkedCount === pageIds.length;
  orderSelectAll.indeterminate = checkedCount > 0 && checkedCount < pageIds.length;
}

function pruneSelectedOrders() {
  // Selections persist across pages: only drop ids that exist neither on the
  // current page nor as a stored cross-page snapshot.
  const currentIds = new Set((state.orders || []).map((item) => String(item.id || "")).filter(Boolean));
  state.selectedOrderIds = (state.selectedOrderIds || []).filter(
    (id) => currentIds.has(id) || Boolean(state.selectedOrdersById?.has(id))
  );
}

// 以下为从 app.js 拆出的订单深逻辑（采购/标签/追踪/匹配/备注/作废/翻页）。



function getOrderCacheKey(order) {
  return String(order?.shopOrderNo || order?.id || "").trim();
}

async function changePage(nextPage) {
  const totalPages = Math.max(1, Number(state.ordersPagination?.totalPages || 1) || 1);
  if (nextPage < 1 || nextPage > totalPages) return;
  state.currentPage = nextPage;
  await loadOrders();
}

function onOrderTitleToggle(event) {
  const title = event.target.closest(".order-title-text");
  if (!title) return;
  title.classList.toggle("is-expanded");
}

function onOrderSelectAllChange(event) {
  const checked = Boolean(event.target.checked);
  const pageItems = getCurrentPageItems();
  const pageIds = pageItems.map((order) => String(order.id || "")).filter(Boolean);
  if (checked) {
    const selectedSet = new Set(state.selectedOrderIds);
    for (const order of pageItems) {
      const id = String(order.id || "");
      if (!id) continue;
      selectedSet.add(id);
      if (!state.selectedOrdersById.has(id)) state.selectedOrdersById.set(id, order);
    }
    state.selectedOrderIds = Array.from(selectedSet);
  } else {
    const pageSet = new Set(pageIds);
    state.selectedOrderIds = state.selectedOrderIds.filter((id) => !pageSet.has(id));
    for (const id of pageIds) state.selectedOrdersById.delete(id);
  }
  renderOrdersTable();
}

function getOrderMatchTypeLabel(value) {
  const type = String(value || "").trim();
  if (type === "shopSku") return "店铺SKU";
  if (type === "vendorCode") return "商家编码";
  if (type === "marketSku") return "平台SKU";
  if (type === "manual") return "手动";
  if (type === "manual_clear") return "手动清空";
  return "-";
}

function getOrderMatchCandidates(order, searchText = "") {
  const shopId = String(order?.shopId || "").trim();
  const sku = String(order?.shopSku || "").trim().toLowerCase();
  const title = String(order?.productName || order?.title || "").trim().toLowerCase();
  const tokens = String(searchText || "")
    .toLowerCase()
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return (state.onlineProducts || [])
    .filter((item) => String(item?.shopId || "").trim() === shopId)
    .map((item) => {
      const exactShopSku = sku && String(item.shopSku || item.offerId || "").trim().toLowerCase() === sku;
      const exactVendorCode = sku && String(item.vendorCode || "").trim().toLowerCase() === sku;
      const haystack = `${item.name || ""} ${item.shopSku || ""} ${item.offerId || ""} ${item.vendorCode || ""} ${item.marketSku || ""}`.toLowerCase();
      const keywordHit = tokens.length ? tokens.every((token) => haystack.includes(token)) : true;
      const titleHit = title && String(item.name || "").trim().toLowerCase().includes(title) ? 1 : 0;
      const score = (exactShopSku ? 100 : 0) + (exactVendorCode ? 90 : 0) + (titleHit ? 10 : 0);
      return { item, keywordHit, score };
    })
    .filter((entry) => entry.keywordHit)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.item.name || "").localeCompare(String(right.item.name || ""), "zh-CN");
    });
}

function hasPurchaseInfo(order) {
  return Boolean(
    order?.purchaseOrderNo ||
      order?.purchasePlatform ||
      order?.purchasePriceRmb ||
      order?.purchasePriceRub ||
      order?.purchaseLink ||
      order?.purchaseExpressNo ||
      order?.purchaseIntlNo
  );
}

function setOrdersPurchaseImportMessage(message, ok = true) {
  if (!ordersPurchaseImportMessage) return;
  ordersPurchaseImportMessage.style.color = ok ? "#1d6f3a" : "#c02030";
  ordersPurchaseImportMessage.textContent = message;
}

function openOrdersPurchaseImportModal() {
  if (!ordersPurchaseImportModalMask) return;
  if (ordersPurchaseImportForm) ordersPurchaseImportForm.reset();
  setOrdersPurchaseImportMessage("下载模板填写后导入；留空的列保持订单原值不变。", true);
  ordersPurchaseImportModalMask.classList.remove("hidden");
}

function closeOrdersPurchaseImportModal() {
  if (ordersPurchaseImportModalMask) ordersPurchaseImportModalMask.classList.add("hidden");
}

function onOrdersPurchaseImportMaskClick(event) {
  if (event.target === ordersPurchaseImportModalMask) closeOrdersPurchaseImportModal();
}

async function onDownloadOrdersPurchaseTemplate() {
  const result = await fetchBinary("/api/orders/purchase-template");
  if (!result.ok) {
    setOrdersPurchaseImportMessage(result.error || "模板下载失败", false);
    return;
  }
  downloadBlob(result.blob, result.filename || "purchase-import-template.xlsx");
  setOrdersPurchaseImportMessage("模板已下载", true);
}

async function onExportUnpurchasedOrders() {
  const result = await fetchBinary("/api/orders/purchase-export");
  if (!result.ok) {
    setOrdersPurchaseImportMessage(result.error || "导出未采购订单失败", false);
    return;
  }
  downloadBlob(result.blob, result.filename || "unpurchased-orders.xlsx");
  setOrdersPurchaseImportMessage("未采购订单已导出，填好采购列后再导入即可", true);
}

async function onOrdersPurchaseImportSubmit(event) {
  event.preventDefault();
  const file = ordersPurchaseFileInput?.files?.[0] || null;
  if (!file) {
    setOrdersPurchaseImportMessage("请先选择要导入的 Excel 文件", false);
    return;
  }
  if (ordersPurchaseSubmitBtn) ordersPurchaseSubmitBtn.disabled = true;
  setOrdersPurchaseImportMessage("正在导入采购信息...", true);
  let result;
  try {
    const response = await fetch("/api/orders/purchase-import", {
      method: "POST",
      headers: {
        "X-File-Name": encodeURIComponent(file.name || "purchase-import.xlsx"),
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    });
    const data = await response.json().catch(() => ({}));
    result = { ok: response.ok, status: response.status, data, error: data.message || `HTTP ${response.status}` };
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  }
  if (ordersPurchaseSubmitBtn) ordersPurchaseSubmitBtn.disabled = false;
  if (!result.ok) {
    setOrdersPurchaseImportMessage(result.error || "导入失败", false);
    return;
  }
  const data = result.data || {};
  const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
  const failedLines = (Array.isArray(data.errors) ? data.errors : [])
    .slice(0, 5)
    .map((entry) => `第${entry.row || "?"}行: ${entry.message || "失败"}`)
    .join("；");
  const summary = `导入完成：更新 ${Number(data.updated || 0)} 条，跳过 ${Number(data.skipped || 0)} 条${errorCount ? `，失败 ${errorCount} 条` : ""}${failedLines ? `（${failedLines}）` : ""}`;
  setOrdersPurchaseImportMessage(summary, errorCount === 0);
  if (ordersPurchaseFileInput) ordersPurchaseFileInput.value = "";
  await loadOrders();
}

function getPurchaseTimestamp(order) {
  return new Date(order?.purchaseUpdatedAt || order?.updatedAt || order?.sellerOrderAt || order?.createdAt || 0).getTime();
}

function onBatchPurchaseClick() {
  const selected = (state.selectedOrderIds || []).map(String);
  if (!selected.length) {
    orderMessage.textContent = "请先选择订单";
    return;
  }
  const orders = getSelectedOrders();
  if (!orders.length) {
    orderMessage.textContent = "未找到选中的订单";
    return;
  }
  openBatchPurchaseModal(orders);
}

async function voidOrder(order) {
  if (!order) return;
  if (orderMessage) {
    orderMessage.style.color = "#1f2b3b";
    orderMessage.textContent = "正在作废订单...";
  }
  const result = await apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/void`, { method: "POST" });
  if (!result.ok) {
    if (orderMessage) {
      orderMessage.style.color = "#c02030";
      orderMessage.textContent = result.error || "订单作废失败";
    }
    return;
  }
  if (orderMessage) {
    orderMessage.style.color = "#1d6f3a";
    orderMessage.textContent = "订单已作废";
  }
  await loadOrders();
}

function onSyncLabels() {
  const selected = (state.selectedOrderIds || []).map(String);
  if (!selected.length) {
    orderMessage.textContent = "请先选择订单";
    return;
  }
  const orders = getSelectedOrders();
  if (!orders.length) {
    orderMessage.textContent = "未找到选中的订单";
    return;
  }
  const yandexOrders = orders.filter(isYandexOrder);
  if (!yandexOrders.length) {
    orderMessage.textContent = "选中的订单不支持面单";
    return;
  }
  orderMessage.textContent = `正在保存面单 (${yandexOrders.length})...`;
  saveLabelsSequentially(yandexOrders, { silent: true }).then(({ success, failed, skipped }) => {
    orderMessage.textContent = `面单保存完成：成功 ${success}${skipped ? `，跳过 ${skipped}` : ""}${failed ? `，失败 ${failed}` : ""}`;
  });
}

async function onPrintLabels() {
  const selected = (state.selectedOrderIds || []).map(String);
  if (!selected.length) {
    orderMessage.textContent = "请先选择订单";
    return;
  }
  const orders = getSelectedOrders();
  if (!orders.length) {
    orderMessage.textContent = "未找到选中的订单";
    return;
  }
  const yandexOrders = orders.filter(isYandexOrder);
  if (!yandexOrders.length) {
    orderMessage.textContent = "选中的订单不支持面单";
    return;
  }
  const skipped = orders.length - yandexOrders.length;
  orderMessage.textContent = `正在保存面单 (${yandexOrders.length})...`;
  const { success, failed, skipped: labelSkipped } = await saveLabelsSequentially(yandexOrders, { silent: true });
  if (success === 0 && labelSkipped === 0) {
    orderMessage.textContent = failed ? `面单保存失败（失败 ${failed}）` : "没有可用面单";
    return;
  }
  orderMessage.textContent = `面单准备完成：新增 ${success}${labelSkipped ? `，复用已同步 ${labelSkipped}` : ""}${failed ? `，失败 ${failed}` : ""}，正在合并...${skipped ? `（非Yandex跳过 ${skipped}）` : ""}`;
  downloadMergedLabels(yandexOrders);
}

async function downloadMergedLabels(orders) {
  const orderIds = orders.map((o) => getOrderRequestRef(o)).filter(Boolean);
  const result = await fetchBinary("/api/orders/labels/merge", {
    method: "POST",
    body: JSON.stringify({ orderIds })
  });
  if (!result.ok) {
    orderMessage.textContent = result.error || "合并失败";
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const win = window.open(url, "_blank");
  if (!win) {
    orderMessage.textContent = "无法打开新窗口，请检查浏览器拦截";
    return;
  }
  win.focus();
  const cleanup = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  };
  try {
    win.addEventListener("beforeunload", cleanup, { once: true });
  } catch {}
  setTimeout(() => {
    try {
      win.print();
    } catch {}
    setTimeout(cleanup, 10 * 60 * 1000);
  }, 300);
  orderMessage.textContent = "已打开打印页面";
}

async function saveLabelsSequentially(orders, options = {}) {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const order of orders) {
    const state = await saveOrderLabel(order, options);
    if (state === "saved") success += 1;
    else if (state === "skipped") skipped += 1;
    else failed += 1;
  }
  return { success, failed, skipped };
}

async function saveOrderLabel(order, options = {}) {
  if (!order?.id) return "failed";
  if (order.labelData) {
    if (!options.silent) orderMessage.textContent = "该订单面单已同步，已跳过";
    return "skipped";
  }
  const result = await apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/labels/save?format=A4`, { method: "POST" });
  if (!result.ok) {
    if (result.status === 409) return "skipped";
    if (!options.silent) {
      orderMessage.textContent = result.error || "面单保存失败";
    }
    return "failed";
  }
  if (!options.silent) {
    orderMessage.textContent = "面单已保存";
  }
  return "saved";
}

async function openOrderLabelForPrint(order) {
  if (!order?.id) return;
  const result = await fetchBinary(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/labels/print`);
  if (!result.ok) {
    orderMessage.textContent = result.error || "面单未保存";
    return;
  }
  const url = URL.createObjectURL(result.blob);
  const win = window.open(url, "_blank");
  if (!win) {
    orderMessage.textContent = "无法打开新窗口，请检查浏览器拦截";
    return;
  }
  win.focus();
  const cleanup = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  };
  try {
    win.addEventListener("beforeunload", cleanup, { once: true });
  } catch {}
  setTimeout(() => {
    try {
      win.print();
    } catch {}
    setTimeout(cleanup, 10 * 60 * 1000);
  }, 300);
  orderMessage.textContent = "已打开打印页面";
}

function mapOrderStatusLabel(status) {
  if (status === "shipped") return "已发货";
  if (status === "cancelled") return "作废";
  return "未处理";
}

function filterOrdersByPlatform(orders, platform) {
  if (platform === "all") return orders;
  return orders.filter((order) => {
    const provider = String(order.provider || order.platform || "").toLowerCase();
    if (platform === "yandex") return provider.includes("yandex");
    if (platform === "ozon") return provider.includes("ozon");
    return provider && !provider.includes("yandex") && !provider.includes("ozon");
  });
}

function openOrderRemarkModal(order) {
  if (!orderRemarkModalMask || !order) return;
  activeRemarkOrderId = String(order.id || "");
  if (orderRemarkText) orderRemarkText.value = order.remark || "";
  if (orderRemarkMessage) orderRemarkMessage.textContent = "";
  orderRemarkModalMask.classList.remove("hidden");
}

function closeOrderRemarkModal() {
  if (orderRemarkModalMask) orderRemarkModalMask.classList.add("hidden");
  activeRemarkOrderId = "";
}

function onOrderRemarkMaskClick(event) {
  if (event.target === orderRemarkModalMask) closeOrderRemarkModal();
}

function onOrderRemarkSubmit(event) {
  event.preventDefault();
  const order = state.orders.find((item) => String(item.id) === activeRemarkOrderId);
  if (!order) {
    if (orderRemarkMessage) orderRemarkMessage.textContent = "订单不存在";
    return;
  }
  const payload = {
    remark: String(orderRemarkText?.value || "").trim()
  };
  orderRemarkMessage.textContent = "";
  apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/remark`, { method: "PUT", body: JSON.stringify(payload) })
    .then((result) => {
      if (!result.ok) {
        if (orderRemarkMessage) {
          orderRemarkMessage.style.color = "#c02030";
          orderRemarkMessage.textContent = result.error || "保存失败";
        }
        return;
      }
      const item = result.data?.item;
      if (item) {
        order.remark = item.remark || "";
      } else {
        order.remark = payload.remark;
      }
      if (orderRemarkMessage) {
        orderRemarkMessage.style.color = "#1d6f3a";
        orderRemarkMessage.textContent = "备注已保存";
      }
      orderMessage.textContent = "订单备注已保存";
      setTimeout(() => {
        closeOrderRemarkModal();
        renderOrdersTable();
      }, 300);
    })
    .catch((error) => {
      if (orderRemarkMessage) {
        orderRemarkMessage.style.color = "#c02030";
        orderRemarkMessage.textContent = String(error);
      }
    });
}

function clearPurchaseFormValues() {
  if (purchasePlatform) purchasePlatform.value = "";
  if (purchaseLink) purchaseLink.value = "";
  if (purchaseOrderNo) purchaseOrderNo.value = "";
  if (purchaseExpressNo) purchaseExpressNo.value = "";
  if (purchaseIntlNo) purchaseIntlNo.value = "";
  if (purchasePriceRmb) purchasePriceRmb.value = "";
  if (purchasePriceRub) purchasePriceRub.value = "";
}

function openPurchaseModal(order) {
  if (!purchaseModalMask || !order) return;
  isBatchPurchaseMode = false;
  activePurchaseOrderIds = [];
  activePurchaseOrderId = String(order.id || "");
  if (purchaseModalTitle) purchaseModalTitle.textContent = "采购信息";
  if (purchasePlatform) purchasePlatform.value = order.purchasePlatform || "";
  if (purchaseLink) purchaseLink.value = order.purchaseLink || "";
  if (purchaseOrderNo) purchaseOrderNo.value = order.purchaseOrderNo || "";
  if (purchaseExpressNo) purchaseExpressNo.value = order.purchaseExpressNo || "";
  if (purchaseIntlNo) purchaseIntlNo.value = order.purchaseIntlNo || "";
  if (purchasePriceRmb) purchasePriceRmb.value = order.purchasePriceRmb || "";
  if (purchasePriceRub) {
    purchasePriceRub.value = order.purchasePriceRub || "";
    delete purchasePriceRub.dataset.userEdited;
  }
  if (purchaseMessage) purchaseMessage.textContent = "";
  if (purchaseInfoPreview) {
    const image = order.imageUrl || order.image || "";
    const title = escapeHtml(order.productName || order.title || "-");
    purchaseInfoPreview.innerHTML = `
      ${image ? `<img src="${escapeHtml(safeImageUrl(image))}" alt="product" referrerpolicy="no-referrer" />` : ""}
      <div>标题: <span class="value">${title}</span></div>
      <div>SKU: <span class="value">${escapeHtml(order.shopSku || "-")}</span></div>
      <div>数量: <span class="value">${escapeHtml(String(order.itemCount || 1))}</span></div>
    `;
  }

  purchaseModalMask.classList.remove("hidden");
  if (purchasePriceRmb && purchasePriceRmb.value) {
    onPurchaseRmbInput();
  }
}

function openBatchPurchaseModal(orders) {
  if (!purchaseModalMask) return;
  const ids = orders.map((order) => String(order.id || "")).filter(Boolean);
  if (!ids.length) return;
  isBatchPurchaseMode = true;
  activePurchaseOrderIds = ids;
  activePurchaseOrderId = "";
  if (purchaseModalTitle) purchaseModalTitle.textContent = "批量采购信息";
  clearPurchaseFormValues();
  if (purchaseMessage) purchaseMessage.textContent = "";
  if (purchaseInfoPreview) {
    purchaseInfoPreview.innerHTML = `
      <div class="purchase-batch-note">
        已选 ${ids.length} 条订单，填写的信息将批量写入（空字段保持原值）。
      </div>
    `;
  }
  purchaseModalMask.classList.remove("hidden");
}

function closePurchaseModal() {
  if (purchaseModalMask) purchaseModalMask.classList.add("hidden");
  activePurchaseOrderId = "";
  activePurchaseOrderIds = [];
  isBatchPurchaseMode = false;
}

function onPurchaseModalMaskClick(event) {
  if (event.target === purchaseModalMask) closePurchaseModal();
}

function openTrackingModal(order) {
  if (!trackingModalMask || !order) return;
  if (trackingModalTitle) trackingModalTitle.textContent = "订单跟踪信息";
  if (trackingMessage) trackingMessage.textContent = "加载中...";
  if (trackingTimeline) trackingTimeline.innerHTML = "";
  if (trackingCode) trackingCode.textContent = order.trackingNo || order.trackingId || "-";
  if (trackingService) trackingService.textContent = order.logistics || order.carrier || "-";
  trackingModalMask.classList.remove("hidden");

  apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/tracking`, { method: "GET" }).then((result) => {
    if (!result.ok) {
      if (trackingMessage) trackingMessage.textContent = result.error || "获取失败";
      return;
    }
    const data = result.data || {};
    if (trackingCode) trackingCode.textContent = data.primaryTrackCode || trackingCode.textContent || "-";
    if (trackingService) trackingService.textContent = data.primaryServiceName || trackingService.textContent || "-";
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    if (!tracks.length) {
      const apiModel = String(data.fulfillmentType || "").toUpperCase();
      if (trackingMessage) {
        trackingMessage.textContent = apiModel === "FBS"
          ? "FBS 模式暂无可用轨迹（Yandex 未返回 tracks）"
          : "暂无跟踪信息";
      }
      return;
    }
    if (trackingMessage) trackingMessage.textContent = "";
    if (trackingTimeline) {
      trackingTimeline.innerHTML = tracks
        .map((track) => {
          const code = escapeHtml(track.trackCode || "");
          const service = escapeHtml(track.serviceName || track.serviceId || "");
          const status = escapeHtml(track.status || track.statusText || "");
          const time = escapeHtml(track.updatedAt || track.shipmentTime || track.shipmentDate || "");
          const extra = [service, status].filter(Boolean).join(" · ");
          return `
            <div class="tracking-item">
              <div class="tracking-main">${code || "-"}</div>
              <div class="tracking-sub">${extra || "暂无详情"}</div>
              <div class="tracking-time">${time}</div>
            </div>
          `;
        })
        .join("");
    }
  });
}

function closeTrackingModal() {
  if (trackingModalMask) trackingModalMask.classList.add("hidden");
}

function onTrackingModalMaskClick(event) {
  if (event.target === trackingModalMask) closeTrackingModal();
}

async function openOrderMatchModal(order) {
  if (!orderMatchModalMask || !order) return;
  activeOrderMatchId = getOrderRequestRef(order);
  if (orderMatchSearch) {
    orderMatchSearch.value = "";
    orderMatchSearch.placeholder = `默认按 ${order.shopSku || "SKU"} / 标题优先`;
  }
  if (orderMatchMessage) {
    orderMatchMessage.style.color = "#2f3d63";
    orderMatchMessage.textContent = "正在准备在线产品列表...";
  }
  if (orderMatchPreview) {
    const matchText = order.matchedOnlineProductName
      ? `${order.matchedOnlineProductName}${order.matchedOnlineProductSku ? ` / ${order.matchedOnlineProductSku}` : ""}`
      : "未匹配";
    orderMatchPreview.innerHTML = `
      <div>订单号: <span class="value">${escapeHtml(order.shopOrderNo || order.id || "-")}</span></div>
      <div>店铺: <span class="value">${escapeHtml(order.shopName || "-")}</span></div>
      <div>订单SKU: <span class="value">${escapeHtml(order.shopSku || "-")}</span></div>
      <div>当前匹配: <span class="value">${escapeHtml(matchText)}</span></div>
    `;
  }
  if (!state.panelLoaded.onlineProducts) {
    const ok = await loadOnlineProducts();
    state.panelLoaded.onlineProducts = Boolean(ok);
  }
  renderOrderMatchOptions();
  orderMatchModalMask.classList.remove("hidden");
}

function closeOrderMatchModal() {
  activeOrderMatchId = "";
  if (orderMatchModalMask) orderMatchModalMask.classList.add("hidden");
}

function onOrderMatchModalMaskClick(event) {
  if (event.target === orderMatchModalMask) closeOrderMatchModal();
}

function renderOrderMatchOptions() {
  if (!orderMatchProductSelect) return;
  const order = (state.orders || []).find((item) => getOrderRequestRef(item) === activeOrderMatchId);
  if (!order) {
    orderMatchProductSelect.innerHTML = "";
    if (orderMatchMessage) orderMatchMessage.textContent = "订单不存在";
    return;
  }
  const entries = getOrderMatchCandidates(order, orderMatchSearch?.value || "");
  const selectedId = String(order.matchedOnlineProductId || "").trim();
  if (!entries.length) {
    orderMatchProductSelect.innerHTML = "";
    if (orderMatchMessage) {
      orderMatchMessage.style.color = "#b45c00";
      orderMatchMessage.textContent = "当前店铺下没有可匹配的在线产品";
    }
    return;
  }
  orderMatchProductSelect.innerHTML = entries
    .slice(0, 200)
    .map(({ item, score }) => {
      const itemId = String(item.id || "").trim();
      const selected = itemId === selectedId ? "selected" : "";
      const title = String(item.name || "-").trim();
      const sku = String(item.shopSku || item.offerId || item.vendorCode || "-").trim();
      const label = `${title} / ${sku}${score > 0 ? ` / 优先级 ${score}` : ""}`;
      return `<option value="${escapeHtml(itemId)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  if (!orderMatchProductSelect.value && entries[0]?.item?.id) {
    orderMatchProductSelect.value = String(entries[0].item.id);
  }
  if (orderMatchMessage) {
    orderMatchMessage.style.color = "#2f3d63";
    orderMatchMessage.textContent = `当前店铺共 ${entries.length} 个候选产品`;
  }
}

async function saveOrderMatch(productId = "") {
  const order = (state.orders || []).find((item) => getOrderRequestRef(item) === activeOrderMatchId);
  if (!order) {
    if (orderMatchMessage) {
      orderMatchMessage.style.color = "#c02030";
      orderMatchMessage.textContent = "订单不存在";
    }
    return;
  }
  if (orderMatchMessage) {
    orderMatchMessage.style.color = "#2f3d63";
    orderMatchMessage.textContent = "正在保存匹配...";
  }
  const result = await apiRequest(`/api/orders/${encodeURIComponent(activeOrderMatchId)}/match-product`, {
    method: "PUT",
    body: JSON.stringify({ productId })
  });
  if (!result.ok) {
    if (orderMatchMessage) {
      orderMatchMessage.style.color = "#c02030";
      orderMatchMessage.textContent = result.error || "保存匹配失败";
    }
    return;
  }
  const updated = normalizeOrderForView(result.data?.item || {});
  state.orders = (state.orders || []).map((item) => (getOrderRequestRef(item) === activeOrderMatchId ? { ...item, ...updated } : item));
  refreshOrderProfitData();
  applyFiltersAndRender();
  buildFinancePurchaseView();
  buildFinanceProfitView();
  closeOrderMatchModal();
  if (orderMessage) {
    orderMessage.style.color = "#1d6f3a";
    orderMessage.textContent = productId ? "订单匹配已保存" : "订单匹配已清空";
  }
}

async function onOrderMatchSubmit(event) {
  event.preventDefault();
  if (!orderMatchProductSelect) return;
  const productId = String(orderMatchProductSelect.value || "").trim();
  if (!productId) {
    if (orderMatchMessage) {
      orderMatchMessage.style.color = "#c02030";
      orderMatchMessage.textContent = "请先选择一个在线产品";
    }
    return;
  }
  await saveOrderMatch(productId);
}

async function onOrderMatchClear() {
  await saveOrderMatch("");
}

function onTrackingModalEscClose(event) {
  if (event.key === "Escape" && trackingModalMask && !trackingModalMask.classList.contains("hidden")) {
    closeTrackingModal();
  }
}

async function onPurchaseSubmit(event) {
  event.preventDefault();
  if (isBatchPurchaseMode) {
    const selected = (activePurchaseOrderIds || []).map(String);
    if (!selected.length) {
      if (purchaseMessage) purchaseMessage.textContent = "请先选择订单";
      return;
    }

    const input = {
      purchasePlatform: String(purchasePlatform?.value || "").trim(),
      purchaseLink: String(purchaseLink?.value || "").trim(),
      purchaseOrderNo: String(purchaseOrderNo?.value || "").trim(),
      purchaseExpressNo: String(purchaseExpressNo?.value || "").trim(),
      purchaseIntlNo: String(purchaseIntlNo?.value || "").trim(),
      purchasePriceRmb: String(purchasePriceRmb?.value || "").trim(),
      purchasePriceRub: String(purchasePriceRub?.value || "").trim()
    };
    const hasAny = Object.values(input).some((value) => value);
    if (!hasAny) {
      if (purchaseMessage) purchaseMessage.textContent = "请至少填写一项采购信息";
      return;
    }

    const orders = state.orders.filter((item) => selected.includes(String(item.id)));
    if (!orders.length) {
      if (purchaseMessage) purchaseMessage.textContent = "未找到选中的订单";
      return;
    }

    if (purchaseMessage) {
      purchaseMessage.style.color = "#1f2b3b";
      purchaseMessage.textContent = `正在批量保存 (${orders.length})...`;
    }
    let success = 0;
    let failed = 0;
    let deferredSaved = 0;
    for (const order of orders) {
      const payload = {
        purchasePlatform: input.purchasePlatform || order.purchasePlatform || "",
        purchaseLink: input.purchaseLink || order.purchaseLink || "",
        purchaseOrderNo: input.purchaseOrderNo || order.purchaseOrderNo || "",
        purchaseExpressNo: input.purchaseExpressNo || order.purchaseExpressNo || "",
        purchaseIntlNo: input.purchaseIntlNo || order.purchaseIntlNo || "",
        purchasePriceRmb: input.purchasePriceRmb || order.purchasePriceRmb || "",
        purchasePriceRub: input.purchasePriceRub || order.purchasePriceRub || "",
        purchaseUpdatedAt: new Date().toISOString()
      };
      try {
        const result = await apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/purchase`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        if (!result.ok) {
          failed += 1;
          continue;
        }
        const updated = result.data?.item;
        Object.assign(order, updated || payload);
        if (result.data?.deferred) {
          deferredSaved += 1;
        }
        success += 1;
      } catch {
        failed += 1;
      }
    }

    refreshOrderProfitData();
    buildFinancePurchaseView();
    buildFinanceProfitView();
    const summary = `批量保存完成：成功 ${success}，失败 ${failed}${deferredSaved ? `（后端暂存 ${deferredSaved}）` : ""}`;
    if (purchaseMessage) {
      purchaseMessage.style.color = failed > 0 ? "#c02030" : deferredSaved > 0 ? "#b45c00" : "#1d6f3a";
      purchaseMessage.textContent = summary;
    }
    if (orderMessage) orderMessage.textContent = summary;
    setTimeout(() => {
      closePurchaseModal();
      renderOrdersTable();
    }, 400);
    return;
  }

  const order = state.orders.find((item) => String(item.id) === activePurchaseOrderId);
  if (!order) {
    if (purchaseMessage) purchaseMessage.textContent = "订单不存在";
    return;
  }

  const payload = {
    purchasePlatform: String(purchasePlatform?.value || "").trim(),
    purchaseLink: String(purchaseLink?.value || "").trim(),
    purchaseOrderNo: String(purchaseOrderNo?.value || "").trim(),
    purchaseExpressNo: String(purchaseExpressNo?.value || "").trim(),
    purchaseIntlNo: String(purchaseIntlNo?.value || "").trim(),
    purchasePriceRmb: String(purchasePriceRmb?.value || "").trim(),
    purchasePriceRub: String(purchasePriceRub?.value || "").trim(),
    purchaseUpdatedAt: new Date().toISOString()
  };

  try {
    const result = await apiRequest(`/api/orders/${encodeURIComponent(getOrderRequestRef(order))}/purchase`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    if (!result.ok) {
      if (purchaseMessage) {
        purchaseMessage.style.color = "#c02030";
        purchaseMessage.textContent = result.error || "保存失败";
      }
      return;
    }
    const updated = result.data?.item;
    if (updated) {
      Object.assign(order, updated);
    } else {
      Object.assign(order, payload);
    }
    refreshOrderProfitData();
    buildFinancePurchaseView();
    buildFinanceProfitView();
    if (purchaseMessage) {
      purchaseMessage.style.color = result.data?.deferred ? "#b45c00" : "#1d6f3a";
      purchaseMessage.textContent = result.data?.deferred ? "采购信息已暂存到后端，待订单同步后自动挂回" : "采购信息已写入后端";
    }
    setTimeout(() => {
      closePurchaseModal();
      renderOrdersTable();
    }, 300);
  } catch (error) {
    if (purchaseMessage) {
      purchaseMessage.style.color = "#c02030";
      purchaseMessage.textContent = String(error);
    }
  }
}

async function onPurchaseRmbInput() {
  if (!purchasePriceRmb || !purchasePriceRub) return;
  const raw = String(purchasePriceRmb.value || "").replace(",", ".");
  const rmb = Number(raw);
  if (!Number.isFinite(rmb)) {
    if (purchasePriceRub.dataset.userEdited !== "1") purchasePriceRub.value = "";
    return;
  }
  if (purchasePriceRub.dataset.userEdited === "1") return;

  const rate = await getCbrRateCny();
  if (!rate) return;
  const rub = rmb * rate;
  purchasePriceRub.value = rub.toFixed(2);
}

// 从 app.js 拆出的订单同步弹窗与单订单同步逻辑。

function getOrderSyncNumber(order) {
  const directOrderNo = String(
    order?.shopOrderNo ||
      order?.shopOrderId ||
      order?.externalOrderId ||
      order?.orderNo ||
      order?.orderId ||
      ""
  ).trim();
  if (directOrderNo) return directOrderNo;

  const rawId = String(order?.id || "").trim();
  if (!rawId) return "";
  if (/^ORD-YM-/i.test(rawId)) return "";
  return rawId;
}

function onOrderImageLoadError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches('img[data-action="preview-image"]')) return;
  const wrap = image.closest(".order-product-image-wrap");
  if (!wrap || wrap.querySelector(".order-image-placeholder")) return;
  const placeholder = document.createElement("div");
  placeholder.className = "order-image-placeholder";
  placeholder.setAttribute("aria-label", "商品图片加载失败");
  placeholder.textContent = "图片不可用";
  image.replaceWith(placeholder);
}

async function onOrdersListClick(event) {
  const previewImg = event.target.closest("img[data-action=\"preview-image\"]");
  if (previewImg) {
    const src = previewImg.getAttribute("src");
    if (src) openImagePreview(src);
    return;
  }
  const button = event.target.closest("button[data-action]");
  const card = event.target.closest(".order-card");
  if (!card) return;
  const orderId = card.dataset.orderId;
  const order = state.orders.find((item) => getOrderRequestRef(item) === String(orderId));
  if (!order) return;

  if (!button) return;
  const action = button.dataset.action;
  if (action === "purchase-info") {
    openPurchaseModal(order);
    return;
  }
  if (action === "match-product") {
    openOrderMatchModal(order);
    return;
  }
  if (action === "sync-order") {
    onSyncOrders(order);
    return;
  }
  if (action === "remark") {
    openOrderRemarkModal(order);
    return;
  }
  if (action === "void") {
    voidOrder(order);
    return;
  }
  if (action === "tracking") {
    openTrackingModal(order);
    return;
  }
  if (action === "profit-detail") {
    openProfitDetailModal(order, String(button.dataset.profitCurrency || "rmb").trim().toLowerCase());
    return;
  }
  if (action === "sync-label") {
    saveOrderLabel(order);
    return;
  }
  if (action === "print") {
    openOrderLabelForPrint(order);
  }
}

function onOrdersListChange(event) {
  const checkbox = event.target.closest("input[type='checkbox'][data-order-check]");
  if (!checkbox) return;
  const orderId = String(checkbox.getAttribute("data-order-check") || "");
  if (!orderId) return;
  if (checkbox.checked) {
    if (!state.selectedOrderIds.includes(orderId)) state.selectedOrderIds.push(orderId);
    const order = state.orders.find((o) => String(o.id) === orderId);
    if (order && !state.selectedOrdersById.has(orderId)) state.selectedOrdersById.set(orderId, order);
  } else {
    state.selectedOrderIds = state.selectedOrderIds.filter((id) => id !== orderId);
    state.selectedOrdersById.delete(orderId);
  }
  syncOrderSelectionUi();
}

function getSelectedOrders() {
  if (!state.selectedOrdersById) state.selectedOrdersById = new Map();
  const selected = (state.selectedOrderIds || []).map(String);
  const resolved = [];
  for (const id of selected) {
    const stored = state.selectedOrdersById.get(id);
    if (stored) {
      resolved.push(stored);
      continue;
    }
    const live = state.orders.find((o) => String(o.id) === id);
    if (live) {
      resolved.push(live);
      state.selectedOrdersById.set(id, live);
    }
  }
  return resolved;
}

function isYandexOrder(order) {
  const provider = String(order?.provider || "").toLowerCase();
  const platform = String(order?.platform || "").toLowerCase();
  return provider.includes("yandex") || platform.includes("yandex");
}

function buildSingleOrderSyncPayload(order) {
  const shopId = String(order?.shopId || "").trim();
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 7);

  const earliestFrom = new Date(now);
  earliestFrom.setDate(earliestFrom.getDate() - 7);

  const orderDate = new Date(order?.sellerOrderAt || order?.createdAt || order?.updatedAt || "");
  let fromDate = defaultFrom;
  if (!Number.isNaN(orderDate.getTime())) {
    const candidate = new Date(orderDate);
    candidate.setDate(candidate.getDate() - 1);
    fromDate = candidate < earliestFrom ? earliestFrom : candidate;
  }

  // Pass the exact order number so the backend fetches only this order's
  // detail instead of syncing the whole shop over a date range.
  const shopOrderNo = String(getOrderSyncNumber(order) || "").trim();

  return {
    shopIds: shopId ? [shopId] : [],
    orderNos: shopOrderNo ? [shopOrderNo] : [],
    fromDate: formatDateInputValue(fromDate),
    toDate: formatDateInputValue(now)
  };
}

function extractShopOptionsForOrderSync() {
  const source = (state.shops || []).length
    ? (state.shops || [])
        .filter((shop) => String(shop?.provider || "").toLowerCase() === "yandex_market" && Boolean(shop?.enabled))
        .map((shop) => ({
          id: String(shop.id || "").trim(),
          name: String(shop.name || shop.id || "").trim()
        }))
    : (state.orders || [])
        .filter((order) => isYandexOrder(order))
        .map((order) => ({
          id: String(order.shopId || "").trim(),
          name: String(order.shopName || order.shopId || "").trim()
        }));
  const seen = new Set();
  return source.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function renderOrderSyncShopOptions() {
  if (!orderSyncShopSelect) return;
  const current = String(orderSyncShopSelect.value || "").trim();
  const options = extractShopOptionsForOrderSync()
    .map((shop) => {
      const selected = shop.id === current ? "selected" : "";
      return `<option value="${escapeHtml(shop.id)}" ${selected}>${escapeHtml(shop.name || shop.id)}</option>`;
    })
    .join("");
  orderSyncShopSelect.innerHTML = `<option value="">全部已启用店铺</option>${options}`;
  if (current) orderSyncShopSelect.value = current;
}

function updateGlobalSyncStatus(running, message = "") {
  state.orderSync.running = Boolean(running);
  state.orderSync.message = String(message || "").trim();
  state.orderSync.updatedAt = new Date().toISOString();
  if (!globalSyncStatusBar || !globalSyncStatusText) return;
  globalSyncStatusBar.classList.toggle("hidden", !state.orderSync.running && !state.orderSync.message);
  globalSyncStatusBar.classList.toggle("running", state.orderSync.running);
  globalSyncStatusBar.classList.toggle("done", !state.orderSync.running && Boolean(state.orderSync.message));
  globalSyncStatusText.textContent = state.orderSync.message || "订单同步状态";
}

function showOrderSyncRunning(message) {
  updateGlobalSyncStatus(true, message || "订单同步中...");
}

function showOrderSyncDone(message) {
  updateGlobalSyncStatus(false, message || "订单同步完成");
}

function getActivePanelId() {
  return String(localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY) || "reportsPanel").trim() || "reportsPanel";
}

function scheduleOrdersPanelRefresh(delay = 500) {
  if (ordersPanelRefreshTimer) {
    clearTimeout(ordersPanelRefreshTimer);
  }
  ordersPanelRefreshTimer = setTimeout(async () => {
    ordersPanelRefreshTimer = null;
    const activePanelId = getActivePanelId();
    if (activePanelId !== "ordersPanel" && activePanelId !== "ordersV2Panel") return;
    const workspaceLoaded = state.orderWorkspace === "v2" ? state.panelLoaded.ordersV2 : state.panelLoaded.orders;
    if (workspaceLoaded) await loadOrders();
  }, delay);
}

function openOrderSyncModal(seedOrder = null) {
  renderOrderSyncShopOptions();
  const syncOrderNo = String(seedOrder?.shopOrderNo || "").trim();
  const syncShopId = String(seedOrder?.shopId || "").trim();
  orderSyncSubmitting = false;
  if (orderSyncFromDate && !orderSyncFromDate.value) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    orderSyncFromDate.value = formatDateInputValue(start);
  }
  if (orderSyncToDate && !orderSyncToDate.value) {
    orderSyncToDate.value = formatDateInputValue(new Date());
  }
  if (orderSyncModalMessage) {
    orderSyncModalMessage.style.color = "#5f7390";
    orderSyncModalMessage.textContent = "";
  }
  if (orderSyncOrderNos) {
    orderSyncOrderNos.value = syncOrderNo;
  }
  if (orderSyncShopSelect) {
    orderSyncShopSelect.value = syncShopId;
  }
  if (submitOrderSyncBtn) {
    submitOrderSyncBtn.disabled = false;
    submitOrderSyncBtn.textContent = "开始同步";
  }
  if (orderSyncModalMask) orderSyncModalMask.classList.remove("hidden");
}

function closeOrderSyncModal() {
  if (orderSyncModalMask) orderSyncModalMask.classList.add("hidden");
}

function onOrderSyncModalMaskClick(event) {
  if (event.target === orderSyncModalMask) closeOrderSyncModal();
}

function parseOrderSyncNumbers(raw) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(/[\s,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

async function syncSingleOrder(order) {
  const shopOrderNo = getOrderSyncNumber(order);
  const orderRef = getOrderRequestRef(order);
  const syncPayload = buildSingleOrderSyncPayload(order);
  const scopeLabel = shopOrderNo || String(order?.shopName || order?.shopId || "当前订单").trim();
  const syncTargetLabel = syncPayload.shopIds.length ? `店铺 ${scopeLabel}` : "系统订单";
  if (syncingSingleOrderRefs.has(orderRef)) {
    orderMessage.style.color = "#b45c00";
    orderMessage.textContent = `${syncTargetLabel} 正在同步中，请稍候`;
    return;
  }

  syncingSingleOrderRefs.add(orderRef);
  renderOrdersTable();
  orderMessage.style.color = "#1f2b3b";
  orderMessage.textContent = `正在从系统拉取 ${syncTargetLabel}...`;
  showOrderSyncRunning(`${syncTargetLabel} 正在同步中...`);
  try {
    const result = await apiRequest("/api/orders/sync", {
      method: "POST",
      body: JSON.stringify(syncPayload)
    });
    if (!result.ok) {
      orderMessage.style.color = "#c02030";
      orderMessage.textContent = result.error || `${syncTargetLabel} 同步失败`;
      return;
    }

    const added = result.data?.added ?? 0;
    const updated = result.data?.updated ?? 0;
    const skipped = result.data?.skipped ?? 0;
    const errors = Array.isArray(result.data?.errors) ? result.data.errors : [];
    const errorText = errors.length
      ? `，失败: ${errors
          .slice(0, 3)
          .map((e) => e.message)
          .filter(Boolean)
          .join("；")}${errors.length > 3 ? "..." : ""}`
      : "";
    orderMessage.style.color = errors.length ? "#b45c00" : "#1d6f3a";
    orderMessage.textContent = `${syncTargetLabel} 同步完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}${errorText}`;
    showOrderSyncDone(`${syncTargetLabel} 同步完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}`);
    await loadOrders();
    if (getActivePanelId() !== "ordersPanel") {
      scheduleOrdersPanelRefresh();
    }
  } finally {
    syncingSingleOrderRefs.delete(orderRef);
    renderOrdersTable();
  }
}

function onSyncOrders(order = null) {
  if (order) {
    openOrderSyncModal(order);
    return;
  }
  openOrderSyncModal();
}

async function onOrderSyncSubmit(event) {
  event.preventDefault();
  if (orderSyncSubmitting) {
    orderMessage.style.color = "#b45c00";
    orderMessage.textContent = "已有同步任务正在提交，请稍候";
    return;
  }
  const fromDate = String(orderSyncFromDate?.value || "").trim();
  const toDate = String(orderSyncToDate?.value || "").trim();
  const shopId = String(orderSyncShopSelect?.value || "").trim();
  const orderNos = parseOrderSyncNumbers(orderSyncOrderNos?.value || "");
  if (fromDate && toDate && fromDate > toDate) {
    if (orderSyncModalMessage) {
      orderSyncModalMessage.style.color = "#c02030";
      orderSyncModalMessage.textContent = "开始日期不能晚于结束日期";
    }
    return;
  }
  if (!orderNos.length && (!fromDate || !toDate)) {
    if (orderSyncModalMessage) {
      orderSyncModalMessage.style.color = "#c02030";
      orderSyncModalMessage.textContent = "请填写时间区间，或输入指定订单号";
    }
    return;
  }
  orderMessage.style.color = "#1f2b3b";
  orderMessage.textContent = "正在同步店铺订单...";
  showOrderSyncRunning("店铺订单同步中...");
  if (orderSyncModalMessage) {
    orderSyncModalMessage.style.color = "#1f2b3b";
    orderSyncModalMessage.textContent = "正在提交同步任务...";
  }
  orderSyncSubmitting = true;
  if (submitOrderSyncBtn) {
    submitOrderSyncBtn.disabled = true;
    submitOrderSyncBtn.textContent = "同步中...";
  }
  closeOrderSyncModal();
  try {
    const result = await apiRequest("/api/orders/sync", {
      method: "POST",
      body: JSON.stringify({
        fromDate,
        toDate,
        shopIds: shopId ? [shopId] : [],
        orderNos
      })
    });
    if (!result.ok) {
      const rawError = String(result.error || "同步失败").trim();
      const isAlreadyRunning = /order sync already running/i.test(rawError);
      orderMessage.style.color = isAlreadyRunning ? "#b45c00" : "#c02030";
      orderMessage.textContent = isAlreadyRunning ? "已有订单同步任务正在执行，请稍候再试" : rawError;
      showOrderSyncDone(isAlreadyRunning ? "已有订单同步任务正在执行，请稍候再试" : `订单同步失败：${rawError}`);
      if (orderSyncModalMessage) {
        orderSyncModalMessage.style.color = isAlreadyRunning ? "#b45c00" : "#c02030";
        orderSyncModalMessage.textContent = isAlreadyRunning ? "已有订单同步任务正在执行，请稍候再试" : rawError;
      }
      return;
    }
    const added = result.data?.added ?? 0;
    const updated = result.data?.updated ?? 0;
    const skipped = result.data?.skipped ?? 0;
    const total = result.data?.totalShops ?? 0;
    const errors = Array.isArray(result.data?.errors) ? result.data.errors : [];
    const errorText = errors.length
      ? ` | 失败原因: ${errors
          .slice(0, 5)
          .map((e) => e.message)
          .filter(Boolean)
          .join("；")}${errors.length > 5 ? "..." : ""}`
      : "";
    orderMessage.style.color = "#1d6f3a";
    orderMessage.textContent = `同步完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}，店铺 ${total}${errorText}`;
    showOrderSyncDone(`同步完成：新增 ${added}，更新 ${updated}，跳过 ${skipped}，店铺 ${total}`);
    if (orderSyncModalMessage) {
      orderSyncModalMessage.style.color = "#1d6f3a";
      orderSyncModalMessage.textContent = "同步完成";
    }
    closeOrderSyncModal();
    await loadOrders();
  } catch (error) {
    orderMessage.style.color = "#c02030";
    orderMessage.textContent = error?.message || "同步失败";
    showOrderSyncDone(`订单同步失败：${error?.message || "同步失败"}`);
  } finally {
    orderSyncSubmitting = false;
    if (submitOrderSyncBtn) {
      submitOrderSyncBtn.disabled = false;
      submitOrderSyncBtn.textContent = "开始同步";
    }
  }
}

// 从 app.js 迁出的订单截止倒计时逻辑。

let remainingTimer = null;

function computeRemaining(deadlineIso) {
  const deadline = new Date(deadlineIso);
  if (Number.isNaN(deadline.getTime())) return "-";
  const diff = deadline.getTime() - Date.now();
  if (diff <= 0) return "已超时";
  const minutes = Math.floor(diff / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return `${days}天 ${hours}时 ${mins}分`;
}

function updateRemainingTimes() {
  if (!ordersList) return;
  const nodes = ordersList.querySelectorAll(".remaining-time");
  nodes.forEach((node) => {
    const deadline = node.getAttribute("data-deadline") || "";
    node.textContent = deadline ? computeRemaining(deadline) : "";
  });
}

function startRemainingTicker() {
  if (remainingTimer) return;
  updateRemainingTimes();
  remainingTimer = setInterval(updateRemainingTimes, 30000);
}

function stopRemainingTicker() {
  if (remainingTimer) {
    clearInterval(remainingTimer);
    remainingTimer = null;
  }
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const syncingSingleOrderRefs = new Set();
let orderSyncSubmitting = false;
const orderFilterForm = document.getElementById("orderFilterForm");
const orderShopFilter = document.getElementById("orderShopFilter");
const resetFilterBtn = document.getElementById("resetFilterBtn");
const orderStatusMenu = document.getElementById("orderStatusMenu");
const orderMessage = document.getElementById("orderMessage");
const ordersList = document.getElementById("ordersList");
const orderSelectAll = document.getElementById("orderSelectAll");
const orderSelectedCount = document.getElementById("orderSelectedCount");
const syncOrdersBtn = document.getElementById("syncOrdersBtn");
const globalSyncStatusBar = document.getElementById("globalSyncStatusBar");
const globalSyncStatusText = document.getElementById("globalSyncStatusText");
const syncLabelsBtn = document.getElementById("syncLabelsBtn");
const printLabelsBtn = document.getElementById("printLabelsBtn");
const batchPurchaseBtn = document.getElementById("batchPurchaseBtn");
const ordersPurchaseImportBtn = document.getElementById("ordersPurchaseImportBtn");
const ordersPurchaseImportModalMask = document.getElementById("ordersPurchaseImportModalMask");
const closeOrdersPurchaseImportBtn = document.getElementById("closeOrdersPurchaseImportBtn");
const ordersPurchaseTemplateBtn = document.getElementById("ordersPurchaseTemplateBtn");
const ordersPurchaseExportBtn = document.getElementById("ordersPurchaseExportBtn");
const ordersPurchaseImportForm = document.getElementById("ordersPurchaseImportForm");
const ordersPurchaseFileInput = document.getElementById("ordersPurchaseFileInput");
const ordersPurchaseSubmitBtn = document.getElementById("ordersPurchaseSubmitBtn");
const ordersPurchaseImportMessage = document.getElementById("ordersPurchaseImportMessage");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const paginationInfo = document.getElementById("paginationInfo");
const orderSyncModalMask = document.getElementById("orderSyncModalMask");
const closeOrderSyncModalBtn = document.getElementById("closeOrderSyncModalBtn");
const cancelOrderSyncBtn = document.getElementById("cancelOrderSyncBtn");
const orderSyncForm = document.getElementById("orderSyncForm");
const orderSyncFromDate = document.getElementById("orderSyncFromDate");
const orderSyncToDate = document.getElementById("orderSyncToDate");
const orderSyncShopSelect = document.getElementById("orderSyncShopSelect");
const orderSyncOrderNos = document.getElementById("orderSyncOrderNos");
const orderSyncModalMessage = document.getElementById("orderSyncModalMessage");
const submitOrderSyncBtn = document.getElementById("submitOrderSyncBtn");
const orderRemarkModalMask = document.getElementById("orderRemarkModalMask");
const orderRemarkForm = document.getElementById("orderRemarkForm");
const orderRemarkText = document.getElementById("orderRemarkText");
const orderRemarkMessage = document.getElementById("orderRemarkMessage");
const closeOrderRemarkBtn = document.getElementById("closeOrderRemarkBtn");
let activeRemarkOrderId = "";
const purchaseModalMask = document.getElementById("purchaseModalMask");
const purchaseModalTitle = document.getElementById("purchaseModalTitle");
const closePurchaseModalBtn = document.getElementById("closePurchaseModalBtn");
const purchaseForm = document.getElementById("purchaseForm");
const purchaseMessage = document.getElementById("purchaseMessage");
const purchaseInfoPreview = document.getElementById("purchaseInfoPreview");
const purchasePlatform = document.getElementById("purchasePlatform");
const purchaseLink = document.getElementById("purchaseLink");
const purchaseOrderNo = document.getElementById("purchaseOrderNo");
const purchaseExpressNo = document.getElementById("purchaseExpressNo");
const purchaseIntlNo = document.getElementById("purchaseIntlNo");
const purchasePriceRmb = document.getElementById("purchasePriceRmb");
const purchasePriceRub = document.getElementById("purchasePriceRub");
const trackingModalMask = document.getElementById("trackingModalMask");
const trackingModalTitle = document.getElementById("trackingModalTitle");
const closeTrackingModalBtn = document.getElementById("closeTrackingModalBtn");
const trackingCode = document.getElementById("trackingCode");
const trackingService = document.getElementById("trackingService");
const trackingTimeline = document.getElementById("trackingTimeline");
const trackingMessage = document.getElementById("trackingMessage");
const orderMatchModalMask = document.getElementById("orderMatchModalMask");
const closeOrderMatchModalBtn = document.getElementById("closeOrderMatchModalBtn");
const orderMatchForm = document.getElementById("orderMatchForm");
const orderMatchSearch = document.getElementById("orderMatchSearch");
const orderMatchProductSelect = document.getElementById("orderMatchProductSelect");
const orderMatchPreview = document.getElementById("orderMatchPreview");
const orderMatchMessage = document.getElementById("orderMatchMessage");
const clearOrderMatchBtn = document.getElementById("clearOrderMatchBtn");
let activePurchaseOrderId = "";
let activePurchaseOrderIds = [];
let isBatchPurchaseMode = false;
let activeOrderMatchId = "";
let ordersPanelRefreshTimer = null;

function bindOrdersEvents() {
  if (syncOrdersBtn) syncOrdersBtn.addEventListener("click", onSyncOrders);
  if (syncLabelsBtn) syncLabelsBtn.addEventListener("click", onSyncLabels);
  if (printLabelsBtn) printLabelsBtn.addEventListener("click", onPrintLabels);
  if (batchPurchaseBtn) batchPurchaseBtn.addEventListener("click", onBatchPurchaseClick);
  if (ordersPurchaseImportBtn) ordersPurchaseImportBtn.addEventListener("click", openOrdersPurchaseImportModal);
  if (closeOrdersPurchaseImportBtn) closeOrdersPurchaseImportBtn.addEventListener("click", closeOrdersPurchaseImportModal);
  if (ordersPurchaseImportModalMask) ordersPurchaseImportModalMask.addEventListener("click", onOrdersPurchaseImportMaskClick);
  if (ordersPurchaseTemplateBtn) ordersPurchaseTemplateBtn.addEventListener("click", onDownloadOrdersPurchaseTemplate);
  if (ordersPurchaseExportBtn) ordersPurchaseExportBtn.addEventListener("click", onExportUnpurchasedOrders);
  if (ordersPurchaseImportForm) ordersPurchaseImportForm.addEventListener("submit", onOrdersPurchaseImportSubmit);
  if (orderFilterForm) orderFilterForm.addEventListener("submit", onFilterSubmit);
  if (resetFilterBtn) resetFilterBtn.addEventListener("click", onFilterReset);
  if (orderStatusMenu) orderStatusMenu.addEventListener("click", onOrderStatusMenuClick);
  if (prevPageBtn) prevPageBtn.addEventListener("click", () => changePage(state.currentPage - 1));
  if (nextPageBtn) nextPageBtn.addEventListener("click", () => changePage(state.currentPage + 1));
  if (ordersList) ordersList.addEventListener("click", onOrdersListClick);
  if (ordersList) ordersList.addEventListener("error", onOrderImageLoadError, true);
  if (ordersList) ordersList.addEventListener("change", onOrdersListChange);
  if (orderSelectAll) orderSelectAll.addEventListener("change", onOrderSelectAllChange);
  if (ordersList) ordersList.addEventListener("click", onOrderTitleToggle);
  if (closeOrderSyncModalBtn) closeOrderSyncModalBtn.addEventListener("click", closeOrderSyncModal);
  if (cancelOrderSyncBtn) cancelOrderSyncBtn.addEventListener("click", closeOrderSyncModal);
  if (orderSyncModalMask) orderSyncModalMask.addEventListener("click", onOrderSyncModalMaskClick);
  if (orderSyncForm) orderSyncForm.addEventListener("submit", onOrderSyncSubmit);
  if (closeOrderRemarkBtn) closeOrderRemarkBtn.addEventListener("click", closeOrderRemarkModal);
  if (orderRemarkModalMask) orderRemarkModalMask.addEventListener("click", onOrderRemarkMaskClick);
  if (orderRemarkForm) orderRemarkForm.addEventListener("submit", onOrderRemarkSubmit);
  if (closePurchaseModalBtn) closePurchaseModalBtn.addEventListener("click", closePurchaseModal);
  if (purchaseModalMask) purchaseModalMask.addEventListener("click", onPurchaseModalMaskClick);
  if (purchaseForm) purchaseForm.addEventListener("submit", onPurchaseSubmit);
  if (purchasePriceRmb) purchasePriceRmb.addEventListener("input", onPurchaseRmbInput);
  if (purchasePriceRub) {
  // Track manual edits so the RMB auto-conversion does not clobber a value
  // the user typed into the RUB field themselves.
  purchasePriceRub.addEventListener("input", () => {
  purchasePriceRub.dataset.userEdited = "1";
  });
  }
  if (closeTrackingModalBtn) closeTrackingModalBtn.addEventListener("click", closeTrackingModal);
  if (trackingModalMask) trackingModalMask.addEventListener("click", onTrackingModalMaskClick);
  if (closeOrderMatchModalBtn) closeOrderMatchModalBtn.addEventListener("click", closeOrderMatchModal);
  if (orderMatchModalMask) orderMatchModalMask.addEventListener("click", onOrderMatchModalMaskClick);
  if (orderMatchForm) orderMatchForm.addEventListener("submit", onOrderMatchSubmit);
  if (orderMatchSearch) orderMatchSearch.addEventListener("input", renderOrderMatchOptions);
  if (clearOrderMatchBtn) clearOrderMatchBtn.addEventListener("click", onOrderMatchClear);
  document.addEventListener("keydown", onTrackingModalEscClose);
}
