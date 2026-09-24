const ACTIVE_PANEL_STORAGE_KEY = "erp_active_panel";

const PANEL_ROUTES = Object.freeze({
  reportsPanel: "home",
  productListPanel: "products",
  productOnlinePanel: "yandex-products",
  ozonProductPanel: "ozon-products",
  multiPlatformPublishPanel: "publish",
  collectionBoxPanel: "collection-box",
  publishRecordsPanel: "publish-records",
  ordersPanel: "orders",
  ordersV2Panel: "orders-v2",
  aiPanel: "ai",
  usersPanel: "users",
  apiPanel: "shops",
  messagesPanel: "messages",
  warehousePanel: "warehouse",
  systemPanel: "system",
  aiConfigPanel: "ai-config",
  aiImageTaskPanel: "ai-image-tasks",
  reviewRulesPanel: "review-rules",
  categoryMappingPanel: "category-mapping",
  yandexCommissionPanel: "yandex-commission",
  ozonCommissionPanel: "ozon-commission",
  logisticsFeePanel: "logistics-fees",
  financePurchasePanel: "finance-purchase",
  financeProfitPanel: "finance-profit",
  financeBillPanel: "finance-bills",
  logsPanel: "logs"
});

const ROUTE_PANELS = Object.freeze(
  Object.fromEntries(Object.entries(PANEL_ROUTES).map(([panelId, route]) => [route, panelId]))
);

function getPanelIdFromHash() {
  const rawRoute = String(window.location.hash || "").replace(/^#\/?/, "");
  let route = rawRoute;
  try {
    route = decodeURIComponent(rawRoute);
  } catch {}
  route = route.trim().toLowerCase();
  return ROUTE_PANELS[route] || "";
}

function updatePanelRoute(panelId, replace = false) {
  const route = PANEL_ROUTES[panelId] || PANEL_ROUTES.reportsPanel;
  const nextHash = `#${route}`;
  if (window.location.hash === nextHash) return;
  if (replace) {
    window.history.replaceState(null, "", nextHash);
  } else {
    window.history.pushState(null, "", nextHash);
  }
}

// 从 app.js 迁出的路由编排骨架（hash 路由、面板数据加载与切换）。

async function onPanelRouteChange() {
  if (!state.user) return;
  const panelId = getPanelIdFromHash();
  await switchPanel(panelId || "reportsPanel", {
    persist: Boolean(panelId),
    updateRoute: false
  });
  if (!panelId) updatePanelRoute("reportsPanel", true);
}

function resetPanelLoadedState() {
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
    aiModels: false,
    aiImageTasks: false
  };
}

function resolveInitialPanelId() {
  const routedPanelId = getPanelIdFromHash();
  if (routedPanelId && document.getElementById(routedPanelId) && !isPanelBlocked(routedPanelId)) {
    return routedPanelId;
  }
  const savedPanelId = String(localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY) || "").trim();
  if (savedPanelId && document.getElementById(savedPanelId) && !isPanelBlocked(savedPanelId)) {
    return savedPanelId;
  }
  return "reportsPanel";
}

async function ensurePanelData(panelId) {
  if (panelId === "reportsPanel") {
    if (!state.panelLoaded.orders) {
      const ok = await loadOrders();
      state.panelLoaded.orders = Boolean(ok);
    }
    if (!state.panelLoaded.reviewRules) {
      const ok = await loadReviewRules();
      state.panelLoaded.reviewRules = Boolean(ok);
    }
    await ensureProfitRateLoaded(true);
    refreshOrderProfitData();
    applyFiltersAndRender();
    updateReportStats();
    // Dashboard charts aggregate the FULL order list, not just the current
    // orders page (state.orders holds only one page).
    await loadDashboardOrders();
    renderDashboard();
  }

  if (panelId === "ordersPanel") {
    if (!state.panelLoaded.orders) {
      const ok = await loadOrders();
      state.panelLoaded.orders = Boolean(ok);
    }
    if (!state.panelLoaded.reviewRules) {
      const ok = await loadReviewRules();
      state.panelLoaded.reviewRules = Boolean(ok);
    }
    await ensureProfitRateLoaded(true);
    refreshOrderProfitData();
    applyFiltersAndRender();
  }

  if (panelId === "ordersV2Panel") {
    if (!state.panelLoaded.ordersV2) {
      const ok = await loadOrders();
      state.panelLoaded.ordersV2 = Boolean(ok);
    }
    if (!state.panelLoaded.reviewRules) {
      const ok = await loadReviewRules();
      state.panelLoaded.reviewRules = Boolean(ok);
    }
    await ensureProfitRateLoaded(true);
    refreshOrderProfitData();
    applyFiltersAndRender();
  }

  if (panelId === "financePurchasePanel" || panelId === "financeProfitPanel") {
    await loadFinanceOrders();
    if (!state.panelLoaded.reviewRules) {
      const ok = await loadReviewRules();
      state.panelLoaded.reviewRules = Boolean(ok);
    }
    await ensureProfitRateLoaded(true);
    applyFinanceProfitFallback();
    buildFinancePurchaseView();
    buildFinanceProfitView();
    if (panelId === "financeProfitPanel") {
      await loadProfitIssues();
    }
  }

  if (panelId === "reviewRulesPanel") {
    if (canShopRead() && !state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
    if (!state.panelLoaded.reviewRules) {
      const ok = await loadReviewRules();
      state.panelLoaded.reviewRules = Boolean(ok);
    }
    if (!state.panelLoaded.orders) {
      const ok = await loadOrders();
      state.panelLoaded.orders = Boolean(ok);
    }
    await ensureProfitRateLoaded(true);
    refreshOrderProfitData();
  }

  if (panelId === "categoryMappingPanel") {
    if (canShopRead() && !state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
    if (!state.panelLoaded.categoryMapping) {
      const ok = await loadCategoryMappingKnowledge();
      state.panelLoaded.categoryMapping = Boolean(ok);
    }
  }

  if (panelId === "aiConfigPanel") {
    if (!can("aiConfig")) {
      state.aiModels = [];
      renderAiConfigModels();
    } else if (!state.panelLoaded.aiConfig) {
      const ok = await loadAiConfigModels();
      state.panelLoaded.aiConfig = Boolean(ok);
    }
  }

  if (panelId === "aiImageTaskPanel") {
    if (!can("aiConfig")) {
      state.aiImageTasks = [];
      renderAiImageTasks();
    } else {
      if (!state.panelLoaded.aiConfig && !state.aiModels.length) {
        const ok = await loadAiConfigModels();
        state.panelLoaded.aiConfig = Boolean(ok);
      }
      if (!state.panelLoaded.aiImageTasks) {
        const ok = await loadAiImageTasks();
        state.panelLoaded.aiImageTasks = Boolean(ok);
      }
    }
  }

  if (panelId === "aiPanel") {
    if (!can("productAi")) {
      state.aiModels = [];
      renderAiModelButtons([]);
    } else if (!state.panelLoaded.aiModels) {
      const ok = await loadAvailableAiModels();
      state.panelLoaded.aiModels = Boolean(ok);
    }
  }

  if (panelId === "productOnlinePanel" || panelId === "ozonProductPanel") {
    if (canShopRead() && !state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
    if (!state.panelLoaded.onlineProducts) {
      const ok = await loadOnlineProducts();
      state.panelLoaded.onlineProducts = Boolean(ok);
    }
  }

  if (panelId === "productListPanel") {
    if (canShopRead() && !state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
    if (!state.panelLoaded.onlineProducts) {
      const ok = await loadOnlineProducts();
      state.panelLoaded.onlineProducts = Boolean(ok);
    }
  }

  if (panelId === "multiPlatformPublishPanel") {
    if (canShopRead() && !state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
    if (!state.panelLoaded.publishSettings) {
      await loadPublishSettings();
      state.panelLoaded.publishSettings = true;
    }
    if (!state.panelLoaded.publishProducts) {
      const ok = await loadPublishProducts();
      state.panelLoaded.publishProducts = Boolean(ok);
    }
  }

  // 采集箱与上架记录：每次进入都按各自的数据域重新拉取。
  if (panelId === "collectionBoxPanel") {
    await loadCollectionBox();
  }

  if (panelId === "publishRecordsPanel") {
    await loadPublishRecords();
  }

  if (panelId === "usersPanel") {
    if (!can("userManage")) {
      if (usersTableBody) usersTableBody.innerHTML = "<tr><td colspan='7'>仅管理员可查看</td></tr>";
    } else if (!state.panelLoaded.users) {
      const ok = await loadUsers();
      state.panelLoaded.users = Boolean(ok);
      if (canShopRead() && ok) state.panelLoaded.shops = true;
    }
  }

  if (panelId === "apiPanel") {
    if (!canShopRead()) {
      state.shops = [];
      if (shopsTableBody) shopsTableBody.innerHTML = "<tr><td colspan='7'>无权限查看</td></tr>";
    } else if (!state.panelLoaded.shops) {
      const ok = await loadShops();
      state.panelLoaded.shops = Boolean(ok);
    }
  }

  if (panelId === "messagesPanel") {
    if (!canMessageRead()) {
      state.messages = [];
      if (messagesTableBody) messagesTableBody.innerHTML = "<tr><td colspan='4'>无权限查看</td></tr>";
    } else if (!state.panelLoaded.messages) {
      const ok = await loadMessages();
      state.panelLoaded.messages = Boolean(ok);
    }
  }

  if (panelId === "logsPanel") {
    if (!canAuditRead()) {
      state.logs = [];
      if (logsTableBody) logsTableBody.innerHTML = "<tr><td colspan='9'>仅管理员可查看</td></tr>";
      renderLogsPagination();
    } else if (!state.panelLoaded.logs) {
      const ok = await loadLogs();
      state.panelLoaded.logs = Boolean(ok);
    }
  }
}

async function switchPanel(panelId, options = {}) {
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.add("hidden"));
  const requestedPanel = document.getElementById(panelId);
  const resolvedPanelId = requestedPanel && !isPanelBlocked(panelId) ? panelId : "reportsPanel";
  const openingOrdersPanel = resolvedPanelId === "ordersPanel" || resolvedPanelId === "ordersV2Panel";
  const next = document.getElementById(resolvedPanelId === "ordersV2Panel" ? "ordersPanel" : resolvedPanelId);
  const previousOrderWorkspace = state.orderWorkspace;
  if (resolvedPanelId === "ordersV2Panel") state.orderWorkspace = "v2";
  else if (resolvedPanelId === "ordersPanel") state.orderWorkspace = "v1";
  if (next) next.classList.remove("hidden");
  if (contentMain) contentMain.classList.toggle("orders-scroll-mode", resolvedPanelId === "ordersPanel" || resolvedPanelId === "ordersV2Panel");

  document.querySelectorAll("[data-view]").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === resolvedPanelId);
  });
  if (options.persist !== false) {
    localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, resolvedPanelId);
  }
  if (options.updateRoute !== false) {
    updatePanelRoute(resolvedPanelId, options.replaceRoute === true);
  }

  if (openingOrdersPanel) {
    const workspaceChanged = previousOrderWorkspace !== state.orderWorkspace;
    const defaultOrderStatus = state.orderWorkspace === "v2" ? "" : "pending";
    const shouldResetOrdersView =
      workspaceChanged ||
      state.filters.status !== defaultOrderStatus ||
      Math.max(1, Number(state.currentPage || 1) || 1) !== 1;
    state.filters.status = defaultOrderStatus;
    state.currentPage = 1;
    if (workspaceChanged) {
      state.selectedOrderIds = [];
      if (state.selectedOrdersById) state.selectedOrdersById.clear();
    }
    if (shouldResetOrdersView) {
      if (state.orderWorkspace === "v2") state.panelLoaded.ordersV2 = false;
      else state.panelLoaded.orders = false;
    }
    const workspaceTitle = document.getElementById("ordersWorkspaceTitle");
    if (workspaceTitle) workspaceTitle.textContent = state.orderWorkspace === "v2" ? "订单管理 V2" : "订单管理";
    document.querySelectorAll("[data-orders-v2-only]").forEach((element) => {
      element.classList.toggle("hidden", state.orderWorkspace !== "v2");
    });
  }

  await ensurePanelData(resolvedPanelId);

  if (resolvedPanelId === "productOnlinePanel") {
    renderOnlineSummary();
    renderOnlineProducts();
    renderOnlinePagination();
    syncOnlineIslandScrollbarMetrics();
  }
  if (resolvedPanelId === "ozonProductPanel") {
    renderOzonProducts();
  }
  if (resolvedPanelId === "productListPanel") {
    syncProductListShopOptions();
    syncProductListFilterFormFromState();
    applyProductListFilters();
    renderProductListSummary();
    renderProductListTable();
    renderProductListPagination();
  }
  if (resolvedPanelId === "multiPlatformPublishPanel") {
    updatePublishWorkspaceUi();
    renderPublishShopOptions();
    fillPublishSettingsForm();
    renderPublishTable();
    renderPublishPagination();
  }
  if (resolvedPanelId === "collectionBoxPanel") {
    renderCollectionBoxTable();
    renderCollectionBoxPagination(state.collectionBoxPagination || {});
  }
  if (resolvedPanelId === "publishRecordsPanel") {
    renderPublishRecordsTable();
    renderPublishRecordsPagination(state.publishRecordsPagination || {});
  }
  if (resolvedPanelId === "reviewRulesPanel") {
    renderReviewRuleShopOptions();
    renderReviewRulesTable();
  }
  if (resolvedPanelId === "aiConfigPanel") {
    renderAiModelButtons(state.aiModels);
    renderAiConfigModels();
  }
  if (resolvedPanelId === "aiImageTaskPanel") {
    renderAiImageTaskModelOptions(String(aiImageTaskModelId?.value || "").trim());
    renderAiImageTasks();
  }
  if (resolvedPanelId === "categoryMappingPanel") {
    renderCategoryMappingRuleShopOptions();
    renderCategoryMappingRulesTable();
    renderCategoryMappingSamplesTable();
  }
  if (resolvedPanelId === "financeProfitPanel") {
    buildFinanceProfitView();
  }
  if (resolvedPanelId === "yandexCommissionPanel") {
    loadYandexCommissionCatalog();
  }
  if (resolvedPanelId === "ozonCommissionPanel") {
    loadOzonCommissionCatalog();
  }
  if (resolvedPanelId === "logisticsFeePanel") {
    applyYandexRateTable();
    updateYandexModelHint();
    if (rateModelTitle) rateModelTitle.textContent = YANDEX_MODEL_CONFIG[currentYandexModel]?.label || currentYandexModel;
    if (yandexServiceSections?.length) {
      yandexServiceSections.forEach((section) => {
        section.classList.toggle("hidden", section.dataset.rateSection !== currentYandexModel);
      });
    }
    computeYandexFee();
  }
}
