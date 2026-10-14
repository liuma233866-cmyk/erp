const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchOzonFbsOrders, mapOzonPostingToLocal } = require("./ozon-orders");

test("maps an Ozon posting to a CNY V2 order", () => {
  const order = mapOzonPostingToLocal({
    posting_number: "123-1-1",
    status: "delivered",
    in_process_at: "2026-08-10T08:00:00Z",
    products: [{ offer_id: "SKU-1", name: "商品", quantity: 2, price: "19.50", currency_code: "CNY" }]
  }, { id: "SHOP-1", name: "Ozon店", campaignId: "CAMPAIGN-TEST-1" });
  assert.equal(order.amount, 39);
  assert.equal(order.currency, "CNY");
  assert.equal(order.customerReceiptCode, "received");
  assert.equal(order.status, "shipped");
  assert.equal(order.shopId, "SHOP-1");
});

test("paginates Ozon postings", async () => {
  let calls = 0;
  const request = async () => ({ ok: true, status: 200, json: async () => ({ result: { postings: [{ posting_number: String(++calls) }], has_next: calls < 2 } }) });
  const result = await fetchOzonFbsOrders("client", "key", { request, limit: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.posting_number), ["1", "2"]);
});
