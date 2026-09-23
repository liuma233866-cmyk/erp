const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeExternalHttpUrl, validateOptionalExternalHttpUrl } = require("./url-safety");

test("allows only absolute HTTP(S) external URLs", () => {
  assert.equal(normalizeExternalHttpUrl(" https://example.com/item "), "https://example.com/item");
  assert.equal(normalizeExternalHttpUrl("http://example.com/item"), "http://example.com/item");
  assert.equal(normalizeExternalHttpUrl("javascript:alert(1)"), "");
  assert.equal(normalizeExternalHttpUrl("data:text/html,payload"), "");
  assert.equal(normalizeExternalHttpUrl("//example.com/item"), "");
});

test("rejects non-HTTP protocols for optional URL fields", () => {
  assert.deepEqual(validateOptionalExternalHttpUrl("", "purchaseUrl"), { ok: true, value: "" });
  assert.equal(validateOptionalExternalHttpUrl("javascript:alert(1)", "purchaseUrl").ok, false);
});
