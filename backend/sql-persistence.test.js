const { test } = require("node:test");
const assert = require("node:assert");
const { createSqlWriters } = require("./sql-persistence");

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
