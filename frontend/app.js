


const authView = document.getElementById("authView");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");

const adminView = document.getElementById("adminView");
const currentUser = document.getElementById("currentUser");
const sidebarToggle = document.getElementById("sidebarToggle");
const logoutBtn = document.getElementById("logoutBtn");
const contentMain = document.querySelector("main.content");

bindEvents();
init();

function bindEvents() {
  bindOrdersEvents();
  bindDashboardEvents();
  bindProductListEvents();
  bindOnlineProductsEvents();
  bindPublishProductsEvents();
  bindCollectionBoxEvents();
  bindPublishRecordsEvents();
  bindProfitDetailEvents();
  bindFinanceEvents();
  bindCommissionsEvents();
  bindCategoryMappingEvents();
  bindUsersEvents();
  bindLogsEvents();
  bindShopsEvents();
  bindMessagesEvents();
  bindAiEvents();
  bindReviewRulesEvents();
  bindYandexRateEvents();

  if (loginForm) loginForm.addEventListener("submit", onLoginSubmit);
  if (sidebarToggle) sidebarToggle.addEventListener("click", toggleSidebar);
  if (logoutBtn) logoutBtn.addEventListener("click", onLogout);
  window.addEventListener("hashchange", onPanelRouteChange);

  document.querySelectorAll("[data-view]").forEach((el) => {
    el.addEventListener("click", () => switchPanel(el.dataset.view));
  });
  document.querySelectorAll("[data-view-jump]").forEach((el) => {
    el.addEventListener("click", () => {
      const target = String(el.dataset.viewJump || "").trim();
      if (target) switchPanel(target);
    });
  });
  document.querySelectorAll("[data-publish-open-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      const tab = normalizePublishWorkspaceTab(el.dataset.publishOpenTab);
      state.publishWorkspaceTab = tab;
      if (publishWorkspaceTabs) {
        publishWorkspaceTabs.querySelectorAll("button[data-publish-tab]").forEach((btn) => {
          btn.classList.toggle("active", String(btn.dataset.publishTab || "") === tab);
        });
      }
      switchPanel("multiPlatformPublishPanel");
    });
  });

  document.querySelectorAll(".side-group-toggle").forEach((el) => {
    const sideGroup = el.closest(".side-group");
    const submenuId = el.dataset.submenu;
    const submenu = submenuId ? document.getElementById(submenuId) : null;

    const openCollapsedSubmenu = () => {
      if (!adminView?.classList.contains("sidebar-collapsed")) return;
      if (!submenu) return;
      clearCollapsedSubmenuHideTimer(submenuId);
      submenu.classList.remove("hidden");
      el.classList.add("is-open");
      positionCollapsedSubmenu(el, submenu);
    };

    const closeCollapsedSubmenu = (delay = 140) => {
      if (!adminView?.classList.contains("sidebar-collapsed")) return;
      if (!submenu) return;
      clearCollapsedSubmenuHideTimer(submenuId);
      collapsedSubmenuHideTimers.set(
        submenuId,
        window.setTimeout(() => {
          if (submenu.matches(":hover") || el.matches(":hover") || sideGroup?.matches(":hover")) return;
          submenu.classList.add("hidden");
          el.classList.remove("is-open");
        }, delay)
      );
    };

    el.addEventListener("click", (event) => {
      event.preventDefault();
      const submenuId = el.dataset.submenu;
      if (!submenuId) return;
      const submenu = document.getElementById(submenuId);
      if (!submenu) return;
      clearCollapsedSubmenuHideTimer(submenuId);
      submenu.classList.toggle("hidden");
      el.classList.toggle("is-open");
      if (!submenu.classList.contains("hidden")) {
        positionCollapsedSubmenu(el, submenu);
      }
    });
    if (sideGroup && submenu) {
      sideGroup.addEventListener("mouseenter", () => {
        openCollapsedSubmenu();
      });
      sideGroup.addEventListener("mouseleave", () => {
        closeCollapsedSubmenu();
      });
      submenu.addEventListener("mouseenter", () => {
        openCollapsedSubmenu();
      });
      submenu.addEventListener("mouseleave", () => {
        closeCollapsedSubmenu(90);
      });
    }
  });
  window.addEventListener("resize", refreshCollapsedSubmenuPositions);
}


// Fetch the full (unpaginated) order list for dashboard aggregation. The
// backend returns all items when page/pageSize are omitted.


// Resolve the current selection to order objects, including orders selected on
// other pages (stored snapshots) and legacy page-local ids.


const collapsedSubmenuHideTimers = new Map();


function clearCollapsedSubmenuHideTimer(submenuId) {
  if (!submenuId) return;
  const timerId = collapsedSubmenuHideTimers.get(submenuId);
  if (timerId) {
    clearTimeout(timerId);
    collapsedSubmenuHideTimers.delete(submenuId);
  }
}


// Only http(s) URLs may be used in <img src>: product image URLs come from
// third-party (Ozon/Yandex) data, and escapeHtml alone cannot stop
// javascript:/data: payloads. The canonical implementation lives in
// safe-image-url.js (loaded before this file in index.html); the fallback
// keeps app.js functional if that script is missing.
const safeImageUrl = (window.SafeImageUrl && window.SafeImageUrl.safeImageUrl) || function safeImageUrlFallback(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
};
const safeExternalUrl = (window.SafeImageUrl && window.SafeImageUrl.safeExternalUrl) || safeImageUrl;
