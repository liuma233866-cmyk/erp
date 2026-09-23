const test = require("node:test");
const assert = require("node:assert/strict");
const { parseOzonDate } = require("./ozon-orders");
test("parses Ozon DD-MM-YYYY dates without locale ambiguity", () => {
  assert.equal(parseOzonDate("31-12-2025", "fallback"), "2025-12-31T00:00:00.000Z");
  assert.equal(parseOzonDate("20-01-2026", "fallback"), "2026-01-20T00:00:00.000Z");
});
