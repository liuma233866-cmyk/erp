// fetchYandexOrders 的「部分结果」回归测试。
//
// 历史缺陷：180 天回溯被切成多个 29 天窗口，任一窗口请求失败会 break 掉区间循环，但只要
// 之前收到过订单，函数就返回 ok:true。调用方（orders/order-sync）只判 !ok，于是把一次被
// 截断的同步记成完整成功 —— 第 5 个窗口被限流就只导入前 4 个窗口的订单，缺口无人知晓。
//
// 注意 420/429/5xx 会先被 fetchYandexJson 重试，所以这里用 400 这种非可重试状态来
// 确定性地触发区间中断，也避免测试里出现退避等待。
const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchYandexOrders } = require("./yandex-fetch");

// 2026-01-01 → 2026-04-01 约 90 天，按 29 天切分会产生多个区间。
const WIDE_WINDOW = { fromDate: "2026-01-01", toDate: "2026-04-01" };

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(calls.length, String(url));
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

function okResponse(orderId) {
  return { ok: true, status: 200, json: async () => ({ orders: [{ id: orderId }] }) };
}

function badRequestResponse(message) {
  return { ok: false, status: 400, json: async () => ({ errors: [{ code: "BAD_REQUEST", message }] }) };
}

test("中途某个时间区间失败时，仍返回已拉到的订单，但必须标记 partial", async () => {
  const stub = stubFetch((callIndex) =>
    callIndex === 1 ? okResponse("ORD-1") : badRequestResponse("invalid date range")
  );
  try {
    const result = await fetchYandexOrders("111", "api-key", WIDE_WINDOW);

    assert.ok(stub.calls.length >= 2, "宽窗口应被切成多个区间，测试才有意义");
    assert.equal(result.ok, true, "已拉到的订单不应被丢掉");
    assert.deepEqual(result.items.map((item) => item.id), ["ORD-1"]);
    assert.equal(result.partial, true, "截断必须被标出来，否则调用方会当成完整成功");
    assert.match(String(result.message), /400|invalid date range/);
  } finally {
    stub.restore();
  }
});

test("所有区间都成功时不带 partial 标记（不能把正常结果误报成截断）", async () => {
  const stub = stubFetch((callIndex) => okResponse(`ORD-${callIndex}`));
  try {
    const result = await fetchYandexOrders("111", "api-key", WIDE_WINDOW);

    assert.equal(result.ok, true);
    assert.ok(result.items.length >= 2, "每个区间都应贡献订单");
    assert.equal(result.partial, undefined);
  } finally {
    stub.restore();
  }
});

test("第一个区间就失败且一条都没拉到时不返回成功", async () => {
  const stub = stubFetch(() => badRequestResponse("invalid campaign"));
  try {
    const result = await fetchYandexOrders("111", "api-key", WIDE_WINDOW);
    assert.equal(result.ok, false);
    assert.match(String(result.message), /400|invalid campaign/);
  } finally {
    stub.restore();
  }
});

// 这是最容易改错的一处：business 接口被废弃时会 break 区间循环并回退到 legacy 策略，
// 那同样是「提前中断」但**不是数据缺口**。若把它一并标成 partial，带 businessId 的店铺
// 每次同步都会报一个假警报。
test("business 接口已废弃而回退到 legacy 时不算截断（正常回退不能报成缺口）", async () => {
  const stub = stubFetch((callIndex, url) =>
    url.includes("/v1/businesses/")
      ? { ok: false, status: 404, json: async () => ({ errors: [{ code: "NOT_FOUND", message: "method not found" }] }) }
      : okResponse(`ORD-L${callIndex}`)
  );
  try {
    const result = await fetchYandexOrders("111", "api-key", { businessId: "222", ...WIDE_WINDOW });

    assert.equal(result.ok, true);
    assert.ok(result.items.length >= 2, "legacy 策略应覆盖全部区间");
    assert.equal(result.partial, undefined, "正常的策略回退不应被报成数据缺口");
  } finally {
    stub.restore();
  }
});
