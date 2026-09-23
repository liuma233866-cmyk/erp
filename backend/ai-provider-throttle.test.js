const test = require("node:test");
const assert = require("node:assert/strict");
const { isProviderThrottlingError, isTransientProviderError, retryDelayMs, callWithThrottleRetry } = require("./ai-provider-throttle");

test("recognizes DashScope RateQuota and HTTP 429 errors", () => {
  assert.equal(isProviderThrottlingError({ providerCode: "Throttling.RateQuota" }), true);
  assert.equal(isProviderThrottlingError({ providerStatusCode: 429 }), true);
  assert.equal(isProviderThrottlingError({ providerCode: "InvalidParameter" }), false);
});

test("honors Retry-After supplied by the provider", () => {
  assert.equal(retryDelayMs({ providerRetryAfterMs: 17000 }, 0), 17000);
});

test("recognizes ECONNRESET and timeout as transient provider errors", () => {
  assert.equal(isTransientProviderError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientProviderError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientProviderError({ providerCode: "InvalidParameter" }), false);
});

test("retries a reset provider connection", async () => {
  let calls = 0;
  const result = await callWithThrottleRetry(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("read ECONNRESET");
      error.code = "ECONNRESET";
      throw error;
    }
    return "connected";
  }, { delaysMs: [1000], sleep: async () => {} });
  assert.equal(result, "connected");
  assert.equal(calls, 2);
});

test("retries throttling errors with exponential delays", async () => {
  let calls = 0;
  const waits = [];
  const result = await callWithThrottleRetry(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("rate limited");
      error.providerCode = "Throttling.RateQuota";
      throw error;
    }
    return "ok";
  }, { delaysMs: [1000, 2000, 4000], sleep: async (ms) => waits.push(ms) });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("does not retry permanent provider errors", async () => {
  let calls = 0;
  await assert.rejects(() => callWithThrottleRetry(async () => {
    calls += 1;
    const error = new Error("bad input");
    error.providerCode = "InvalidParameter";
    throw error;
  }, { sleep: async () => {} }), /bad input/);
  assert.equal(calls, 1);
});

test("aborts before a throttled retry sleep", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => callWithThrottleRetry(async () => {
    calls += 1;
    const error = new Error("rate limited");
    error.providerCode = "Throttling.RateQuota";
    controller.abort();
    throw error;
  }, { delaysMs: [1000], signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});
