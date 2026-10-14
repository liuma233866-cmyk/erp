async function loadDashboardData() {
  resetPanelLoadedState();
  if (!can("productAi")) {
    setAiMessage(aiHint, "", false);
    if (aiResponse) aiResponse.textContent = "";
    if (aiImagePreview) aiImagePreview.innerHTML = "";
    if (aiResultPreview) aiResultPreview.innerHTML = "";
  } else {
    setAiMessage(aiHint, "", false);
  }

  updateReportStats();
  applyRoleVisibility();
  await switchPanel(resolveInitialPanelId(), { persist: false, replaceRoute: true });
}

// 仪表盘数据来自后端聚合接口 /api/orders/summary。
//
// 这里曾经是 apiRequest("/api/orders")：不带 page/pageSize 时列表接口会返回**整张** orders 表
// （见 backend/pagination.js），于是每次进面板都要把全部订单下载到浏览器、再在前端把
// KPI / 折线序列 / Top10 / 柱状图各聚合一遍。现在聚合在后端一次算完
// （backend/order-summary.js 与其差异测试），前端只收结果。
async function loadDashboardSummary() {
  if (!can("orderRead")) {
    dashboardState.summary = null;
    dashboardState.summaryError = "";
    updateReportStats();
    renderDashboard();
    return;
  }
  const result = await apiRequest("/api/orders/summary", { method: "GET" });
  const loaded = Boolean(result.ok && result.data && result.data.summary && Array.isArray(result.data.platforms));
  dashboardState.summary = loaded ? result.data : null;
  // 拿到（或失败）之后立刻重算，否则 KPI 会停在进入面板时的那组占位数字上。
  dashboardState.summaryError = loaded ? "" : String(result.error || "仪表盘数据加载失败");
  updateReportStats();
  renderDashboard();
}

function getDashboardBucket() {
  const platforms = dashboardState.summary && Array.isArray(dashboardState.summary.platforms)
    ? dashboardState.summary.platforms
    : [];
  return platforms.find((bucket) => bucket.key === dashboardState.platform)
    || platforms.find((bucket) => bucket.key === "all")
    || null;
}

function emptySeries() {
  return { labels: [], orderSeries: [], paidSeries: [], refundSeries: [] };
}

function renderDashboard() {
  // 后端已按「平台 × 周期」算好全部序列，所以切页签只是重渲染，不再发请求。
  const bucket = getDashboardBucket();
  renderChart((bucket && bucket.series && bucket.series[dashboardState.period]) || emptySeries());
  renderTop10((bucket && bucket.topShops) || []);
  renderBarCharts(bucket);
}

function updateReportStats() {
  // 这三个数字是「全站口径」，直接取后端聚合结果。
  // 历史上这里走过两次弯路：先是读 state.orders（只有一页 50 条），后来即使读了全量，
  // 也仍然要把整张表下载到浏览器再自己算。现在口径只有一处实现。
  const stats = dashboardState.summary ? dashboardState.summary.summary : null;
  const ready = Boolean(stats);
  const hint = dashboardState.summaryError || "正在加载仪表盘数据…";

  if (todayOrders) {
    todayOrders.textContent = ready ? String(stats.todayCount) : "—";
    todayOrders.title = ready ? "" : hint;
  }
  if (totalAmount) {
    totalAmount.textContent = ready ? `₽${Number(stats.amountRub || 0).toFixed(2)}` : "—";
    totalAmount.title = ready ? "" : hint;
  }
  if (shippedRate) {
    shippedRate.textContent = ready ? `${Number(stats.shippedPercent || 0).toFixed(0)}%` : "—";
    shippedRate.title = ready ? "" : hint;
  }
}

// 仪表盘页签与 Top10 渲染。

function onPlatformTabClick(event) {
  const btn = event.target.closest("button[data-platform]");
  if (!btn) return;
  dashboardState.platform = String(btn.dataset.platform || "all");
  platformTabs.querySelectorAll("button[data-platform]").forEach((b) => b.classList.toggle("active", b === btn));
  renderDashboard();
}

function onPeriodTabClick(event) {
  const btn = event.target.closest("button[data-period]");
  if (!btn) return;
  dashboardState.period = String(btn.dataset.period || "day");
  periodTabs.querySelectorAll("button[data-period]").forEach((b) => b.classList.toggle("active", b === btn));
  renderDashboard();
}

// 参数改为后端算好的 Top10（[{ shopName, amountRub }]，已倒序取前 10）。
function renderTop10(topShops) {
  if (!top10List) return;
  const items = Array.isArray(topShops) ? topShops : [];
  if (!items.length) {
    top10List.innerHTML = "<li>暂无数据</li>";
    return;
  }
  top10List.innerHTML = items
    .map((item, index) => {
      const rank = String(index + 1).padStart(2, "0");
      const color = index === 0 ? "red" : "green";
      // 店铺名来自平台数据，必须转义后再进 innerHTML。
      return `<li><span class="rank ${color}">${rank}</span><span>${escapeHtml(item.shopName)}</span><span class="amount">₽${Number(item.amountRub || 0).toFixed(2)}</span></li>`;
    })
    .join("");
}

// DOM 常量与事件绑定。

const platformTabs = document.getElementById("platformTabs");
const periodTabs = document.getElementById("periodTabs");
const top10List = document.getElementById("top10List");
const dashboardState = {
  platform: "all",
  period: "day",
  // 后端聚合结果 { summary, platforms }；null 表示尚未拿到或加载失败。
  // KPI 是全站口径，在 summary 到位之前一律显示占位符，绝不用当前分页的数字顶替。
  summary: null,
  summaryError: ""
};
const todayOrders = document.getElementById("todayOrders");
const totalAmount = document.getElementById("totalAmount");
const shippedRate = document.getElementById("shippedRate");

function bindDashboardEvents() {
  if (platformTabs) platformTabs.addEventListener("click", onPlatformTabClick);
  if (periodTabs) periodTabs.addEventListener("click", onPeriodTabClick);
}
