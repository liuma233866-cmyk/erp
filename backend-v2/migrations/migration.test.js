"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readMigrations, assertSingleStatement, checksum } = require("./migrationRunner");

const directory = path.join(__dirname);

test("migration plan is ordered, unique, and contains the four stage-0 tables", () => {
  const migrations = readMigrations(directory);
  assert.deepEqual(migrations.map((migration) => migration.version), ["V001", "V002", "V003", "V004", "V005", "V006", "V007", "V008", "V009", "V010", "V011"]);
  assert.equal(new Set(migrations.map((migration) => migration.version)).size, migrations.length);
  const sql = migrations.map((migration) => migration.sql).join("\n");
  for (const table of ["collection_batches", "collection_items", "publish_batches", "publish_claims"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  for (const table of ["central_products", "central_product_variants", "central_product_sources", "central_product_versions", "central_product_assets"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test("every migration is one immutable executable statement with a stable checksum", () => {
  for (const migration of readMigrations(directory)) {
    assert.doesNotThrow(() => assertSingleStatement(migration.sql, migration.file));
    assert.equal(migration.checksum, checksum(migration.sql));
    assert.match(migration.sql, /ENGINE=InnoDB/);
  }
});

test("trailing SQL comments remain one statement but change the checksum", () => {
  const sql = "CREATE TABLE probe (id INT);\n-- tamper probe";
  assert.doesNotThrow(() => assertSingleStatement(sql, "probe.sql"));
  assert.notEqual(checksum(sql), checksum("CREATE TABLE probe (id INT);"));
});

test("stage-0 migration constraints are tenant scoped and idempotent", () => {
  const sql = readMigrations(directory).map((migration) => migration.sql).join("\n");
  assert.match(sql, /uq_collection_batches_request \(company_id, request_namespace, request_id\)/);
  assert.match(sql, /uq_publish_batches_request \(company_id, request_namespace, client_request_id\)/);
  assert.match(sql, /uq_publish_claims_business \(company_id, platform, shop_id, business_key\)/);
  assert.match(sql, /uq_central_variants_product_key \(company_id, central_product_id, variant_key\)/);
  assert.match(sql, /uq_central_variants_system_sku \(company_id, system_sku\)/);
  assert.match(sql, /uq_central_sources_identity \(company_id, source_platform, source_product_id\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
});
