function renderYandexCommissionCatalog(catalog) {
  const itemCount = Number(catalog?.itemCount || 0) || 0;
  const sample = Array.isArray(catalog?.items) ? catalog.items : [];
  const page = Number(catalog?.page || state.yandexCommissionPage || 1) || 1;
  const pageSize = Number(catalog?.pageSize || state.yandexCommissionPageSize || 20) || 20;
  const totalPages = Number(catalog?.totalPages || Math.max(1, Math.ceil(itemCount / Math.max(1, pageSize)))) || 1;
  const catalogFetchedAt = String(catalog?.fetchedAt || "").trim();
  state.yandexCommissionTotal = itemCount;
  state.yandexCommissionPage = Math.min(totalPages, Math.max(1, page));
  const formatPercent = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "-";

  if (yandexCommissionSampleBody) {
    if (!sample.length) {
      yandexCommissionSampleBody.innerHTML = "<tr><td colspan='6'>当前页暂无数据，请先计算。</td></tr>";
    } else {
      yandexCommissionSampleBody.innerHTML = sample
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(String(item.shopName || item.shopId || "-"))}</td>
              <td title="${escapeHtml(String(item.categoryRu || ""))}">${escapeHtml(String(item.categoryRu || "-"))}</td>
              <td title="${escapeHtml(String(item.categoryZh || ""))}">${escapeHtml(String(item.categoryZh || "-"))}</td>
              <td title="${escapeHtml(String(item.categoryEn || ""))}">${escapeHtml(String(item.categoryEn || "-"))}</td>
              <td>${escapeHtml(formatPercent(item.commissionPercent))}</td>
              <td>${escapeHtml(formatDateTime(item.fetchedAt || catalogFetchedAt))}</td>
            </tr>
          `
        )
        .join("");
    }
  }

  if (yandexCommissionMessage) {
    yandexCommissionMessage.style.color = "#1d6f3a";
    yandexCommissionMessage.textContent = catalog?.warning || `已加载 ${itemCount} 条由 Yandex API 计算的类目佣金`;
  }
  if (yandexCommissionPageInfo) {
    yandexCommissionPageInfo.textContent = `第 ${state.yandexCommissionPage} / ${totalPages} 页，共 ${itemCount.toLocaleString()} 条`;
  }
  if (yandexCommissionPrevBtn) yandexCommissionPrevBtn.disabled = state.yandexCommissionPage <= 1;
  if (yandexCommissionNextBtn) yandexCommissionNextBtn.disabled = state.yandexCommissionPage >= totalPages;
}

async function loadYandexCommissionCatalog(page = state.yandexCommissionPage || 1) {
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(10, Number(state.yandexCommissionPageSize || 20) || 20);
  const result = await apiRequest(`/api/market-category-commissions?platform=yandex&page=${pageNum}&pageSize=${pageSize}`, { method: "GET" });
  if (!result.ok) {
    if (yandexCommissionMessage) {
      yandexCommissionMessage.style.color = "#c02030";
      yandexCommissionMessage.textContent = result.error || "加载 Yandex 佣金失败";
    }
    if (yandexCommissionSampleBody) yandexCommissionSampleBody.innerHTML = "<tr><td colspan='6'>加载失败</td></tr>";
    return;
  }
  state.yandexCommissionCatalog = result.data || null;
  renderYandexCommissionCatalog(state.yandexCommissionCatalog);
}

async function onSyncYandexCommissionCatalog() {
  if (!syncYandexCommissionBtn) return;
  syncYandexCommissionBtn.disabled = true;
  if (yandexCommissionMessage) {
    yandexCommissionMessage.style.color = "#2f3d63";
    yandexCommissionMessage.textContent = "正在调用 Yandex API 计算在线产品佣金...";
  }
  const result = await apiRequest("/api/market-category-commissions/sync", { method: "POST", body: JSON.stringify({ platform: "yandex" }) });
  syncYandexCommissionBtn.disabled = false;
  if (!result.ok) {
    if (yandexCommissionMessage) {
      yandexCommissionMessage.style.color = "#c02030";
      yandexCommissionMessage.textContent = result.error || "同步失败";
    }
    return;
  }
  state.yandexCommissionPage = 1;
  await loadYandexCommissionCatalog(1);
}

function onYandexCommissionPageChange(delta) {
  const current = Number(state.yandexCommissionPage || 1) || 1;
  const next = Math.max(1, current + Number(delta || 0));
  loadYandexCommissionCatalog(next);
}

async function loadOzonCommissionCatalog(page = state.ozonCommissionPage || 1) {
  if (!ozonCommissionTableBody) return;
  const pageNum = Math.max(1, Number(page) || 1);
  const result = await apiRequest(`/api/market-category-commissions?platform=ozon&page=${pageNum}&pageSize=200`, { method: "GET" });
  if (!result.ok) {
    ozonCommissionTableBody.innerHTML = "<tr><td colspan='3'>加载失败</td></tr>";
    if (ozonCommissionMessage) {
      ozonCommissionMessage.style.color = "#c02030";
      ozonCommissionMessage.textContent = result.error || "加载 Ozon 佣金失败";
    }
    return;
  }
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  const itemCount = Number(result.data?.itemCount || items.length) || 0;
  const totalPages = Number(result.data?.totalPages || 1) || 1;
  state.ozonCommissionPage = Math.min(totalPages, pageNum);
  const formatPercent = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : "-";
  ozonCommissionTableBody.innerHTML = items.length ? items.map((item) => `
    <tr>
      <td>${escapeHtml(String(item.categoryId || "-").replace(/^type:/, ""))}</td>
      <td>${escapeHtml(Number.isFinite(Number(item.commissionPercent)) ? formatPercent(item.commissionPercent) : "待获取")}</td>
      <td>${escapeHtml(formatDateTime(item.fetchedAt))}</td>
    </tr>`).join("") : "<tr><td colspan='3'>暂无 Ozon Type ID 数据，请先同步。</td></tr>";
  if (ozonCommissionMessage) {
    ozonCommissionMessage.style.color = "#1d6f3a";
    ozonCommissionMessage.textContent = `已加载 ${itemCount.toLocaleString()} 条 Ozon 类目数据`;
  }
  if (ozonCommissionPageInfo) ozonCommissionPageInfo.textContent = `第 ${state.ozonCommissionPage} / ${totalPages} 页，共 ${itemCount.toLocaleString()} 条`;
  if (ozonCommissionPrevBtn) ozonCommissionPrevBtn.disabled = state.ozonCommissionPage <= 1;
  if (ozonCommissionNextBtn) ozonCommissionNextBtn.disabled = state.ozonCommissionPage >= totalPages;
}

async function onSyncOzonCommissionCatalog() {
  if (!syncOzonCommissionBtn) return;
  syncOzonCommissionBtn.disabled = true;
  if (ozonCommissionMessage) {
    ozonCommissionMessage.style.color = "#2f3d63";
    ozonCommissionMessage.textContent = "正在从 Ozon Seller API 同步佣金...";
  }
  const result = await apiRequest("/api/market-category-commissions/sync", { method: "POST", body: JSON.stringify({ platform: "ozon" }) });
  syncOzonCommissionBtn.disabled = false;
  if (!result.ok) {
    if (ozonCommissionMessage) {
      ozonCommissionMessage.style.color = "#c02030";
      ozonCommissionMessage.textContent = result.error || "同步 Ozon 佣金失败";
    }
    return;
  }
  await loadOzonCommissionCatalog();
}

async function onSyncOzonFullCategoryCatalog() {
  if (!syncOzonFullCategoryBtn) return;
  syncOzonFullCategoryBtn.disabled = true;
  if (syncOzonCommissionBtn) syncOzonCommissionBtn.disabled = true;
  if (ozonCommissionMessage) {
    ozonCommissionMessage.style.color = "#2f3d63";
    ozonCommissionMessage.textContent = "正在从 Ozon Seller API 同步全量类目与可用佣金...";
  }
  const result = await apiRequest("/api/market-category-commissions/sync", { method: "POST", body: JSON.stringify({ platform: "ozon", scope: "full" }) });
  syncOzonFullCategoryBtn.disabled = false;
  if (syncOzonCommissionBtn) syncOzonCommissionBtn.disabled = false;
  if (!result.ok) {
    if (ozonCommissionMessage) {
      ozonCommissionMessage.style.color = "#c02030";
      ozonCommissionMessage.textContent = result.error || "同步全量 Ozon 类目失败";
    }
    return;
  }
  state.ozonCommissionPage = 1;
  await loadOzonCommissionCatalog(1);
}

function onLogisticsTabClick(event) {
  const btn = event.target.closest("button[data-logistics-tab]");
  if (!btn) return;
  const tab = btn.dataset.logisticsTab;
  logisticsTabs.querySelectorAll("button[data-logistics-tab]").forEach((b) => b.classList.toggle("active", b === btn));
  if (logisticsYandex) logisticsYandex.classList.toggle("hidden", tab !== "yandex");
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const syncYandexCommissionBtn = document.getElementById("syncYandexCommissionBtn");
const yandexCommissionMessage = document.getElementById("yandexCommissionMessage");
const yandexCommissionSampleBody = document.getElementById("yandexCommissionSampleBody");
const yandexCommissionPrevBtn = document.getElementById("yandexCommissionPrevBtn");
const yandexCommissionNextBtn = document.getElementById("yandexCommissionNextBtn");
const yandexCommissionPageInfo = document.getElementById("yandexCommissionPageInfo");
const syncOzonCommissionBtn = document.getElementById("syncOzonCommissionBtn");
const syncOzonFullCategoryBtn = document.getElementById("syncOzonFullCategoryBtn");
const ozonCommissionMessage = document.getElementById("ozonCommissionMessage");
const ozonCommissionTableBody = document.getElementById("ozonCommissionTableBody");
const ozonCommissionPrevBtn = document.getElementById("ozonCommissionPrevBtn");
const ozonCommissionNextBtn = document.getElementById("ozonCommissionNextBtn");
const ozonCommissionPageInfo = document.getElementById("ozonCommissionPageInfo");
const logisticsTabs = document.getElementById("logisticsTabs");
const logisticsYandex = document.getElementById("logisticsYandex");

function bindCommissionsEvents() {
  if (syncYandexCommissionBtn) syncYandexCommissionBtn.addEventListener("click", onSyncYandexCommissionCatalog);
  if (yandexCommissionPrevBtn) yandexCommissionPrevBtn.addEventListener("click", () => onYandexCommissionPageChange(-1));
  if (yandexCommissionNextBtn) yandexCommissionNextBtn.addEventListener("click", () => onYandexCommissionPageChange(1));
  if (syncOzonCommissionBtn) syncOzonCommissionBtn.addEventListener("click", onSyncOzonCommissionCatalog);
  if (syncOzonFullCategoryBtn) syncOzonFullCategoryBtn.addEventListener("click", onSyncOzonFullCategoryCatalog);
  if (ozonCommissionPrevBtn) ozonCommissionPrevBtn.addEventListener("click", () => loadOzonCommissionCatalog((state.ozonCommissionPage || 1) - 1));
  if (ozonCommissionNextBtn) ozonCommissionNextBtn.addEventListener("click", () => loadOzonCommissionCatalog((state.ozonCommissionPage || 1) + 1));
  if (logisticsTabs) logisticsTabs.addEventListener("click", onLogisticsTabClick);
}
