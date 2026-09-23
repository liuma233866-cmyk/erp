"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { productRow, productDetail } = require("./catalogViewModel");

test("central product row exposes stable list fields", () => {
  assert.deepEqual(productRow({ publicId: "CP_1", title: "Demo", status: "ready", stockCount: 3, currentVersion: 2 }), {
    publicId: "CP_1", title: "Demo", sku: "—", status: "可发布", stockCount: 3, version: 2, updatedAt: "—"
  });
});

test("central product detail keeps variants, versions, and assets visible", () => {
  const detail = productDetail({ publicId: "CP_1", title: "Demo", variants: [{ systemSku: "SKU-1", variantKey: "default", stockCount: 1 }], versions: [{ version_no: 1, change_reason: "create" }], assets: [{ id: 1 }] });
  assert.equal(detail.variants[0].systemSku, "SKU-1");
  assert.equal(detail.versions[0].reason, "create");
  assert.equal(detail.assets.length, 1);
});

