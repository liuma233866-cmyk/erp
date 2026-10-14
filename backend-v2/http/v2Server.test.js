"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createV2Handler } = require("./v2Server");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

function mockResponse() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
}

function mockRequest({ authorization = "Bearer good", body = "", url = "/api/v2/central/products?status=ready" } = {}) {
  const listeners = {};
  return {
    method: "GET",
    url,
    headers: { authorization },
    setEncoding() {},
    on(event, handler) { listeners[event] = handler; if (event === "end") queueMicrotask(() => { if (body) listeners.data?.(body); handler(); }); return this; },
    destroy() {}
  };
}

test("V2 HTTP handler authenticates, routes central requests, and propagates requestId", async () => {
  const handler = createV2Handler({
    auth: { authenticate: async () => ({ id: "u-1", companyId: "1" }) },
    controller: { handle: async (input) => { assert.equal(input.pathname, "/products"); assert.equal(input.query.status, "ready"); return { statusCode: 200, body: { data: { items: [] } } }; } }
  });
  const response = mockResponse();
  await handler(mockRequest(), response);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["X-Request-Id"], /^v2-/);
  assert.deepEqual(JSON.parse(response.body), { data: { items: [] } });
});

test("V2 HTTP handler returns 401 without a bearer token", async () => {
  const handler = createV2Handler({ auth: { authenticate: async () => { throw new V2Error(ERROR_CODES.AUTH_REQUIRED, "required"); } }, controller: {} });
  const response = mockResponse();
  await handler(mockRequest({ authorization: "" }), response);
  assert.equal(response.statusCode, 401);
});

test("多挂载点按最长前缀路由到对应控制器", async () => {
  const seen = [];
  const handler = createV2Handler({
    auth: { authenticate: async () => ({ id: "u-1", companyId: "1" }) },
    routes: [
      { prefix: "/api/v2/central", controller: { handle: async (input) => { seen.push(["central", input.pathname]); return { statusCode: 200, body: { data: "central" } }; } } },
      { prefix: "/api/v2/collection", controller: { handle: async (input) => { seen.push(["collection", input.pathname]); return { statusCode: 200, body: { data: "collection" } }; } } },
      { prefix: "/api/v2/publish", controller: { handle: async (input) => { seen.push(["publish", input.pathname]); return { statusCode: 200, body: { data: "publish" } }; } } }
    ]
  });

  for (const [url, expected] of [["/api/v2/collection/batches", "collection"], ["/api/v2/publish/claims", "publish"], ["/api/v2/central/products", "central"]]) {
    const response = mockResponse();
    await handler(mockRequest({ url }), response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { data: expected });
  }
  assert.deepEqual(seen, [["collection", "/batches"], ["publish", "/claims"], ["central", "/products"]]);
});

test("未挂载的 V2 路径返回 400", async () => {
  const handler = createV2Handler({
    auth: { authenticate: async () => ({ id: "u-1", companyId: "1" }) },
    routes: [{ prefix: "/api/v2/central", controller: { handle: async () => ({ statusCode: 200, body: {} }) } }]
  });
  const response = mockResponse();
  await handler(mockRequest({ url: "/api/v2/unknown/thing" }), response);
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error.message, /Unknown V2 route/);
});

test("缺少挂载点或控制器时构造失败", () => {
  assert.throws(() => createV2Handler({ auth: { authenticate: async () => ({}) } }), /at least one route mount/);
  assert.throws(
    () => createV2Handler({ auth: { authenticate: async () => ({}) }, routes: [{ prefix: "/api/v2/x" }] }),
    /has no controller/
  );
});
