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

async function loadDashboardOrders() {
  if (!can("orderRead")) {
    state.dashboardOrders = [];
    return;
  }
  const result = await apiRequest("/api/orders", { method: "GET" });
  state.dashboardOrders = result.ok && Array.isArray(result.data?.items)
    ? result.data.items.map(normalizeOrderForView)
    : [];
}

function getDashboardOrders() {
  return Array.isArray(state.dashboardOrders) && state.dashboardOrders.length
    ? state.dashboardOrders
    : state.orders || [];
}

function renderDashboard() {
  const orders = filterOrdersByPlatform(getDashboardOrders(), dashboardState.platform);
  const series = buildSeries(orders, dashboardState.period);
  renderChart(series);
  renderTop10(orders);
  renderBarCharts();
}

function updateReportStats() {
  const items = state.orders || [];
  const today = new Date().toDateString();
  const todayCount = items.filter((item) => new Date(item.createdAt).toDateString() === today).length;
  const amount = items.reduce((sum, item) => sum + getRubAmount(item), 0);
  const shippedCount = items.filter((item) => item.status === "shipped").length;
  const shippedPercent = items.length ? (shippedCount / items.length) * 100 : 0;

  if (todayOrders) todayOrders.textContent = String(todayCount);
  if (totalAmount) totalAmount.textContent = `₽${amount.toFixed(2)}`;
  if (shippedRate) shippedRate.textContent = `${shippedPercent.toFixed(0)}%`;
}

// 从 app.js 迁出的仪表盘页签与 Top10 渲染。

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

function renderTop10(orders) {
  if (!top10List) return;
  const totals = new Map();
  for (const order of orders) {
    const shopName = String(order.shopName || "").trim() || "未命名店铺";
    const amount = getRubAmount(order);
    totals.set(shopName, (totals.get(shopName) || 0) + amount);
  }
  const items = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (!items.length) {
    top10List.innerHTML = "<li>暂无数据</li>";
    return;
  }
  top10List.innerHTML = items
    .map(([name, amount], index) => {
      const rank = String(index + 1).padStart(2, "0");
      const color = index === 0 ? "red" : "green";
      return `<li><span class="rank ${color}">${rank}</span><span>${escapeHtml(name)}</span><span class="amount">₽${amount.toFixed(2)}</span></li>`;
    })
    .join("");
}

// 从 app.js 下沉的 DOM 常量与事件绑定。

const platformTabs = document.getElementById("platformTabs");
const periodTabs = document.getElementById("periodTabs");
const top10List = document.getElementById("top10List");
const dashboardState = {
  platform: "all",
  period: "day"
};
const todayOrders = document.getElementById("todayOrders");
const totalAmount = document.getElementById("totalAmount");
const shippedRate = document.getElementById("shippedRate");

function bindDashboardEvents() {
  if (platformTabs) platformTabs.addEventListener("click", onPlatformTabClick);
  if (periodTabs) periodTabs.addEventListener("click", onPeriodTabClick);
}
