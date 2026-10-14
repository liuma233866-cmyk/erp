// 首页仪表盘的调用方回归测试（数据来自后端聚合接口）。
//
// 页面模块不是 CommonJS，无法 require；但 reports.js 顶层只做 document.getElementById 与
// const 声明，因此可以用 node:vm 在最小沙箱里加载它，并**真实调用**这些函数。
//
// 锁定的不变量：
//   1. KPI 卡片取后端聚合结果，而不是任何订单数组（历史缺陷：读 state.orders，只有一页 50 条）；
//   2. 数据没拿到 / 加载失败时显示占位符并把原因挂在 title 上，绝不用分页数字冒充全站数字；
//   3. 数据来自 /api/orders/summary（不是 /api/orders —— 那会下载整张 orders 表）；
//   4. 切页签只是重渲染，不再发请求（后端已按平台 × 周期算好全部序列）；
//   5. Top10 的店铺名来自平台数据，必须转义后再进 innerHTML。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPORTS_PATH = path.join(__dirname, "pages", "reports", "reports.js");
const ELEMENT_IDS = ["todayOrders", "totalAmount", "shippedRate", "top10List", "platformTabs", "periodTabs"];

const ALL_SERIES = { labels: ["2026-01-05"], orderSeries: [10], paidSeries: [5], refundSeries: [0] };
const OZON_SERIES = { labels: ["2026-01-06"], orderSeries: [20], paidSeries: [0], refundSeries: [0] };
const SUMMARY_PAYLOAD = {
  summary: { total: 120, todayCount: 7, amountRub: 1200, shippedCount: 60, shippedPercent: 50 },
  platforms: [
    { key: "all", count: 120, amountRub: 1200, statusCounts: { shipped: 60 }, providerTotals: [], topShops: [{ shopName: "店铺A", amountRub: 900 }], series: { day: ALL_SERIES, week: ALL_SERIES, month: ALL_SERIES } },
    { key: "ozon", count: 20, amountRub: 200, statusCounts: { pending: 20 }, providerTotals: [], topShops: [], series: { day: OZON_SERIES, week: OZON_SERIES, month: OZON_SERIES } }
  ]
};

function makeElement() {
  return {
    textContent: "",
    title: "",
    innerHTML: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelectorAll: () => []
  };
}

function loadReportsPanel(options = {}) {
  const elements = new Map(ELEMENT_IDS.map((id) => [id, makeElement()]));
  const calls = { api: [], chart: [], bar: [] };
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) || null },
    console,
    window: {},
    state: {},
    can: () => options.canOrderRead !== false,
    apiRequest: async (url) => {
      calls.api.push(String(url));
      return options.apiResponse ? options.apiResponse(String(url)) : { ok: true, data: SUMMARY_PAYLOAD };
    },
    // renderChart / renderBarCharts 在 ui.js 里，这里用替身记录调用，便于断言数据流向。
    renderChart: (series) => calls.chart.push(series),
    renderBarCharts: (bucket) => calls.bar.push(bucket),
    escapeHtml: (value) => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(REPORTS_PATH, "utf8"), sandbox, { filename: "reports.js" });
  return { sandbox, elements, calls };
}

// dashboardState 是脚本顶层的 const，属于词法作用域而不是 sandbox 的属性，
// 因此必须回到同一个 context 里赋值（Object.assign 只改属性，不违反 const）。
function applyDashboardState(sandbox, patch) {
  sandbox.__patchJson = JSON.stringify(patch);
  vm.runInContext("Object.assign(dashboardState, JSON.parse(__patchJson))", sandbox);
}

function readKpis(elements) {
  return {
    today: elements.get("todayOrders").textContent,
    amount: elements.get("totalAmount").textContent,
    shipped: elements.get("shippedRate").textContent
  };
}

test("KPI 卡片直接取后端聚合结果", () => {
  const { sandbox, elements } = loadReportsPanel();
  applyDashboardState(sandbox, { summary: SUMMARY_PAYLOAD, summaryError: "" });

  vm.runInContext("updateReportStats()", sandbox);

  assert.deepEqual(readKpis(elements), { today: "7", amount: "₽1200.00", shipped: "50%" });
});

test("数据未到位时显示占位符，不拿任何分页数字冒充全站数字", () => {
  const { sandbox, elements } = loadReportsPanel();
  applyDashboardState(sandbox, { summary: null, summaryError: "" });

  vm.runInContext("updateReportStats()", sandbox);

  assert.deepEqual(readKpis(elements), { today: "—", amount: "—", shipped: "—" });
  assert.match(elements.get("totalAmount").title, /正在加载/);
});

test("加载失败时显示占位符，并在 title 上说明原因", () => {
  const { sandbox, elements } = loadReportsPanel();
  applyDashboardState(sandbox, { summary: null, summaryError: "HTTP 500" });

  vm.runInContext("updateReportStats()", sandbox);

  assert.deepEqual(readKpis(elements), { today: "—", amount: "—", shipped: "—" });
  for (const id of ["totalAmount", "todayOrders", "shippedRate"]) {
    assert.equal(elements.get(id).title, "HTTP 500");
  }
});

test("loadDashboardSummary 拉取聚合接口并立刻重算 KPI", async () => {
  const { sandbox, elements, calls } = loadReportsPanel();

  await vm.runInContext("loadDashboardSummary()", sandbox);

  assert.deepEqual(calls.api, ["/api/orders/summary"], "必须调用聚合接口，而不是会下载整张表的 /api/orders");
  assert.deepEqual(readKpis(elements), { today: "7", amount: "₽1200.00", shipped: "50%" });
});

test("聚合接口失败时给出占位符与原因，且不把响应当成有效数据", async () => {
  const { sandbox, elements } = loadReportsPanel({
    apiResponse: () => ({ ok: false, status: 500, error: "HTTP 500" })
  });

  await vm.runInContext("loadDashboardSummary()", sandbox);

  assert.deepEqual(readKpis(elements), { today: "—", amount: "—", shipped: "—" });
  assert.equal(elements.get("totalAmount").title, "HTTP 500");
});

test("响应结构不对（缺少 summary/platforms）也按失败处理，且不存成有效数据", async () => {
  const { sandbox, elements } = loadReportsPanel({
    apiResponse: () => ({ ok: true, data: { unexpected: true } })
  });

  await vm.runInContext("loadDashboardSummary()", sandbox);

  assert.deepEqual(readKpis(elements), { today: "—", amount: "—", shipped: "—" });
  assert.equal(vm.runInContext("dashboardState.summary", sandbox), null, "结构不对的响应不得被存成有效数据");
  // 必须记为「加载失败」，而不是「正在加载」——否则界面会一直假装还在加载。
  const title = elements.get("totalAmount").title;
  assert.notEqual(title, "");
  assert.doesNotMatch(title, /正在加载/);
});

test("切页签只是重渲染：不再发请求，且折线取的是所点平台的序列", async () => {
  const { sandbox, calls } = loadReportsPanel();
  await vm.runInContext("loadDashboardSummary()", sandbox);
  const apiCallsAfterLoad = calls.api.length;

  const btn = { dataset: { platform: "ozon" }, classList: { toggle() {} } };
  sandbox.__btn = btn;
  sandbox.__event = { target: { closest: () => btn } };
  vm.runInContext("onPlatformTabClick(__event)", sandbox);

  assert.equal(calls.api.length, apiCallsAfterLoad, "切页签不得再发请求");
  assert.deepEqual(calls.chart[calls.chart.length - 1], OZON_SERIES, "折线必须换成所点平台的序列");
  assert.equal(calls.bar[calls.bar.length - 1].key, "ozon");
});

test("Top10 的店铺名必须转义后再进 innerHTML", () => {
  const { sandbox, elements } = loadReportsPanel();
  sandbox.__items = [{ shopName: "<img src=x onerror=alert(1)>", amountRub: 5 }];

  vm.runInContext("renderTop10(__items)", sandbox);

  const html = elements.get("top10List").innerHTML;
  assert.ok(!html.includes("<img"), "不得把原始标签写进 innerHTML");
  assert.ok(html.includes("&lt;img"), "应输出转义后的标签");
  assert.ok(html.includes("₽5.00"), "金额照常显示");
});

test("没有数据时 Top10 显示空态而不是报错", () => {
  const { sandbox, elements } = loadReportsPanel();

  vm.runInContext("renderTop10([])", sandbox);

  assert.equal(elements.get("top10List").innerHTML, "<li>暂无数据</li>");
});
