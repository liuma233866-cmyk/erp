"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createV2Pool } = require("../db/pool");
const { MysqlCentralCatalogRepository } = require("./mysqlCatalogRepository");
const { CentralCatalogService } = require("./catalogService");

const enabled = process.env.V2_MYSQL_RUN_CENTRAL_INTEGRATION === "1";

test("central catalog CRUD, dedupe, versions, and assets work against MySQL", { skip: !enabled }, async () => {
  const pool = createV2Pool();
  const repository = new MysqlCentralCatalogRepository({ pool });
  const service = new CentralCatalogService({
    repository,
    clock: () => new Date("2026-08-18T00:00:00.000Z"),
    publicIdFactory: (prefix) => `${prefix}_INTEGRATION`
  });
  try {
    const created = await service.createProduct({ companyId: "9001", canonicalSku: "stage1-sku", title: "Stage 1 Product" });
    assert.equal(created.deduplicated, false);
    const duplicate = await service.createProduct({ companyId: "9001", canonicalSku: "STAGE1-SKU", title: "Duplicate" });
    assert.equal(duplicate.deduplicated, true);
    const collected = await service.ingestCollectedItem({ companyId: "9001", sourcePlatform: "ozon", sourceProductId: "source-1", rawPayload: { sku: "stage1-sku" }, title: "Stage 1 Product" });
    assert.equal(collected.kind, "matched");
    const sourceDuplicate = await service.ingestCollectedItem({ companyId: "9001", sourcePlatform: "ozon", sourceProductId: "source-1", rawPayload: { sku: "stage1-sku" }, title: "Stage 1 Product" });
    assert.equal(sourceDuplicate.kind, "duplicate");
    const updated = await service.updateProduct({ companyId: "9001", publicId: created.product.publicId, expectedRowVersion: 0, patch: { title: "Stage 1 Updated" }, actorId: "9001" });
    assert.equal(updated.currentVersion, 2);
    await service.addAsset({ companyId: "9001", centralProductId: created.product.id, versionNo: 2, assetType: "main", checksum: "b".repeat(64), sourceUrl: "https://example.com/image.jpg" });
    const detail = await service.getProduct("9001", created.product.publicId);
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.assets.length, 1);
    assert.equal(detail.variants.length, 1);
  } finally {
    await pool.end();
  }
});

