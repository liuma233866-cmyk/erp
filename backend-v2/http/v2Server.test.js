"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createV2Handler } = require("./v2Server");
const { ERROR_CODES, V2Error } = require("../core/errorCodes");

function mockResponse() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
}

function mockRequest({ authorization = "Bearer good", body = "" } = {}) {
  const listeners = {};
  return {
    method: "GET",
    url: "/api/v2/central/products?status=ready",
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
