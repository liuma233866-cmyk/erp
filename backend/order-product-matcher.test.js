const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillOrderProductMatches } = require("./order-product-matcher");

test("fills product, weight and commission for one exact shop SKU match", () => {
  const order = { shopId: "shop-1", shopSku: "SKU00134" };
  const changed = backfillOrderProductMatches([order], [{
    id: "product-1",
    shopId: "shop-1",
    shopSku: "SKU00134",
    name: "Matched product",
    weightKg: 1.5,
    commissionPercent: 26
  }]);

  assert.equal(changed, true);
  assert.equal(order.matchedOnlineProductId, "product-1");
  assert.equal(order.matchedOnlineProductWeightKg, 1.5);
  assert.equal(order.matchedOnlineProductCommissionPercent, 26);
});

test("does not guess when the same shop SKU has multiple products", () => {
  const order = { shopId: "shop-1", shopSku: "duplicate" };
  const products = [
    { id: "product-1", shopId: "shop-1", shopSku: "duplicate", weightKg: 1, commissionPercent: 10 },
    { id: "product-2", shopId: "shop-1", shopSku: "duplicate", weightKg: 2, commissionPercent: 20 }
  ];

  assert.equal(backfillOrderProductMatches([order], products), false);
  assert.equal(order.matchedOnlineProductId, undefined);
});
