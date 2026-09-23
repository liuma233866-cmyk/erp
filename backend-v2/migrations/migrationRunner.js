"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

const MIGRATION_FILE = /^V(\d+)__([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;

function checksum(sql) {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex");
}

function readMigrations(directory = __dirname) {
  const files = fs.readdirSync(directory)
    .filter((file) => MIGRATION_FILE.test(file))
    .map((file) => {
      const match = MIGRATION_FILE.exec(file);
      const sql = fs.readFileSync(path.join(directory, file), "utf8").trim();
      return {
        file,
        version: `V${match[1]}`,
        number: Number(match[1]),
        name: match[2],
        sql,
        checksum: checksum(sql)
      };
    })
    .sort((a, b) => a.number - b.number);

  const seen = new Set();
  for (const migration of files) {
    if (seen.has(migration.version)) {
      throw new V2Error(ERROR_CODES.MIGRATION_ORDER_INVALID, `Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return files;
}

function assertSingleStatement(sql, file) {
  const withoutComments = sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, "");
  const withoutTrailingSemicolon = withoutComments.trim().replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new V2Error(ERROR_CODES.MIGRATION_ORDER_INVALID, `Migration must contain one statement: ${file}`);
  }
}

async function runMigrations(pool, options = {}) {
  if (!pool || typeof pool.getConnection !== "function") throw new TypeError("A mysql2 pool is required");
  const directory = options.directory || __dirname;
  const migrations = readMigrations(directory);
  for (const migration of migrations) assertSingleStatement(migration.sql, migration.file);
  const connection = await pool.getConnection();
  try {
    const bootstrap = migrations.find((item) => item.number === 1);
    if (!bootstrap) throw new V2Error(ERROR_CODES.MIGRATION_ORDER_INVALID, "V001 schema migration is required");
    await connection.query(bootstrap.sql);
    let bootstrapInserted = false;
    const [bootstrapRows] = await connection.query(
      "SELECT version, name, checksum FROM v2_schema_migrations WHERE version = ?",
      [bootstrap.version]
    );
    if (bootstrapRows.length === 0) {
      await connection.query(
        "INSERT INTO v2_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))",
        [bootstrap.version, bootstrap.name, bootstrap.checksum]
      );
      bootstrapInserted = true;
    }
    const [rows] = await connection.query("SELECT version, name, checksum FROM v2_schema_migrations ORDER BY version");
    const applied = new Map(rows.map((row) => [String(row.version), row]));
    const pending = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (String(existing.name) !== migration.name || String(existing.checksum) !== migration.checksum) {
          throw new V2Error(ERROR_CODES.MIGRATION_CHECKSUM_MISMATCH, `Applied migration changed: ${migration.file}`);
        }
        continue;
      }
      pending.push(migration);
    }
    for (const migration of pending) {
      await connection.beginTransaction();
      try {
        await connection.query(migration.sql);
        await connection.query(
          "INSERT INTO v2_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))",
          [migration.version, migration.name, migration.checksum]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
    return {
      applied: [...(bootstrapInserted ? [bootstrap.version] : []), ...pending.map((migration) => migration.version)],
      current: migrations.at(-1)?.version || ""
    };
  } finally {
    connection.release();
  }
}

module.exports = { MIGRATION_FILE, checksum, readMigrations, assertSingleStatement, runMigrations };
