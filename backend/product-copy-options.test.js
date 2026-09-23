const test = require("node:test");
const assert = require("node:assert/strict");
const { isExchangeRateFresh, normalizeCopyOptions } = require("./product-copy-options");

test("normalizes copy preview and strategy options", () => {
  assert.deepEqual(normalizeCopyOptions({ dryRun: true, aiMode: "main", priceStrategy: "keep", overwriteTitleDescription: false }), {
    dryRun: true, aiMode: "main", priceStrategy: "keep", overwriteTitleDescription: false
  });
  assert.equal(normalizeCopyOptions({ aiMode: "unknown", priceStrategy: "unknown" }).aiMode, "all");
});

test("marks exchange rates older than the configured threshold stale", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  assert.equal(isExchangeRateFresh("2026-08-20", now, 3), true);
  assert.equal(isExchangeRateFresh("2026-08-15", now, 3), false);
  assert.equal(isExchangeRateFresh("", now, 3), false);
});
