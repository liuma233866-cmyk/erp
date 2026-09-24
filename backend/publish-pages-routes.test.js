// 采集箱 / 上架记录 两个新页面的数据边界测试。
//
// 规则：两个页面只认自己域内的数据。
// - 采集箱：只显示采集来源（collector / 采集批次）的商品，从在线产品复制过来的不算。
// - 上架记录：只显示 product_publish + publish 的商品级动作，日志汇总行和别的模块日志都不算。
const test = require("node:test");
const assert = require("node:assert/strict");

const { createCollectionBoxRoutes } = require("./routes/collection-box");
const { createPublishRecordsRoutes } = require("./routes/publish-records");
const { paginateItems, readPositiveIntParam } = require("./pagination");

function createHarness(createRoutes, db) {
  const deps = {
    authService: {
      requireAuth: () => ({ ok: true, user: { id: "USR-1", username: "admin2", role: "admin", companyId: "system" } }),
      checkPermission: () => true
    },
    respondApi: (req, res, user, auditContext, statusCode, payload) => {
      res.statusCode = statusCode;
      res.payload = payload;
    },
    getDb: () => db,
    parseJsonBody: async () => ({}),
    maskSensitive: (value) => value,
    saveDatabase: () => {},
    writeAudit: () => {},
    getUserAssignedShopIds: () => null,
    canUserAccessShop: () => true,
    paginateItems,
    readPositiveIntParam
  };
  return { ...deps, routes: createRoutes(deps) };
}

async function callRoute(harness, pathname, method, query) {
  const route = harness.routes.find((entry) => entry.matches(pathname, method));
  assert.ok(route, `route not found: ${method} ${pathname}`);
  const res = {};
  await route.handler({ method, url: pathname, headers: {} }, res, query || {}, {});
  return res;
}

test("采集箱只返回采集来源的商品，复制自主线产品的条目被排除", async () => {
  const db = {
    shops: [],
    auditLogs: [],
    publishProducts: [
      { id: "COL-1", source: "erp-chrome-collector-v1", title: "扩展采集", publishStatus: "draft", createdAt: "2026-09-20T00:00:00.000Z" },
      { id: "COL-2", source: "ozon-yandex-collector-v2", title: "采集器采集", publishStatus: "success", createdAt: "2026-09-19T00:00:00.000Z" },
      { id: "COL-3", source: "browser_extension", title: "扩展别名", collectedAt: "2026-09-18T00:00:00.000Z" },
      { id: "COL-4", source: "", collectBatchId: "batch-9", title: "带采集批次" },
      { id: "COPY-1", source: "yandex_online_product", title: "从在线产品复制" },
      { id: "MANUAL-1", source: "manual", title: "手工录入" }
    ]
  };
  const harness = createHarness(createCollectionBoxRoutes, db);
  const res = await callRoute(harness, "/api/collection-box", "GET", {});

  const ids = res.payload.items.map((item) => item.id);
  assert.deepEqual(ids.sort(), ["COL-1", "COL-2", "COL-3", "COL-4"]);
  assert.equal(res.payload.summary.total, 4);
  assert.equal(res.payload.summary.pending, 3);
  assert.equal(res.payload.summary.published, 1);
  assert.equal(res.payload.summary.failed, 0);
});

test("采集箱的关键词与状态筛选只作用在采集条目的字段上", async () => {
  const db = {
    shops: [],
    auditLogs: [],
    publishProducts: [
      { id: "COL-1", source: "erp-chrome-collector-v1", title: "帐篷", sku: "4430417783", publishStatus: "draft" },
      { id: "COL-2", source: "ozon-yandex-collector-v2", title: "烤炉", sku: "yd-1", publishStatus: "success" },
      { id: "COPY-1", source: "yandex_online_product", title: "帐篷", sku: "4430417783" }
    ]
  };
  const harness = createHarness(createCollectionBoxRoutes, db);

  const byKeyword = await callRoute(harness, "/api/collection-box", "GET", { keyword: "4430417783" });
  assert.deepEqual(byKeyword.payload.items.map((item) => item.id), ["COL-1"]);

  const published = await callRoute(harness, "/api/collection-box", "GET", { status: "published" });
  assert.deepEqual(published.payload.items.map((item) => item.id), ["COL-2"]);
  assert.equal(published.payload.pagination.total, 1);
});

test("上架记录只取商品级上架动作，请求级汇总行和其他模块日志都不返回", async () => {
  const db = {
    shops: [{ id: "SHP-1", name: "Yandex 主店", provider: "yandex_market" }],
    publishProducts: [{ id: "PUB-1", sku: "SKU-1", title: "商品一", shopId: "SHP-1", shopName: "Yandex 主店", publishStatus: "success" }],
    auditLogs: [
      { id: "AUD-1", ts: "2026-09-20T10:00:00.000Z", resourceType: "product_publish", actionType: "publish", resourceId: "PUB-1", statusCode: 200, success: true, actorUsername: "admin2" },
      { id: "AUD-2", ts: "2026-09-20T10:00:00.000Z", resourceType: "product_publish", actionType: "publish", resourceId: "", statusCode: 200, success: true, actorUsername: "admin2" },
      { id: "AUD-3", ts: "2026-09-20T09:00:00.000Z", resourceType: "product_publish", actionType: "copy", resourceId: "PUB-1", statusCode: 200, success: true },
      { id: "AUD-4", ts: "2026-09-20T08:00:00.000Z", resourceType: "order", actionType: "publish", resourceId: "PUB-1", statusCode: 200, success: true },
      { id: "AUD-5", ts: "2026-09-20T07:00:00.000Z", resourceType: "product_publish", actionType: "publish", resourceId: "PUB-1", statusCode: 400, success: false, errorMessage: "Publish failed: required: yandexCategory", actorUsername: "admin2" }
    ]
  };
  const harness = createHarness(createPublishRecordsRoutes, db);
  const res = await callRoute(harness, "/api/publish-records", "GET", {});

  assert.deepEqual(res.payload.items.map((item) => item.id).sort(), ["AUD-1", "AUD-5"]);
  assert.equal(res.payload.summary.total, 2);
  assert.equal(res.payload.summary.success, 1);
  assert.equal(res.payload.summary.failed, 1);
  assert.equal(res.payload.summary.blocked, 0);

  const successRecord = res.payload.items.find((item) => item.id === "AUD-1");
  assert.equal(successRecord.result, "success");
  assert.equal(successRecord.sku, "SKU-1");
  assert.equal(successRecord.platform, "Yandex");
});

test("被规则拦截的上架记为 blocked，不再算成功，并且可以单独筛选", async () => {
  const db = {
    shops: [],
    publishProducts: [],
    auditLogs: [
      {
        id: "AUD-B1",
        ts: "2026-09-21T03:40:08.695Z",
        resourceType: "product_publish",
        actionType: "publish",
        resourceId: "PUB-B1",
        statusCode: 200,
        success: true,
        warningMessage: "店铺SHP-1: 卡片质量分低于 80，已拦截刊登",
        requestBodyMasked: { sku: "SKU-B1", title: "被拦截的商品" }
      }
    ]
  };
  const harness = createHarness(createPublishRecordsRoutes, db);
  const all = await callRoute(harness, "/api/publish-records", "GET", {});

  assert.equal(all.payload.items[0].result, "blocked");
  assert.equal(all.payload.items[0].success, false);
  assert.equal(all.payload.items[0].sku, "SKU-B1");
  assert.equal(all.payload.items[0].title, "被拦截的商品");
  assert.equal(all.payload.summary.blocked, 1);

  const blockedOnly = await callRoute(harness, "/api/publish-records", "GET", { status: "blocked" });
  assert.equal(blockedOnly.payload.pagination.total, 1);
  const successOnly = await callRoute(harness, "/api/publish-records", "GET", { status: "success" });
  assert.equal(successOnly.payload.pagination.total, 0);
  const failedOnly = await callRoute(harness, "/api/publish-records", "GET", { status: "failed" });
  assert.equal(failedOnly.payload.pagination.total, 0);
});
