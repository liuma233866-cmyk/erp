const test = require("node:test");
const assert = require("node:assert/strict");
const { safeExternalUrl, safeImageUrl } = require("./shared/core/safe-image-url");

test("allows http and https URLs", () => {
  assert.equal(safeImageUrl("https://example.com/img.png"), "https://example.com/img.png");
  assert.equal(safeImageUrl("http://example.com/img.png"), "http://example.com/img.png");
  assert.equal(safeImageUrl("  https://example.com/img.png  "), "https://example.com/img.png");
  assert.equal(safeImageUrl("HTTPS://EXAMPLE.COM/IMG.PNG"), "HTTPS://EXAMPLE.COM/IMG.PNG");
});

test("rejects javascript: and data: payloads", () => {
  assert.equal(safeImageUrl("javascript:alert(1)"), "");
  assert.equal(safeImageUrl("JaVaScRiPt:alert(1)"), "");
  assert.equal(safeImageUrl("data:image/png;base64,AAAA"), "");
});

test("rejects empty, relative and other schemes", () => {
  assert.equal(safeImageUrl(""), "");
  assert.equal(safeImageUrl("   "), "");
  assert.equal(safeImageUrl(null), "");
  assert.equal(safeImageUrl(undefined), "");
  assert.equal(safeImageUrl("/relative/path.png"), "");
  assert.equal(safeImageUrl("//example.com/img.png"), "");
  assert.equal(safeImageUrl("ftp://example.com/img.png"), "");
});

test("applies the same protocol allowlist to clickable external links", () => {
  assert.equal(safeExternalUrl("https://example.com/product"), "https://example.com/product");
  assert.equal(safeExternalUrl("javascript:alert(1)"), "");
  assert.equal(safeExternalUrl("data:text/html,payload"), "");
});
