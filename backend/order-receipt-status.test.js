const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyReceiptGroup, classifyYandexCustomerReceipt, matchesCustomerReceiptFilter } = require("./order-receipt-status");

test("marks a delivered order as received in Chinese and English", () => {
  assert.deepEqual(classifyYandexCustomerReceipt("DELIVERED", "DELIVERY_SERVICE_DELIVERED"), {
    code: "received",
    labelZh: "已收货",
    labelEn: "Received",
    received: true
  });
});

test("does not treat arrival at a pickup point as customer receipt", () => {
  assert.deepEqual(classifyYandexCustomerReceipt("PICKUP", "PICKUP_SERVICE_RECEIVED"), {
    code: "ready_for_pickup",
    labelZh: "待顾客取件",
    labelEn: "Ready for pickup",
    received: false
  });
});

test("explicit customer-not-received substatus overrides DELIVERED", () => {
  assert.deepEqual(classifyYandexCustomerReceipt("DELIVERED", "DELIVERED_USER_NOT_RECEIVED"), {
    code: "not_received",
    labelZh: "顾客未收到",
    labelEn: "Customer not received",
    received: false
  });
});

test("recognizes explicit pickup receipt", () => {
  assert.equal(classifyYandexCustomerReceipt("PICKUP", "PICKUP_USER_RECEIVED").received, true);
});

test("returned filter includes full and partial returns", () => {
  assert.equal(matchesCustomerReceiptFilter("returned", "returned"), true);
  assert.equal(matchesCustomerReceiptFilter("partially_returned", "returned"), true);
  assert.equal(matchesCustomerReceiptFilter("received", "returned"), false);
});

test("groups receipt statuses for the V2 signed-order tabs", () => {
  assert.equal(classifyReceiptGroup("received", "shipped"), "signed");
  assert.equal(classifyReceiptGroup("ready_for_pickup", "shipped"), "unsigned");
  assert.equal(classifyReceiptGroup("in_delivery", "shipped"), "unsigned");
  assert.equal(classifyReceiptGroup("", "shipped"), "unsigned");
  assert.equal(classifyReceiptGroup("not_received", "shipped"), "exception");
  assert.equal(classifyReceiptGroup("returned", "shipped"), "exception");
  assert.equal(classifyReceiptGroup("partially_returned", "shipped"), "exception");
  assert.equal(classifyReceiptGroup("", "pending"), "");
});
