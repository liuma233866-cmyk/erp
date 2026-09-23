const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_TABLE_DDL, REQUIRED_TABLE_DDLS } = require("./mysql-schema");

test("declares every table used outside AppState for fresh database deployment", () => {
  for (const table of [
    "users",
    "active_sessions",
    "shops",
    "online_products",
    "review_rules",
    "yandex_card_quality_latest",
    "yandex_card_quality_history"
  ]) {
    assert.match(REQUIRED_TABLE_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"));
  }
});

test("exposes one executable statement per table without requiring multi-statements", () => {
  // 5 core tables plus the two Yandex card-quality tables.
  assert.equal(REQUIRED_TABLE_DDLS.length, 7);
  for (const statement of REQUIRED_TABLE_DDLS) assert.equal(statement.includes(";"), false);
});

test("card-quality tables key one latest row per offer and one history row per day", () => {
  const latest = REQUIRED_TABLE_DDLS.find((statement) => /yandex_card_quality_latest/i.test(statement));
  assert.match(latest, /PRIMARY KEY \(shopId, offerId\)/i);

  const history = REQUIRED_TABLE_DDLS.find((statement) => /yandex_card_quality_history/i.test(statement));
  assert.match(history, /UNIQUE KEY uniq_yandex_card_quality_history \(shopId, offerId, snapshotDate\)/i);
  assert.match(history, /AUTO_INCREMENT/i);
});

test("shops persist their operational currency", () => {
  const shopsDdl = REQUIRED_TABLE_DDLS.find((statement) => /CREATE TABLE IF NOT EXISTS shops/i.test(statement));
  assert.match(shopsDdl, /shopCurrency VARCHAR\(8\) NOT NULL DEFAULT 'RUR'/i);
});

test("user and session tables retain complete payloads and enforce stable identities", () => {
  assert.match(REQUIRED_TABLE_DDL, /CREATE TABLE IF NOT EXISTS users[\s\S]*PRIMARY KEY[\s\S]*payloadJson LONGTEXT/i);
  assert.match(REQUIRED_TABLE_DDL, /CREATE TABLE IF NOT EXISTS active_sessions[\s\S]*PRIMARY KEY[\s\S]*payloadJson LONGTEXT/i);
});
