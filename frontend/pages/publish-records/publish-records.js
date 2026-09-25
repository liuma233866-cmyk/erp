const PUBLISH_RECORDS_PAGE_SIZE = 20;

function getPublishRecordsFilters() {
  return state.publishRecordsFilters || { keyword: "", status: "" };
}

async function loadPublishRecords() {
  if (!publishRecordsTableBody) return false;
  if (!can("productRead")) {
    publishRecordsTableBody.innerHTML = "<tr><td colspan='8'>无权限查看上架记录</td></tr>";
    if (publishRecordsMessage) publishRecordsMessage.textContent = "无权查看";
    return false;
  }
  if (publishRecordsMessage) {
    publishRecordsMessage.style.color = "#2f3d63";
    publishRecordsMessage.textContent = "正在加载上架记录...";
  }
  publishRecordsTableBody.innerHTML = "<tr><td colspan='8'>加载中...</td></tr>";
  const filters = getPublishRecordsFilters();
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Number(state.publishRecordsPage || 1) || 1)));
  params.set("pageSize", String(Math.max(1, Number(state.publishRecordsPageSize || PUBLISH_RECORDS_PAGE_SIZE) || PUBLISH_RECORDS_PAGE_SIZE)));
  if (filters.keyword) params.set("keyword", filters.keyword);
  if (filters.status) params.set("status", filters.status);
  const result = await apiRequest(`/api/publish-records?${params.toString()}`, { method: "GET" });
  if (!result.ok) {
    if (publishRecordsMessage) {
      publishRecordsMessage.style.color = "#c02030";
      publishRecordsMessage.textContent = result.error || "上架记录加载失败";
    }
    publishRecordsTableBody.innerHTML = "<tr><td colspan='8'>加载失败</td></tr>";
    state.publishRecords = [];
    renderPublishRecordsSummary({});
    renderPublishRecordsPagination({ totalPages: 1 });
    return false;
  }
  const data = result.data || {};
  state.publishRecords = Array.isArray(data.items) ? data.items : [];
  state.publishRecordsPagination = data.pagination || {};
  state.publishRecordsPage = Number(state.publishRecordsPagination.page || state.publishRecordsPage || 1) || 1;
  state.publishRecordsPageSize = Number(state.publishRecordsPagination.pageSize || state.publishRecordsPageSize || PUBLISH_RECORDS_PAGE_SIZE) || PUBLISH_RECORDS_PAGE_SIZE;
  renderPublishRecordsSummary(data.summary || {});
  renderPublishRecordsTable();
  renderPublishRecordsPagination(state.publishRecordsPagination);
  if (publishRecordsMessage) publishRecordsMessage.textContent = "";
  return true;
}

function renderPublishRecordsSummary(summary) {
  const data = summary && typeof summary === "object" ? summary : {};
  if (publishRecordsTotal) publishRecordsTotal.textContent = String(Number(data.total || 0) || 0);
  if (publishRecordsSuccess) publishRecordsSuccess.textContent = String(Number(data.success || 0) || 0);
  if (publishRecordsBlocked) publishRecordsBlocked.textContent = String(Number(data.blocked || 0) || 0);
  if (publishRecordsPending) publishRecordsPending.textContent = String(Number(data.pending || 0) || 0);
  if (publishRecordsFailed) publishRecordsFailed.textContent = String(Number(data.failed || 0) || 0);
}

function getPublishRecordResultMeta(record) {
  const result = String(record?.result || "").trim().toLowerCase() || (record?.success ? "success" : "failed");
  if (result === "blocked") return { key: "blocked", label: "已拦截" };
  if (result === "pending") return { key: "pending", label: "处理中" };
  if (result === "success") return { key: "success", label: "成功" };
  return { key: "failed", label: "失败" };
}

function renderPublishRecordsTable() {
  if (!publishRecordsTableBody) return;
  const records = Array.isArray(state.publishRecords) ? state.publishRecords : [];
  if (!records.length) {
    publishRecordsTableBody.innerHTML = "<tr><td colspan='8'><div class='table-empty'>暂无上架记录</div><div class='table-empty-hint'>在刊登工作台点刊登后会自动记录在这里</div></td></tr>";
    return;
  }
  publishRecordsTableBody.innerHTML = records.map((record) => {
    const meta = getPublishRecordResultMeta(record);
    const [recordDate = "-", recordTime = ""] = String(record.ts ? formatDateTime(record.ts) : "").split(" ");
    return `
      <tr>
        <td><div class="record-time"><span>${escapeHtml(record.ts ? recordDate : "-")}</span>${recordTime ? `<span class="time-part">${escapeHtml(recordTime)}</span>` : ""}</div></td>
        <td><span class="record-strong">${escapeHtml(record.shopName || record.shopId || "-")}</span></td>
        <td>${escapeHtml(record.platform || "-")}</td>
        <td><span class="record-strong">${escapeHtml(record.sku || "-")}</span></td>
        <td><div class="record-title">${escapeHtml(record.title || "-")}</div></td>
        <td><span class="publish-record-result ${meta.key}">${meta.label}</span></td>
        <td>${escapeHtml(record.actorUsername || "-")}</td>
        <td class="publish-record-message">${escapeHtml(record.message || "-")}</td>
      </tr>
    `;
  }).join("");
}

function renderPublishRecordsPagination(pagination) {
  const data = pagination && typeof pagination === "object" ? pagination : {};
  const page = Math.max(1, Number(state.publishRecordsPage || 1) || 1);
  const totalPages = Math.max(1, Number(data.totalPages || 1) || 1);
  const total = Number(data.total || 0) || 0;
  if (publishRecordsPaginationInfo) {
    publishRecordsPaginationInfo.textContent = `第 ${page} 页 / 共 ${totalPages} 页（共 ${total} 条）`;
  }
  if (publishRecordsPrevPageBtn) publishRecordsPrevPageBtn.disabled = page <= 1;
  if (publishRecordsNextPageBtn) publishRecordsNextPageBtn.disabled = page >= totalPages;
}

function onPublishRecordsFilterSubmit(event) {
  event.preventDefault();
  const form = new FormData(publishRecordsFilterForm);
  state.publishRecordsFilters = {
    keyword: String(form.get("keyword") || "").trim(),
    status: String(form.get("status") || "").trim()
  };
  state.publishRecordsPage = 1;
  loadPublishRecords();
}

function onPublishRecordsFilterReset() {
  if (publishRecordsFilterForm) publishRecordsFilterForm.reset();
  state.publishRecordsFilters = { keyword: "", status: "" };
  state.publishRecordsPage = 1;
  loadPublishRecords();
}

function changePublishRecordsPage(nextPage) {
  const totalPages = Math.max(1, Number(state.publishRecordsPagination?.totalPages || 1) || 1);
  const page = Math.min(Math.max(1, Number(nextPage) || 1), totalPages);
  if (page === (state.publishRecordsPage || 1)) return;
  state.publishRecordsPage = page;
  loadPublishRecords();
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const publishRecordsTableBody = document.getElementById("publishRecordsTableBody");
const publishRecordsMessage = document.getElementById("publishRecordsMessage");
const publishRecordsTotal = document.getElementById("publishRecordsTotal");
const publishRecordsSuccess = document.getElementById("publishRecordsSuccess");
const publishRecordsBlocked = document.getElementById("publishRecordsBlocked");
const publishRecordsPending = document.getElementById("publishRecordsPending");
const publishRecordsFailed = document.getElementById("publishRecordsFailed");
const publishRecordsFilterForm = document.getElementById("publishRecordsFilterForm");
const resetPublishRecordsFilterBtn = document.getElementById("resetPublishRecordsFilterBtn");
const refreshPublishRecordsBtn = document.getElementById("refreshPublishRecordsBtn");
const publishRecordsPrevPageBtn = document.getElementById("publishRecordsPrevPageBtn");
const publishRecordsNextPageBtn = document.getElementById("publishRecordsNextPageBtn");
const publishRecordsPaginationInfo = document.getElementById("publishRecordsPaginationInfo");

function bindPublishRecordsEvents() {
  if (publishRecordsFilterForm) publishRecordsFilterForm.addEventListener("submit", onPublishRecordsFilterSubmit);
  if (resetPublishRecordsFilterBtn) resetPublishRecordsFilterBtn.addEventListener("click", onPublishRecordsFilterReset);
  if (refreshPublishRecordsBtn) refreshPublishRecordsBtn.addEventListener("click", () => loadPublishRecords());
  if (publishRecordsPrevPageBtn) publishRecordsPrevPageBtn.addEventListener("click", () => changePublishRecordsPage((state.publishRecordsPage || 1) - 1));
  if (publishRecordsNextPageBtn) publishRecordsNextPageBtn.addEventListener("click", () => changePublishRecordsPage((state.publishRecordsPage || 1) + 1));
}
