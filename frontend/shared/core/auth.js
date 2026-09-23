// 从 app.js 拆出的鉴权/登录模块（classic script，全局作用域）。

async function init() {
  applySidebarState(localStorage.getItem("sidebar_collapsed") === "1");

  const profile = await apiRequest("/api/profile", { method: "GET" });
  if (!profile.ok) {
    clearAuth();
    showAuth();
    return;
  }

  state.user = profile.data;
  restoreOnlineFiltersFromStorage();
  restoreOnlineExportColumnsFromStorage();
  showAdmin();
  await loadDashboardData();
}
function showAuth() {
  document.body.classList.remove("app-booting");
  document.body.classList.remove("admin-body-lock");
  authView.classList.remove("hidden");
  adminView.classList.add("hidden");
  if (contentMain) contentMain.classList.remove("orders-scroll-mode");
  stopRemainingTicker();
}
function showAdmin() {
  document.body.classList.remove("app-booting");
  document.body.classList.add("admin-body-lock");
  authView.classList.add("hidden");
  adminView.classList.remove("hidden");
  const companyName = String(state.user?.companyName || "").trim();
  currentUser.textContent = state.user.username;
  startRemainingTicker();

  const canManageUsers = can("userManage");
  const canReadAudit = canAuditRead();
  const canReadShops = canShopRead();
  const canUseProductAi = can("productAi");
  const canManageAiConfig = can("aiConfig");
  const canManageAiImageTasks = can("aiConfig");
  const canSyncOnline = can("productSync");
  const canManageReviewRules = can("productSync");
  const canManageCategoryMapping = can("productSync");

  document.querySelectorAll("[data-view='usersPanel']").forEach((el) => (el.style.display = canManageUsers ? "" : "none"));
  document.querySelectorAll("[data-view='apiPanel']").forEach((el) => (el.style.display = canReadShops ? "" : "none"));
  document.querySelectorAll("[data-view='logsPanel']").forEach((el) => (el.style.display = canReadAudit ? "" : "none"));
  document.querySelectorAll("[data-view='aiPanel']").forEach((el) => (el.style.display = canUseProductAi ? "" : "none"));
  document.querySelectorAll("[data-view='aiConfigPanel']").forEach((el) => (el.style.display = canManageAiConfig ? "" : "none"));
  document.querySelectorAll("[data-view='aiImageTaskPanel']").forEach((el) => (el.style.display = canManageAiImageTasks ? "" : "none"));
  document.querySelectorAll("[data-view='reviewRulesPanel']").forEach((el) => (el.style.display = canManageReviewRules ? "" : "none"));
  document.querySelectorAll("[data-view='categoryMappingPanel']").forEach((el) => (el.style.display = canManageCategoryMapping ? "" : "none"));
  if (syncOnlineProductsBtn) syncOnlineProductsBtn.classList.toggle("hidden", !canSyncOnline);
  if (onlineExportBtn) onlineExportBtn.classList.toggle("hidden", !can("productRead"));

  const activePanel = document.querySelector(".panel:not(.hidden)");
  if (!activePanel) return;
  const panelId = activePanel.id;
  const blocked = isPanelBlocked(panelId, {
    canManageUsers,
    canReadShops,
    canReadAudit,
    canUseProductAi,
    canManageAiConfig,
    canManageAiImageTasks,
    canManageCategoryMapping
  });
  if (blocked) switchPanel("reportsPanel");
}
async function onLoginSubmit(event) {
  event.preventDefault();
  loginMessage.textContent = "";

  const form = new FormData(loginForm);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (!validateLoginForm(username, password, loginMessage)) return;

  const result = await apiRequest("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (!result.ok) {
    loginMessage.textContent = result.error || "Login failed";
    return;
  }

  state.user = result.data.user;
  showAdmin();
  await loadDashboardData();
}
function validateCredentials(username, password, targetEl) {
  targetEl.style.color = "#c02030";
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    targetEl.textContent = "用户名格式不正确，需为 4-20 位字母、数字或下划线";
    return false;
  }
  if (password.length < 10 || password.length > 64) {
    targetEl.textContent = "密码长度需为 10-64 位";
    return false;
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    targetEl.textContent = "密码需同时包含大小写字母、数字和符号";
    return false;
  }
  const lowered = password.toLowerCase();
  const weakPatterns = ["123456", "password", "qwerty", "admin", "111111", "abc123"];
  if (weakPatterns.some((pattern) => lowered.includes(pattern))) {
    targetEl.textContent = "密码强度过低，请更换更安全的密码";
    return false;
  }
  if (lowered.includes(username.toLowerCase())) {
    targetEl.textContent = "密码中不能包含用户名";
    return false;
  }
  return true;
}
function validateLoginForm(username, password, targetEl) {
  targetEl.style.color = "#c02030";
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
    targetEl.textContent = "用户名格式不正确，需为 4-20 位字母、数字或下划线";
    return false;
  }
  if (!password || password.length > 256) {
    targetEl.textContent = "密码无效";
    return false;
  }
  return true;
}
async function onLogout() {
  await apiRequest("/api/logout", { method: "POST" });
  clearAuth();
  showAuth();
}
function clearAuth() {
  state.user = null;
  state.panelLoaded = {
    orders: false,
    ordersV2: false,
    onlineProducts: false,
    publishProducts: false,
    publishSettings: false,
    users: false,
    shops: false,
    messages: false,
    logs: false,
    reviewRules: false,
    categoryMapping: false,
    aiConfig: false,
    aiModels: false
  };
  state.orders = [];
  state.orderWorkspace = "v1";
  state.filteredOrders = [];
  state.currentPage = 1;
  state.ordersPagination = {
    page: 1,
    pageSize: PAGE_SIZE,
    total: 0,
    totalPages: 1
  };
  state.onlineProducts = [];
  state.onlineFilteredProducts = [];
  state.onlineCurrentPage = 1;
  state.onlinePageSize = DEFAULT_ONLINE_PAGE_SIZE;
  state.onlineSelectedIds = [];
  state.publishProducts = [];
  state.publishCurrentPage = 1;
  state.publishPageSize = DEFAULT_PUBLISH_PAGE_SIZE;
  state.publishSelectedIds = [];
  state.orderSync = {
    running: false,
    message: "",
    updatedAt: ""
  };
  state.reviewRules = [];
  state.categoryMappingRules = [];
  state.categoryMappingSamples = [];
  state.categoryMappingPlatform = "ozon";
  state.categoryMappingFetchedAt = "";
  state.financePurchaseRows = [];
  state.financeProfitRows = [];
  state.logs = [];
  state.logsCurrentPage = 1;
  state.shops = [];
  state.messages = [];
  state.aiModels = [];
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
    status: ""
  };
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
  state.cnyRateRub = null;
  updateGlobalSyncStatus(false, "");
}
