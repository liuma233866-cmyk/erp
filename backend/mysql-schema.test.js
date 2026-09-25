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
    "collection_box",
    "publish_records",
    "yandex_card_quality_latest",
    "yandex_card_quality_history"
  ]) {
    assert.match(REQUIRED_TABLE_DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"));
  }
});

test("exposes one executable statement per table without requiring multi-statements", () => {
  // 5 core tables plus the two Yandex card-quality tables plus the two page stores.
  assert.equal(REQUIRED_TABLE_DDLS.length, 9);
  for (const statement of REQUIRED_TABLE_DDLS) assert.equal(statement.includes(";"), false);
});

test("采集箱和上架记录各自建表，不共用 AppState 里的老结构", () => {
  const boxDdl = REQUIRED_TABLE_DDLS.find((statement) => /CREATE TABLE IF NOT EXISTS collection_box/i.test(statement));
  assert.ok(boxDdl, "collection_box 表要单独建");
  assert.match(boxDdl, /publishStatus VARCHAR\(32\) NOT NULL DEFAULT 'draft'/i);
  assert.match(boxDdl, /publishProductId VARCHAR\(128\)/i);

  const recordDdl = REQUIRED_TABLE_DDLS.find((statement) => /CREATE TABLE IF NOT EXISTS publish_records/i.test(statement));
  assert.ok(recordDdl, "publish_records 表要单独建");
  assert.match(recordDdl, /result VARCHAR\(16\) NOT NULL DEFAULT 'success'/i);
  assert.match(recordDdl, /KEY idx_publish_records_ts \(ts\)/i);
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
