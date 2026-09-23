"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCatalogApi } = require("./catalogApi");

test("central catalog API scopes requests to the V2 central routes and bearer token", async () => {
  const calls = [];
  const api = createCatalogApi({
    baseUrl: "/api/v2/central",
    getToken: () => "token-1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ items: [] }) };
    }
  });
  await api.list({ search: "demo", status: "ready" });
  assert.equal(calls[0].url, "/api/v2/central/products?search=demo&status=ready");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-1");
});

