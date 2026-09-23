const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRateLimit } = require("./rate-limit");

test("lets empty keys through without touching the bucket", () => {
  const buckets = new Map();
  assert.deepEqual(checkRateLimit(buckets, "", 1000, 2), { ok: true });
  assert.equal(buckets.size, 0);
});

test("allows the first N requests and rejects the next within the window", () => {
  const buckets = new Map();
  assert.deepEqual(checkRateLimit(buckets, "ip:api", 10000, 3), { ok: true });
  assert.deepEqual(checkRateLimit(buckets, "ip:api", 10000, 3), { ok: true });
  assert.deepEqual(checkRateLimit(buckets, "ip:api", 10000, 3), { ok: true });
  const blocked = checkRateLimit(buckets, "ip:api", 10000, 3);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 10000);
});

test("resets the count after the window expires", () => {
  const buckets = new Map();
  checkRateLimit(buckets, "k", 50, 1);
  assert.equal(checkRateLimit(buckets, "k", 50, 1).ok, false);
  // Bucket windowStart is in the past once the real clock passes it; simulate by
  // rewriting the stored windowStart to an expired value.
  buckets.get("k").windowStart = Date.now() - 51;
  assert.deepEqual(checkRateLimit(buckets, "k", 50, 1), { ok: true });
  assert.equal(buckets.get("k").count, 1);
});

test("keeps keys independent", () => {
  const buckets = new Map();
  assert.equal(checkRateLimit(buckets, "a", 1000, 1).ok, true);
  assert.equal(checkRateLimit(buckets, "b", 1000, 1).ok, true);
  assert.equal(checkRateLimit(buckets, "a", 1000, 1).ok, false);
  assert.equal(checkRateLimit(buckets, "b", 1000, 1).ok, false);
});
