// 采集箱 / 上架记录 独立数据层测试。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  upsertCollectionBoxEntry,
  appendPublishRecord,
  applyPublishOutcome,
  collectorKey
} = require("./page-stores");

test("采集器同一条商品重复投递只更新采集箱里的同一条", () => {
  const box = [];
  const first = upsertCollectionBoxEntry(box, {
    sourcePlatform: "ozon",
    sourceProductId: "4430417783",
    title: "第一次采集",
    sku: "4430417783"
  });
  const second = upsertCollectionBoxEntry(box, {
    sourcePlatform: "ozon",
    sourceProductId: "4430417783",
    title: "第二次采集"
  });

  assert.equal(box.length, 1);
  assert.equal(first.id, second.id);
  assert.equal(box[0].title, "第二次采集");
  assert.equal(collectorKey(box[0]), "ozon::4430417783::");
});

test("同一款商品采集到两个店铺算两条，不互相覆盖", () => {
  const box = [];
  upsertCollectionBoxEntry(box, { sourcePlatform: "ozon", sourceProductId: "4430417783", shopId: "SHP-A", title: "A 店的" });
  upsertCollectionBoxEntry(box, { sourcePlatform: "ozon", sourceProductId: "4430417783", shopId: "SHP-B", title: "B 店的" });
  upsertCollectionBoxEntry(box, { sourcePlatform: "ozon", sourceProductId: "4430417783", shopId: "SHP-A", title: "A 店改过标题" });

  assert.equal(box.length, 2);
  assert.equal(box.find((entry) => entry.shopId === "SHP-A").title, "A 店改过标题");
  assert.equal(box.find((entry) => entry.shopId === "SHP-B").title, "B 店的");
});

test("上架成功会写下记录，并把采集箱里对应条目置为已刊登", () => {
  const db = {
    shops: [{ id: "SHP-1", name: "Yandex 主店", provider: "yandex_market" }],
    publishRecords: [],
    collectionBox: [{ id: "CB-1", publishProductId: "PUB-1", sourcePlatform: "ozon", sourceProductId: "4430417783", publishStatus: "draft" }]
  };
  const items = [{ id: "PUB-1", sku: "SKU-1", title: "商品一", shopId: "SHP-1", shopName: "Yandex 主店", publishStatus: "success" }];
  const outcome = applyPublishOutcome(db, { username: "admin2" }, items, { statusCode: 200, payload: {} });

  assert.equal(outcome.result, "success");
  assert.equal(db.publishRecords.length, 1);
  assert.equal(db.publishRecords[0].result, "success");
  assert.equal(db.publishRecords[0].platform, "Yandex");
  assert.equal(db.publishRecords[0].actorUsername, "admin2");
  assert.equal(db.collectionBox[0].publishStatus, "success");
});

test("被规则拦截的上架写成 blocked，不算成功", () => {
  const db = { shops: [], publishRecords: [], collectionBox: [] };
  applyPublishOutcome(db, { username: "admin2" }, [{ id: "PUB-1", sku: "SKU-1" }], {
    statusCode: 200,
    payload: { errors: [{ shopId: "SHP-1", message: "卡片质量分低于 80，已拦截刊登" }] }
  });

  assert.equal(db.publishRecords[0].result, "blocked");
  assert.match(db.publishRecords[0].message, /已拦截/);
});

test("失败的上架写成 failed，并带上错误说明", () => {
  const db = { shops: [], publishRecords: [], collectionBox: [] };
  applyPublishOutcome(db, { username: "admin2" }, [{ id: "PUB-1", sku: "SKU-1" }], {
    statusCode: 400,
    payload: { message: "Publish failed: required: yandexCategory" }
  });

  assert.equal(db.publishRecords[0].result, "failed");
  assert.equal(db.publishRecords[0].statusCode, 400);
  assert.match(db.publishRecords[0].message, /yandexCategory/);
});

test("Ozon 一次提交里每条商品按自己的状态记录", () => {
  const db = { shops: [{ id: "SHP-OZON", name: "Ozon 店", provider: "ozon" }], publishRecords: [], collectionBox: [] };
  const items = [
    { id: "PUB-1", sku: "SKU-1", shopId: "SHP-OZON", publishStatus: "success", publishResultMessage: "Ozon 发布成功" },
    { id: "PUB-2", sku: "SKU-2", shopId: "SHP-OZON", publishStatus: "processing", publishResultMessage: "Ozon 任务处理中" },
    { id: "PUB-3", sku: "SKU-3", shopId: "SHP-OZON", publishStatus: "failed", publishResultMessage: "Ozon 发布失败" }
  ];
  applyPublishOutcome(db, { username: "admin2" }, items, { statusCode: 200, payload: {}, perItemStatuses: true });

  const bySku = new Map(db.publishRecords.map((record) => [record.sku, record.result]));
  assert.equal(bySku.get("SKU-1"), "success");
  assert.equal(bySku.get("SKU-2"), "pending");
  assert.equal(bySku.get("SKU-3"), "failed");
});

test("上架记录写到 5000 条封顶，不会无限增长", () => {
  const records = [];
  for (let index = 0; index < 5010; index += 1) {
    appendPublishRecord(records, { ts: new Date().toISOString(), result: "success", sku: `SKU-${index}` });
  }
  assert.equal(records.length, 5000);
  assert.equal(records[0].sku, "SKU-5009");
});

test("上架结果返回刚落库的记录，方便写进 publish_records 表", () => {
  const db = { shops: [], publishRecords: [], collectionBox: [{ id: "CB-1", publishProductId: "PUB-1", publishStatus: "draft" }] };
  const outcome = applyPublishOutcome(db, { username: "admin2" }, [{ id: "PUB-1", sku: "SKU-1", publishStatus: "success" }], { statusCode: 200, payload: {} });

  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].id, db.publishRecords[0].id);
  assert.equal(outcome.boxEntries.length, 1);
  assert.equal(outcome.boxEntries[0].id, "CB-1");
  assert.equal(outcome.boxEntries[0].publishStatus, "success");
});
