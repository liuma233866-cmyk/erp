// 出站 HTTP 超时的回归测试。
//
// 背景：Undici（Node 内置 fetch）没有应用层响应期限。没有超时的话，一次 connect/DNS 停滞
// 或对端慢速吐响应体就会把调用方永远挂住；orders/order-sync 用 state.running 防并发同步，
// 一次挂死等于把每日同步永久锁死（之后每天只会返回 { skipped: true }）。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
  MIN_HTTP_TIMEOUT_MS,
  defaultHttpTimeoutMs,
  resolveHttpTimeoutMs,
  withFetchTimeout
} = require("./http-timeout");
const { fetchYandexJson } = require("./yandex-http");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("默认期限是 30s，非法输入回落到默认值", () => {
  assert.equal(DEFAULT_HTTP_TIMEOUT_MS, 30000);
  assert.equal(resolveHttpTimeoutMs(undefined), DEFAULT_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs(""), DEFAULT_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs("abc"), DEFAULT_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs(0), DEFAULT_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs(-5), DEFAULT_HTTP_TIMEOUT_MS);
});

test("显式值被夹在 1s..300s 之间，避免设成 0 或无限", () => {
  assert.equal(resolveHttpTimeoutMs(15000), 15000);
  assert.equal(resolveHttpTimeoutMs("15000"), 15000);
  // 过小/过大的显式值被抬到下限 / 压到上限
  assert.equal(resolveHttpTimeoutMs(1), MIN_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs(100), MIN_HTTP_TIMEOUT_MS);
  assert.equal(resolveHttpTimeoutMs(10 * 60 * 1000), MAX_HTTP_TIMEOUT_MS);
  // 自定义 fallback 只在原始值非法时生效
  assert.equal(resolveHttpTimeoutMs(undefined, 5000), 5000);
  assert.equal(resolveHttpTimeoutMs("nope", 5000), 5000);
});

test("默认期限可由 HTTP_TIMEOUT_MS 覆盖", () => {
  const original = process.env.HTTP_TIMEOUT_MS;
  try {
    process.env.HTTP_TIMEOUT_MS = "7000";
    assert.equal(defaultHttpTimeoutMs(), 7000);
    delete process.env.HTTP_TIMEOUT_MS;
    assert.equal(defaultHttpTimeoutMs(), DEFAULT_HTTP_TIMEOUT_MS);
  } finally {
    if (original === undefined) delete process.env.HTTP_TIMEOUT_MS;
    else process.env.HTTP_TIMEOUT_MS = original;
  }
});

test("withFetchTimeout 注入 signal，且不改动传入的 options 对象", () => {
  const input = { headers: { Accept: "application/json" } };
  const output = withFetchTimeout(input, 5000);

  assert.ok(output.signal, "必须带上 signal，否则请求没有期限");
  assert.equal(output.headers, input.headers, "原有字段应保留");
  assert.notEqual(output, input, "应返回新对象，不原地修改调用方的 options");
  assert.equal(input.signal, undefined, "调用方对象不应被写入 signal");
});

test("每次调用都新建 signal：重试时不能复用已 abort 的 signal", () => {
  const first = withFetchTimeout({}, 5000);
  const second = withFetchTimeout({}, 5000);
  assert.notEqual(first.signal, second.signal);
});

test("不覆盖调用方自己传入的 signal（publish 自建 AbortController 的场景）", () => {
  const controller = new AbortController();
  const output = withFetchTimeout({ signal: controller.signal }, 5000);
  assert.equal(output.signal, controller.signal);
});

test("注入的 signal 到点会真的 abort", async () => {
  const { signal } = withFetchTimeout({}, 20);
  assert.equal(signal.aborted, false);
  await sleep(60);
  assert.equal(signal.aborted, true, "超时后 signal 必须已中止，否则期限形同虚设");
});

test("fetchYandexJson 真的把超时 signal 传给了 fetch（覆盖 8 个调用点）", async () => {
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = options;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const result = await fetchYandexJson("https://yandex.test/v2/campaigns/1/orders", { headers: { "Api-Key": "k" } });
    assert.equal(result.ok, true);
    assert.ok(seen.signal, "没有 signal 就等于没有超时");
    assert.equal(seen.headers["Api-Key"], "k", "原有 options 必须原样保留");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchYandexJson 重试时使用新的 signal（不复用已中止的那个）", async () => {
  const original = globalThis.fetch;
  const signals = [];
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    signals.push(options.signal);
    if (calls === 1) {
      return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const result = await fetchYandexJson("https://yandex.test/x", {});
    assert.equal(result.ok, true, "5xx 应被重试后成功");
    assert.ok(signals.length >= 2, "应发生了重试");
    assert.notEqual(signals[0], signals[1], "重试必须换一个新的 signal");
  } finally {
    globalThis.fetch = original;
  }
});
