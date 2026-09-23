const test = require("node:test");
const assert = require("node:assert/strict");
const { getShopOrderWorkspace, normalizeOrderWorkspace, orderBelongsToWorkspace } = require("./shop-order-workspace");

test("existing shops default to order management V1", () => {
  assert.equal(normalizeOrderWorkspace(""), "v1");
  assert.equal(getShopOrderWorkspace({ id: "s1" }, {}), "v1");
});

test("shop override routes existing and future orders to V2", () => {
  const shops = [{ id: "s1" }, { id: "s2" }];
  const overrides = { s1: "v2" };
  assert.equal(orderBelongsToWorkspace({ shopId: "s1" }, shops, overrides, "v2"), true);
  assert.equal(orderBelongsToWorkspace({ shopId: "s1" }, shops, overrides, "v1"), false);
  assert.equal(orderBelongsToWorkspace({ shopId: "s2" }, shops, overrides, "v1"), true);
});
