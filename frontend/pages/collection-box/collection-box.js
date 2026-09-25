const COLLECTION_BOX_PAGE_SIZE = 20;

function getCollectionBoxFilters() {
  return state.collectionBoxFilters || { keyword: "", sourcePlatform: "", status: "" };
}

function getCollectionBoxStatusLabel(group) {
  if (group === "published") return "已刊登";
  if (group === "failed") return "失败";
  return "待刊登";
}

function getCollectionBoxStatusClass(group) {
  if (group === "published") return "published";
  if (group === "failed") return "failed";
  return "pending";
}

function getCollectionBoxAiLabel(status) {
  const key = String(status || "").trim().toLowerCase();
  if (key === "succeeded" || key === "success" || key === "done") return "已生成";
  if (key === "queued" || key === "pending" || key === "processing") return "生成中";
  if (key === "failed" || key === "error") return "生成失败";
  return status ? String(status) : "未生成";
}

async function loadCollectionBox() {
  if (!collectionBoxTableBody) return false;
  if (!can("productRead")) {
    collectionBoxTableBody.innerHTML = "<tr><td colspan='7'>无权限查看采集箱</td></tr>";
    if (collectionBoxMessage) collectionBoxMessage.textContent = "无权查看";
    return false;
  }
  if (collectionBoxMessage) {
    collectionBoxMessage.style.color = "#2f3d63";
    collectionBoxMessage.textContent = "正在加载采集箱...";
  }
  collectionBoxTableBody.innerHTML = "<tr><td colspan='7'>加载中...</td></tr>";
  const filters = getCollectionBoxFilters();
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Number(state.collectionBoxPage || 1) || 1)));
  params.set("pageSize", String(Math.max(1, Number(state.collectionBoxPageSize || COLLECTION_BOX_PAGE_SIZE) || COLLECTION_BOX_PAGE_SIZE)));
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.sourcePlatform) params.set("sourcePlatform", filters.sourcePlatform);
  if (filters.status) params.set("status", filters.status);
  const result = await apiRequest(`/api/collection-box?${params.toString()}`, { method: "GET" });
  if (!result.ok) {
    if (collectionBoxMessage) {
      collectionBoxMessage.style.color = "#c02030";
      collectionBoxMessage.textContent = result.error || "采集箱加载失败";
    }
    collectionBoxTableBody.innerHTML = "<tr><td colspan='7'>加载失败</td></tr>";
    state.collectionBoxItems = [];
    renderCollectionBoxSummary({});
    renderCollectionBoxPagination({ totalPages: 1 });
    return false;
  }
  const data = result.data || {};
  state.collectionBoxItems = Array.isArray(data.items) ? data.items : [];
  state.collectionBoxPagination = data.pagination || {};
  state.collectionBoxPage = Number(state.collectionBoxPagination.page || state.collectionBoxPage || 1) || 1;
  state.collectionBoxPageSize = Number(state.collectionBoxPagination.pageSize || state.collectionBoxPageSize || COLLECTION_BOX_PAGE_SIZE) || COLLECTION_BOX_PAGE_SIZE;
  const currentIds = new Set(state.collectionBoxItems.map((item) => String(item.id || "")));
  state.collectionBoxSelectedIds = (state.collectionBoxSelectedIds || []).filter((id) => currentIds.has(String(id)));
  renderCollectionBoxSummary(data.summary || {});
  renderCollectionBoxTable();
  renderCollectionBoxPagination(state.collectionBoxPagination);
  if (collectionBoxMessage) collectionBoxMessage.textContent = "";
  return true;
}

function renderCollectionBoxSummary(summary) {
  const data = summary && typeof summary === "object" ? summary : {};
  if (collectionBoxTotal) collectionBoxTotal.textContent = String(Number(data.total || 0) || 0);
  if (collectionBoxPending) collectionBoxPending.textContent = String(Number(data.pending || 0) || 0);
  if (collectionBoxPublished) collectionBoxPublished.textContent = String(Number(data.published || 0) || 0);
  if (collectionBoxFailed) collectionBoxFailed.textContent = String(Number(data.failed || 0) || 0);
}

function renderCollectionBoxTable() {
  if (!collectionBoxTableBody) return;
  const items = Array.isArray(state.collectionBoxItems) ? state.collectionBoxItems : [];
  const selectedSet = new Set((state.collectionBoxSelectedIds || []).map(String));
  if (!items.length) {
    collectionBoxTableBody.innerHTML = "<tr><td colspan='7'><div class='table-empty'>暂无采集商品</div><div class='table-empty-hint'>采集器投递进来后会自动出现在这里</div></td></tr>";
    syncCollectionBoxSelectionUi();
    return;
  }
  collectionBoxTableBody.innerHTML = items.map((item) => {
    const id = String(item.id || "");
    const checked = selectedSet.has(id) ? "checked" : "";
    const platform = String(item.sourcePlatform || "").trim().toLowerCase();
    const platformLabel = platform === "ozon" ? "Ozon" : platform === "yandex" ? "Yandex" : (platform || "-");
    const sourceUrl = safeExternalUrl(String(item.sourceUrl || ""));
    const sourceLine = [
      item.sourceProductId ? `ID: ${escapeHtml(String(item.sourceProductId))}` : "",
      sourceUrl ? `<a class="link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ""
    ].filter(Boolean).join("");
    const imageUrl = String(item.imageUrl || "").trim();
    const statusGroup = String(item.statusGroup || "pending");
    const collectedText = item.createdAt ? formatDateTime(item.createdAt) : "";
    const [collectedDate = "-", collectedTime = ""] = collectedText.split(" ");
    return `
      <tr>
        <td><input type="checkbox" data-collection-box-id="${escapeHtml(id)}" ${checked} /></td>
        <td><div class="collection-time"><span>${escapeHtml(collectedDate)}</span>${collectedTime ? `<span class="time-part">${escapeHtml(collectedTime)}</span>` : ""}</div></td>
        <td class="collection-source-cell"><span class="platform-name">${escapeHtml(platformLabel)}</span><div class="product-sub">${sourceLine || "来源信息缺失"}</div></td>
        <td>
          <div class="online-product-info">
            <div class="product-thumb small">
              ${imageUrl ? `<img src="${escapeHtml(safeImageUrl(imageUrl))}" alt="product" referrerpolicy="no-referrer" />` : "<span class='thumb-placeholder'>暂无图片</span>"}
            </div>
            <div class="product-info">
              <div class="product-title clamp-2">${escapeHtml(item.title || "-")}</div>
              <div class="product-sub">SKU: ${escapeHtml(item.sku || "-")}</div>
            </div>
          </div>
        </td>
        <td><span class="collection-ai">${escapeHtml(getCollectionBoxAiLabel(item.aiImageStatus))}</span></td>
        <td><span class="collection-status ${getCollectionBoxStatusClass(statusGroup)}">${escapeHtml(getCollectionBoxStatusLabel(statusGroup))}</span></td>
        <td><button type="button" class="link-btn" data-collection-box-publish="${escapeHtml(id)}">去刊登</button></td>
      </tr>
    `;
  }).join("");
  syncCollectionBoxSelectionUi();
}

function renderCollectionBoxPagination(pagination) {
  const data = pagination && typeof pagination === "object" ? pagination : {};
  const page = Math.max(1, Number(state.collectionBoxPage || 1) || 1);
  const totalPages = Math.max(1, Number(data.totalPages || 1) || 1);
  const total = Number(data.total || 0) || 0;
  if (collectionBoxPaginationInfo) {
    collectionBoxPaginationInfo.textContent = `第 ${page} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  }
  if (collectionBoxPrevPageBtn) collectionBoxPrevPageBtn.disabled = page <= 1;
  if (collectionBoxNextPageBtn) collectionBoxNextPageBtn.disabled = page >= totalPages;
}

function syncCollectionBoxSelectionUi() {
  const items = Array.isArray(state.collectionBoxItems) ? state.collectionBoxItems : [];
  const selected = new Set((state.collectionBoxSelectedIds || []).map(String));
  if (collectionBoxSelectAll) {
    collectionBoxSelectAll.checked = items.length > 0 && items.every((item) => selected.has(String(item.id || "")));
  }
  if (deleteCollectionBoxSelectedBtn) deleteCollectionBoxSelectedBtn.disabled = selected.size === 0;
}

function onCollectionBoxFilterSubmit(event) {
  event.preventDefault();
  const form = new FormData(collectionBoxFilterForm);
  state.collectionBoxFilters = {
    keyword: String(form.get("keyword") || "").trim(),
    sourcePlatform: String(form.get("sourcePlatform") || "").trim(),
    status: String(form.get("status") || "").trim()
  };
  state.collectionBoxPage = 1;
  loadCollectionBox();
}

function onCollectionBoxFilterReset() {
  if (collectionBoxFilterForm) collectionBoxFilterForm.reset();
  state.collectionBoxFilters = { keyword: "", sourcePlatform: "", status: "" };
  state.collectionBoxPage = 1;
  loadCollectionBox();
}

function changeCollectionBoxPage(nextPage) {
  const totalPages = Math.max(1, Number(state.collectionBoxPagination?.totalPages || 1) || 1);
  const page = Math.min(Math.max(1, Number(nextPage) || 1), totalPages);
  if (page === (state.collectionBoxPage || 1)) return;
  state.collectionBoxPage = page;
  loadCollectionBox();
}

function onCollectionBoxTableChange(event) {
  const checkbox = event.target.closest("input[data-collection-box-id]");
  if (!checkbox) return;
  const id = String(checkbox.dataset.collectionBoxId || "").trim();
  if (!id) return;
  const selected = new Set((state.collectionBoxSelectedIds || []).map(String));
  if (checkbox.checked) selected.add(id);
  else selected.delete(id);
  state.collectionBoxSelectedIds = Array.from(selected);
  syncCollectionBoxSelectionUi();
}

function onCollectionBoxSelectAllChange() {
  const items = Array.isArray(state.collectionBoxItems) ? state.collectionBoxItems : [];
  state.collectionBoxSelectedIds = collectionBoxSelectAll?.checked
    ? items.map((item) => String(item.id || "")).filter(Boolean)
    : [];
  renderCollectionBoxTable();
}

function onCollectionBoxTableClick(event) {
  const publishBtn = event.target.closest("[data-collection-box-publish]");
  if (publishBtn) {
    window.location.hash = "#publish";
  }
}

async function onDeleteCollectionBoxSelected() {
  const ids = (state.collectionBoxSelectedIds || []).map(String).filter(Boolean);
  if (!ids.length) {
    if (collectionBoxMessage) {
      collectionBoxMessage.style.color = "#c02030";
      collectionBoxMessage.textContent = "请先选择要删除的采集商品";
    }
    return;
  }
  if (!window.confirm(`确认从采集箱删除选中的 ${ids.length} 条采集商品？`)) return;
  const result = await apiRequest("/api/collection-box", {
    method: "DELETE",
    body: JSON.stringify({ ids })
  });
  if (!result.ok) {
    if (collectionBoxMessage) {
      collectionBoxMessage.style.color = "#c02030";
      collectionBoxMessage.textContent = result.error || "删除失败";
    }
    return;
  }
  state.collectionBoxSelectedIds = [];
  if (collectionBoxMessage) {
    collectionBoxMessage.style.color = "#1d6f3a";
    collectionBoxMessage.textContent = `已删除 ${Number(result.data?.removed || 0)} 条采集商品`;
  }
  await loadCollectionBox();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const collectionBoxTableBody = document.getElementById("collectionBoxTableBody");
const collectionBoxMessage = document.getElementById("collectionBoxMessage");
const collectionBoxTotal = document.getElementById("collectionBoxTotal");
const collectionBoxPending = document.getElementById("collectionBoxPending");
const collectionBoxPublished = document.getElementById("collectionBoxPublished");
const collectionBoxFailed = document.getElementById("collectionBoxFailed");
const collectionBoxFilterForm = document.getElementById("collectionBoxFilterForm");
const resetCollectionBoxFilterBtn = document.getElementById("resetCollectionBoxFilterBtn");
const refreshCollectionBoxBtn = document.getElementById("refreshCollectionBoxBtn");
const deleteCollectionBoxSelectedBtn = document.getElementById("deleteCollectionBoxSelectedBtn");
const collectionBoxSelectAll = document.getElementById("collectionBoxSelectAll");
const collectionBoxPrevPageBtn = document.getElementById("collectionBoxPrevPageBtn");
const collectionBoxNextPageBtn = document.getElementById("collectionBoxNextPageBtn");
const collectionBoxPaginationInfo = document.getElementById("collectionBoxPaginationInfo");

function bindCollectionBoxEvents() {
  if (collectionBoxFilterForm) collectionBoxFilterForm.addEventListener("submit", onCollectionBoxFilterSubmit);
  if (resetCollectionBoxFilterBtn) resetCollectionBoxFilterBtn.addEventListener("click", onCollectionBoxFilterReset);
  if (refreshCollectionBoxBtn) refreshCollectionBoxBtn.addEventListener("click", () => loadCollectionBox());
  if (deleteCollectionBoxSelectedBtn) deleteCollectionBoxSelectedBtn.addEventListener("click", onDeleteCollectionBoxSelected);
  if (collectionBoxSelectAll) collectionBoxSelectAll.addEventListener("change", onCollectionBoxSelectAllChange);
  if (collectionBoxTableBody) collectionBoxTableBody.addEventListener("change", onCollectionBoxTableChange);
  if (collectionBoxTableBody) collectionBoxTableBody.addEventListener("click", onCollectionBoxTableClick);
  if (collectionBoxPrevPageBtn) collectionBoxPrevPageBtn.addEventListener("click", () => changeCollectionBoxPage((state.collectionBoxPage || 1) - 1));
  if (collectionBoxNextPageBtn) collectionBoxNextPageBtn.addEventListener("click", () => changeCollectionBoxPage((state.collectionBoxPage || 1) + 1));
}
