// 从 app.js 拆出的共享 UI 工具模块（classic script，全局作用域）。



function splitFilterText(value) {
  const text = String(value || "")
    .split(/[,，;\t；\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return text;
}

function matchesAny(field, list) {
  if (!list.length) return true;
  const target = String(field || "").toLowerCase();
  return list.some((item) => target.includes(String(item).toLowerCase()));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(date) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

function openImagePreview(src) {
  closeImagePreview();
  const mask = document.createElement("div");
  mask.className = "order-image-preview-mask";
  mask.addEventListener("click", onPreviewMaskClick);
  mask.addEventListener("keydown", onPreviewKeydown);
  mask.tabIndex = 0;

  const closeBtn = document.createElement("button");
  closeBtn.className = "order-image-preview-close";
  closeBtn.textContent = "\u00D7";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closeImagePreview();
  });

  const img = document.createElement("img");
  img.src = src;
  img.alt = "product preview";
  img.addEventListener("error", function () {
    img.remove();
    const errEl = document.createElement("div");
    errEl.className = "order-image-preview-error";
    errEl.textContent = "图片加载失败";
    mask.appendChild(errEl);
  });

  mask.appendChild(closeBtn);
  mask.appendChild(img);
  document.body.appendChild(mask);

  requestAnimationFrame(function () {
    mask.classList.add("visible");
    mask.focus();
  });
}

function closeImagePreview() {
  const mask = document.querySelector(".order-image-preview-mask");
  if (!mask) return;
  mask.classList.remove("visible");
  mask.removeEventListener("click", onPreviewMaskClick);
  mask.removeEventListener("keydown", onPreviewKeydown);
  setTimeout(function () {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
  }, 200);
}

function formatDateInputValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "label.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN");
}

function formatCurrency(value, currency) {
  if (!Number.isFinite(value)) return "";
  const amount = value.toFixed(2);
  const code = String(currency || "").toUpperCase();
  const symbols = {
    RUB: "₽",
    RUR: "₽",
    USD: "$",
    EUR: "€",
    CNY: "¥"
  };
  const symbol = symbols[code] || (code ? `${code} ` : "");
  return symbol ? `${symbol}${amount}` : amount;
}

function periodKey(date, period) {
  if (period === "month") {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${m}`;
  }
  if (period === "week") {
    const monday = new Date(date);
    const day = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - day);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderChart(series) {
  if (!chartYAxis || !chartXAxis || !lineOrder || !linePaid || !lineRefund) return;
  const max = Math.max(1, ...series.orderSeries, ...series.paidSeries, ...series.refundSeries);
  const steps = 5;
  const yLabels = Array.from({ length: steps + 1 }, (_, i) => Math.round((max * (steps - i)) / steps));
  chartYAxis.innerHTML = yLabels.map((v) => `<span>${v}</span>`).join("");

  const orderPoints = buildPoints(series.orderSeries, max);
  const paidPoints = buildPoints(series.paidSeries, max);
  const refundPoints = buildPoints(series.refundSeries, max);
  lineOrder.setAttribute("points", orderPoints);
  linePaid.setAttribute("points", paidPoints);
  lineRefund.setAttribute("points", refundPoints);

  renderPoints(lineOrder, series.orderSeries, series.labels, "订单总金额", max);
  renderPoints(linePaid, series.paidSeries, series.labels, "付款金额", max);
  renderPoints(lineRefund, series.refundSeries, series.labels, "退款金额", max);

  chartXAxis.innerHTML = series.labels.length ? series.labels.map((label) => `<span>${label}</span>`).join("") : "<span>-</span>";
}

function renderPoints(polyline, values, labels, name, chartMax) {
  if (!polyline || !polyline.parentElement) return;
  const svg = polyline.parentElement;
  svg.querySelectorAll(`circle[data-series='${name}']`).forEach((el) => el.remove());
  if (!values.length) return;

  const width = 640;
  const height = 220;
  const max = Math.max(1, Number(chartMax) || 1);
  const step = values.length === 1 ? 0 : width / (values.length - 1);

  values.forEach((v, i) => {
    const x = Math.round(i * step);
    const y = Math.round(height - (v / max) * height);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", 2.5);
    dot.setAttribute("fill", polyline.classList.contains("blue") ? "#4c6fff" : polyline.classList.contains("green") ? "#4cc48a" : "#ffb347");
    dot.setAttribute("data-series", name);
    dot.classList.add("point");
    dot.addEventListener("mouseenter", () => showChartTooltip(name, labels[i] || "", v, x, y));
    dot.addEventListener("mouseleave", hideChartTooltip);
    svg.appendChild(dot);
  });
}

function showChartTooltip(name, label, value, x, y) {
  if (!chartTooltip) return;
  chartTooltip.textContent = `${label} ${name}: ₽${value.toFixed(2)}`;
  chartTooltip.style.left = `${(x / 640) * 100}%`;
  chartTooltip.style.top = `${(y / 220) * 100}%`;
  chartTooltip.classList.remove("hidden");
}

function hideChartTooltip() {
  if (!chartTooltip) return;
  chartTooltip.classList.add("hidden");
}

function renderBarCharts() {
  if (!barChartPlatform || !barChartStatus) return;
  const orders = filterOrdersByPlatform(getDashboardOrders(), dashboardState.platform);

  const platformTotals = new Map();
  for (const order of orders) {
    const providerRaw = String(order.provider || order.platform || "").trim();
    const providerLower = providerRaw.toLowerCase();
    let label = providerRaw || "其他";
    if (providerLower.includes("yandex")) label = "Yandex";
    else if (providerLower.includes("ozon")) label = "Ozon";
    const amount = getRubAmount(order);
    platformTotals.set(label, (platformTotals.get(label) || 0) + amount);
  }

  const platformItems = Array.from(platformTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  barChartPlatform.innerHTML = buildBarRows(platformItems, "currency");

  const statusLabels = {
    pending: "新订单",
    shipped: "已发货",
    cancelled: "作废"
  };
  const statusTotals = new Map();
  for (const order of orders) {
    const status = String(order.status || "pending");
    statusTotals.set(status, (statusTotals.get(status) || 0) + 1);
  }
  const statusItems = Array.from(statusTotals.entries()).map(([key, value]) => [statusLabels[key] || key, value, key]);
  barChartStatus.innerHTML = buildBarRows(statusItems, "count");
}

function addHours(value, hours) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

function secureRandomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    do {
      globalThis.crypto.getRandomValues(values);
    } while (values[0] >= limit);
    return values[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function generateStrongPassword(length = 18) {
  const groups = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%^&*_-+=?"
  ];
  const alphabet = groups.join("");
  const characters = groups.map((group) => group[secureRandomInt(group.length)]);
  while (characters.length < length) characters.push(alphabet[secureRandomInt(alphabet.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

function toggleSidebar() {
  const collapsed = !adminView.classList.contains("sidebar-collapsed");
  applySidebarState(collapsed);
}

function applySidebarState(collapsed) {
  adminView.classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem("sidebar_collapsed", collapsed ? "1" : "0");
  document.querySelectorAll(".side-submenu").forEach((submenu) => {
    submenu.style.left = "";
    submenu.style.top = "";
    if (collapsed) submenu.classList.add("hidden");
  });
  document.querySelectorAll(".side-group-toggle").forEach((toggleEl) => {
    if (collapsed) toggleEl.classList.remove("is-open");
  });
  if (collapsed) refreshCollapsedSubmenuPositions();
}

function positionCollapsedSubmenu(toggleEl, submenuEl) {
  if (!adminView?.classList.contains("sidebar-collapsed") || !toggleEl || !submenuEl) return;
  const rect = toggleEl.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const submenuHeight = submenuEl.offsetHeight || 0;
  const gap = 14;
  const minTop = 12;
  const maxTop = Math.max(minTop, viewportHeight - submenuHeight - 12);
  const top = Math.min(Math.max(rect.top, minTop), maxTop);
  submenuEl.style.left = `${Math.round(rect.right + gap)}px`;
  submenuEl.style.top = `${Math.round(top)}px`;
}

function refreshCollapsedSubmenuPositions() {
  if (!adminView?.classList.contains("sidebar-collapsed")) return;
  document.querySelectorAll(".side-group-toggle.is-open").forEach((toggleEl) => {
    const submenuId = toggleEl.dataset.submenu;
    const submenuEl = submenuId ? document.getElementById(submenuId) : null;
    if (!submenuEl || submenuEl.classList.contains("hidden")) return;
    positionCollapsedSubmenu(toggleEl, submenuEl);
  });
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getRoleLabel(role) {
  return ROLE_LABELS[role] || role;
}

// 图片预览遮罩关闭处理（从 app.js 迁移）。

function onPreviewMaskClick(event) {
  if (event.target === this) closeImagePreview();
}

function onPreviewKeydown(event) {
  if (event.key === "Escape") closeImagePreview();
}

// 从 app.js 迁出的共享图表/金额辅助函数。

function toMoneyNumber(value) {
  const amount = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(amount) ? amount : 0;
}

function buildSeries(orders, period) {
  const buckets = new Map();
  for (const order of orders) {
    const date = new Date(order.createdAt || "");
    if (Number.isNaN(date.getTime())) continue;
    const key = periodKey(date, period);
    const current = buckets.get(key) || { order: 0, paid: 0, refund: 0 };
    const amount = getRubAmount(order);
    current.order += amount;
    if (order.status === "shipped") current.paid += amount;
    if (order.status === "cancelled") current.refund += amount;
    buckets.set(key, current);
  }
  const labels = Array.from(buckets.keys()).sort();
  const orderSeries = labels.map((k) => buckets.get(k)?.order || 0);
  const paidSeries = labels.map((k) => buckets.get(k)?.paid || 0);
  const refundSeries = labels.map((k) => buckets.get(k)?.refund || 0);
  return { labels, orderSeries, paidSeries, refundSeries };
}

function getRubAmount(order) {
  const currency = String(order.currency || "").toUpperCase();
  if (currency && currency !== "RUB" && currency !== "RUR") return 0;
  const amount = Number(order.amount);
  return Number.isFinite(amount) ? amount : 0;
}

function buildPoints(values, max) {
  if (!values.length) return "0,220 640,220";
  const width = 640;
  const height = 220;
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(height - (v / max) * height);
      return `${x},${y}`;
    })
    .join(" ");
}

function buildBarRows(items, mode) {
  if (!items.length) {
    return "<div class=\"hint\">暂无数据</div>";
  }
  const values = items.map((item) => Number(item[1] || 0));
  const max = Math.max(1, ...values);
  return items
    .map((item) => {
      const label = String(item[0] || "-");
      const value = Number(item[1] || 0);
      const percent = Math.max(2, Math.round((value / max) * 100));
      const statusKey = String(item[2] || "");
      const tone = statusKey === "shipped" ? "green" : statusKey === "cancelled" ? "red" : "";
      const display = mode === "currency" ? `₽${value.toFixed(2)}` : String(value);
      return `<div class="bar-row">
        <div class="bar-label">${escapeHtml(label)}</div>
        <div class="bar-track"><div class="bar-fill ${tone}" style="width:${percent}%"></div></div>
        <div class="bar-value">${display}</div>
      </div>`;
    })
    .join("");
}

// 从 app.js 下沉的图表 DOM 常量。

const chartYAxis = document.getElementById("chartYAxis");
const chartXAxis = document.getElementById("chartXAxis");
const lineOrder = document.getElementById("lineOrder");
const linePaid = document.getElementById("linePaid");
const lineRefund = document.getElementById("lineRefund");
const chartTooltip = document.getElementById("chartTooltip");
const barChartPlatform = document.getElementById("barChartPlatform");
const barChartStatus = document.getElementById("barChartStatus");
