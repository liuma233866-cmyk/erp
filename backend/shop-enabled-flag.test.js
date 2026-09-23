// Unit tests for the shop `enabled` flag coercion used by normalizeDatabase.
//
// The shops table stores `enabled` as TINYINT(1), so mysql2 returns the numbers 0 and
// 1 — never a boolean. The previous code treated any non-boolean as "enabled", which
// silently re-enabled every disabled shop on load: a suspended shop started pulling
// orders again after a restart, and the shop management toggle could not stay off.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-enabled-flag-"));
process.env.LOG_DIR = path.join(tmpDir, "logs");
process.env.DATA_DIR = tmpDir;
process.env.APP_SECRET_KEY = "enabled-flag-test-secret-0123456789abcdef0123456789abcdef";
fs.mkdirSync(process.env.LOG_DIR, { recursive: true });

// This file must not touch MYSQL_* or any other shared variable: app.test.js reads
// process.env.MYSQL_* for its own integration tests, and test files share one process
// whenever the runner is invoked with --test-isolation=none.
const { coerceEnabledFlag } = requireFreshServerModule();

function requireFreshServerModule() {
  const modulePath = require.resolve("./server");
  const cached = require.cache[modulePath];
  if (cached) delete require.cache[modulePath];
  const loaded = require("./server");
  if (cached) delete require.cache[modulePath];
  return loaded;
}

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("the number 0 returned by MySQL keeps a shop disabled", () => {
  assert.equal(coerceEnabledFlag(0), false, "TINYINT 0 must stay disabled");
});

test("the number 1 returned by MySQL keeps a shop enabled", () => {
  assert.equal(coerceEnabledFlag(1), true);
});

test("booleans pass through unchanged", () => {
  assert.equal(coerceEnabledFlag(true), true);
  assert.equal(coerceEnabledFlag(false), false);
});

test("numeric strings are interpreted as their value", () => {
  assert.equal(coerceEnabledFlag("0"), false, "JSON round-trips can produce \"0\"");
  assert.equal(coerceEnabledFlag("1"), true);
});

test("the words MySQL and JSON may use for false are respected", () => {
  for (const value of ["false", "FALSE", "no", "off", " false "]) {
    assert.equal(coerceEnabledFlag(value), false, `${JSON.stringify(value)} must stay disabled`);
  }
});

test("unset or unrecognised values default to enabled", () => {
  // Preserves the previous behaviour for shops created before the flag existed.
  for (const value of [undefined, null, "", "yes", "true", {}]) {
    assert.equal(coerceEnabledFlag(value), true, `${JSON.stringify(value) ?? String(value)} defaults to enabled`);
  }
  assert.equal(coerceEnabledFlag(NaN), true, "a non-finite number defaults to enabled");
});
