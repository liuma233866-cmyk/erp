"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { createV2Pool } = require("../db/pool");
const { MySqlAuditSink } = require("../audit/mysqlAuditSink");
const { runMigrations, readMigrations } = require("./migrationRunner");

const enabled = process.env.V2_MYSQL_RUN_INTEGRATION === "1";
const sourceDirectory = __dirname;
const emptyDatabase = process.env.V2_MYSQL_TEST_DATABASE || "v2test";
const incrementalDatabase = process.env.V2_MYSQL_TEST_INCREMENTAL_DATABASE || "v2test_incr";
const baseEnv = {
  host: process.env.V2_MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.V2_MYSQL_PORT || 3306),
  user: process.env.V2_MYSQL_USER || "root",
  password: process.env.V2_MYSQL_PASSWORD || ""
};

async function ensureDatabase(name) {
  const connection = await mysql.createConnection(baseEnv);
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4`);
  } finally {
    await connection.end();
  }
}

function poolFor(database) {
  return createV2Pool({
    V2_MYSQL_HOST: baseEnv.host,
    V2_MYSQL_PORT: String(baseEnv.port),
    V2_MYSQL_USER: baseEnv.user,
    V2_MYSQL_PASSWORD: baseEnv.password,
    V2_MYSQL_DATABASE: database
  });
}

test("MySQL 8 migration gate covers empty, incremental, and idempotent runs", { skip: !enabled }, async () => {
  const allMigrations = readMigrations(sourceDirectory);
  await ensureDatabase(emptyDatabase);
  await ensureDatabase(incrementalDatabase);

  const emptyPool = poolFor(emptyDatabase);
  try {
    const first = await runMigrations(emptyPool);
    assert.deepEqual(first.applied, allMigrations.map((migration) => migration.version));
    const [tables] = await emptyPool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()"
    );
    for (const table of ["collection_batches", "collection_items", "publish_batches", "publish_claims", "central_products", "central_product_variants", "central_product_sources", "central_product_versions", "central_product_assets"]) {
      assert.ok(tables.some((row) => row.TABLE_NAME === table || row.table_name === table));
    }
    const auditSink = new MySqlAuditSink({ pool: emptyPool });
    await auditSink.write({
      requestId: "integration-req",
      companyId: "1",
      actorId: "1",
      action: "migration_gate",
      resourceType: "test",
      resourceId: "integration",
      outcome: "success",
      statusCode: 200,
      metadata: {},
      occurredAt: "2026-08-18T00:00:00.000Z"
    });
    const [auditRows] = await emptyPool.query(
      "SELECT occurred_at FROM v2_audit_logs WHERE request_id = ? ORDER BY id DESC LIMIT 1",
      ["integration-req"]
    );
    assert.equal(String(auditRows[0].occurred_at), "2026-08-18 00:00:00.000");
    const rerun = await runMigrations(emptyPool);
    assert.deepEqual(rerun.applied, []);
  } finally {
    await emptyPool.end();
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "v2-migrations-"));
  try {
    for (const migration of readMigrations(sourceDirectory).filter((item) => item.number <= 5)) {
      fs.copyFileSync(path.join(sourceDirectory, migration.file), path.join(tempDirectory, migration.file));
    }
    const incrementalPool = poolFor(incrementalDatabase);
    try {
      const baseline = await runMigrations(incrementalPool, { directory: tempDirectory });
      assert.deepEqual(baseline.applied, ["V001", "V002", "V003", "V004", "V005"]);
      const upgrade = await runMigrations(incrementalPool, { directory: sourceDirectory });
      assert.deepEqual(upgrade.applied, allMigrations.filter((migration) => migration.number > 5).map((migration) => migration.version));
      const stable = await runMigrations(incrementalPool, { directory: sourceDirectory });
      assert.deepEqual(stable.applied, []);
    } finally {
      await incrementalPool.end();
    }
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
