// Unit tests for the local error log tail reader used by the log checker panel.
//
// A log file whose only content is a UTF-8 BOM (3 bytes, EF BB BF) previously made
// GET /api/log-checker report a HIGH "本地错误日志有内容" issue forever, because
// "\uFEFF" is a non-empty string that String.prototype.trim() does not remove and
// every line without a timestamp bypassed the server-start freshness filter.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-log-checker-"));
const logDir = path.join(tmpDir, "logs");
fs.mkdirSync(logDir, { recursive: true });

// Pin the log directory before requiring the module: server.js resolves LOG_DIR at
// import time and loadEnvFile() never overwrites an already-set variable.
process.env.LOG_DIR = logDir;
process.env.DATA_DIR = tmpDir;
process.env.APP_SECRET_KEY = "log-checker-test-secret-0123456789abcdef0123456789abcdef";

// This file must not touch MYSQL_* or any other shared variable: app.test.js reads
// process.env.MYSQL_* for its own MySQL integration tests, and test files share a
// single process whenever the runner is invoked with --test-isolation=none.
const { readRecentLocalErrorTail, extractFreshLogEntries } = requireFreshServerModule();
const { analyzeAuditLogIssue } = require("./log-checker");

test("quality gate blocks are classified as low informational issues", () => {
  const result = analyzeAuditLogIssue({
    method: "POST",
    path: "/api/yandex/publish",
    statusCode: 200,
    errorMessage: "",
    warningMessage: "店铺SHP-MN0L3MMG-CF39: 卡片质量分低于 80，已拦截刊登"
  });
  assert.equal(result.key, "quality_gate_block");
  assert.equal(result.config.severity, "low");
  assert.equal(result.config.title, "卡片质量门槛拦截（正常防护）");
});

// The default runner often loads this file in a fresh process, in which case the
// LOG_DIR above already applies; a shared or reordered process may have created an
// earlier copy of server.js, so drop that cache entry and load one pinned to the
// test log directory. The entry is evicted again afterwards so no other file can
// pick up a copy built from this file's environment.
function requireFreshServerModule() {
  const modulePath = require.resolve("./server");
  const cached = require.cache[modulePath];
  if (cached) delete require.cache[modulePath];
  const helperPath = require.resolve("./log-checker");
  const cachedHelper = require.cache[helperPath];
  if (cachedHelper) delete require.cache[helperPath];
  const loaded = require("./server");
  if (cached) delete require.cache[modulePath];
  if (cachedHelper) delete require.cache[helperPath];
  return loaded;
}

const FRESH_START = new Date("2026-09-16T02:57:57.317Z").getTime();
const STALE_TS = "2026-08-16T02:36:28.000Z";
const FRESH_TS = "2026-09-16T03:00:39.000Z";

function writeLog(name, content) {
  const target = path.join(logDir, name);
  fs.writeFileSync(target, content);
  return target;
}

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a log file holding only a UTF-8 BOM is not reported as error content", () => {
  writeLog("bom-only.log", "\uFEFF");
  assert.equal(fs.readFileSync(path.join(logDir, "bom-only.log"), "utf8").length, 1, "fixture is a lone BOM");
  assert.equal(readRecentLocalErrorTail("bom-only.log", FRESH_START), "");
});

test("an empty or whitespace-only log file is not reported as error content", () => {
  writeLog("empty.log", "");
  writeLog("blank.log", "\r\n   \n\t\n");
  assert.equal(readRecentLocalErrorTail("empty.log", FRESH_START), "");
  assert.equal(readRecentLocalErrorTail("blank.log", FRESH_START), "");
});

test("a missing log file yields no content", () => {
  assert.equal(readRecentLocalErrorTail("does-not-exist.log", FRESH_START), "");
});

test("the BOM is stripped so a real fresh error is reported cleanly", () => {
  writeLog("bom-fresh.log", `\uFEFF${FRESH_TS} uncaughtException: boom`);
  assert.equal(readRecentLocalErrorTail("bom-fresh.log", FRESH_START), `${FRESH_TS} uncaughtException: boom`);
});

test("an error written before the current server start is not reported as recent", () => {
  writeLog("stale.log", `${STALE_TS} uncaughtException: old failure`);
  assert.equal(readRecentLocalErrorTail("stale.log", FRESH_START), "");
});

test("a BOM followed by a stale error is not reported as recent", () => {
  writeLog("bom-stale.log", `\uFEFF${STALE_TS} uncaughtException: old failure`);
  assert.equal(readRecentLocalErrorTail("bom-stale.log", FRESH_START), "");
});

test("only fresh records are returned and stale ones are dropped", () => {
  writeLog(
    "mixed.log",
    [`${STALE_TS} uncaughtException: old failure`, `${FRESH_TS} request_error GET /api/orders -> 500: boom`].join("\n")
  );
  assert.equal(readRecentLocalErrorTail("mixed.log", FRESH_START), `${FRESH_TS} request_error GET /api/orders -> 500: boom`);
});

test("lines without a timestamp never stand alone as a fresh record", () => {
  writeLog("no-timestamp.log", ["orphan line without a timestamp", "another orphan line"].join("\n"));
  assert.equal(readRecentLocalErrorTail("no-timestamp.log", FRESH_START), "");
});

test("a fresh record keeps its continuation lines so stack traces stay intact", () => {
  writeLog(
    "continuation.log",
    [
      `${FRESH_TS} uncaughtException: boom`,
      "    at handleRequest (backend/server.js:519:11)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      `${STALE_TS} uncaughtException: old failure`,
      "    at staleFrame (backend/server.js:1:1)"
    ].join("\n")
  );
  assert.equal(
    readRecentLocalErrorTail("continuation.log", FRESH_START),
    [
      `${FRESH_TS} uncaughtException: boom`,
      "    at handleRequest (backend/server.js:519:11)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)"
    ].join("\n")
  );
});

test("a timestamp that cannot be parsed is treated as stale, not fresh", () => {
  writeLog("bad-timestamp.log", "9999-99-99T99:99:99.999Z uncaughtException: malformed stamp");
  assert.equal(readRecentLocalErrorTail("bad-timestamp.log", FRESH_START), "");
});

test("without a server start time the tail is returned as-is", () => {
  writeLog("no-start.log", `${STALE_TS} uncaughtException: old failure`);
  assert.equal(readRecentLocalErrorTail("no-start.log", 0), `${STALE_TS} uncaughtException: old failure`);
});

test("the returned tail is capped at maxChars", () => {
  writeLog("long.log", `${FRESH_TS} ${"x".repeat(500)}`);
  assert.equal(readRecentLocalErrorTail("long.log", FRESH_START, 40).length, 40);
});

test("extractFreshLogEntries keeps only anchored fresh records", () => {
  const text = [
    `${STALE_TS} stale record`,
    "stale continuation",
    "",
    `${FRESH_TS} fresh record`,
    "fresh continuation",
    "",
    "trailing orphan line"
  ].join("\n");
  // Everything after the last fresh anchor counts as its continuation. Keeping it is
  // deliberate: appendRuntimeLog() writes each record as one timestamped line plus
  // arbitrary continuation lines, so dropping them would truncate stack traces.
  assert.equal(
    extractFreshLogEntries(text, FRESH_START),
    [`${FRESH_TS} fresh record`, "fresh continuation", "trailing orphan line"].join("\n")
  );
});
