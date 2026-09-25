// 采集箱 / 上架记录 两个页面的数据边界测试。
//
// 规则：两个页面各自读写自己的数据，不与其他模块互通。
// - 采集箱：只读 db.collectionBox，删除只删自己这一份，不动刊登工作台。
// - 上架记录：只读 db.publishRecords，不读审计日志，也不依赖刊登池。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createCollectionBoxRoutes } = require("./routes/collection-box");
const { createPublishRecordsRoutes } = require("./routes/publish-records");
const { listCollectionBox, listPublishRecords } = require("./page-stores");
const { paginateItems, readPositiveIntParam } = require("./pagination");

const TEST_USER = { id: "USR-1", username: "admin2", role: "admin", companyId: "system" };

function createHarness(createRoutes, db) {
  const requestBody = { value: {} };
  const deps = {
    authService: {
      requireAuth: () => ({ ok: true, user: TEST_USER }),
      checkPermission: () => true
    },
    respondApi: (req, res, user, auditContext, statusCode, payload) => {
      res.statusCode = statusCode;
      res.payload = payload;
    },
    getDb: () => db,
    parseJsonBody: async () => requestBody.value,
    maskSensitive: (value) => value,
    saveDatabase: () => {},
    writeAudit: () => {},
    getUserAssignedShopIds: () => null,
    canUserAccessShop: () => true,
    paginateItems,
    readPositiveIntParam,
    listCollectionBox,
    listPublishRecords
  };
  const harness = { ...deps, db, requestBody, routes: createRoutes(deps) };
  return harness;
}

async function callRoute(harness, pathname, method, query, body) {
  const route = harness.routes.find((entry) => entry.matches(pathname, method));
  assert.ok(route, `route not found: ${method} ${pathname}`);
  if (body !== undefined) harness.requestBody.value = body;
  const res = {};
  await route.handler({ method, url: pathname, headers: {} }, res, query || {}, {});
  return res;
}

test("采集箱只返回采集箱自己的条目，刊登池里的东西一条都不过去", async () => {
  const db = {
    shops: [],
    auditLogs: [],
    // 刊登池里既有采集条目也有从在线产品复制的条目：采集箱一个都不该读。
    publishProducts: [
      { id: "PUB-1", source: "erp-chrome-collector-v1", title: "刊登池里的采集条目" },
      { id: "PUB-2", source: "yandex_online_product", title: "从在线产品复制" }
    ],
    collectionBox: [
      { id: "CB-1", source: "erp-chrome-collector-v1", sourcePlatform: "ozon", title: "采集箱自己的条目", publishStatus: "draft", collectedAt: "2026-09-20T00:00:00.000Z" },
      { id: "CB-2", source: "ozon-yandex-collector-v2", sourcePlatform: "yandex", title: "已刊登的采集条目", publishStatus: "success", collectedAt: "2026-09-19T00:00:00.000Z" }
    ]
  };
  const harness = createHarness(createCollectionBoxRoutes, db);
  const res = await callRoute(harness, "/api/collection-box", "GET", {});

  assert.deepEqual(res.payload.items.map((item) => item.id), ["CB-1", "CB-2"]);
  assert.equal(res.payload.summary.total, 2);
  assert.equal(res.payload.summary.pending, 1);
  assert.equal(res.payload.summary.published, 1);
  assert.equal(res.payload.summary.failed, 0);
});

test("采集箱的关键词与状态筛选只作用在自己条目的字段上", async () => {
  const db = {
    shops: [],
    auditLogs: [],
    publishProducts: [],
    collectionBox: [
      { id: "CB-1", sourcePlatform: "ozon", title: "帐篷", sku: "4430417783", publishStatus: "draft" },
      { id: "CB-2", sourcePlatform: "yandex", title: "烤炉", sku: "yd-1", publishStatus: "success" }
    ]
  };
  const harness = createHarness(createCollectionBoxRoutes, db);

  const byKeyword = await callRoute(harness, "/api/collection-box", "GET", { keyword: "4430417783" });
  assert.deepEqual(byKeyword.payload.items.map((item) => item.id), ["CB-1"]);

  const published = await callRoute(harness, "/api/collection-box", "GET", { status: "published" });
  assert.deepEqual(published.payload.items.map((item) => item.id), ["CB-2"]);
  assert.equal(published.payload.pagination.total, 1);
});

test("删除采集箱条目不会碰到刊登工作台和其他地方", async () => {
  const publishProduct = { id: "PUB-1", source: "erp-chrome-collector-v1", title: "刊登池里的同款商品" };
  const db = {
    shops: [],
    auditLogs: [{ id: "AUD-1" }],
    publishProducts: [publishProduct],
    collectionBox: [{ id: "CB-1", publishProductId: "PUB-1", title: "采集箱条目" }]
  };
  const before = JSON.stringify({ products: db.publishProducts, audits: db.auditLogs });
  const harness = createHarness(createCollectionBoxRoutes, db);
  const res = await callRoute(harness, "/api/collection-box", "DELETE", {}, { ids: ["CB-1"] });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.removed, 1);
  assert.equal(db.collectionBox.length, 0);
  assert.equal(JSON.stringify({ products: db.publishProducts, audits: db.auditLogs }), before);
});

test("上架记录只读自己的表，审计日志和刊登池都不参与", async () => {
  const db = {
    shops: [{ id: "SHP-1", name: "Yandex 主店", provider: "yandex_market" }],
    publishProducts: [],
    auditLogs: [
      { id: "AUD-1", ts: "2026-09-20T10:00:00.000Z", resourceType: "product_publish", actionType: "publish", resourceId: "PUB-1", statusCode: 200, success: true }
    ],
    publishRecords: [
      { id: "PR-1", ts: "2026-09-20T10:00:00.000Z", result: "success", productId: "PUB-1", sku: "SKU-1", title: "商品一", shopId: "SHP-1", shopName: "Yandex 主店", platform: "Yandex", actorUsername: "admin2" },
      { id: "PR-2", ts: "2026-09-20T09:00:00.000Z", result: "failed", productId: "PUB-2", sku: "SKU-2", message: "Publish failed: required: yandexCategory" }
    ]
  };
  const harness = createHarness(createPublishRecordsRoutes, db);
  const res = await callRoute(harness, "/api/publish-records", "GET", {});

  assert.deepEqual(res.payload.items.map((item) => item.id), ["PR-1", "PR-2"]);
  assert.equal(res.payload.summary.total, 2);
  assert.equal(res.payload.summary.success, 1);
  assert.equal(res.payload.summary.failed, 1);
  assert.equal(res.payload.items[0].platform, "Yandex");
  assert.equal(res.payload.items[0].sku, "SKU-1");
});

test("上架记录的三种结果可以分别筛选", async () => {
  const db = {
    shops: [],
    publishProducts: [],
    auditLogs: [],
    publishRecords: [
      { id: "PR-1", ts: "2026-09-20T10:00:00.000Z", result: "success", sku: "SKU-1" },
      { id: "PR-2", ts: "2026-09-20T09:00:00.000Z", result: "blocked", sku: "SKU-2", message: "卡片质量分低于 80，已拦截刊登" },
      { id: "PR-3", ts: "2026-09-20T08:00:00.000Z", result: "failed", sku: "SKU-3" },
      { id: "PR-4", ts: "2026-09-20T07:00:00.000Z", result: "pending", sku: "SKU-4" }
    ]
  };
  const harness = createHarness(createPublishRecordsRoutes, db);
  const all = await callRoute(harness, "/api/publish-records", "GET", {});
  assert.equal(all.payload.summary.total, 4);
  assert.equal(all.payload.summary.success, 1);
  assert.equal(all.payload.summary.blocked, 1);
  assert.equal(all.payload.summary.failed, 1);
  assert.equal(all.payload.summary.pending, 1);

  for (const status of ["success", "blocked", "failed", "pending"]) {
    const filtered = await callRoute(harness, "/api/publish-records", "GET", { status });
    assert.equal(filtered.payload.pagination.total, 1, `status=${status}`);
  }
});
