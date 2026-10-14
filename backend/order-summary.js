"use strict";
// 首页仪表盘的聚合计算。
//
// 为什么下沉到后端：这些数字原先由前端下载**全量订单**再在浏览器里聚合 —— 每次进面板都要
// 拉整张 orders 表，并在内存里留一份完整副本（reports.js 的 dashboardOrders 与 finance.js 的
// financeOrders 各存一份）。现在后端一次算好，前端只收聚合结果。
//
// 语义与原先的前端实现**逐一对齐**，并由 order-summary.test.js 里的差异测试锁定：
//   - getRubAmount            ← shared/core/ui.js
//   - periodKey / buildSeries  ← shared/core/ui.js
//   - filterOrdersByPlatform   ← pages/orders/orders.js
//   - 今日/总额/发货率          ← pages/reports/reports.js 的 updateReportStats
//   - 平台汇总与状态计数        ← shared/core/ui.js 的 renderBarCharts
//   - Top10 店铺               ← pages/reports/reports.js 的 renderTop10
// 分桶一律使用服务器本地时间，与原先浏览器端一致（同机部署）。

const PLATFORM_KEYS = ["all", "yandex", "ozon", "other"];
const PERIODS = ["day", "week", "month"];

function getRubAmount(order) {
  const currency = String((order && order.currency) || "").toUpperCase();
  if (currency && currency !== "RUB" && currency !== "RUR") return 0;
  const amount = Number(order && order.amount);
  return Number.isFinite(amount) ? amount : 0;
}

function filterOrdersByPlatform(orders, platform) {
  if (platform === "all") return orders;
  return orders.filter((order) => {
    const provider = String((order && (order.provider || order.platform)) || "").toLowerCase();
    if (platform === "yandex") return provider.includes("yandex");
    if (platform === "ozon") return provider.includes("ozon");
    // 注意：与前端一致，provider 为空的订单既不属于 yandex/ozon，也不计入 other。
    return provider && !provider.includes("yandex") && !provider.includes("ozon");
  });
}

function periodKey(date, period) {
  if (period === "month") {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${date.getFullYear()}-${month}`;
  }
  if (period === "week") {
    const monday = new Date(date);
    const day = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - day);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildSeries(orders, period) {
  const buckets = new Map();
  for (const order of orders) {
    const date = new Date((order && order.createdAt) || "");
    if (Number.isNaN(date.getTime())) continue;
    const key = periodKey(date, period);
    const current = buckets.get(key) || { order: 0, paid: 0, refund: 0 };
    const amount = getRubAmount(order);
    // order 是该时间桶内全部订单的金额；paid / refund 都是它的子集，因此蓝线恒 >= 绿线、橙线，
    // 蓝线并不是「绿 + 橙」（未发货也未作废的 pending 订单只进蓝线）。
    current.order += amount;
    // 与前端 buildSeries 同名同义（差异测试逐字对拍）：字段名 paid/refund 是历史命名，
    // 实际口径是「已发货」（shipped）与「作废」（cancelled）金额。
    if (order.status === "shipped") current.paid += amount;
    if (order.status === "cancelled") current.refund += amount;
    buckets.set(key, current);
  }
  const labels = Array.from(buckets.keys()).sort();
  return {
    labels,
    orderSeries: labels.map((key) => buckets.get(key).order),
    paidSeries: labels.map((key) => buckets.get(key).paid),
    refundSeries: labels.map((key) => buckets.get(key).refund)
  };
}

function buildSummary(orders, now) {
  const list = Array.isArray(orders) ? orders : [];
  const today = now.toDateString();
  let todayCount = 0;
  let amountRub = 0;
  let shippedCount = 0;
  for (const order of list) {
    const created = new Date((order && order.createdAt) || "");
    if (!Number.isNaN(created.getTime()) && created.toDateString() === today) todayCount += 1;
    amountRub += getRubAmount(order);
    if (String((order && order.status) || "") === "shipped") shippedCount += 1;
  }
  return {
    total: list.length,
    todayCount,
    amountRub,
    shippedCount,
    shippedPercent: list.length ? (shippedCount / list.length) * 100 : 0
  };
}

function buildStatusCounts(orders) {
  const counts = {};
  for (const order of orders) {
    const status = String((order && order.status) || "pending");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function buildTopShops(orders, limit = 10) {
  const totals = new Map();
  for (const order of orders) {
    const shopName = String((order && order.shopName) || "").trim() || "未命名店铺";
    totals.set(shopName, (totals.get(shopName) || 0) + getRubAmount(order));
  }
  return Array.from(totals.entries())
    .map(([shopName, amountRub]) => ({ shopName, amountRub }))
    .sort((a, b) => b.amountRub - a.amountRub)
    .slice(0, limit);
}

// 平台柱状图的数据源：与 ui.js 的 renderBarCharts 逐字对齐——按 provider 字符串分组，
// 未知 provider 保留原值（而不是并进"其他"），金额倒序取前 6。
function buildProviderTotals(orders, limit = 6) {
  const totals = new Map();
  for (const order of orders) {
    const providerRaw = String((order && (order.provider || order.platform)) || "").trim();
    const providerLower = providerRaw.toLowerCase();
    let label = providerRaw || "其他";
    if (providerLower.includes("yandex")) label = "Yandex";
    else if (providerLower.includes("ozon")) label = "Ozon";
    totals.set(label, (totals.get(label) || 0) + getRubAmount(order));
  }
  return Array.from(totals.entries())
    .map(([label, amountRub]) => ({ label, amountRub }))
    .sort((a, b) => b.amountRub - a.amountRub)
    .slice(0, limit);
}

// 一次返回全部页签（平台）所需的数据，避免切页签时再发请求。
function buildOrderSummary(orders, options = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();

  const platforms = PLATFORM_KEYS.map((key) => {
    const scoped = filterOrdersByPlatform(list, key);
    const series = {};
    for (const period of PERIODS) series[period] = buildSeries(scoped, period);
    return {
      key,
      count: scoped.length,
      amountRub: scoped.reduce((sum, order) => sum + getRubAmount(order), 0),
      statusCounts: buildStatusCounts(scoped),
      providerTotals: buildProviderTotals(scoped),
      topShops: buildTopShops(scoped),
      series
    };
  });

  return { summary: buildSummary(list, now), platforms };
}

module.exports = {
  PERIODS,
  PLATFORM_KEYS,
  buildOrderSummary,
  buildProviderTotals,
  buildSeries,
  buildStatusCounts,
  buildSummary,
  buildTopShops,
  filterOrdersByPlatform,
  getRubAmount,
  periodKey
};
