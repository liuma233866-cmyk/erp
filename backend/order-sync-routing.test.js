const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRequestedOrderSyncPlan } = require("./order-sync-routing");

test("routes requested orders only to their owning child shop", () => {
  const shops = [{ id: "child-a" }, { id: "child-b" }];
  const orders = [
    { shopOrderNo: "100", shopId: "child-a" },
    { shopOrderNo: "200", shopId: "child-b" }
  ];
  const result = buildRequestedOrderSyncPlan(shops, ["100", "200"], orders);
  assert.deepEqual(result.plans.map((item) => ({ shopId: item.shop.id, orderNos: item.orderNos })), [
    { shopId: "child-a", orderNos: ["100"] },
    { shopId: "child-b", orderNos: ["200"] }
  ]);
  assert.deepEqual(result.unresolved, []);
});

test("does not query every child shop when an order owner is unknown", () => {
  const result = buildRequestedOrderSyncPlan([{ id: "child-a" }, { id: "child-b" }], ["new-order"], []);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.unresolved, ["new-order"]);
});
