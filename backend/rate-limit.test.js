const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRateLimit, pruneRateLimitBuckets } = require("./rate-limit");

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

test("pruneRateLimitBuckets removes only long-expired entries", () => {
  const buckets = new Map([
    ["old", { windowStart: Date.now() - 10 * 60 * 1000, count: 5 }],
    ["fresh", { windowStart: Date.now() - 10 * 1000, count: 2 }]
  ]);
  const removed = pruneRateLimitBuckets(buckets, 60 * 1000);
  assert.equal(removed, 1);
  assert.equal(buckets.has("old"), false);
  assert.equal(buckets.has("fresh"), true);
});

test("pruneRateLimitBuckets ignores invalid input", () => {
  assert.equal(pruneRateLimitBuckets(null, 1000), 0);
  assert.equal(pruneRateLimitBuckets(new Map(), 0), 0);
  const buckets = new Map([["k", { windowStart: Date.now(), count: 1 }]]);
  assert.equal(pruneRateLimitBuckets(buckets, 1000), 0);
  assert.equal(buckets.size, 1);
});
