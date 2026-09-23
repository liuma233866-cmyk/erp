const test = require("node:test");
const assert = require("node:assert/strict");
const { paginateItems, readPositiveIntParam, validateNonEmptyString } = require("./pagination");

test("returns everything when no paging params are given", () => {
  const items = [1, 2, 3];
  assert.deepEqual(paginateItems(items, {}), {
    items,
    pagination: { page: 1, pageSize: 3, total: 3, totalPages: 1 }
  });
});

test("paginates normally", () => {
  const items = Array.from({ length: 25 }, (_, i) => i + 1);
  const page2 = paginateItems(items, { page: 2, pageSize: 10 });
  assert.deepEqual(page2.items, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(page2.pagination, { page: 2, pageSize: 10, total: 25, totalPages: 3 });
});

test("clamps out-of-range pages and oversized pageSize", () => {
  const items = Array.from({ length: 5 }, (_, i) => i + 1);
  assert.equal(paginateItems(items, { page: 99, pageSize: 10 }).pagination.page, 1);
  const oversized = paginateItems(items, { page: 1, pageSize: 500 });
  assert.equal(oversized.pagination.pageSize, 200);
});

test("falls back to defaults for invalid params", () => {
  const items = [1, 2, 3];
  const bad = paginateItems(items, { page: 0, pageSize: -4 });
  assert.equal(bad.pagination.page, 1);
  assert.equal(bad.pagination.pageSize, 50);
  assert.deepEqual(bad.items, items);
  assert.deepEqual(paginateItems(null, {}).items, []);
});

test("readPositiveIntParam clamps and falls back", () => {
  assert.equal(readPositiveIntParam("5", 1), 5);
  assert.equal(readPositiveIntParam("abc", 7), 7);
  assert.equal(readPositiveIntParam(undefined, 7), 7);
  assert.equal(readPositiveIntParam("0", 7), 1);
  assert.equal(readPositiveIntParam("-3", 7), 1);
  assert.equal(readPositiveIntParam("99999", 7), 1000);
  assert.equal(readPositiveIntParam("2.9", 7), 2);
});

test("validateNonEmptyString rejects empty and overlong values", () => {
  assert.deepEqual(validateNonEmptyString("", "name"), { ok: false, message: "name is required" });
  assert.deepEqual(validateNonEmptyString("   ", "name"), { ok: false, message: "name is required" });
  assert.deepEqual(validateNonEmptyString("x".repeat(257), "name"), { ok: false, message: "name is too long (max 256)" });
  assert.deepEqual(validateNonEmptyString("  hello  ", "name"), { ok: true, value: "hello" });
  assert.deepEqual(validateNonEmptyString("x".repeat(10), "name", 5), { ok: false, message: "name is too long (max 5)" });
});
