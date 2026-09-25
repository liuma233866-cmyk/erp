// 采集箱 / 上架记录 落库映射测试：写进自己的表、读回来还是同一条。
const { test } = require("node:test");
const assert = require("node:assert");

const { createSqlWriters } = require("./sql-persistence");

function makeWriters(db = {}) {
  const captured = [];
  return {
    captured,
    writers: createSqlWriters({
      getSqlPool: () => ({
        execute: async (sql, values) => {
          captured.push({ sql, values });
          return [{}];
        },
        query: async (sql) => {
          captured.push({ sql, values: [] });
          return [[]];
        },
        getConnection: async () => ({
          beginTransaction: async () => {},
          query: async (sql, values) => {
            captured.push({ sql, values });
            return [{}];
          },
          commit: async () => {},
          rollback: async () => {},
          release: () => {}
        })
      }),
      isSqlReady: () => true,
      getDb: () => db,
      serializeDatabase: (value) => value,
      stateKey: "app_state_v1",
      encryptSecret: (value) => value
    })
  };
}

test("采集箱条目写进 collection_box 表，日期字段转成 Date", async () => {
  const { captured, writers } = makeWriters();
  await writers.saveCollectionBoxToSql([{
    id: "CB-1",
    source: "erp-chrome-collector-v1",
    sourcePlatform: "ozon",
    sourceProductId: "4430417783",
    title: "帐篷",
    sku: "4430417783",
    publishStatus: "draft",
    collectedAt: "2026-09-25T04:30:00.000Z",
    createdAt: "2026-09-25T04:30:00.000Z",
    updatedAt: "2026-09-25T04:30:00.000Z"
  }]);

  const insert = captured.find((entry) => entry.sql.includes("INSERT INTO collection_box"));
  assert.ok(insert, "expected an INSERT INTO collection_box call");
  assert.ok(insert.values.includes("CB-1"));
  assert.ok(insert.values.includes("ozon"));
  const dateValues = insert.values.filter((value) => value instanceof Date);
  assert.equal(dateValues.length, 2, "createdAt/updatedAt 应该是 Date 对象，不能是带 Z 的字符串");
  assert.ok(insert.values.includes("2026-09-25T04:30:00.000Z"), "collectedAt 是文本列，按原样存");
});

test("collection_box 行读回来能还原成采集箱条目", () => {
  const { writers } = makeWriters();
  const entry = writers.hydrateCollectionBoxFromSqlRow({
    id: "CB-1",
    source: "erp-chrome-collector-v1",
    sourcePlatform: "ozon",
    sourceProductId: "4430417783",
    sourceUrl: "https://www.ozon.ru/product/4430417783",
    title: "帐篷",
    sku: "4430417783",
    imageUrl: "https://img/1.png",
    aiImageStatus: "queued",
    publishStatus: "draft",
    publishMessage: "",
    publishProductId: "COL-1",
    shopId: "SHP-1",
    collectedAt: "2026-09-25T04:30:00.000Z",
    createdAt: new Date("2026-09-25T04:30:00.000Z"),
    updatedAt: new Date("2026-09-25T05:00:00.000Z")
  });

  assert.equal(entry.id, "CB-1");
  assert.equal(entry.publishProductId, "COL-1");
  assert.equal(entry.createdAt, "2026-09-25T04:30:00.000Z");
  assert.equal(entry.updatedAt, "2026-09-25T05:00:00.000Z");
});

test("采集箱删除只删 collection_box 指定行", async () => {
  const { captured, writers } = makeWriters();
  await writers.deleteCollectionBoxFromSql(["CB-1", "CB-2"]);
  const del = captured.find((entry) => entry.sql.startsWith("DELETE FROM collection_box"));
  assert.ok(del, "expected a DELETE FROM collection_box call");
  assert.equal(del.values.length, 2);
  assert.ok(!captured.some((entry) => entry.sql.includes("publishProducts")), "不能碰刊登池");
});

test("上架记录写进 publish_records 表并能读回来", async () => {
  const { captured, writers } = makeWriters();
  await writers.savePublishRecordsToSql([{
    id: "PR-1",
    ts: "2026-09-25T04:12:00.000Z",
    actorUsername: "admin2",
    result: "blocked",
    statusCode: 200,
    message: "卡片质量分低于 80，已拦截刊登",
    productId: "PUB-1",
    sku: "SKU-1",
    title: "商品一",
    shopId: "SHP-1",
    shopName: "Yandex 主店",
    platform: "Yandex",
    publishStatus: "blocked"
  }]);

  const insert = captured.find((entry) => entry.sql.includes("INSERT INTO publish_records"));
  assert.ok(insert, "expected an INSERT INTO publish_records call");
  assert.ok(insert.values.includes("PR-1"));
  assert.ok(insert.values.includes("blocked"));

  const record = writers.hydratePublishRecordFromSqlRow({
    id: "PR-1",
    ts: new Date("2026-09-25T04:12:00.000Z"),
    actorUsername: "admin2",
    result: "blocked",
    statusCode: 200,
    message: "卡片质量分低于 80，已拦截刊登",
    productId: "PUB-1",
    sku: "SKU-1",
    title: "商品一",
    shopId: "SHP-1",
    shopName: "Yandex 主店",
    platform: "Yandex",
    publishStatus: "blocked"
  });
  assert.equal(record.result, "blocked");
  assert.equal(record.ts, "2026-09-25T04:12:00.000Z");
  assert.equal(record.sku, "SKU-1");
});

test("AppState 快照里不再写采集箱和上架记录", async () => {
  const db = {
    users: [],
    activeSessions: [],
    shops: [],
    reviewRules: [],
    onlineProducts: [],
    orders: [],
    collectionBox: [{ id: "CB-1" }],
    publishRecords: [{ id: "PR-1" }]
  };
  const { captured, writers } = makeWriters(db);
  await writers.saveDatabaseToSql();
  const snapshotWrite = captured.find((entry) => entry.sql.includes("INSERT INTO AppState"));
  assert.ok(snapshotWrite, "expected the AppState snapshot write");
  const payload = JSON.parse(snapshotWrite.values[1]);
  assert.equal(payload.collectionBox, undefined, "快照里不该再有 collectionBox");
  assert.equal(payload.publishRecords, undefined, "快照里不该再有 publishRecords");
});
