"use strict";
// 报表/费率/审计洞察域单元测试：审计筛选、利润快照回填、CBR 缓存与兜底链路。
// 全部用假实现，不接触 MySQL 或网络。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createReportingService } = require("./reporting-service");
const { normalizeNullableNumber } = require("../settings-normalize");

function makeService(overrides = {}) {
  const db = { auditLogs: [], orders: [], reviewRules: [], ...(overrides.db || {}) };
  const calls = { fetchJson: [], saveOrders: [] };
  const service = createReportingService({
    getDb: () => db,
    isSqlReady: () => false,
    getSqlPool: () => null,
    sqlWriters: { saveOrdersToSql: async (orders) => { calls.saveOrders.push(orders.length); } },
    logError: () => {},
    fetchJson: async (url) => { calls.fetchJson.push(url); return { ok: false, status: 502 }; },
    normalizeNullableNumber,
    isExchangeRateFresh: () => true,
    findMatchingReviewRule: () => null,
    computeOrderProfit: () => ({}),
    deriveRates: () => ({}),
    cbrDailyJsonUrl: "https://cbr.invalid/daily.json",
    currencyRateMaxAgeDays: 3,
    ...overrides.deps
  });
  return { service, db, calls };
}

test("mapCbrRate 按 Nominal 折算，并处理缺失与非法数据", () => {
  const { service } = makeService();
  const ok = service.mapCbrRate({ Date: "2026-09-27", Valute: { CNY: { Value: 12.5, Nominal: 1 } } }, "CNY");
  assert.equal(ok.ok, true);
  assert.equal(ok.data.rate, 12.5);
  assert.equal(ok.data.date, "2026-09-27");

  const nominal = service.mapCbrRate({ Valute: { JPY: { Value: 60, Nominal: 10 } } }, "JPY");
  assert.equal(nominal.data.rate, 6);

  assert.equal(service.mapCbrRate({ Valute: {} }, "CNY").status, 404);
  // Nominal 为 0 时按 1 处理（原实现如此），Value 非数字才判为非法。
  const zeroNominal = service.mapCbrRate({ Valute: { CNY: { Value: 0, Nominal: 0 } } }, "CNY");
  assert.equal(zeroNominal.ok, true);
  assert.equal(zeroNominal.data.rate, 0);
  assert.equal(service.mapCbrRate({ Valute: { CNY: { Value: "abc", Nominal: 1 } } }, "CNY").status, 500);
  assert.equal(service.mapCbrRate(null, "CNY").status, 404);
});

test("getRecentAuditIssues 只看时间窗内且失败/有告警的条目", () => {
  const now = Date.now();
  const { service } = makeService({
    db: {
      auditLogs: [
        { ts: new Date(now - 60 * 1000).toISOString(), success: false },
        { ts: new Date(now - 60 * 1000).toISOString(), success: true, warningMessage: "缓存未命中" },
        { ts: new Date(now - 60 * 1000).toISOString(), success: true, warningMessage: "" },
        { ts: new Date(now - 30 * 60 * 60 * 1000).toISOString(), success: false },
        { ts: "not-a-date", success: false }
      ]
    }
  });
  const issues = service.getRecentAuditIssues(24);
  assert.equal(issues.length, 2);
});

test("refreshOrderProfitSnapshots 在 SQL 未就绪时直接返回 0", async () => {
  const { service, calls } = makeService();
  assert.equal(await service.refreshOrderProfitSnapshots(), 0);
  assert.equal(calls.saveOrders.length, 0);
});

test("refreshOrderProfitSnapshots 只回填符合条件的订单", async () => {
  const { service, db, calls } = makeService({
    db: {
      reviewRules: [{ id: "R1" }],
      orders: [
        { id: "1", sku: "A", amount: 100 },
        { id: "2", sku: "B", amount: 100 },
        { id: "3", sku: "A", amount: null },
        { id: "4", sku: "A", amount: 100, profitUpdatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    },
    deps: {
      isSqlReady: () => true,
      getSqlPool: () => ({ query: async () => [[{ cnyRateRub: 12, rubPurchaseCostRate: 1.5 }]] }),
      deriveRates: (rubPurchaseCostRate, cnyRateRub) => ({ rubPurchaseCostRate, cnyRateRub }),
      findMatchingReviewRule: (order) => (order.sku === "A" ? { id: "R1", name: "rule A" } : null),
      computeOrderProfit: () => ({
        profitRmb: 30, profitRub: 360, matchedRuleId: "R1", matchedRuleName: "rule A",
        purchaseCostRmb: 10, purchaseCostRub: 120, commissionPercent: 5, commissionRmb: 5, commissionRub: 60,
        logisticsFeeRmb: 1, logisticsFeeRub: 12, otherFeeRmb: 0, otherFeeRub: 0,
        packingFeeRmb: 0, packingFeeRub: 0, withdrawPercent: 1, withdrawFeeRmb: 1, withdrawFeeRub: 12,
        transferPercent: 1, transferFeeRmb: 1, transferFeeRub: 12
      })
    }
  });

  const changed = await service.refreshOrderProfitSnapshots();
  assert.equal(changed, 1);
  assert.equal(db.orders[0].profitRmb, 30);
  assert.equal(db.orders[0].matchedRuleId, "R1");
  assert.ok(db.orders[0].profitUpdatedAt, "应写入 profitUpdatedAt");
  assert.equal(db.orders[1].profitUpdatedAt, undefined);
  assert.equal(db.orders[3].profitUpdatedAt, "2026-01-01T00:00:00.000Z", "已回填的订单不应被覆盖");
  assert.deepEqual(calls.saveOrders, [4]);
});

test("refreshOrderProfitSnapshots 读汇率失败时记错误并返回 0", async () => {
  const errors = [];
  const { service } = makeService({
    deps: {
      isSqlReady: () => true,
      getSqlPool: () => ({ query: async () => { throw new Error("table missing"); } }),
      logError: (message) => errors.push(String(message))
    }
  });
  assert.equal(await service.refreshOrderProfitSnapshots(), 0);
  assert.match(errors[0], /exchange rates unavailable/);
});

test("fetchStoredCbrRate 仅支持 CNY，并标记过期", async () => {
  const { service } = makeService({ deps: { isSqlReady: () => true, getSqlPool: () => ({ query: async () => [[{ rateDate: "2026-09-20", cnyRateRub: 12.6, source: "cbr" }]] }) } });
  const usd = await service.fetchStoredCbrRate("USD");
  assert.equal(usd.status, 404);

  const cny = await service.fetchStoredCbrRate("CNY");
  assert.equal(cny.ok, true);
  assert.equal(cny.data.rate, 12.6);
  assert.equal(cny.data.source, "cbr");

  const stale = makeService({
    deps: {
      isSqlReady: () => true,
      getSqlPool: () => ({ query: async () => [[{ rateDate: "2020-01-01", cnyRateRub: 12.6, source: "cbr" }]] }),
      isExchangeRateFresh: () => false,
      currencyRateMaxAgeDays: 3
    }
  });
  const staleResult = await stale.service.fetchStoredCbrRate("CNY");
  assert.equal(staleResult.stale, true);
  assert.match(staleResult.warning, /older than 3 days/);
});

test("fetchStoredCbrRate 查不到行时返回 404", async () => {
  const { service } = makeService({ deps: { isSqlReady: () => true, getSqlPool: () => ({ query: async () => [[]] }) } });
  const result = await service.fetchStoredCbrRate("CNY");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test("fetchCbrRate 命中 30 分钟缓存后不再请求网络", async () => {
  let calls = 0;
  const { service } = makeService({
    deps: {
      fetchJson: async () => {
        calls += 1;
        return { ok: true, data: { Date: "2026-09-27", Valute: { CNY: { Value: 12.5, Nominal: 1 } } } };
      }
    }
  });
  const first = await service.fetchCbrRate("CNY");
  const second = await service.fetchCbrRate("CNY");
  assert.equal(first.data.rate, 12.5);
  assert.equal(second.data.rate, 12.5);
  assert.equal(calls, 1, "第二次应命中内存缓存");
});

test("fetchCbrRate 网络失败时回退到库内快照", async () => {
  const { service } = makeService({
    deps: {
      fetchJson: async () => ({ ok: false, status: 502 }),
      isSqlReady: () => true,
      getSqlPool: () => ({ query: async () => [[{ rateDate: "2026-09-26", cnyRateRub: 12.4, source: "cbr" }]] })
    }
  });
  const result = await service.fetchCbrRate("CNY");
  assert.equal(result.ok, true);
  assert.equal(result.data.rate, 12.4);
  assert.equal(result.data.source, "cbr");
});

test("fetchCbrRate 网络与库都不可用时返回上游错误", async () => {
  const { service } = makeService({ deps: { fetchJson: async () => ({ ok: false, status: 503 }) } });
  const result = await service.fetchCbrRate("CNY");
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.message, /Failed to fetch CBR rates/);
});

test("fetchRubPurchaseCostRate 优先用库内值，否则由 CBR 反推", async () => {
  const fromDb = makeService({
    deps: { isSqlReady: () => true, getSqlPool: () => ({ query: async () => [[{ rateDate: "2026-09-26", rubPurchaseCostRate: 0.08, source: "manual" }]] }) }
  });
  const dbResult = await fromDb.service.fetchRubPurchaseCostRate();
  assert.equal(dbResult.ok, true);
  assert.equal(dbResult.data.rate, 0.08);
  assert.equal(dbResult.data.source, "manual");

  const derived = makeService({
    deps: {
      isSqlReady: () => false,
      fetchJson: async () => ({ ok: true, data: { Date: "2026-09-26", Valute: { CNY: { Value: 12.5, Nominal: 1 } } } })
    }
  });
  const derivedResult = await derived.service.fetchRubPurchaseCostRate();
  assert.equal(derivedResult.ok, true);
  assert.equal(derivedResult.data.rate, 1 / 12.5);
  assert.equal(derivedResult.data.source, "cbr-derived");
});

test("fetchRubPurchaseCostRate 无库值且 CBR 不可用时返回 502", async () => {
  const { service } = makeService({ deps: { fetchJson: async () => ({ ok: false, status: 502 }) } });
  const result = await service.fetchRubPurchaseCostRate();
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
});
