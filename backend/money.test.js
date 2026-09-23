const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMoney } = require("./money");
test("preserves decimal money and handles thousands separators", () => {
  assert.equal(normalizeMoney("199.99"), 199.99);
  assert.equal(normalizeMoney("1,234.56"), 1234.56);
  assert.equal(normalizeMoney("1234.56 RUB"), 1234.56);
  assert.equal(normalizeMoney("1 234,56 ₽"), 1234.56);
});
