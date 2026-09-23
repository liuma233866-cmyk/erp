const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateYandexOrderPricing,
  applyHistoricalRevenueFallback
} = require("./order-pricing");

const toMoney = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
};

test("sums seller price and Yandex subsidy for every item", () => {
  const pricing = calculateYandexOrderPricing(
    [
      { count: 2, price: 100, subsidy: 10 },
      { count: 1, price: 250, subsidy: 20 }
    ],
    [400],
    toMoney
  );

  assert.deepEqual(pricing, { quantity: 3, amount: 490, unitPrice: 163.33 });
  const order = { amount: pricing.amount, unitPrice: pricing.unitPrice, itemCount: pricing.quantity };
  applyHistoricalRevenueFallback(order, 999);
  assert.deepEqual(order, { amount: 490, unitPrice: 163.33, itemCount: 3, revenueRub: 490 });
});

test("matches the Yandex seller price for a subsidized order", () => {
  const pricing = calculateYandexOrderPricing(
    [{ count: 1, price: 659, subsidy: 434 }],
    [659],
    toMoney
  );
  const order = { amount: pricing.amount, unitPrice: pricing.unitPrice, itemCount: 1 };
  applyHistoricalRevenueFallback(order, 2000);
  assert.equal(order.amount, 1093);
  assert.equal(order.unitPrice, 1093);
  assert.equal(order.revenueRub, 1093);
});

test("uses historical revenue only when the current order has no usable price", () => {
  const order = { amount: 0, itemCount: 2 };
  applyHistoricalRevenueFallback(order, 1200);
  assert.equal(order.amount, 1200);
  assert.equal(order.unitPrice, 600);
  assert.equal(order.revenueRub, 1200);
});
