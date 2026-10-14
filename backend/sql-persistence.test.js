const { test } = require("node:test");
const assert = require("node:assert");
const { createSqlWriters, buildAppStateSnapshot } = require("./sql-persistence");
const { tableOwnedKeys, appStateOwnedKeys } = require("./persistence/store-manifest");

function makeWriters(encryptSecret) {
  const captured = [];
  return {
    captured,
    writers: createSqlWriters({
      getSqlPool: () => ({
        execute: async (sql, values) => {
          captured.push({ sql, values });
          return [{}];
        }
      }),
      isSqlReady: () => true,
      getDb: () => ({ shops: [] }),
      serializeDatabase: (db) => db,
      stateKey: "app_state_v1",
      encryptSecret
    })
  };
}

test("saveShopToSql encrypts the plaintext key with the injected secret function", async () => {
  const { captured, writers } = makeWriters((value) => `injected:${value}`);
  await writers.saveShopToSql({
    id: "SHP-TEST-1",
    name: "test",
    provider: "yandex_market",
    campaignId: "123",
    businessId: "456",
    apiKey: "plain-key-123"
  });
  const insert = captured.find((entry) => entry.sql.includes("INSERT INTO shops"));
  assert.ok(insert, "expected an INSERT INTO shops call");
  const encryptedKey = insert.values[8];
  assert.strictEqual(encryptedKey, "injected:plain-key-123");
  // The stored value must never be the raw plaintext key.
  assert.notStrictEqual(encryptedKey, "plain-key-123");
});

test("saveShopToSql keeps the existing encrypted value when no plaintext key is present", async () => {
  const { captured, writers } = makeWriters((value) => `injected:${value}`);
  await writers.saveShopToSql({
    id: "SHP-TEST-2",
    name: "test",
    provider: "yandex_market",
    campaignId: "123",
    businessId: "456",
    apiKey: "",
    apiKeyEncrypted: "enc:v1:kept"
  });
  const insert = captured.find((entry) => entry.sql.includes("INSERT INTO shops"));
  assert.ok(insert, "expected an INSERT INTO shops call");
  assert.strictEqual(insert.values[8], "enc:v1:kept");
});

test("buildAppStateSnapshot 剔除所有有专用表的实体，保留 AppState 自有实体", () => {
  const source = {
    users: [{ id: "U1" }],
    shops: [{ id: "S1" }],
    reviewRules: [{ id: "R1" }],
    onlineProducts: [{ id: "P1" }],
    activeSessions: [{ tokenHash: "h" }],
    orders: [{ id: "O1" }],
    orderPurchaseOverrides: [{ orderRef: "O1" }],
    collectionBox: [{ id: "C1" }],
    publishRecords: [{ id: "PR1" }],
    publishProducts: [{ id: "PUB1" }],
    publishSettings: { qualityGateEnabled: true },
    auditLogs: [{ id: "A1" }],
    messages: [],
    aiConfig: { provider: "openai" },
    aiImageTasks: [{ id: "T1" }]
  };
  const snapshot = buildAppStateSnapshot(source, (db) => JSON.parse(JSON.stringify(db)));

  for (const key of tableOwnedKeys()) {
    assert.strictEqual(snapshot[key], undefined, `${key} 不应该出现在 AppState 快照里`);
  }
  for (const key of appStateOwnedKeys()) {
    assert.ok(snapshot[key] !== undefined, `${key} 应该保留在 AppState 快照里`);
  }
  // 原始对象不能被就地改写（快照是副本）。
  assert.ok(Array.isArray(source.users) && source.users.length === 1);
  assert.deepStrictEqual(snapshot.publishProducts, [{ id: "PUB1" }]);
});

test("归属清单本身无重叠（同一实体不能既声明有专用表又声明在快照里）", () => {
  const overlap = tableOwnedKeys().filter((key) => appStateOwnedKeys().includes(key));
  assert.deepStrictEqual(overlap, []);
});

test("saveYandexCommissionCatalogToSql 把单文档整体 upsert 到单行表", async () => {
  const captured = [];
  const writers = createSqlWriters({
    getSqlPool: () => ({ execute: async (sql, values) => { captured.push({ sql, values }); return [{}]; }, query: async () => [[]] }),
    isSqlReady: () => true,
    getDb: () => ({ yandexCommissionCatalog: {} }),
    serializeDatabase: (db) => db,
    stateKey: "app_state_v1"
  });
  const document = { items: [{ category: "Электроника", percent: 5 }], syncedAt: "2026-09-27" };
  await writers.saveYandexCommissionCatalogToSql(document);

  assert.equal(captured.length, 1);
  assert.match(captured[0].sql, /INSERT INTO yandex_commission_catalog/);
  assert.equal(captured[0].values[0], "default");
  assert.deepStrictEqual(JSON.parse(captured[0].values[1]), document);
});

test("loadYandexCommissionCatalogFromSql 解析单行文档，坏数据返回 null", async () => {
  const makeWriters = (payloadJson) => createSqlWriters({
    getSqlPool: () => ({ execute: async () => [{}], query: async () => [[{ payloadJson }]] }),
    isSqlReady: () => true,
    getDb: () => ({}),
    serializeDatabase: (db) => db,
    stateKey: "app_state_v1"
  });

  const loaded = await makeWriters('{"items":[{"percent":7}]}').loadYandexCommissionCatalogFromSql();
  assert.deepStrictEqual(loaded, { items: [{ percent: 7 }] });

  assert.strictEqual(await makeWriters("").loadYandexCommissionCatalogFromSql(), null);
  assert.strictEqual(await makeWriters("{not json").loadYandexCommissionCatalogFromSql(), null);
  assert.strictEqual(await makeWriters(null).loadYandexCommissionCatalogFromSql(), null);
});

test("SQL 未就绪时费率目录读写都是安全空操作", async () => {
  const writers = createSqlWriters({
    getSqlPool: () => null,
    isSqlReady: () => false,
    getDb: () => ({}),
    serializeDatabase: (db) => db,
    stateKey: "app_state_v1"
  });
  await writers.saveYandexCommissionCatalogToSql({ items: [] });
  assert.strictEqual(await writers.loadYandexCommissionCatalogFromSql(), null);
  assert.strictEqual(await writers.ensureYandexCommissionCatalogTable(), false);
});
