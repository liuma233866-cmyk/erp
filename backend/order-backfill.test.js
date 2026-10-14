// order_purchases 表行 → db.orderPurchaseOverrides 的映射回归测试。
//
// 背景：orderPurchaseOverrides 是「表属主」实体（persistence/store-manifest.js），AppState
// 快照里没有它，所以它只能由 order_purchases 表回填。历史缺陷是启动时压根没有重建这个数组
// （只把表行贴到已存在的订单对象上），导致重启后数组恒为空、延迟采购单再也贴不回订单。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyOrderPurchaseOverrides,
  buildOrderPurchaseOverridesFromRows
} = require("./order-backfill");

test("完整表行映射为标准覆盖集形状，字段全部字符串化并去空白", () => {
  const [override] = buildOrderPurchaseOverridesFromRows([{
    orderRef: " ORD-1 ",
    orderId: "ORD-1",
    shopOrderNo: "SHOP-1",
    purchasePlatform: "taobao",
    purchaseLink: "https://example.com/item",
    purchaseOrderNo: "PO-1",
    purchaseExpressNo: "SF123",
    purchaseIntlNo: "INT456",
    purchasePriceRmb: " 12.5 ",
    purchasePriceRub: "150",
    purchaseUpdatedAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T11:00:00.000Z"
  }]);
  assert.deepEqual(override, {
    orderRef: "ORD-1",
    purchasePlatform: "taobao",
    purchaseLink: "https://example.com/item",
    purchaseOrderNo: "PO-1",
    purchaseExpressNo: "SF123",
    purchaseIntlNo: "INT456",
    purchasePriceRmb: "12.5",
    purchasePriceRub: "150",
    purchaseUpdatedAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T11:00:00.000Z"
  });
});

test("orderRef 为空时回退到 orderId / shopOrderNo（延迟采购单只有其中一列有值）", () => {
  const overrides = buildOrderPurchaseOverridesFromRows([
    { orderRef: "", orderId: "ORD-BY-ID", purchaseOrderNo: "PO-A" },
    { orderRef: null, orderId: "", shopOrderNo: "SHOP-BY-NO", purchaseOrderNo: "PO-B" }
  ]);
  assert.deepEqual(overrides.map((item) => item.orderRef), ["ORD-BY-ID", "SHOP-BY-NO"]);
});

test("三列都为空的行被丢弃，不产生无引用的覆盖项", () => {
  const overrides = buildOrderPurchaseOverridesFromRows([
    { orderRef: "  ", orderId: "", shopOrderNo: null },
    { orderRef: "ORD-OK" }
  ]);
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].orderRef, "ORD-OK");
});

test("缺失字段补为空字符串（applyOrderPurchaseOverrides 只认非空值，所以安全）", () => {
  const [override] = buildOrderPurchaseOverridesFromRows([{ orderRef: "ORD-X", purchaseOrderNo: "PO-X" }]);
  assert.equal(override.purchasePlatform, "");
  assert.equal(override.purchasePriceRmb, "");
  assert.equal(override.purchaseLink, "");
});

test("updatedAt 缺失时回退到 purchaseUpdatedAt", () => {
  const [override] = buildOrderPurchaseOverridesFromRows([{
    orderRef: "ORD-Y",
    purchaseUpdatedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: ""
  }]);
  assert.equal(override.updatedAt, "2026-10-01T00:00:00.000Z");
});

test("空表 / 非数组输入返回空数组", () => {
  assert.deepEqual(buildOrderPurchaseOverridesFromRows([]), []);
  assert.deepEqual(buildOrderPurchaseOverridesFromRows(null), []);
  assert.deepEqual(buildOrderPurchaseOverridesFromRows(undefined), []);
});

test("回填出的覆盖集能把采购信息贴回订单（含延迟采购：订单稍后才出现）", () => {
  const overrides = buildOrderPurchaseOverridesFromRows([{
    orderRef: "ORD-LATE",
    purchasePlatform: "1688",
    purchaseOrderNo: "PO-LATE",
    purchasePriceRmb: "88.8",
    purchaseUpdatedAt: "2026-10-06T00:00:00.000Z"
  }]);
  // 订单在采购登记之后才被同步进来
  const orders = [{ id: "ORD-LATE", shopOrderNo: "ORD-LATE", status: "PROCESSING" }];
  applyOrderPurchaseOverrides(orders, overrides);
  assert.equal(orders[0].purchaseOrderNo, "PO-LATE");
  assert.equal(orders[0].purchasePlatform, "1688");
  assert.equal(orders[0].purchasePriceRmb, "88.8");
});
