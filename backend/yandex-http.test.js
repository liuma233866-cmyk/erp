// Yandex 可重试状态码「单一来源」回归测试。
//
// 历史缺陷：三处各写一份且互相矛盾 —— yandex-http 有 409 无 420、yandex-publish-service
// 两者皆无、orders/order-sync 有 420。结果是同一份限流在链路上行为不一致：详情拉取会退避
// 重试，而列表分页与刊登批次遇到 420 直接当成永久失败。下面既锁定成员，也锁定"三处同源"。
const test = require("node:test");
const assert = require("node:assert/strict");

const { RETRYABLE_YANDEX_STATUS, isRetryableYandexStatus } = require("./yandex-http");
const { RETRYABLE_HTTP_STATUS } = require("./orders/order-sync");
const { publishYandexProducts } = require("./yandex-publish-service");

test("420（Yandex「每 campaign 最多 6 并发」限流码）必须可重试", () => {
  assert.equal(isRetryableYandexStatus(420), true);
  assert.ok(RETRYABLE_YANDEX_STATUS.has(420));
});

test("409 不可重试：它是冲突而非瞬时故障，重试不会成功、还可能重复提交", () => {
  assert.equal(isRetryableYandexStatus(409), false);
  assert.equal(RETRYABLE_YANDEX_STATUS.has(409), false);
});

test("其余可重试状态码：408 / 425 / 429 / 5xx", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableYandexStatus(status), true, `${status} 应可重试`);
  }
});

test("客户端错误与空值不可重试", () => {
  for (const status of [400, 401, 403, 404, 405, 422, 0, undefined, null, "", "abc", NaN]) {
    assert.equal(isRetryableYandexStatus(status), false, `${String(status)} 不应可重试`);
  }
});

test("order-sync 与 yandex-http 共享同一个集合实例，不再是两份拷贝", () => {
  assert.equal(RETRYABLE_HTTP_STATUS, RETRYABLE_YANDEX_STATUS);
  assert.ok(RETRYABLE_HTTP_STATUS.has(420), "order-sync 的详情重试必须认 420");
});

test("刊登链路遇到 420 会退避重试并最终成功", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 420,
        json: async () => ({ errors: [{ code: "METHOD_FAILURE", message: "Hit rate limit of 6 parallel requests" }] })
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const result = await publishYandexProducts({
    shop: { businessId: "b1", campaignId: "c1", apiKey: "k" },
    products: [{ offerId: "SKU-420", name: "retry me", price: 10, stockCount: 1 }],
    apiBase: "https://yandex.test",
    fetchImpl
  });

  assert.equal(result.ok, true, "420 应被重试，而不是一次就判失败");
  assert.ok(calls > 1, "应发生重试");
});

test("刊登链路遇到 409 只请求一次（不重试）", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: false,
      status: 409,
      json: async () => ({ errors: [{ code: "CONFLICT", message: "offer already exists" }] })
    };
  };

  const result = await publishYandexProducts({
    shop: { businessId: "b1", campaignId: "c1", apiKey: "k" },
    products: [{ offerId: "SKU-409", name: "conflict", price: 10, stockCount: 1 }],
    apiBase: "https://yandex.test",
    fetchImpl
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1, "409 不应重试");
});
