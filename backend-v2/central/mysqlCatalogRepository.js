"use strict";

const { toMysqlDatetime } = require("../core/dateTime");

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    companyId: row.company_id,
    canonicalSku: row.canonical_sku,
    title: row.title,
    description: row.description || "",
    brand: row.brand || "",
    categoryId: row.category_id || "",
    purchasePrice: row.purchase_price,
    currency: row.currency,
    packageLengthCm: row.package_length_cm,
    packageWidthCm: row.package_width_cm,
    packageHeightCm: row.package_height_cm,
    weightKg: row.weight_kg,
    stockCount: row.stock_count,
    status: row.status,
    currentVersion: row.current_version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version
  };
}

function mapVariant(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    centralProductId: row.central_product_id,
    variantKey: row.variant_key,
    systemSku: row.system_sku,
    attributes: parseJson(row.attributes_json, {}),
    titleSuffix: row.title_suffix || "",
    purchasePrice: row.purchase_price,
    stockCount: row.stock_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class MysqlCentralCatalogRepository {
  constructor({ pool, executor } = {}) {
    if (!pool && !executor) throw new TypeError("A mysql pool is required");
    this.pool = pool || executor;
    this.executor = executor || pool;
  }

  async transaction(work) {
    if (this.executor !== this.pool || typeof this.pool.getConnection !== "function") return work(this);
    const connection = await this.pool.getConnection();
    const repository = new MysqlCentralCatalogRepository({ pool: this.pool, executor: connection });
    try {
      await connection.beginTransaction();
      const result = await work(repository);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async findProductByCanonicalSku(companyId, canonicalSku) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM central_products WHERE company_id = ? AND canonical_sku = ? LIMIT 1",
      [companyId, canonicalSku]
    );
    return mapProduct(rows[0]);
  }

  async findProductByPublicId(companyId, publicId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM central_products WHERE company_id = ? AND public_id = ? LIMIT 1",
      [companyId, publicId]
    );
    return mapProduct(rows[0]);
  }

  async createProduct(product) {
    const [result] = await this.executor.execute(
      `INSERT INTO central_products
       (public_id, company_id, canonical_sku, title, description, brand, category_id, purchase_price, currency,
        package_length_cm, package_width_cm, package_height_cm, weight_kg, stock_count, status, current_version,
        created_by, updated_by, created_at, updated_at, row_version)
       VALUES (
         ?, ?, NULLIF(?, ''),
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?
       )`,
      [product.publicId, product.companyId, product.canonicalSku, product.title, product.description, product.brand,
        product.categoryId, product.purchasePrice, product.currency, product.packageLengthCm, product.packageWidthCm,
        product.packageHeightCm, product.weightKg, product.stockCount, product.status, product.currentVersion,
        product.createdBy, product.updatedBy, product.createdAt, product.updatedAt, product.rowVersion]
    );
    return { ...product, id: result.insertId };
  }

  async updateProduct(product) {
    const [result] = await this.executor.execute(
      `UPDATE central_products SET canonical_sku = NULLIF(?, ''), title = ?, description = ?, brand = ?, category_id = ?,
       purchase_price = ?, currency = ?, package_length_cm = ?, package_width_cm = ?, package_height_cm = ?, weight_kg = ?,
       stock_count = ?, status = ?, current_version = ?, updated_by = ?, updated_at = ?, row_version = row_version + 1
       WHERE company_id = ? AND public_id = ? AND row_version = ?`,
      [product.canonicalSku, product.title, product.description, product.brand, product.categoryId, product.purchasePrice,
        product.currency, product.packageLengthCm, product.packageWidthCm, product.packageHeightCm, product.weightKg,
        product.stockCount, product.status, product.currentVersion, product.updatedBy, product.updatedAt,
        product.companyId, product.publicId, product.expectedRowVersion]
    );
    if (!result.affectedRows) return null;
    return this.findProductByPublicId(product.companyId, product.publicId);
  }

  async createVersion(version) {
    const [result] = await this.executor.execute(
      `INSERT INTO central_product_versions (central_product_id, version_no, payload_json, change_reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [version.centralProductId, version.versionNo, JSON.stringify(version.payload || {}), version.changeReason, version.createdBy, version.createdAt || toMysqlDatetime(new Date())]
    );
    return { ...version, id: result.insertId };
  }

  async createVariant(variant) {
    const [result] = await this.executor.execute(
      `INSERT INTO central_product_variants
       (company_id, central_product_id, variant_key, system_sku, attributes_json, title_suffix, purchase_price, stock_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [variant.companyId, variant.centralProductId, variant.variantKey, variant.systemSku, JSON.stringify(variant.attributes || {}),
        variant.titleSuffix, variant.purchasePrice, variant.stockCount, variant.status, variant.createdAt, variant.updatedAt]
    );
    return { ...variant, id: result.insertId };
  }

  async findSource(companyId, sourcePlatform, sourceProductId) {
    const [rows] = await this.executor.execute(
      "SELECT * FROM central_product_sources WHERE company_id = ? AND source_platform = ? AND source_product_id = ? LIMIT 1",
      [companyId, sourcePlatform, sourceProductId]
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      companyId: row.company_id,
      centralProductId: row.central_product_id,
      sourcePlatform: row.source_platform,
      sourceProductId: row.source_product_id,
      sourceUrl: row.source_url,
      rawPayload: parseJson(row.raw_payload_json, {}),
      collectedAt: row.collected_at,
      collectionBatchId: row.collection_batch_id
    } : null;
  }

  async createSource(source) {
    const [result] = await this.executor.execute(
      `INSERT INTO central_product_sources
       (company_id, central_product_id, source_platform, source_product_id, source_url, raw_payload_json, collected_at, collection_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [source.companyId, source.centralProductId, source.sourcePlatform, source.sourceProductId, source.sourceUrl,
        JSON.stringify(source.rawPayload || {}), source.collectedAt, source.collectionBatchId]
    );
    return { ...source, id: result.insertId };
  }

  async createAsset(asset) {
    const [result] = await this.executor.execute(
      `INSERT INTO central_product_assets
       (central_product_id, version_no, asset_type, source_url, storage_url, checksum, sort_no, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [asset.centralProductId, asset.versionNo, asset.assetType, asset.sourceUrl, asset.storageUrl, asset.checksum,
        asset.sortNo ?? 0, asset.status || "pending", JSON.stringify(asset.metadata || {}), asset.createdAt, asset.updatedAt]
    );
    return { ...asset, id: result.insertId };
  }

  async listProducts(companyId, filters = {}) {
    const clauses = ["company_id = ?"];
    const params = [companyId];
    if (filters.status) { clauses.push("status = ?"); params.push(filters.status); }
    if (filters.search) { clauses.push("(title LIKE ? OR canonical_sku LIKE ?)"); params.push(`%${filters.search}%`, `%${filters.search}%`); }
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 200);
    const offset = Math.max(Number(filters.offset || 0), 0);
    params.push(limit, offset);
    const [rows] = await this.executor.execute(`SELECT * FROM central_products WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, params);
    return rows.map(mapProduct);
  }

  async getProductDetail(companyId, publicId) {
    const product = await this.findProductByPublicId(companyId, publicId);
    if (!product) return null;
    const [variants] = await this.executor.execute("SELECT * FROM central_product_variants WHERE company_id = ? AND central_product_id = ? ORDER BY id", [companyId, product.id]);
    const [versions] = await this.executor.execute("SELECT id, central_product_id, version_no, payload_json, change_reason, created_by, created_at FROM central_product_versions WHERE central_product_id = ? ORDER BY version_no DESC", [product.id]);
    const [assets] = await this.executor.execute("SELECT * FROM central_product_assets WHERE central_product_id = ? ORDER BY version_no DESC, sort_no, id", [product.id]);
    return {
      ...product,
      variants: variants.map(mapVariant),
      versions: versions.map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })),
      assets: assets.map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }))
    };
  }
}

module.exports = { MysqlCentralCatalogRepository, mapProduct, mapVariant, parseJson };
