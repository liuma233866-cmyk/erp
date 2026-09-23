// 从 app.js 拆出的在线产品模块（Yandex 在线产品 + Ozon 产品，classic script，全局作用域）。



async function loadOnlineProducts(options = {}) {
  if (!can("productRead")) {
    if (onlineProductsTableBody) onlineProductsTableBody.innerHTML = "<tr><td colspan='17'>无权限查看在线产品</td></tr>";
    if (onlineProductMessage) onlineProductMessage.textContent = "无权限查看";
    return false;
  }
  if (onlineProductMessage) {
    onlineProductMessage.style.color = "#2f3d63";
    onlineProductMessage.textContent = "正在加载在线商品...";
  }
  const result = await apiRequest("/api/online-products", { method: "GET" });
  if (!result.ok) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = result.error || "在线商品加载失败";
    }
    if (onlineProductsTableBody) onlineProductsTableBody.innerHTML = "<tr><td colspan='17'>加载失败</td></tr>";
    return false;
  }
  state.onlineProducts = Array.isArray(result.data.items) ? result.data.items : [];
  state.onlineSelectedIds = [];
  state.onlineCurrentPage = 1;
  if (onlinePageSize) {
    state.onlinePageSize = Number(onlinePageSize.value || DEFAULT_ONLINE_PAGE_SIZE) || DEFAULT_ONLINE_PAGE_SIZE;
  }
  applyOnlineFilters();
  syncOnlineFilterFormFromState();
  renderOnlineSummary();
  renderOnlineProducts();
  renderOnlinePagination();
  renderOnlineShopFilterOptions();
  await loadOnlineCommissionUnmatched();
  if (!options.keepMessage && onlineProductMessage) onlineProductMessage.textContent = "";
  return true;
}

async function onSyncOnlineProducts() {
  if (!can("productSync")) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "无权限查看";
    }
    return;
  }
  if (syncOnlineProductsBtn) syncOnlineProductsBtn.disabled = true;
  if (onlineProductMessage) {
    onlineProductMessage.style.color = "#2f3d63";
    onlineProductMessage.textContent = "正在同步在线商品...";
  }
  const result = await apiRequest("/api/online-products/sync", { method: "POST" });
  if (!result.ok) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = result.error || "同步失败";
    }
    if (syncOnlineProductsBtn) syncOnlineProductsBtn.disabled = false;
    return;
  }
  const data = result.data || {};
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const unmatchedCount = Number(data.unmatchedCommissionCount || 0) || 0;
  if (onlineProductMessage) {
    if (errors.length) {
      const errorText = errors
        .map((err) => {
          if (!err) return "";
          if (typeof err === "string") return err;
          const shopText = err.shopName ? `店铺${err.shopName}` : err.shopId ? `店铺${err.shopId}` : "";
          const msg = err.message || err.error || "";
          return shopText && msg ? `${shopText}: ${msg}` : msg || shopText;
        })
        .filter(Boolean)
        .join("；");
      onlineProductMessage.style.color = "#b45c00";
      onlineProductMessage.textContent = `同步完成：新增 ${data.added || 0}，更新 ${data.updated || 0}，跳过 ${data.skipped || 0}${unmatchedCount ? `，未匹配佣金 ${unmatchedCount}` : ""}。错误：${errorText}`;
    } else {
      onlineProductMessage.style.color = "#1d6f3a";
      onlineProductMessage.textContent = `同步完成：新增 ${data.added || 0}，更新 ${data.updated || 0}，跳过 ${data.skipped || 0}${unmatchedCount ? `，未匹配佣金 ${unmatchedCount}` : ""}`;
    }
  }
  await loadOnlineProducts({ keepMessage: true });
  if (onlineProductSyncInfo) onlineProductSyncInfo.textContent = new Date().toLocaleString("zh-CN");
  if (syncOnlineProductsBtn) syncOnlineProductsBtn.disabled = false;
}

async function onRefreshCardQuality() {
  if (!refreshCardQualityBtn) return;
  if (!can("productSync")) {
    if (onlineProductMessage) onlineProductMessage.textContent = "无权刷新卡片质量";
    return;
  }
  const shops = (state.shops || []).filter((shop) => {
    const provider = String(shop?.provider || "").toLowerCase();
    return (provider === "yandex_market" || provider === "yandex") && Boolean(shop?.enabled);
  });
  if (!shops.length) {
    if (onlineProductMessage) onlineProductMessage.textContent = "没有启用的 Yandex 店铺";
    return;
  }
  refreshCardQualityBtn.disabled = true;
  const failures = [];
  let done = 0;
  for (const shop of shops) {
    if (onlineProductMessage) onlineProductMessage.textContent = `正在刷新卡片质量（${done + 1}/${shops.length}）：${shop.name || shop.id}`;
    const result = await apiRequest("/api/yandex/card-quality", {
      method: "POST",
      body: JSON.stringify({ shopId: String(shop.id || "") })
    });
    done += 1;
    if (!result.ok) failures.push(`${shop.name || shop.id}: ${result.error || "失败"}`);
  }
  refreshCardQualityBtn.disabled = false;
  loadOnlineCardQualityForPage();
  if (onlineProductMessage) {
    if (failures.length) {
      onlineProductMessage.textContent = `卡片质量刷新完成，${failures.length} 个店铺失败：${failures.join("；")}`;
    } else {
      onlineProductMessage.style.color = "#1d6f3a";
      onlineProductMessage.textContent = `卡片质量已刷新（${done} 个店铺）`;
    }
  }
}

async function loadOnlineCommissionUnmatched() {
  if (!can("productRead")) {
    state.onlineCommissionUnmatched = [];
    return;
  }
  const result = await apiRequest("/api/online-products/commission-unmatched", { method: "GET" });
  state.onlineCommissionUnmatched = result.ok && Array.isArray(result.data?.items) ? result.data.items : [];
}

function renderOnlineCommissionUnmatched() {
  if (!onlineCommissionTableBody) return;
  const items = Array.isArray(state.onlineCommissionUnmatched) ? state.onlineCommissionUnmatched : [];
  if (!items.length) {
    onlineCommissionTableBody.innerHTML = "<tr><td colspan='5'>暂无未匹配佣金商品</td></tr>";
    if (onlineCommissionMessage) {
      onlineCommissionMessage.style.color = "#1d6f3a";
      onlineCommissionMessage.textContent = "当前全部商品都已匹配佣金";
    }
    return;
  }
  onlineCommissionTableBody.innerHTML = items
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.shopName || item.shopId || "-")}</td>
        <td>${escapeHtml(item.shopSku || item.offerId || "-")}</td>
        <td title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || "-")}</td>
        <td title="${escapeHtml(item.categoryName || "")}">${escapeHtml(item.categoryName || item.categoryId || "-")}</td>
        <td title="${escapeHtml(item.reason || "")}">${escapeHtml(item.reason || "-")}</td>
      </tr>
    `)
    .join("");
  if (onlineCommissionMessage) {
    onlineCommissionMessage.style.color = "#b45c00";
    onlineCommissionMessage.textContent = `共 ${items.length} 条未匹配佣金商品`;
  }
}

async function openOnlineCommissionModal() {
  if (!onlineCommissionModalMask) return;
  if (onlineCommissionMessage) {
    onlineCommissionMessage.style.color = "#2f3d63";
    onlineCommissionMessage.textContent = "正在加载...";
  }
  await loadOnlineCommissionUnmatched();
  renderOnlineCommissionUnmatched();
  onlineCommissionModalMask.classList.remove("hidden");
}

function closeOnlineCommissionModal() {
  if (!onlineCommissionModalMask) return;
  onlineCommissionModalMask.classList.add("hidden");
}

function onOnlineCommissionMaskClick(event) {
  if (event.target === onlineCommissionModalMask) closeOnlineCommissionModal();
}

function onOnlineProductFilterSubmit(event) {
  event.preventDefault();
  state.onlineFilters = {
    ...state.onlineFilters,
    ...readOnlineFilterFormValues()
  };
  state.onlineCurrentPage = 1;
  applyOnlineFilters();
  renderOnlineStatusTabs();
  renderOnlineProducts();
  renderOnlinePagination();
}

function onOnlineProductFilterReset() {
  if (onlineProductFilterForm) onlineProductFilterForm.reset();
  state.onlineFilters = {
    shopId: "",
    title: "",
    productId: "",
    shopSku: "",
    marketSku: "",
    brand: "",
    vendorCode: "",
    categoryId: "",
    status: "",
    statusGroup: "all"
  };
  state.onlineCurrentPage = 1;
  applyOnlineFilters();
  saveOnlineFiltersToStorage(state.onlineFilters);
  renderOnlineStatusTabs();
  renderOnlineProducts();
  renderOnlinePagination();
}

function onOnlineProductFilterSave() {
  state.onlineFilters = {
    ...state.onlineFilters,
    ...readOnlineFilterFormValues()
  };
  saveOnlineFiltersToStorage(state.onlineFilters);
  if (onlineProductMessage) {
    onlineProductMessage.style.color = "#1d6f3a";
    onlineProductMessage.textContent = "筛选条件已保存";
  }
}

function readOnlineFilterFormValues() {
  const form = new FormData(onlineProductFilterForm);
  return {
    shopId: String(form.get("shopId") || "").trim(),
    title: String(form.get("title") || "").trim(),
    productId: String(form.get("productId") || "").trim(),
    shopSku: String(form.get("shopSku") || "").trim(),
    marketSku: String(form.get("marketSku") || "").trim(),
    brand: String(form.get("brand") || "").trim(),
    vendorCode: String(form.get("vendorCode") || "").trim(),
    categoryId: String(form.get("categoryId") || "").trim(),
    status: String(form.get("status") || "").trim()
  };
}

function syncOnlineFilterFormFromState() {
  if (!onlineProductFilterForm) return;
  const filterNames = ["shopId", "title", "productId", "shopSku", "marketSku", "brand", "vendorCode", "categoryId", "status"];
  for (const name of filterNames) {
    const field = onlineProductFilterForm.elements?.namedItem(name);
    if (!field) continue;
    field.value = String(state.onlineFilters?.[name] || "");
  }
}

function saveOnlineFiltersToStorage(filters) {
  try {
    const safe = {
      shopId: String(filters?.shopId || ""),
      title: String(filters?.title || ""),
      productId: String(filters?.productId || ""),
      shopSku: String(filters?.shopSku || ""),
      marketSku: String(filters?.marketSku || ""),
      brand: String(filters?.brand || ""),
      vendorCode: String(filters?.vendorCode || ""),
      categoryId: String(filters?.categoryId || ""),
      status: String(filters?.status || ""),
      statusGroup: String(filters?.statusGroup || "all")
    };
    localStorage.setItem(ONLINE_FILTERS_STORAGE_KEY, JSON.stringify(safe));
  } catch {}
}

function restoreOnlineFiltersFromStorage() {
  try {
    const raw = localStorage.getItem(ONLINE_FILTERS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.onlineFilters = {
      ...state.onlineFilters,
      shopId: String(parsed?.shopId || ""),
      title: String(parsed?.title || ""),
      productId: String(parsed?.productId || ""),
      shopSku: String(parsed?.shopSku || ""),
      marketSku: String(parsed?.marketSku || ""),
      brand: String(parsed?.brand || ""),
      vendorCode: String(parsed?.vendorCode || ""),
      categoryId: String(parsed?.categoryId || ""),
      status: String(parsed?.status || ""),
      statusGroup: String(parsed?.statusGroup || "all") || "all"
    };
  } catch {}
}

function getDefaultOnlineExportColumns() {
  return ONLINE_EXPORT_COLUMN_DEFS
    .map((item) => item.key)
    .filter((key) => !["purchaseUrl2", "collectUrl"].includes(key));
}

function saveOnlineExportColumnsToStorage(columns) {
  try {
    const valid = new Set(ONLINE_EXPORT_COLUMN_DEFS.map((item) => item.key));
    const safe = Array.isArray(columns)
      ? columns.map((key) => String(key || "").trim()).filter((key) => valid.has(key))
      : [];
    localStorage.setItem(ONLINE_EXPORT_COLUMNS_STORAGE_KEY, JSON.stringify(safe));
  } catch {}
}

function restoreOnlineExportColumnsFromStorage() {
  const fallback = getDefaultOnlineExportColumns();
  try {
    const raw = localStorage.getItem(ONLINE_EXPORT_COLUMNS_STORAGE_KEY);
    if (!raw) {
      state.onlineExportColumns = fallback;
      return;
    }
    const parsed = JSON.parse(raw);
    const valid = new Set(ONLINE_EXPORT_COLUMN_DEFS.map((item) => item.key));
    const columns = Array.isArray(parsed)
      ? parsed.map((key) => String(key || "").trim()).filter((key) => valid.has(key))
      : [];
    state.onlineExportColumns = columns.length ? columns : fallback;
  } catch {
    state.onlineExportColumns = fallback;
  }
}

function getSelectedOnlineExportColumns() {
  const valid = new Set(ONLINE_EXPORT_COLUMN_DEFS.map((item) => item.key));
  const columns = Array.isArray(state.onlineExportColumns)
    ? state.onlineExportColumns.map((key) => String(key || "").trim()).filter((key) => valid.has(key))
    : [];
  return columns.length ? columns : getDefaultOnlineExportColumns();
}

function renderOnlineExportColumns() {
  if (!onlineExportColumns) return;
  const selected = new Set(getSelectedOnlineExportColumns());
  onlineExportColumns.innerHTML = ONLINE_EXPORT_COLUMN_DEFS
    .map((item) => `
      <label class="online-export-column">
        <input type="checkbox" name="columns" value="${escapeHtml(item.key)}" ${selected.has(item.key) ? "checked" : ""} />
        <span>${escapeHtml(item.label)}</span>
      </label>
    `)
    .join("");
}

function openOnlineExportModal() {
  if (!onlineExportModalMask) return;
  const total = Array.isArray(state.onlineFilteredProducts) ? state.onlineFilteredProducts.length : 0;
  if (!total) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "当前筛选结果没有可导出的产品";
    }
    return;
  }
  if (onlineExportSummary) onlineExportSummary.textContent = `当前筛选 ${total} 条产品`;
  if (onlineExportMessage) {
    onlineExportMessage.style.color = "#2f3d63";
    onlineExportMessage.textContent = "勾选要导出的列，然后点击导出Excel";
  }
  renderOnlineExportColumns();
  onlineExportModalMask.classList.remove("hidden");
}

function closeOnlineExportModal() {
  if (!onlineExportModalMask) return;
  onlineExportModalMask.classList.add("hidden");
}

function onOnlineExportMaskClick(event) {
  if (event.target === onlineExportModalMask) closeOnlineExportModal();
}

function readOnlineExportColumnsFromForm() {
  if (!onlineExportForm) return [];
  const form = new FormData(onlineExportForm);
  return form.getAll("columns").map((key) => String(key || "").trim()).filter(Boolean);
}

function onOnlineExportSelectAll() {
  state.onlineExportColumns = ONLINE_EXPORT_COLUMN_DEFS.map((item) => item.key);
  saveOnlineExportColumnsToStorage(state.onlineExportColumns);
  renderOnlineExportColumns();
}

function onOnlineExportReset() {
  state.onlineExportColumns = getDefaultOnlineExportColumns();
  saveOnlineExportColumnsToStorage(state.onlineExportColumns);
  renderOnlineExportColumns();
}

async function onOnlineExportSubmit(event) {
  event.preventDefault();
  const columns = readOnlineExportColumnsFromForm();
  if (!columns.length) {
    if (onlineExportMessage) {
      onlineExportMessage.style.color = "#c02030";
      onlineExportMessage.textContent = "请至少选择一列";
    }
    return;
  }
  const ids = (state.onlineFilteredProducts || []).map((item) => String(item?.id || "").trim()).filter(Boolean);
  if (!ids.length) {
    if (onlineExportMessage) {
      onlineExportMessage.style.color = "#c02030";
      onlineExportMessage.textContent = "当前筛选结果没有可导出的产品";
    }
    return;
  }
  if (onlineExportMessage) {
    onlineExportMessage.style.color = "#2f3d63";
    onlineExportMessage.textContent = "正在生成导出文件...";
  }
  const result = await fetchBinary("/api/online-products/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, columns })
  });
  if (!result.ok) {
    if (onlineExportMessage) {
      onlineExportMessage.style.color = "#c02030";
      onlineExportMessage.textContent = result.error || "导出失败";
    }
    return;
  }
  state.onlineExportColumns = columns;
  saveOnlineExportColumnsToStorage(columns);
  downloadBlob(result.blob, result.filename || "online-products-export.xlsx");
  closeOnlineExportModal();
  if (onlineProductMessage) {
    onlineProductMessage.style.color = "#1d6f3a";
    onlineProductMessage.textContent = `已导出 ${ids.length} 条在线产品`;
  }
}

function applyOnlineFilters() {
  let items = getYandexProducts();
  const titleList = splitFilterText(state.onlineFilters.title);
  const productIdList = splitFilterText(state.onlineFilters.productId);
  const shopSkuList = splitFilterText(state.onlineFilters.shopSku);
  const marketSkuList = splitFilterText(state.onlineFilters.marketSku);
  const brandList = splitFilterText(state.onlineFilters.brand);
  const vendorCodeList = splitFilterText(state.onlineFilters.vendorCode);
  const categoryIdList = splitFilterText(state.onlineFilters.categoryId);
  const status = String(state.onlineFilters.status || "").toLowerCase();
  const shopId = String(state.onlineFilters.shopId || "");
  const statusGroup = String(state.onlineFilters.statusGroup || "all");

  if (shopId) {
    items = items.filter((p) => String(p.shopId || "") === shopId);
  }
  if (titleList.length) {
    items = items.filter((p) => matchesAny(p.name, titleList));
  }
  if (productIdList.length) {
    items = items.filter((p) => matchesAny(p.offerId || p.id, productIdList));
  }
  if (shopSkuList.length) {
    items = items.filter((p) => matchesAny(p.shopSku, shopSkuList));
  }
  if (marketSkuList.length) {
    items = items.filter((p) => matchesAny(p.marketSku, marketSkuList));
  }
  if (brandList.length) {
    items = items.filter((p) => matchesAny(p.vendor, brandList));
  }
  if (vendorCodeList.length) {
    items = items.filter((p) => matchesAny(`${p.vendorCode || ""} ${p.style || ""} ${p.model || ""}`, vendorCodeList));
  }
  if (categoryIdList.length) {
    items = items.filter((p) => matchesAny(`${p.categoryId || ""} ${p.categoryName || ""}`, categoryIdList));
  }
  if (status) {
    items = items.filter((p) => matchesAny(`${p.status || ""} ${p.statusReason || ""}`, splitFilterText(status)));
  }
  if (statusGroup && statusGroup !== "all") {
    items = items.filter((p) => getOnlineStatusGroup(p.status) === statusGroup);
  }
  state.onlineFilteredProducts = items;
  pruneSelectedOnlineProducts();
}

function getOnlineTabBaseItems() {
  let items = getYandexProducts();
  const titleList = splitFilterText(state.onlineFilters.title);
  const productIdList = splitFilterText(state.onlineFilters.productId);
  const shopSkuList = splitFilterText(state.onlineFilters.shopSku);
  const marketSkuList = splitFilterText(state.onlineFilters.marketSku);
  const brandList = splitFilterText(state.onlineFilters.brand);
  const vendorCodeList = splitFilterText(state.onlineFilters.vendorCode);
  const categoryIdList = splitFilterText(state.onlineFilters.categoryId);
  const shopId = String(state.onlineFilters.shopId || "");

  if (shopId) {
    items = items.filter((p) => String(p.shopId || "") === shopId);
  }
  if (titleList.length) {
    items = items.filter((p) => matchesAny(p.name, titleList));
  }
  if (productIdList.length) {
    items = items.filter((p) => matchesAny(p.offerId || p.id, productIdList));
  }
  if (shopSkuList.length) {
    items = items.filter((p) => matchesAny(p.shopSku, shopSkuList));
  }
  if (marketSkuList.length) {
    items = items.filter((p) => matchesAny(p.marketSku, marketSkuList));
  }
  if (brandList.length) {
    items = items.filter((p) => matchesAny(p.vendor, brandList));
  }
  if (vendorCodeList.length) {
    items = items.filter((p) => matchesAny(`${p.vendorCode || ""} ${p.style || ""} ${p.model || ""}`, vendorCodeList));
  }
  if (categoryIdList.length) {
    items = items.filter((p) => matchesAny(`${p.categoryId || ""} ${p.categoryName || ""}`, categoryIdList));
  }
  return items;
}

function getOnlineStatusGroup(status) {
  const value = String(status || "").toLowerCase();
  if (!value) return "other";
  if (value.includes("active") || value.includes("published") || value.includes("ready") || value.includes("on")) return "active";
  if (
    value.includes("inactive")
    || value.includes("hidden")
    || value.includes("disabled")
    || value.includes("delist")
    || value.includes("no_stock")
    || value.includes("out_of_stock")
    || value.includes("unavailable")
    || value.includes("archive")
    || value.includes("draft")
  ) return "inactive";
  return "other";
}

function onOnlineStatusTabClick(event) {
  const button = event.target.closest("button[data-status-group]");
  if (!button) return;
  const group = String(button.dataset.statusGroup || "all");
  state.onlineFilters.statusGroup = group;
  if (onlineStatusTabs) {
    onlineStatusTabs.querySelectorAll("button[data-status-group]").forEach((btn) => {
      btn.classList.toggle("active", btn === button);
    });
  }
  state.onlineCurrentPage = 1;
  applyOnlineFilters();
  renderOnlineStatusTabs();
  renderOnlineProducts();
  renderOnlinePagination();
}

function getOnlineProductsPage() {
  const pageSize = state.onlinePageSize || DEFAULT_ONLINE_PAGE_SIZE;
  const start = (state.onlineCurrentPage - 1) * pageSize;
  return state.onlineFilteredProducts.slice(start, start + pageSize);
}

function renderOnlineSummary() {
  const items = getYandexProducts();
  if (onlineProductCount) onlineProductCount.textContent = String(items.length);
  if (onlineProductShopCount) {
    const shopSet = new Set(items.map((p) => String(p.shopName || p.shopId || "")).filter(Boolean));
    onlineProductShopCount.textContent = String(shopSet.size);
  }
  if (onlineProductSyncInfo) {
    const latest = items
      .map((p) => new Date(p.updatedAt || p.createdAt || 0).getTime())
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => b - a)[0];
    onlineProductSyncInfo.textContent = latest ? new Date(latest).toLocaleString("zh-CN") : "-";
  }
  renderOnlineStatusTabs();
}

function renderOnlineStatusTabs() {
  if (!onlineStatusTabs) return;
  const counts = { all: 0, active: 0, inactive: 0, other: 0 };
  const tabItems = getOnlineTabBaseItems();
  for (const item of tabItems) {
    counts.all += 1;
    counts[getOnlineStatusGroup(item.status)] += 1;
  }
  onlineStatusTabs.querySelectorAll("button[data-status-group]").forEach((btn) => {
    const group = String(btn.dataset.statusGroup || "all");
    const labelMap = { all: "全部", active: "在售", inactive: "下架", other: "其他" };
    btn.textContent = `${labelMap[group] || "全部"}(${counts[group] || 0})`;
    btn.classList.toggle("active", group === state.onlineFilters.statusGroup);
  });
}

function formatOnlineMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "RUB -";
  return `RUB ${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

function formatOnlinePercent(value) {
  const num = normalizeCommissionPercent(value);
  if (!Number.isFinite(num)) return "-";
  return `${Number.isInteger(num) ? num : num.toFixed(2)}%`;
}

function formatOnlineProfitMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function getOnlineProductPrimaryCode(item) {
  return String(item.shopSku || item.vendorCode || item.offerId || item.marketSku || item.id || "").trim();
}

function getOnlineProductPlatform(item) {
  const direct = String(item?.provider || item?.platform || item?.shopProvider || "").trim().toLowerCase();
  if (direct) return direct;
  const shopId = String(item?.shopId || "").trim();
  const shop = (state.shops || []).find((entry) => String(entry?.id || "").trim() === shopId);
  return String(shop?.provider || shop?.platform || "").trim().toLowerCase();
}

function getOzonProducts() {
  return (state.onlineProducts || []).filter((item) => getOnlineProductPlatform(item).includes("ozon"));
}

function getOzonProductStatusGroup(item) {
  const status = String(item?.ozonStatus || item?.status || item?.statusReason || "").trim().toLowerCase();
  const visibility = item?.visible;
  if (/archive|archived|архив/.test(status)) return "archive";
  if (/error|failed|fail|reject|banned|ошиб/.test(status)) return "error";
  if (/edit|change|moderation|pending|修改|доработ/.test(status)) return "edit";
  if (/removed|deleted|inactive|hidden|下架|снят/.test(status)) return "removed";
  if (visibility === true || /selling|active|visible|published|in_sale|прода/.test(status)) return "selling";
  if (/ready|prepared|moderated|to_supply|validation_state_success|готов|подготов/.test(status)) return "ready";
  // Unknown/empty statuses must not be silently counted as "ready to sell".
  return "other";
}

function getOzonProductStatusLabel(item) {
  const raw = String(item?.ozonStatus || item?.status || item?.statusReason || "").trim().toUpperCase();
  const labels = {
    IN_SALE: "销售中", VISIBLE: "销售中", ACTIVE: "销售中",
    READY_TO_SUPPLY: "准备销售", TO_SUPPLY: "准备销售", MODERATED: "准备销售", VALIDATION_STATE_SUCCESS: "准备销售",
    IN_MODERATION: "待修改", MODERATION: "待修改", VALIDATION_STATE_PENDING: "待修改", PENDING: "待修改",
    FAILED_MODERATION: "错误", STATE_FAILED: "错误", VALIDATION_STATE_FAIL: "错误", REJECTED: "错误", BANNED: "错误",
    REMOVED_FROM_SALE: "商品已下架", INACTIVE: "商品已下架", HIDDEN: "商品已下架",
    ARCHIVED: "档案"
  };
  return labels[raw] || (raw ? String(item.status || raw) : "准备销售");
}

function onOzonProductStatusTabClick(event) {
  const button = event.target.closest("button[data-ozon-status]");
  if (!button) return;
  ozonProductStatusFilter = String(button.dataset.ozonStatus || "all");
  ozonProductStatusTabs.querySelectorAll("button[data-ozon-status]").forEach((item) => {
    item.classList.toggle("active", item === button);
  });
  renderOzonProducts();
}

function renderOzonProductStatusTabs(items) {
  if (!ozonProductStatusTabs) return;
  const counts = { all: items.length, selling: 0, ready: 0, error: 0, edit: 0, removed: 0, archive: 0, other: 0 };
  items.forEach((item) => { counts[getOzonProductStatusGroup(item)] += 1; });
  const labels = { all: "所有", selling: "销售中", ready: "准备销售", error: "错误", edit: "待修改", removed: "商品已下架", archive: "档案", other: "其他" };
  ozonProductStatusTabs.querySelectorAll("button[data-ozon-status]").forEach((button) => {
    const key = String(button.dataset.ozonStatus || "all");
    button.textContent = `${labels[key] || labels.all}(${counts[key] || 0})`;
    button.classList.toggle("active", key === ozonProductStatusFilter);
  });
}

function renderOzonProducts() {
  if (!ozonProductsTableBody) return;
  const allItems = getOzonProducts();
  renderOzonProductStatusTabs(allItems);
  const items = ozonProductStatusFilter === "all"
    ? allItems
    : allItems.filter((item) => getOzonProductStatusGroup(item) === ozonProductStatusFilter);
  const shopSet = new Set(items.map((item) => String(item.shopName || item.shopId || "").trim()).filter(Boolean));
  const latest = items
    .map((item) => item.syncedAt || item.updatedAt || item.createdAt || "")
    .filter(Boolean)
    .sort()
    .at(-1);

  if (ozonProductCount) ozonProductCount.textContent = String(allItems.length);
  if (ozonProductShopCount) ozonProductShopCount.textContent = String(shopSet.size);
  if (ozonProductSyncInfo) ozonProductSyncInfo.textContent = latest ? formatDateTime(latest) : "-";

  if (!items.length) {
    ozonProductsTableBody.innerHTML = allItems.length
      ? "<tr><td colspan='8'>当前状态下暂无 Ozon 产品。</td></tr>"
      : "<tr><td colspan='8'>暂无 Ozon 产品，请先在店铺管理中接入 Ozon 店铺并同步商品。</td></tr>";
    if (ozonProductMessage) {
      ozonProductMessage.textContent = allItems.length
        ? "当前筛选状态下暂无 Ozon 产品。"
        : "Ozon 产品库已创建；当前系统尚未返回 Ozon 在线商品数据。";
    }
    return;
  }

  if (ozonProductMessage) ozonProductMessage.textContent = `共加载 ${items.length} 条 Ozon 产品`;
  ozonProductsTableBody.innerHTML = items.map((item) => {
    const imageUrl = String(item.imageUrl || (Array.isArray(item.pictures) ? item.pictures[0] : "") || "").trim();
    const sku = String(item.shopSku || item.offerId || item.marketSku || item.id || "-").trim();
    const title = String(item.title || item.name || "未命名产品").trim();
    const status = getOzonProductStatusLabel(item);
    const shop = String(item.shopName || item.shopId || "-").trim();
    return `
      <tr>
        <td>${imageUrl ? `<img class="product-thumb small" src="${escapeHtml(safeImageUrl(imageUrl))}" alt="${escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer" />` : "-"}</td>
        <td><strong>${escapeHtml(title)}</strong><div class="small-text">SKU: ${escapeHtml(sku)}</div></td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(formatOzonMoney(item.salePrice ?? item.price))}</td>
        <td>${escapeHtml(formatOzonMoney(item.originalPrice ?? item.oldPrice))}</td>
        <td>${escapeHtml(String(item.stockCount ?? item.stock ?? 0))}</td>
        <td>${escapeHtml(shop)}</td>
        <td>${escapeHtml(formatDateTime(item.updatedAt || item.syncedAt || item.createdAt || ""))}</td>
      </tr>`;
  }).join("");
}

function formatOzonMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "RUB -";
  return `RUB ${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

async function onSyncOzonProducts() {
  if (!syncOzonProductsBtn) return;
  if (!can("productSync")) {
    if (ozonProductMessage) ozonProductMessage.textContent = "无权同步产品";
    return;
  }
  syncOzonProductsBtn.disabled = true;
  if (ozonProductMessage) ozonProductMessage.textContent = "正在从 Ozon API 同步产品...";
  const result = await apiRequest("/api/ozon-products/sync", { method: "POST" });
  syncOzonProductsBtn.disabled = false;
  if (!result.ok) {
    if (ozonProductMessage) ozonProductMessage.textContent = result.error || "Ozon 产品同步失败";
    return;
  }
  const data = result.data || {};
  if (state.panelLoaded.onlineProducts) state.panelLoaded.onlineProducts = false;
  await loadOnlineProducts();
  renderOzonProducts();
  const errors = Array.isArray(data.errors) && data.errors.length ? `，失败 ${data.errors.length} 个店铺` : "";
  if (ozonProductMessage) ozonProductMessage.textContent = `${data.message || "Ozon 产品同步完成"}${errors}`;
}

function renderOnlineProducts() {
  if (!onlineProductsTableBody) return;
  const items = getOnlineProductsPage();
  if (!items.length) {
    onlineProductsTableBody.innerHTML = "<tr><td colspan='17'>暂无在线产品</td></tr>";
    syncOnlineSelectionUi();
    syncOnlineIslandScrollbarMetrics();
    return;
  }
  const selectedSet = new Set(state.onlineSelectedIds || []);
  onlineProductsTableBody.innerHTML = items
    .map((item) => {
      const image = item.imageUrl || (Array.isArray(item.pictures) ? item.pictures[0] : "");
      const statusText = item.status || "-";
      const statusReasonText = String(item.statusReason || "").trim();
      const isChecked = selectedSet.has(String(item.id));
      const skuText = String(item.shopSku || item.vendorCode || item.marketSku || item.offerId || item.id || "-").trim();
      const categoryText = String(item.marketCategoryName || item.categoryName || item.marketCategoryId || item.categoryId || "-").trim();
      const mergedCode = String(item.mergeCode || item.mergeSku || item.parentSku || "-").trim();
      const platformSku = String(item.marketSku || item.offerId || item.id || "-").trim();
      const shopText = String(item.shopName || item.shopId || "-").trim();
      const salePrice = formatOnlineMoney(Number(item.salePrice ?? item.price));
      const originalPrice = formatOnlineMoney(Number(item.originalPrice ?? item.oldPrice ?? item.priceBeforeDiscount));
      const commission = formatOnlinePercent(
        Number(
          item.commissionPercent
          ?? item.commission
          ?? item.feeRate
          ?? item.serviceFeeRate
        )
      );
      const purchasePriceRmb = Number(item.purchasePriceRmb);
      const purchasePriceRub = Number(item.purchasePriceRub ?? item.costPrice);
      const profitRub = formatOnlineProfitMoney(item.profitRub);
      const profitRmb = formatOnlineProfitMoney(item.profitRmb);
      const profitRate = formatOnlinePercent(item.profitRate);
      const lengthCm = Number(item.packageLengthCm ?? item.lengthCm ?? item.length);
      const widthCm = Number(item.packageWidthCm ?? item.widthCm ?? item.width);
      const heightCm = Number(item.packageHeightCm ?? item.heightCm ?? item.height);
      const weightKg = Number(item.weightKg ?? item.weight);
      const productLink = String(item.collectUrl || item.url || "").trim();
      const sourceLink = String(item.purchaseUrl || item.purchaseUrl2 || (Array.isArray(item.urls) ? item.urls[0] : "") || item.collectUrl || item.url || "").trim();
      const sourceTypeText = String(item.sourceType || "非ERP采集").trim() || "非ERP采集";
      const copyCode = getOnlineProductPrimaryCode(item);
      return `
        <tr class="online-product-row">
          <td>
            <input type="checkbox" data-id="${escapeHtml(item.id)}" ${isChecked ? "checked" : ""} />
          </td>
          <td>
            <div class="online-product-info">
              <div class="product-thumb small">
                ${
                  image
                    ? `<button type="button" class="online-image-preview-btn" data-online-preview="${escapeHtml(item.id)}" title="预览图片">
                         <img src="${escapeHtml(safeImageUrl(image))}" alt="product" referrerpolicy="no-referrer" />
                       </button>`
                    : "<span class='thumb-placeholder'>暂无图片</span>"
                }
              </div>
              <div class="product-info">
                <div class="product-title clamp-2">${escapeHtml(item.name || "-")}</div>
                <div class="product-sub">
                  <div>合并编号: ${escapeHtml(mergedCode || "-")}</div>
                  <div>平台SKU: ${escapeHtml(platformSku)}</div>
                  <div>SKU: ${escapeHtml(skuText)}</div>
                  <div>类目: ${escapeHtml(categoryText)}</div>
                  <div class="online-source-row">货源:
                    ${
                      safeExternalUrl(sourceLink)
                        ? `<a class="online-source-type link" href="${escapeHtml(safeExternalUrl(sourceLink))}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceTypeText)}</a>`
                        : `<span class="online-source-type">${escapeHtml(sourceTypeText)}</span>`
                    }
                    <button type="button" class="online-source-add" data-id="${escapeHtml(item.id)}" title="填写货源信息">+</button>
                  </div>
                </div>
              </div>
            </div>
          </td>
          <td>
            <div class="online-status-cell">
              <span class="status-dot"></span>
              <span class="status-chip">${escapeHtml(statusText)}</span>
              <span class="status-stock">${escapeHtml(String(item.stockCount ?? item.availableStock ?? 1))}</span>
              ${statusReasonText ? `<span class="status-reason" title="${escapeHtml(statusReasonText)}">${escapeHtml(statusReasonText)}</span>` : ""}
            </div>
          </td>
          <td class="online-card-quality-cell" data-shop-id="${escapeHtml(String(item.shopId || ""))}" data-offer-id="${escapeHtml(String(item.offerId || item.marketSku || item.shopSku || ""))}">
            <span class="card-quality-chip quality-loading">-</span>
          </td>
          <td class="money-cell">${escapeHtml(salePrice)}</td>
          <td class="money-cell">${escapeHtml(originalPrice)}</td>
          <td class="money-cell">${escapeHtml(commission)}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(purchasePriceRmb) ? String(purchasePriceRmb) : "-")}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(purchasePriceRub) ? String(purchasePriceRub) : "-")}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(lengthCm) ? String(lengthCm) : "-")}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(widthCm) ? String(widthCm) : "-")}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(heightCm) ? String(heightCm) : "-")}</td>
          <td class="money-cell">${escapeHtml(Number.isFinite(weightKg) ? String(weightKg) : "-")}</td>
          <td class="money-cell">${escapeHtml(String(item.stockCount ?? item.availableStock ?? item.inventory ?? "-"))}</td>
          <td>${escapeHtml(shopText)}</td>
          <td>
            <div class="online-actions-cell">
              ${
                safeExternalUrl(productLink)
                  ? `<a class="online-action-link" href="${escapeHtml(safeExternalUrl(productLink))}" target="_blank" rel="noopener noreferrer">查看</a>`
                  : `<span class="online-action-link disabled">查看</span>`
              }
              <button type="button" class="online-action-link" data-online-edit="${escapeHtml(item.id)}">修改</button>
              <button type="button" class="online-action-link online-copy-btn" data-copy-value="${escapeHtml(copyCode)}">复制SKU</button>
            </div>
          </td>
          <td>
            <div class="online-profit-stack">
              <div class="online-profit-line">
                <span>卢布利润</span>
                <button type="button" class="profit-detail-trigger online-profit-detail-trigger" data-online-profit-detail="${escapeHtml(String(item.id || ""))}" data-profit-currency="rub">${escapeHtml(profitRub)}</button>
              </div>
              <div class="online-profit-line">
                <span>人民币利润</span>
                <button type="button" class="profit-detail-trigger online-profit-detail-trigger" data-online-profit-detail="${escapeHtml(String(item.id || ""))}" data-profit-currency="rmb">${escapeHtml(profitRmb)}</button>
              </div>
              <div class="online-profit-line"><span>利润率</span><strong>${escapeHtml(profitRate)}</strong></div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
  syncOnlineSelectionUi();
  syncOnlineIslandScrollbarMetrics();
  loadOnlineCardQualityForPage();
}

async function loadOnlineCardQualityForPage() {
  const items = getOnlineProductsPage();
  if (!items.length) return;
  const byShop = new Map();
  for (const item of items) {
    const shopId = String(item?.shopId || "").trim();
    const offerId = String(item?.offerId || item?.marketSku || item?.shopSku || "").trim();
    if (!shopId || !offerId) continue;
    if (!byShop.has(shopId)) byShop.set(shopId, new Set());
    byShop.get(shopId).add(offerId);
  }
  if (!byShop.size) return;

  const settled = await Promise.allSettled(
    Array.from(byShop.entries()).map(async ([shopId, offerIds]) => {
      const ids = Array.from(offerIds).slice(0, 200);
      const query = `?shopId=${encodeURIComponent(shopId)}&offerIds=${encodeURIComponent(ids.join(","))}`;
      const result = await apiRequest(`/api/yandex/card-quality/batch${query}`, { method: "GET" });
      return { shopId, result };
    })
  );

  const qualityMap = new Map();
  for (const entry of settled) {
    if (entry.status !== "fulfilled" || !entry.value?.result?.ok) continue;
    const shopId = String(entry.value.shopId || "");
    const rows = Array.isArray(entry.value.result.data?.items) ? entry.value.result.data.items : [];
    for (const row of rows) {
      const offerId = String(row?.offerId || "").trim();
      if (offerId) qualityMap.set(`${shopId}|${offerId}`, row);
    }
  }

  document.querySelectorAll(".online-card-quality-cell").forEach((cell) => {
    const key = `${String(cell.dataset.shopId || "").trim()}|${String(cell.dataset.offerId || "").trim()}`;
    cell.innerHTML = renderOnlineCardQualityChip(qualityMap.get(key));
  });
}

function renderOnlineCardQualityChip(row) {
  const rating = Number(row?.rating);
  if (!Number.isFinite(rating)) {
    return `<span class="card-quality-chip quality-none" title="暂无卡片质量数据">-</span>`;
  }
  const level = rating >= 85 ? "quality-high" : rating >= 60 ? "quality-mid" : "quality-low";
  const parts = [`填充度 ${Math.round(rating)}%`];
  if (row?.cardStatus) parts.push(String(row.cardStatus));
  if (row?.fetchedAt) parts.push(`拉取于 ${formatDateTime(row.fetchedAt)}`);
  return `<span class="card-quality-chip ${level}" title="${escapeHtml(parts.join(" · "))}">${Math.round(rating)}分</span>`;
}

async function onOnlineTableClick(event) {
  const profitBtn = event.target.closest("[data-online-profit-detail]");
  if (profitBtn) {
    const id = String(profitBtn.getAttribute("data-online-profit-detail") || "").trim();
    if (id) {
      const item = (state.onlineProducts || []).find((entry) => String(entry?.id || "").trim() === id);
      if (item) {
        openProfitDetailModal(item, String(profitBtn.dataset.profitCurrency || "rmb").trim().toLowerCase(), "online_product");
      }
    }
    return;
  }
  const previewBtn = event.target.closest(".online-image-preview-btn[data-online-preview]");
  if (previewBtn) {
    const id = String(previewBtn.dataset.onlinePreview || "").trim();
    if (id) {
      const item = (state.onlineProducts || []).find((entry) => String(entry?.id || "").trim() === id);
      if (item) openPublishGallery(item);
    }
    return;
  }
  const sourceBtn = event.target.closest(".online-source-add[data-id]");
  if (sourceBtn) {
    openOnlineSourceModal(String(sourceBtn.dataset.id || "").trim());
    return;
  }
  const editBtn = event.target.closest("[data-online-edit]");
  if (editBtn) {
    openOnlineSourceModal(String(editBtn.getAttribute("data-online-edit") || "").trim());
    return;
  }
  const copyBtn = event.target.closest(".online-copy-btn");
  if (!copyBtn) return;
  const value = String(copyBtn.dataset.copyValue || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#18b6b5";
      onlineProductMessage.textContent = `已复制 SKU: ${value}`;
    }
  } catch (error) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "复制失败";
    }
  }
}

function openOnlineSourceModal(productId) {
  const id = String(productId || "").trim();
  if (!id || !onlineSourceModalMask || !onlineSourceForm) return;
  const item = (state.onlineProducts || []).find((entry) => String(entry?.id || "").trim() === id);
  if (!item) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "未找到在线产品";
    }
    return;
  }
  activeOnlineSourceProductId = id;
  if (onlineSourceMessage) onlineSourceMessage.textContent = "";
  if (onlineSourceType) onlineSourceType.value = String(item.sourceType || "非ERP采集").trim() || "非ERP采集";
  if (onlineSourceNote) onlineSourceNote.value = String(item.sourceNote || "").trim();
  if (onlineSourceLink) onlineSourceLink.value = String(item.purchaseUrl || "").trim();
  if (onlineSourceLink2) onlineSourceLink2.value = String(item.purchaseUrl2 || "").trim();
  if (onlineSourcePurchasePriceRmb) onlineSourcePurchasePriceRmb.value = item.purchasePriceRmb !== undefined && item.purchasePriceRmb !== null && item.purchasePriceRmb !== "" ? String(item.purchasePriceRmb) : "";
  if (onlineSourcePurchasePriceRub) onlineSourcePurchasePriceRub.value = item.purchasePriceRub !== undefined && item.purchasePriceRub !== null && item.purchasePriceRub !== "" ? String(item.purchasePriceRub) : "";
  if (onlineSourceSalePrice) onlineSourceSalePrice.value = item.salePrice !== undefined && item.salePrice !== null && item.salePrice !== "" ? String(item.salePrice) : "";
  if (onlineSourceOriginalPrice) onlineSourceOriginalPrice.value = item.originalPrice !== undefined && item.originalPrice !== null && item.originalPrice !== "" ? String(item.originalPrice) : "";
  if (onlineSourceStockCount) onlineSourceStockCount.value = item.stockCount !== undefined && item.stockCount !== null && item.stockCount !== "" ? String(item.stockCount) : "";
  if (onlineSourcePackageLengthCm) onlineSourcePackageLengthCm.value = item.packageLengthCm !== undefined && item.packageLengthCm !== null && item.packageLengthCm !== "" ? String(item.packageLengthCm) : "";
  if (onlineSourcePackageWidthCm) onlineSourcePackageWidthCm.value = item.packageWidthCm !== undefined && item.packageWidthCm !== null && item.packageWidthCm !== "" ? String(item.packageWidthCm) : "";
  if (onlineSourcePackageHeightCm) onlineSourcePackageHeightCm.value = item.packageHeightCm !== undefined && item.packageHeightCm !== null && item.packageHeightCm !== "" ? String(item.packageHeightCm) : "";
  if (onlineSourceWeightKg) onlineSourceWeightKg.value = item.weightKg !== undefined && item.weightKg !== null && item.weightKg !== "" ? String(item.weightKg) : "";
  onlineSourceModalMask.classList.remove("hidden");
}

function closeOnlineSourceModal() {
  activeOnlineSourceProductId = "";
  if (onlineSourceModalMask) onlineSourceModalMask.classList.add("hidden");
}

function onOnlineSourceMaskClick(event) {
  if (event.target === onlineSourceModalMask) closeOnlineSourceModal();
}

async function onOnlineSourceSubmit(event) {
  event.preventDefault();
  if (!onlineSourceForm || !activeOnlineSourceProductId) return;
  const form = new FormData(onlineSourceForm);
  const payload = {
    sourceType: String(form.get("sourceType") || "").trim() || "非ERP采集",
    sourceNote: String(form.get("sourceNote") || "").trim(),
    purchaseUrl: String(form.get("purchaseUrl") || "").trim(),
    purchaseUrl2: String(form.get("purchaseUrl2") || "").trim(),
    purchasePriceRmb: String(form.get("purchasePriceRmb") || "").trim(),
    purchasePriceRub: String(form.get("purchasePriceRub") || "").trim(),
    salePrice: String(form.get("salePrice") || "").trim(),
    originalPrice: String(form.get("originalPrice") || "").trim(),
    stockCount: String(form.get("stockCount") || "").trim(),
    packageLengthCm: String(form.get("packageLengthCm") || "").trim(),
    packageWidthCm: String(form.get("packageWidthCm") || "").trim(),
    packageHeightCm: String(form.get("packageHeightCm") || "").trim(),
    weightKg: String(form.get("weightKg") || "").trim()
  };
  const result = await apiRequest(`/api/online-products/${encodeURIComponent(activeOnlineSourceProductId)}/source`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    if (onlineSourceMessage) {
      onlineSourceMessage.style.color = "#c02030";
      onlineSourceMessage.textContent = result.error || "保存货源信息失败";
    }
    return;
  }
  const sync = result.data?.yandexSync;
  const hasSyncError = sync && [sync.mapping, sync.price, sync.stock].some((entry) => entry && entry.ok === false);
  if (hasSyncError) {
    if (onlineSourceMessage) {
      onlineSourceMessage.style.color = "#c02030";
      const messages = [sync.mapping?.message, sync.price?.message, sync.stock?.message].filter(Boolean);
      onlineSourceMessage.textContent = messages.length ? `本地已保存，但同步Yandex失败：${messages.join(" | ")}` : "本地已保存，但同步Yandex失败";
    }
    return;
  }
  await loadOnlineProducts();
  if (onlineProductMessage) {
    onlineProductMessage.style.color = "#1d6f3a";
    const syncParts = [];
    if (sync?.mapping?.ok) syncParts.push("尺寸/重量");
    if (sync?.price?.ok) syncParts.push("价格");
    if (sync?.stock?.ok) syncParts.push("库存");
    onlineProductMessage.textContent = syncParts.length
      ? `在线产品已保存，${syncParts.join("、")}已同步到Yandex`
      : "在线产品已保存";
  }
  closeOnlineSourceModal();
}

function renderOnlinePagination() {
  if (!onlinePaginationInfo) return;
  const total = state.onlineFilteredProducts.length;
  const pageSize = state.onlinePageSize || DEFAULT_ONLINE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.onlineCurrentPage > totalPages) state.onlineCurrentPage = totalPages;
  onlinePaginationInfo.innerHTML = `${state.onlineCurrentPage} <span class="page-sep">/</span> <span class="page-total">${totalPages}</span>`;
  if (onlinePrevPageBtn) onlinePrevPageBtn.disabled = state.onlineCurrentPage <= 1;
  if (onlineNextPageBtn) onlineNextPageBtn.disabled = state.onlineCurrentPage >= totalPages;
  if (onlineGotoPage) onlineGotoPage.value = String(state.onlineCurrentPage);
}

function changeOnlinePage(nextPage) {
  const pageSize = state.onlinePageSize || DEFAULT_ONLINE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(state.onlineFilteredProducts.length / pageSize));
  if (nextPage < 1 || nextPage > totalPages) return;
  state.onlineCurrentPage = nextPage;
  renderOnlineProducts();
  renderOnlinePagination();
}

function renderOnlineShopFilterOptions() {
  if (!onlineProductShopFilter) return;
  const current = String(state.onlineFilters.shopId || "");
  const source = (state.shops || []).length
    ? state.shops.map((shop) => ({ id: String(shop.id || ""), name: String(shop.name || "") }))
    : (state.onlineProducts || []).map((product) => ({
        id: String(product.shopId || ""),
        name: String(product.shopName || "")
      }));
  const seen = new Set();
  const options = source
    .filter((item) => {
      const id = String(item.id || "").trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((item) => {
      const selected = item.id === current ? "selected" : "";
      return `<option value="${escapeHtml(item.id)}" ${selected}>${escapeHtml(item.name || item.id)}</option>`;
    })
    .join("");
  onlineProductShopFilter.innerHTML = `<option value="">店铺(全部)</option>${options}`;
}

function onOnlineTableChange(event) {
  const checkbox = event.target.closest("input[type='checkbox'][data-id]");
  if (!checkbox) return;
  const id = String(checkbox.dataset.id || "");
  if (!id) return;
  const selected = new Set(state.onlineSelectedIds || []);
  if (checkbox.checked) {
    selected.add(id);
  } else {
    selected.delete(id);
  }
  state.onlineSelectedIds = Array.from(selected);
  syncOnlineSelectionUi();
}

function onOnlineSelectAllChange(event) {
  const checked = Boolean(event.target.checked);
  const pageItems = getOnlineProductsPage();
  const pageIds = pageItems.map((item) => String(item.id));
  const selected = new Set(state.onlineSelectedIds || []);
  if (checked) {
    pageIds.forEach((id) => selected.add(id));
  } else {
    pageIds.forEach((id) => selected.delete(id));
  }
  state.onlineSelectedIds = Array.from(selected);
  renderOnlineProducts();
  syncOnlineSelectionUi();
}

function onOnlineSelectAllButton(checked) {
  const pageItems = getOnlineProductsPage();
  const pageIds = pageItems.map((item) => String(item.id));
  const selected = new Set(state.onlineSelectedIds || []);
  if (checked) {
    pageIds.forEach((id) => selected.add(id));
  } else {
    pageIds.forEach((id) => selected.delete(id));
  }
  state.onlineSelectedIds = Array.from(selected);
  renderOnlineProducts();
  syncOnlineSelectionUi();
}

function onOnlineInvertSelect() {
  const pageItems = getOnlineProductsPage();
  const selected = new Set(state.onlineSelectedIds || []);
  pageItems.forEach((item) => {
    const id = String(item.id);
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }
  });
  state.onlineSelectedIds = Array.from(selected);
  renderOnlineProducts();
  syncOnlineSelectionUi();
}

function pruneSelectedOnlineProducts() {
  const ids = new Set((state.onlineProducts || []).map((item) => String(item.id)));
  state.onlineSelectedIds = (state.onlineSelectedIds || []).filter((id) => ids.has(String(id)));
}

function syncOnlineSelectionUi() {
  const selectedSet = new Set(state.onlineSelectedIds || []);
  const pageItems = getOnlineProductsPage();
  const pageIds = pageItems.map((item) => String(item.id));
  const selectedOnPage = pageIds.filter((id) => selectedSet.has(id));
  if (onlineSelectedCount) onlineSelectedCount.textContent = `已选 ${state.onlineSelectedIds.length} / ${state.onlineFilteredProducts.length} 条`;
  const allChecked = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  if (onlineHeaderSelectAll) onlineHeaderSelectAll.checked = allChecked;
}

function onOnlineGotoPage() {
  if (!onlineGotoPage) return;
  const value = Number(onlineGotoPage.value);
  if (!Number.isFinite(value)) return;
  changeOnlinePage(Math.floor(value));
}

function onOnlinePageSizeChange() {
  if (!onlinePageSize) return;
  const size = Number(onlinePageSize.value);
  state.onlinePageSize = Number.isFinite(size) ? size : DEFAULT_ONLINE_PAGE_SIZE;
  state.onlineCurrentPage = 1;
  renderOnlineProducts();
  renderOnlinePagination();
}

function openOnlineInventoryModal() {
  if (!onlineInventoryModalMask) return;
  if (!state.onlineSelectedIds.length) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "请先选择产品";
    }
    return;
  }
  if (onlineInventoryMessage) onlineInventoryMessage.textContent = "";
  if (onlineInventoryForm) onlineInventoryForm.reset();
  onlineInventoryModalMask.classList.remove("hidden");
}

function closeOnlineInventoryModal() {
  if (!onlineInventoryModalMask) return;
  onlineInventoryModalMask.classList.add("hidden");
}

function onOnlineInventoryMaskClick(event) {
  if (event.target === onlineInventoryModalMask) closeOnlineInventoryModal();
}

async function onOnlineInventorySubmit(event) {
  event.preventDefault();
  if (!onlineInventoryForm) return;
  const form = new FormData(onlineInventoryForm);
  const deltaRaw = form.get("delta");
  const delta = Number(deltaRaw);
  if (!Number.isFinite(delta) || delta <= 0) {
    if (onlineInventoryMessage) {
      onlineInventoryMessage.style.color = "#c02030";
      onlineInventoryMessage.textContent = "请输入大于0的库存数量";
    }
    return;
  }
  const ids = state.onlineSelectedIds || [];
  const result = await apiRequest("/api/online-products/batch-inventory", {
    method: "PUT",
    body: JSON.stringify({ ids, delta })
  });
  if (!result.ok) {
    if (onlineInventoryMessage) {
      onlineInventoryMessage.style.color = "#c02030";
      onlineInventoryMessage.textContent = result.error || "批量库存更新失败";
    }
    return;
  }
  const data = result.data || {};
  if (onlineProductMessage) {
    const syncErrors = Array.isArray(data.syncErrors) ? data.syncErrors : [];
    if (syncErrors.length) {
      const errorText = syncErrors
        .map((e) => {
          const shopText = e?.shopName || e?.shopId ? `店铺${e.shopName || e.shopId}` : "";
          const msg = String(e?.message || "").trim();
          return shopText && msg ? `${shopText}: ${msg}` : (msg || shopText);
        })
        .filter(Boolean)
        .join("；");
      onlineProductMessage.style.color = "#b45c00";
      onlineProductMessage.textContent = `库存已更新 ${data.updated || 0} 条，Yandex已同步 ${data.syncedToYandex || 0} 条。${errorText ? `异常：${errorText}` : ""}`;
    } else {
      onlineProductMessage.style.color = "#1d6f3a";
      onlineProductMessage.textContent = `库存已更新 ${data.updated || 0} 条，并已同步到Yandex ${data.syncedToYandex || 0} 条`;
    }
  }
  closeOnlineInventoryModal();
  await loadOnlineProducts({ keepMessage: true });
}

async function onOnlineBatchDelete() {
  if (!state.onlineSelectedIds.length) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "请先选择产品";
    }
    return;
  }
  const confirmed = window.confirm(`确定删除选中的 ${state.onlineSelectedIds.length} 条产品吗？`);
  if (!confirmed) return;
  const result = await apiRequest("/api/online-products", {
    method: "DELETE",
    body: JSON.stringify({ ids: state.onlineSelectedIds })
  });
  if (!result.ok) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = result.error || "删除失败";
    }
    return;
  }
  state.onlineSelectedIds = [];
  await loadOnlineProducts();
}

function populateOnlineCopyPublishShops() {
  if (!onlineCopyPublishShop) return;
  const platform = String(onlineCopyPublishPlatform?.value || "yandex").trim().toLowerCase();
  const provider = platform === "ozon" ? "ozon" : "yandex_market";
  const shops = (state.shops || []).filter((shop) => Boolean(shop?.enabled) && String(shop?.provider || "").trim().toLowerCase() === provider);
  onlineCopyPublishShop.innerHTML = `<option value="">请选择店铺</option>${shops.map((shop) => `<option value="${escapeHtml(String(shop.id || ""))}">${escapeHtml(String(shop.name || shop.id || "未命名店铺"))}</option>`).join("")}`;
}

function openOnlineCopyPublishModal() {
  const ids = Array.isArray(state.onlineSelectedIds) ? state.onlineSelectedIds : [];
  if (!ids.length) {
    if (onlineProductMessage) {
      onlineProductMessage.style.color = "#c02030";
      onlineProductMessage.textContent = "请先选择要复制到刊登的在线产品";
    }
    return;
  }
  if (onlineCopyPublishSelectionInfo) onlineCopyPublishSelectionInfo.textContent = `已选择 ${ids.length} 条在线产品`;
  if (onlineCopyPublishMessage) {
    onlineCopyPublishMessage.style.color = "#5f7390";
    onlineCopyPublishMessage.textContent = "只复制为刊登草稿，不会立即发布到平台。";
  }
  if (onlineCopyPublishPlatform) onlineCopyPublishPlatform.value = "yandex";
  if (onlineCopyPublishPriceStrategy) onlineCopyPublishPriceStrategy.value = "convert";
  if (onlineCopyPublishAiMode) onlineCopyPublishAiMode.value = "all";
  if (onlineCopyPublishOverwrite) onlineCopyPublishOverwrite.checked = true;
  if (onlineCopyPublishDryRun) onlineCopyPublishDryRun.checked = false;
  if (onlineCopyPublishPreview) onlineCopyPublishPreview.classList.add("hidden");
  populateOnlineCopyPublishShops();
  onlineCopyPublishModalMask?.classList.remove("hidden");
}

function closeOnlineCopyPublishModal() {
  onlineCopyPublishModalMask?.classList.add("hidden");
}

function onOnlineCopyPublishMaskClick(event) {
  if (event.target === onlineCopyPublishModalMask) closeOnlineCopyPublishModal();
}

async function onOnlineCopyPublishSubmit(event) {
  event.preventDefault();
  const ids = Array.isArray(state.onlineSelectedIds) ? state.onlineSelectedIds : [];
  const platform = String(onlineCopyPublishPlatform?.value || "").trim().toLowerCase();
  const shopId = String(onlineCopyPublishShop?.value || "").trim();
  const options = {
    priceStrategy: String(onlineCopyPublishPriceStrategy?.value || "convert"),
    aiMode: String(onlineCopyPublishAiMode?.value || "all"),
    overwriteTitleDescription: onlineCopyPublishOverwrite?.checked !== false
  };
  if (!ids.length || !platform || !shopId) {
    if (onlineCopyPublishMessage) {
      onlineCopyPublishMessage.style.color = "#c02030";
      onlineCopyPublishMessage.textContent = !ids.length ? "请选择在线产品" : "请选择目标平台和店铺";
    }
    return;
  }
  if (onlineCopyPublishMessage) {
    onlineCopyPublishMessage.style.color = "#2f3d63";
    onlineCopyPublishMessage.textContent = "正在复制选中的在线产品...";
  }
  const preview = await apiRequest("/api/product-publish/copy-online", {
    method: "POST",
    body: JSON.stringify({ ids, platform, shopId, ...options, dryRun: true })
  });
  if (!preview.ok) {
    if (onlineCopyPublishMessage) {
      onlineCopyPublishMessage.style.color = "#c02030";
      onlineCopyPublishMessage.textContent = preview.error || "复制预览失败";
    }
    return;
  }
  const previewData = preview.data || {};
  const rateText = previewData.exchangeRate?.date
    ? `汇率 ${previewData.exchangeRate.cnyRateRub} RUB/CNY（${previewData.exchangeRate.date}）`
    : "无需汇率换算";
  const warning = platform === "ozon" ? "；提示：Ozon 不会自动映射 Yandex 类目和属性" : "";
  const previewText = `预览：新增 ${previewData.created || 0} 条，更新 ${previewData.updated || 0} 条；预计 AI 任务 ${previewData.aiTaskCount || 0} 个；${rateText}${warning}`;
  if (onlineCopyPublishPreview) {
    onlineCopyPublishPreview.classList.remove("hidden");
    onlineCopyPublishPreview.style.color = "#2f3d63";
    onlineCopyPublishPreview.textContent = previewText;
  }
  if (onlineCopyPublishDryRun?.checked) {
    if (onlineCopyPublishMessage) onlineCopyPublishMessage.textContent = "预览完成：未写入任何数据。取消勾选后再次确认即可执行。";
    return;
  }
  if (!window.confirm(`${previewText}\n\n确认执行复制吗？`)) return;
  if (onlineCopyPublishMessage) onlineCopyPublishMessage.textContent = `正在处理 ${ids.length} 条产品，AI 任务并发创建中...`;
  const result = await apiRequest("/api/product-publish/copy-online", {
    method: "POST",
    body: JSON.stringify({ ids, platform, shopId, ...options, dryRun: false })
  });
  if (!result.ok) {
    if (onlineCopyPublishMessage) {
      onlineCopyPublishMessage.style.color = "#c02030";
      onlineCopyPublishMessage.textContent = result.error || "复制在线产品失败";
    }
    return;
  }
  closeOnlineCopyPublishModal();
  if (onlineProductMessage) {
    const platformLabel = platform === "ozon" ? "Ozon" : "Yandex";
    onlineProductMessage.style.color = "#1d6f3a";
    const converted = Number(result.data?.priceConverted || 0);
    const rate = Number(result.data?.exchangeRate?.cnyRateRub || 0);
    const conversionText = converted > 0 ? `，已按 1 RMB = ${rate} RUB 换算 ${converted} 条售价和折扣价` : "";
    onlineProductMessage.textContent = `已复制到 ${platformLabel} 刊登：新增 ${result.data?.created || 0} 条，更新 ${result.data?.updated || 0} 条${conversionText}；尚未发布。`;
  }
  state.publishWorkspaceTab = normalizePublishWorkspaceTab(result.data?.nextPublishTab || platform);
  await switchPanel(result.data?.nextView || "multiPlatformPublishPanel");
}

function syncOnlineIslandScrollbarMetrics() {
  if (!onlineTableWrap || !onlineIslandScrollbar || !onlineIslandScrollbarInner) return;
  const clientWidth = Math.max(onlineTableWrap.clientWidth || 0, 1);
  const scrollWidth = Math.max(onlineTableWrap.scrollWidth || 0, clientWidth);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  const shouldShow = scrollWidth > clientWidth + 2;
  if (!shouldShow) {
    onlineIslandScrollbar.style.display = "none";
    onlineIslandScrollbarInner.style.width = "0px";
    onlineIslandScrollbarInner.style.transform = "translateX(0)";
    return;
  }
  const trackWidth = Math.max(onlineIslandScrollbar.clientWidth || 0, clientWidth);
  const thumbWidth = Math.max(96, Math.round((clientWidth / scrollWidth) * trackWidth));
  const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
  const ratio = maxScrollLeft > 0 ? (onlineTableWrap.scrollLeft || 0) / maxScrollLeft : 0;
  const thumbLeft = Math.round(maxThumbLeft * ratio);
  onlineIslandScrollbar.style.display = "block";
  onlineIslandScrollbarInner.style.width = `${Math.min(thumbWidth, trackWidth)}px`;
  onlineIslandScrollbarInner.style.transform = `translateX(${thumbLeft}px)`;
}

function syncOnlineIslandScrollbarFromTable() {
  if (!onlineTableWrap || !onlineIslandScrollbar) return;
  if (isSyncingOnlineScroll) return;
  isSyncingOnlineScroll = true;
  syncOnlineIslandScrollbarMetrics();
  isSyncingOnlineScroll = false;
}

function syncOnlineTableFromIslandScrollbar() {
  syncOnlineIslandScrollbarMetrics();
}

function setOnlineTableScrollByRatio(ratio) {
  if (!onlineTableWrap) return;
  const scrollWidth = Math.max(onlineTableWrap.scrollWidth || 0, onlineTableWrap.clientWidth || 0);
  const clientWidth = Math.max(onlineTableWrap.clientWidth || 0, 1);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  onlineTableWrap.scrollLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(maxScrollLeft * ratio)));
  syncOnlineTableFromIslandScrollbar();
}

function getOnlineScrollbarMetrics() {
  if (!onlineIslandScrollbar || !onlineIslandScrollbarInner || !onlineTableWrap) return null;
  const trackRect = onlineIslandScrollbar.getBoundingClientRect();
  const thumbRect = onlineIslandScrollbarInner.getBoundingClientRect();
  const clientWidth = Math.max(onlineTableWrap.clientWidth || 0, 1);
  const scrollWidth = Math.max(onlineTableWrap.scrollWidth || 0, clientWidth);
  const maxScrollLeft = Math.max(scrollWidth - clientWidth, 0);
  const maxThumbLeft = Math.max(trackRect.width - thumbRect.width, 0);
  return { trackRect, thumbRect, maxScrollLeft, maxThumbLeft };
}

function onOnlineIslandScrollbarClick(event) {
  if (!onlineIslandScrollbar || !onlineIslandScrollbarInner || isDraggingOnlineScrollbar) return;
  if (event.target === onlineIslandScrollbarInner) return;
  const metrics = getOnlineScrollbarMetrics();
  if (!metrics || metrics.maxThumbLeft <= 0) return;
  const clickX = event.clientX - metrics.trackRect.left;
  const nextThumbLeft = Math.max(0, Math.min(metrics.maxThumbLeft, clickX - metrics.thumbRect.width / 2));
  setOnlineTableScrollByRatio(nextThumbLeft / metrics.maxThumbLeft);
}

function onOnlineIslandScrollbarMouseDown(event) {
  if (!onlineIslandScrollbarInner || event.target !== onlineIslandScrollbarInner) return;
  const metrics = getOnlineScrollbarMetrics();
  if (!metrics) return;
  isDraggingOnlineScrollbar = true;
  onlineScrollbarDragStartX = event.clientX;
  onlineScrollbarDragStartLeft = metrics.thumbRect.left - metrics.trackRect.left;
  document.body.classList.add("publish-scrollbar-dragging");
  event.preventDefault();
}

function onOnlineIslandScrollbarMouseMove(event) {
  if (!isDraggingOnlineScrollbar) return;
  const metrics = getOnlineScrollbarMetrics();
  if (!metrics || metrics.maxThumbLeft <= 0) return;
  const deltaX = event.clientX - onlineScrollbarDragStartX;
  const nextThumbLeft = Math.max(0, Math.min(metrics.maxThumbLeft, onlineScrollbarDragStartLeft + deltaX));
  setOnlineTableScrollByRatio(nextThumbLeft / metrics.maxThumbLeft);
}

function onOnlineIslandScrollbarMouseUp() {
  if (!isDraggingOnlineScrollbar) return;
  isDraggingOnlineScrollbar = false;
  document.body.classList.remove("publish-scrollbar-dragging");
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const ONLINE_FILTERS_STORAGE_KEY = "erp_online_filters";
const ONLINE_EXPORT_COLUMNS_STORAGE_KEY = "erp_online_export_columns";
const ONLINE_EXPORT_COLUMN_DEFS = [
  { key: "shopName", label: "店铺" },
  { key: "name", label: "产品名称" },
  { key: "productId", label: "产品ID" },
  { key: "shopSku", label: "店铺SKU" },
  { key: "marketSku", label: "平台SKU" },
  { key: "vendor", label: "品牌" },
  { key: "vendorCode", label: "款式/货号" },
  { key: "categoryName", label: "类目" },
  { key: "status", label: "产品状态" },
  { key: "salePrice", label: "售价(卢布)" },
  { key: "originalPrice", label: "划线价(卢布)" },
  { key: "commissionPercent", label: "佣金" },
  { key: "purchasePriceRmb", label: "采购价(人民币)" },
  { key: "purchasePriceRub", label: "采购价(卢布)" },
  { key: "packageLengthCm", label: "长(cm)" },
  { key: "packageWidthCm", label: "宽(cm)" },
  { key: "packageHeightCm", label: "高(cm)" },
  { key: "weightKg", label: "重量(kg)" },
  { key: "stockCount", label: "库存" },
  { key: "sourceType", label: "货源类型" },
  { key: "purchaseUrl", label: "货源链接1" },
  { key: "purchaseUrl2", label: "货源链接2" },
  { key: "collectUrl", label: "产品链接" },
  { key: "updatedAt", label: "更新时间" }
];
const syncOnlineProductsBtn = document.getElementById("syncOnlineProductsBtn");
const refreshCardQualityBtn = document.getElementById("refreshCardQualityBtn");
const onlineCommissionUnmatchedBtn = document.getElementById("onlineCommissionUnmatchedBtn");
const onlineProductFilterForm = document.getElementById("onlineProductFilterForm");
const onlineProductSaveBtn = document.getElementById("onlineProductSaveBtn");
const onlineProductResetBtn = document.getElementById("onlineProductResetBtn");
const onlineProductShopFilter = document.getElementById("onlineProductShopFilter");
const onlineProductMessage = document.getElementById("onlineProductMessage");
const onlineProductCount = document.getElementById("onlineProductCount");
const onlineProductShopCount = document.getElementById("onlineProductShopCount");
const onlineProductSyncInfo = document.getElementById("onlineProductSyncInfo");
const onlineStatusTabs = document.getElementById("onlineStatusTabs");
const onlineTableWrap = document.getElementById("onlineTableWrap");
const onlineProductsTableBody = document.getElementById("onlineProductsTableBody");
const ozonProductCount = document.getElementById("ozonProductCount");
const ozonProductShopCount = document.getElementById("ozonProductShopCount");
const ozonProductSyncInfo = document.getElementById("ozonProductSyncInfo");
const ozonProductMessage = document.getElementById("ozonProductMessage");
const ozonProductsTableBody = document.getElementById("ozonProductsTableBody");
const syncOzonProductsBtn = document.getElementById("syncOzonProductsBtn");
const ozonProductStatusTabs = document.getElementById("ozonProductStatusTabs");
let ozonProductStatusFilter = "all";
const onlineHeaderSelectAll = document.getElementById("onlineHeaderSelectAll");
const onlineSelectAllBtn = document.getElementById("onlineSelectAllBtn");
const onlineInvertSelectBtn = document.getElementById("onlineInvertSelectBtn");
const onlineSelectedCount = document.getElementById("onlineSelectedCount");
const onlineBatchDeleteBtn = document.getElementById("onlineBatchDeleteBtn");
const onlineBatchInventoryBtn = document.getElementById("onlineBatchInventoryBtn");
const onlineExportBtn = document.getElementById("onlineExportBtn");
const onlineCopyToPublishBtn = document.getElementById("onlineCopyToPublishBtn");
const onlineCopyPublishModalMask = document.getElementById("onlineCopyPublishModalMask");
const closeOnlineCopyPublishModalBtn = document.getElementById("closeOnlineCopyPublishModalBtn");
const cancelOnlineCopyPublishBtn = document.getElementById("cancelOnlineCopyPublishBtn");
const onlineCopyPublishForm = document.getElementById("onlineCopyPublishForm");
const onlineCopyPublishPlatform = document.getElementById("onlineCopyPublishPlatform");
const onlineCopyPublishShop = document.getElementById("onlineCopyPublishShop");
const onlineCopyPublishPriceStrategy = document.getElementById("onlineCopyPublishPriceStrategy");
const onlineCopyPublishAiMode = document.getElementById("onlineCopyPublishAiMode");
const onlineCopyPublishOverwrite = document.getElementById("onlineCopyPublishOverwrite");
const onlineCopyPublishDryRun = document.getElementById("onlineCopyPublishDryRun");
const onlineCopyPublishSelectionInfo = document.getElementById("onlineCopyPublishSelectionInfo");
const onlineCopyPublishMessage = document.getElementById("onlineCopyPublishMessage");
const onlineCopyPublishPreview = document.getElementById("onlineCopyPublishPreview");
const onlineGotoPage = document.getElementById("onlineGotoPage");
const onlinePageSize = document.getElementById("onlinePageSize");
const onlineInventoryModalMask = document.getElementById("onlineInventoryModalMask");
const closeOnlineInventoryModalBtn = document.getElementById("closeOnlineInventoryModalBtn");
const onlineInventoryForm = document.getElementById("onlineInventoryForm");
const onlineInventoryMessage = document.getElementById("onlineInventoryMessage");
const onlineExportModalMask = document.getElementById("onlineExportModalMask");
const closeOnlineExportModalBtn = document.getElementById("closeOnlineExportModalBtn");
const cancelOnlineExportBtn = document.getElementById("cancelOnlineExportBtn");
const onlineExportForm = document.getElementById("onlineExportForm");
const onlineExportColumns = document.getElementById("onlineExportColumns");
const onlineExportSummary = document.getElementById("onlineExportSummary");
const onlineExportMessage = document.getElementById("onlineExportMessage");
const onlineExportSelectAllBtn = document.getElementById("onlineExportSelectAllBtn");
const onlineExportResetBtn = document.getElementById("onlineExportResetBtn");
const onlineSourceModalMask = document.getElementById("onlineSourceModalMask");
const closeOnlineSourceModalBtn = document.getElementById("closeOnlineSourceModalBtn");
const cancelOnlineSourceBtn = document.getElementById("cancelOnlineSourceBtn");
const onlineSourceForm = document.getElementById("onlineSourceForm");
const onlineSourceMessage = document.getElementById("onlineSourceMessage");
const onlineSourceType = document.getElementById("onlineSourceType");
const onlineSourceNote = document.getElementById("onlineSourceNote");
const onlineSourceLink = document.getElementById("onlineSourceLink");
const onlineSourceLink2 = document.getElementById("onlineSourceLink2");
const onlineSourcePurchasePriceRmb = document.getElementById("onlineSourcePurchasePriceRmb");
const onlineSourcePurchasePriceRub = document.getElementById("onlineSourcePurchasePriceRub");
const onlineSourceSalePrice = document.getElementById("onlineSourceSalePrice");
const onlineSourceOriginalPrice = document.getElementById("onlineSourceOriginalPrice");
const onlineSourceStockCount = document.getElementById("onlineSourceStockCount");
const onlineSourcePackageLengthCm = document.getElementById("onlineSourcePackageLengthCm");
const onlineSourcePackageWidthCm = document.getElementById("onlineSourcePackageWidthCm");
const onlineSourcePackageHeightCm = document.getElementById("onlineSourcePackageHeightCm");
const onlineSourceWeightKg = document.getElementById("onlineSourceWeightKg");
const onlinePrevPageBtn = document.getElementById("onlinePrevPageBtn");
const onlineNextPageBtn = document.getElementById("onlineNextPageBtn");
const onlinePaginationInfo = document.getElementById("onlinePaginationInfo");
const onlineIslandScrollbar = document.getElementById("onlineIslandScrollbar");
const onlineIslandScrollbarInner = document.getElementById("onlineIslandScrollbarInner");
const onlineCommissionModalMask = document.getElementById("onlineCommissionModalMask");
const closeOnlineCommissionModalBtn = document.getElementById("closeOnlineCommissionModalBtn");
const onlineCommissionTableBody = document.getElementById("onlineCommissionTableBody");
const onlineCommissionMessage = document.getElementById("onlineCommissionMessage");
let isSyncingOnlineScroll = false;
let isDraggingOnlineScrollbar = false;
let onlineScrollbarDragStartX = 0;
let onlineScrollbarDragStartLeft = 0;
let activeOnlineSourceProductId = "";

function bindOnlineProductsEvents() {
  if (syncOnlineProductsBtn) syncOnlineProductsBtn.addEventListener("click", onSyncOnlineProducts);
  if (refreshCardQualityBtn) refreshCardQualityBtn.addEventListener("click", onRefreshCardQuality);
  if (onlineCommissionUnmatchedBtn) onlineCommissionUnmatchedBtn.addEventListener("click", openOnlineCommissionModal);
  if (onlineProductFilterForm) onlineProductFilterForm.addEventListener("submit", onOnlineProductFilterSubmit);
  if (onlineProductSaveBtn) onlineProductSaveBtn.addEventListener("click", onOnlineProductFilterSave);
  if (onlineProductResetBtn) onlineProductResetBtn.addEventListener("click", onOnlineProductFilterReset);
  if (onlinePrevPageBtn) onlinePrevPageBtn.addEventListener("click", () => changeOnlinePage(state.onlineCurrentPage - 1));
  if (onlineNextPageBtn) onlineNextPageBtn.addEventListener("click", () => changeOnlinePage(state.onlineCurrentPage + 1));
  if (onlineStatusTabs) onlineStatusTabs.addEventListener("click", onOnlineStatusTabClick);
  if (onlineProductsTableBody) onlineProductsTableBody.addEventListener("change", onOnlineTableChange);
  if (onlineProductsTableBody) onlineProductsTableBody.addEventListener("click", onOnlineTableClick);
  if (onlineHeaderSelectAll) onlineHeaderSelectAll.addEventListener("change", onOnlineSelectAllChange);
  if (onlineSelectAllBtn) onlineSelectAllBtn.addEventListener("click", () => onOnlineSelectAllButton(true));
  if (onlineInvertSelectBtn) onlineInvertSelectBtn.addEventListener("click", onOnlineInvertSelect);
  if (onlineBatchDeleteBtn) onlineBatchDeleteBtn.addEventListener("click", onOnlineBatchDelete);
  if (onlineBatchInventoryBtn) onlineBatchInventoryBtn.addEventListener("click", openOnlineInventoryModal);
  if (onlineExportBtn) onlineExportBtn.addEventListener("click", openOnlineExportModal);
  if (onlineCopyToPublishBtn) onlineCopyToPublishBtn.addEventListener("click", openOnlineCopyPublishModal);
  if (closeOnlineCopyPublishModalBtn) closeOnlineCopyPublishModalBtn.addEventListener("click", closeOnlineCopyPublishModal);
  if (cancelOnlineCopyPublishBtn) cancelOnlineCopyPublishBtn.addEventListener("click", closeOnlineCopyPublishModal);
  if (onlineCopyPublishModalMask) onlineCopyPublishModalMask.addEventListener("click", onOnlineCopyPublishMaskClick);
  if (onlineCopyPublishPlatform) onlineCopyPublishPlatform.addEventListener("change", populateOnlineCopyPublishShops);
  if (onlineCopyPublishForm) onlineCopyPublishForm.addEventListener("submit", onOnlineCopyPublishSubmit);
  if (closeOnlineInventoryModalBtn) closeOnlineInventoryModalBtn.addEventListener("click", closeOnlineInventoryModal);
  if (onlineInventoryModalMask) onlineInventoryModalMask.addEventListener("click", onOnlineInventoryMaskClick);
  if (onlineInventoryForm) onlineInventoryForm.addEventListener("submit", onOnlineInventorySubmit);
  if (closeOnlineExportModalBtn) closeOnlineExportModalBtn.addEventListener("click", closeOnlineExportModal);
  if (cancelOnlineExportBtn) cancelOnlineExportBtn.addEventListener("click", closeOnlineExportModal);
  if (onlineExportModalMask) onlineExportModalMask.addEventListener("click", onOnlineExportMaskClick);
  if (onlineExportForm) onlineExportForm.addEventListener("submit", onOnlineExportSubmit);
  if (onlineExportSelectAllBtn) onlineExportSelectAllBtn.addEventListener("click", onOnlineExportSelectAll);
  if (onlineExportResetBtn) onlineExportResetBtn.addEventListener("click", onOnlineExportReset);
  if (closeOnlineCommissionModalBtn) closeOnlineCommissionModalBtn.addEventListener("click", closeOnlineCommissionModal);
  if (onlineCommissionModalMask) onlineCommissionModalMask.addEventListener("click", onOnlineCommissionMaskClick);
  if (closeOnlineSourceModalBtn) closeOnlineSourceModalBtn.addEventListener("click", closeOnlineSourceModal);
  if (cancelOnlineSourceBtn) cancelOnlineSourceBtn.addEventListener("click", closeOnlineSourceModal);
  if (onlineSourceModalMask) onlineSourceModalMask.addEventListener("click", onOnlineSourceMaskClick);
  if (onlineSourceForm) onlineSourceForm.addEventListener("submit", onOnlineSourceSubmit);
  if (onlineGotoPage) onlineGotoPage.addEventListener("change", onOnlineGotoPage);
  if (onlinePageSize) onlinePageSize.addEventListener("change", onOnlinePageSizeChange);
  if (onlineTableWrap) onlineTableWrap.addEventListener("scroll", syncOnlineIslandScrollbarFromTable);
  if (onlineIslandScrollbar) {
  onlineIslandScrollbar.addEventListener("click", onOnlineIslandScrollbarClick);
  onlineIslandScrollbar.addEventListener("mousedown", onOnlineIslandScrollbarMouseDown);
  }
  document.addEventListener("mousemove", onOnlineIslandScrollbarMouseMove);
  document.addEventListener("mouseup", onOnlineIslandScrollbarMouseUp);
  bindRmbToRubAutoFill(onlineSourcePurchasePriceRmb, onlineSourcePurchasePriceRub);
  window.addEventListener("resize", syncOnlineIslandScrollbarMetrics);
  if (syncOzonProductsBtn) syncOzonProductsBtn.addEventListener("click", onSyncOzonProducts);
  if (ozonProductStatusTabs) ozonProductStatusTabs.addEventListener("click", onOzonProductStatusTabClick);
}
