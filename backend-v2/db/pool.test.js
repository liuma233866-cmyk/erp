"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildV2PoolOptions } = require("./pool");

test("V2 pool uses UTC and returns date values as strings", () => {
  const options = buildV2PoolOptions({ V2_MYSQL_HOST: "db", V2_MYSQL_PORT: "3307", V2_MYSQL_DATABASE: "v2" });
  assert.equal(options.host, "db");
  assert.equal(options.port, 3307);
  assert.equal(options.database, "v2");
  assert.equal(options.timezone, "Z");
  assert.equal(options.dateStrings, true);
});
