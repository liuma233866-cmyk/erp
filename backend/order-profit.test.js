const test = require("node:test");
const assert = require("node:assert/strict");
const { computeOrderProfit, deriveRates } = require("./order-profit");

test("computes a RUB order profit snapshot from a matched rule", () => {
  const rates = deriveRates(0.08, 12.5);
  const rule = {
    id: "R1",
    name: "测试规则",
    commissionPercent: 10,
    logisticsPerKgRub: 50,
    registrationFeeRub: 100,
    otherFeeRub: 0,
    packingFeeRub: 0,
    withdrawPercent: 0,
    transferPercent: 0
  };
  const order = {
    id: "O1",
    amount: 1000,
    currency: "RUB",
    itemCount: 2,
    matchedOnlineProductWeightKg: 1,
    purchasePriceRub: 200
  };
  const p = computeOrderProfit(order, rule, rates);
  assert.equal(p.profitRub, 500);
  assert.equal(p.profitRmb, 40);
  assert.equal(p.commissionRub, 100);
  assert.equal(p.logisticsFeeRub, 200);
});

test("returns empty profit when no rule matches", () => {
  const p = computeOrderProfit({ id: "O1", amount: 100 }, null, deriveRates(0.08, 12.5));
  assert.equal(p.profitRub, null);
  assert.equal(p.profitRmb, null);
  assert.equal(p.matchedRuleId, "");
});
