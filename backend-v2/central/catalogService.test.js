"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CentralCatalogService, normalizeVariantAttributes } = require("./catalogService");
const { ERROR_CODES } = require("../core/errorCodes");

class MemoryRepository {
  constructor() {
    this.nextId = 1;
    this.products = [];
    this.variants = [];
    this.sources = [];
    this.versions = [];
    this.assets = [];
  }

  transaction(work) { return work(this); }
  findProductByCanonicalSku(companyId, canonicalSku) { return Promise.resolve(this.products.find((p) => p.companyId === companyId && p.canonicalSku === canonicalSku) || null); }
  findProductByPublicId(companyId, publicId) { return Promise.resolve(this.products.find((p) => p.companyId === companyId && p.publicId === publicId) || null); }
  createProduct(product) { const created = { ...product, id: this.nextId++ }; this.products.push(created); return Promise.resolve(created); }
  createVersion(version) { const created = { ...version, id: this.nextId++ }; this.versions.push(created); return Promise.resolve(created); }
  createVariant(variant) {
    if (this.variants.some((v) => v.companyId === variant.companyId && v.systemSku === variant.systemSku)) throw new Error("duplicate system sku");
    const created = { ...variant, id: this.nextId++ }; this.variants.push(created); return Promise.resolve(created);
  }
  findSource(companyId, sourcePlatform, sourceProductId) { return Promise.resolve(this.sources.find((s) => s.companyId === companyId && s.sourcePlatform === sourcePlatform && s.sourceProductId === sourceProductId) || null); }
  createSource(source) { const created = { ...source, id: this.nextId++ }; this.sources.push(created); return Promise.resolve(created); }
  updateProduct(product) {
    const index = this.products.findIndex((p) => p.companyId === product.companyId && p.publicId === product.publicId && p.rowVersion === product.expectedRowVersion);
    if (index < 0) return Promise.resolve(null);
    this.products[index] = { ...this.products[index], ...product, rowVersion: this.products[index].rowVersion + 1 };
    return Promise.resolve(this.products[index]);
  }
  createAsset(asset) { const created = { ...asset, id: this.nextId++ }; this.assets.push(created); return Promise.resolve(created); }
  listProducts(companyId) { return Promise.resolve(this.products.filter((p) => p.companyId === companyId)); }
  getProductDetail(companyId, publicId) { return this.findProductByPublicId(companyId, publicId); }
}

function serviceWith(repo) {
  return new CentralCatalogService({ repository: repo, clock: () => new Date("2026-08-18T00:00:00.000Z"), publicIdFactory: (prefix) => `${prefix}_TEST` });
}

test("variant keys are stable regardless of attribute input order", () => {
  assert.deepEqual(normalizeVariantAttributes({ Size: "M", Color: "Red" }), {
    attributes: { color: "red", size: "m" },
    variantKey: "color=red;size=m"
  });
});

test("creating a central product creates an immutable version and a default variant", async () => {
  const repo = new MemoryRepository();
  const service = serviceWith(repo);
  const first = await service.createProduct({ companyId: "1", canonicalSku: " sku-1 ", title: "Demo" });
  assert.equal(first.deduplicated, false);
  assert.equal(repo.versions.length, 1);
  assert.equal(repo.variants.length, 1);
  assert.equal(repo.variants[0].variantKey, "default");
  const duplicate = await service.createProduct({ companyId: "1", canonicalSku: "SKU-1", title: "Changed" });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(repo.products.length, 1);
});

test("collection source identity is tenant-scoped and idempotent", async () => {
  const repo = new MemoryRepository();
  const service = serviceWith(repo);
  const input = { companyId: "1", sourcePlatform: "OZON", sourceProductId: "p-1", rawPayload: { sku: "sku-1" }, title: "Demo" };
  const created = await service.ingestCollectedItem(input);
  assert.equal(created.kind, "created");
  const duplicate = await service.ingestCollectedItem(input);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(repo.sources.length, 1);
  const otherTenant = await service.ingestCollectedItem({ ...input, companyId: "2" });
  assert.equal(otherTenant.kind, "created");
  assert.equal(repo.products.length, 2);
});

test("central product edits require the current row version and create a new version", async () => {
  const repo = new MemoryRepository();
  const service = serviceWith(repo);
  const { product } = await service.createProduct({ companyId: "1", canonicalSku: "SKU-1", title: "Before" });
  const updated = await service.updateProduct({ companyId: "1", publicId: product.publicId, expectedRowVersion: 0, patch: { title: "After" }, actorId: "u-1" });
  assert.equal(updated.title, "After");
  assert.equal(updated.currentVersion, 2);
  assert.equal(repo.versions.length, 2);
  await assert.rejects(() => service.updateProduct({ companyId: "1", publicId: product.publicId, expectedRowVersion: 0, patch: { title: "Stale" }, actorId: "u-2" }), (error) => error.code === ERROR_CODES.ROW_VERSION_CONFLICT);
});

test("central asset checksums are validated before persistence", async () => {
  const repo = new MemoryRepository();
  const service = serviceWith(repo);
  await assert.rejects(() => service.addAsset({ companyId: "1", centralProductId: 1, versionNo: 1, assetType: "main", checksum: "bad" }), (error) => error.code === ERROR_CODES.VALIDATION_FAILED);
  await service.addAsset({ companyId: "1", centralProductId: 1, versionNo: 1, assetType: "main", checksum: "a".repeat(64) });
  assert.equal(repo.assets.length, 1);
});

