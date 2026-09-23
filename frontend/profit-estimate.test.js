const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPlatformProfitEstimate } = require("./shared/core/profit-estimate");

test("builds a partial Yandex estimate without pretending missing fees are zero", () => {
  const estimate = buildPlatformProfitEstimate({
    provider: "yandex_market",
    revenueRub: 2186,
    revenueRmb: 188.94,
    commissionRub: 568.36,
    commissionRmb: 49.12,
    matchedOnlineProductCommissionPercent: 26,
    profitRub: 849.78,
    profitRmb: 73.45
  });
  assert.equal(estimate.status, "部分预估");
  assert.equal(estimate.payoutRub, 1617.64);
  assert.equal(estimate.erpProfitRub, 849.78);
  assert.match(estimate.source, /Yandex tariffs\/calculate/);
  assert.equal(estimate.complete, false);
});

test("returns null for a non-Yandex order", () => {
  assert.equal(buildPlatformProfitEstimate({ provider: "ozon" }), null);
});

test("keeps unavailable platform fees and payout as null", () => {
  const estimate = buildPlatformProfitEstimate({ provider: "yandex_market", revenueRub: 1000 });
  assert.equal(estimate.feeRub, null);
  assert.equal(estimate.payoutRub, null);
  assert.equal(estimate.status, "待获取");
});
