// 首页聚合的单元测试 + **差异测试**。
//
// 差异测试是这次「把聚合从前端搬到后端」的核心保障：后端 order-summary.js 必须与前端原实现
// （shared/core/ui.js 的 getRubAmount / periodKey / buildSeries、pages/orders/orders.js 的
// filterOrdersByPlatform）在任意输入上给出**完全相同**的结果，否则仪表盘上的数字与线条会悄悄
// 变样，而这种偏差很难靠肉眼发现。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const summary = require("./order-summary");

const UI_PATH = path.join(__dirname, "..", "frontend", "shared", "core", "ui.js");
const ORDERS_PATH = path.join(__dirname, "..", "frontend", "pages", "orders", "orders.js");

// 以最小沙箱加载传统脚本（页面/核心模块不是 CommonJS）。
// 多个脚本必须加载进**同一个 context**：ui.js 的 buildSeries 依赖 orders.js 的
// filterOrdersByPlatform，这与浏览器里的全局作用域一致。
function loadClassicScripts(files, extras) {
  const sandbox = {
    document: {
      getElementById: () => null,
      addEventListener() {},
      createElement: () => ({ classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} })
    },
    window: { addEventListener() {}, confirm: () => true },
    console,
    URLSearchParams,
    ...extras
  };
  vm.createContext(sandbox);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: path.basename(file) });
  }
  return sandbox;
}

const CLIENT_SCRIPTS = [UI_PATH, ORDERS_PATH];

// vm context 里创建的对象/数组与本进程的不是同一个 Object.prototype，
// deepStrictEqual 会因原型不同而失败，因此跨 realm 比较一律先 JSON 归一化。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFixture() {
  // 覆盖各币种、非法金额、非法日期、空 provider、"其他" provider、同名店铺聚合。
  return [
    { id: "O1", provider: "yandex_market", status: "shipped", amount: 100, currency: "RUB", createdAt: "2026-01-05T10:00:00" },
    { id: "O2", provider: "ozon", status: "pending", amount: 50, currency: "RUR", createdAt: "2026-01-06T10:00:00" },
    { id: "O3", provider: "yandex", status: "cancelled", amount: 30, currency: "CNY", createdAt: "2026-01-07T10:00:00" },
    { id: "O4", provider: "", status: "shipped", amount: 20, currency: "", createdAt: "2026-01-08T10:00:00" },
    { id: "O5", provider: "other_shop", status: "pending", amount: "abc", currency: "RUB", createdAt: "not-a-date" },
    { id: "O6", provider: "ozon", status: "shipped", amount: 70, currency: "RUB", createdAt: "2026-02-10T10:00:00" },
    { id: "O7", shopName: "店铺A", provider: "yandex_market", status: "pending", amount: 200, currency: "RUB", createdAt: "2026-02-11T10:00:00" },
    { id: "O8", shopName: "店铺A", provider: "yandex_market", status: "shipped", amount: 300, currency: "RUB", createdAt: "2026-03-01T10:00:00" }
  ];
}

test("getRubAmount 与前端同语义（非 RUB/RUR 币种不计入）", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  client.__orders = makeFixture();
  const clientAmounts = vm.runInContext("__orders.map(getRubAmount)", client);
  const serverAmounts = makeFixture().map(summary.getRubAmount);
  assert.deepEqual(serverAmounts, plain(clientAmounts));
});

test("periodKey 的日/周/月分桶与前端一致（周从周一开始，本地时间）", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  const dates = [
    new Date("2026-01-05T10:00:00"), // 周一
    new Date("2026-01-11T23:00:00"), // 周日
    new Date("2026-03-01T00:00:00"),
    new Date("2026-12-31T23:59:59")
  ];
  for (const period of ["day", "week", "month"]) {
    client.__dates = dates;
    client.__period = period;
    const clientKeys = vm.runInContext("__dates.map((d) => periodKey(d, __period))", client);
    const serverKeys = dates.map((date) => summary.periodKey(date, period));
    assert.deepEqual(serverKeys, plain(clientKeys), `${period} 分桶不一致`);
  }
});

test("filterOrdersByPlatform 与前端一致（含「空 provider 不计入 other」这一细节）", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  client.__orders = makeFixture();
  for (const key of summary.PLATFORM_KEYS) {
    client.__key = key;
    const clientIds = vm.runInContext("filterOrdersByPlatform(__orders, __key).map((o) => o.id)", client);
    const serverIds = summary.filterOrdersByPlatform(makeFixture(), key).map((order) => order.id);
    assert.deepEqual(serverIds, plain(clientIds), `平台 ${key} 的筛选结果不一致`);
  }
});

test("各平台 × 各周期的图表序列与前端 buildSeries 完全一致", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  const serverResult = summary.buildOrderSummary(makeFixture(), { now: new Date("2026-01-10T12:00:00") });

  for (const bucket of serverResult.platforms) {
    client.__orders = makeFixture();
    client.__key = bucket.key;
    for (const period of summary.PERIODS) {
      client.__period = period;
      const clientSeries = vm.runInContext("buildSeries(filterOrdersByPlatform(__orders, __key), __period)", client);
      assert.deepEqual(bucket.series[period], plain(clientSeries), `${bucket.key}/${period} 序列不一致`);
    }
  }
});

test("平台金额与状态计数与前端聚合口径一致", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  const serverResult = summary.buildOrderSummary(makeFixture(), { now: new Date("2026-01-10T12:00:00") });

  for (const bucket of serverResult.platforms) {
    client.__orders = makeFixture();
    client.__key = bucket.key;
    const clientAmount = vm.runInContext(
      "filterOrdersByPlatform(__orders, __key).reduce((sum, o) => sum + getRubAmount(o), 0)",
      client
    );
    assert.equal(bucket.amountRub, clientAmount, `${bucket.key} 金额不一致`);

    const clientStatusCounts = vm.runInContext(
      "filterOrdersByPlatform(__orders, __key).reduce((acc, o) => { const s = String(o.status || 'pending'); acc[s] = (acc[s] || 0) + 1; return acc; }, {})",
      client
    );
    assert.deepEqual(bucket.statusCounts, plain(clientStatusCounts), `${bucket.key} 状态计数不一致`);
  }
});

test("Top10 店铺聚合口径与 reports.js 原 renderTop10 一致", () => {
  const result = summary.buildOrderSummary(makeFixture(), { now: new Date("2026-01-10T12:00:00") });
  const all = result.platforms.find((bucket) => bucket.key === "all");
  assert.deepEqual(all.topShops, [
    { shopName: "店铺A", amountRub: 500 },
    { shopName: "未命名店铺", amountRub: 240 }
  ]);
});

test("摘要口径与 reports.js 原 updateReportStats 一致（今日/总额/发货率）", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  const orders = makeFixture();
  const now = new Date("2026-01-08T12:00:00");
  const result = summary.buildOrderSummary(orders, { now });

  client.__orders = orders;
  client.__today = now.toDateString();
  const clientAmount = vm.runInContext("__orders.reduce((sum, o) => sum + getRubAmount(o), 0)", client);
  const clientShipped = vm.runInContext("__orders.filter((o) => o.status === 'shipped').length", client);
  const clientToday = vm.runInContext(
    "__orders.filter((o) => new Date(o.createdAt).toDateString() === __today).length",
    client
  );

  assert.equal(result.summary.total, 8);
  assert.equal(result.summary.amountRub, clientAmount, "总额口径不一致");
  assert.equal(result.summary.shippedCount, clientShipped, "已发货计数不一致");
  assert.equal(result.summary.todayCount, clientToday, "今日订单口径不一致");
  assert.equal(result.summary.shippedPercent, (clientShipped / 8) * 100);
});

test("平台柱状图数据与 ui.js renderBarCharts 的分组口径一致（未知 provider 保留原值）", () => {
  const client = loadClassicScripts(CLIENT_SCRIPTS);
  const result = summary.buildOrderSummary(makeFixture(), { now: new Date("2026-01-10T12:00:00") });

  for (const bucket of result.platforms) {
    client.__orders = makeFixture();
    client.__key = bucket.key;
    // 与 ui.js renderBarCharts 的前半段同构：按 provider 分组求和后金额倒序取前 6。
    const clientTotals = vm.runInContext(`
      (() => {
        const orders = filterOrdersByPlatform(__orders, __key);
        const totals = new Map();
        for (const order of orders) {
          const providerRaw = String(order.provider || order.platform || "").trim();
          const providerLower = providerRaw.toLowerCase();
          let label = providerRaw || "其他";
          if (providerLower.includes("yandex")) label = "Yandex";
          else if (providerLower.includes("ozon")) label = "Ozon";
          const amount = getRubAmount(order);
          totals.set(label, (totals.get(label) || 0) + amount);
        }
        return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, amountRub]) => ({ label, amountRub }));
      })()
    `, client);
    assert.deepEqual(bucket.providerTotals, plain(clientTotals), `${bucket.key} 平台柱状图数据不一致`);
  }

  // other_shop 这类未知 provider 必须保留原值，而不是被并进"其他"
  const all = result.platforms.find((bucket) => bucket.key === "all");
  assert.ok(
    all.providerTotals.some((item) => item.label === "other_shop"),
    "未知 provider 应保留原值"
  );
});

test("空订单集不产生 NaN", () => {
  const result = summary.buildOrderSummary([], { now: new Date("2026-01-01T00:00:00") });
  assert.deepEqual(result.summary, { total: 0, todayCount: 0, amountRub: 0, shippedCount: 0, shippedPercent: 0 });
  for (const bucket of result.platforms) {
    assert.equal(bucket.count, 0);
    assert.equal(bucket.amountRub, 0);
    assert.deepEqual(bucket.statusCounts, {});
    assert.deepEqual(bucket.topShops, []);
    assert.deepEqual(bucket.series.day, { labels: [], orderSeries: [], paidSeries: [], refundSeries: [] });
  }
});
