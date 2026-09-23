const test = require("node:test");
const assert = require("node:assert/strict");
const { toMysqlDateTime } = require("./mysql-datetime");

test("converts ISO timestamps into a MySQL DATETIME-compatible UTC value", () => {
  assert.equal(toMysqlDateTime("2026-08-21T01:45:14.240Z"), "2026-08-21 01:45:14.240");
});

test("returns null for empty optional datetime values", () => {
  assert.equal(toMysqlDateTime(""), null);
  assert.equal(toMysqlDateTime(null), null);
});

test("rejects invalid datetime values before they reach MySQL", () => {
  assert.throws(() => toMysqlDateTime("not-a-date"), /Invalid datetime value/);
});

test("round-trips TIMESTAMP(6) values through a UTC MySQL connection", { skip: process.env.MYSQL_INTEGRATION_TEST !== "1" }, async () => {
  const mysql = require("mysql2/promise");
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    timezone: "Z"
  });
  try {
    await connection.query("CREATE TEMPORARY TABLE codex_timestamp_roundtrip (value TIMESTAMP(6) NULL)");
    const expected = "2026-08-21T01:45:14.240Z";
    await connection.execute("INSERT INTO codex_timestamp_roundtrip (value) VALUES (?)", [toMysqlDateTime(expected)]);
    const [rows] = await connection.query("SELECT value FROM codex_timestamp_roundtrip LIMIT 1");
    assert.equal(rows[0].value.toISOString(), expected);
  } finally {
    await connection.end();
  }
});
