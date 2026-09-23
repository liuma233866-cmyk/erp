const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildOrderV2Summary,
  isOrderV2Eligible,
  matchesOrderV2Query,
  normalizeOrderV2
} = require("./orders-v2");

test("V2 accepts only CNY Yandex and Ozon orders", () => {
  assert.equal(isOrderV2Eligible({ platform: "yandex", currency: "CNY" }), true);
  assert.equal(isOrderV2Eligible({ provider: "ozon", currency: "RMB" }), true);
  assert.equal(isOrderV2Eligible({ platform: "yandex", currency: "RUR" }), false);
  assert.equal(isOrderV2Eligible({ platform: "other", currency: "CNY" }), false);
});

test("V2 can resolve platform and currency from its shop", () => {
  const shop = { provider: "yandex_market", settlementCurrency: "CNY", name: "人民币店铺" };
  assert.equal(isOrderV2Eligible({ shopId: "s1" }, shop), true);
  assert.equal(normalizeOrderV2({ shopId: "s1", amount: 100 }, shop).shopName, "人民币店铺");
});

test("V2 normalizes RMB money without exchange-rate conversion", () => {
  const order = normalizeOrderV2({
    platform: "ozon",
    currency: "CNY",
    amount: 300,
    platformFeeRmb: 60,
    purchasePriceRmb: 100,
    logisticsCostRmb: 20
  });
  assert.equal(order.revenueRmb, 300);
  assert.equal(order.estimatedProfitRmb, 120);
  assert.equal(order.settlementCurrency, "CNY");
});

test("V2 query and summary work on normalized orders", () => {
  const orders = [
    normalizeOrderV2({ platform: "yandex", currency: "CNY", shopOrderNo: "Y-1", shopSku: "A", amount: 100, matchedOnlineProductWeightKg: 1 }),
    normalizeOrderV2({ platform: "ozon", currency: "CNY", shopOrderNo: "O-1", amount: 80 })
  ];
  assert.equal(matchesOrderV2Query(orders[0], { platform: "yandex", keyword: "Y-1" }), true);
  assert.deepEqual(buildOrderV2Summary(orders), { total: 2, yandex: 1, ozon: 1, exceptions: 1, profitPending: 2 });
});
