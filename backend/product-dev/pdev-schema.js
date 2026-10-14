"use strict";

// 产品开发库（product-dev）4 张表的 DDL。
//
// 与现有任何表零关系：不读不写 central_* / collection_box / publish_* / 订单表。
// 全部使用 CREATE TABLE IF NOT EXISTS，幂等，可重复执行（测试环境也可直接调用）。
//
// 字段与索引严格按 PRODUCT_DEV_API_CONTRACT.md §3。

const PDEV_TABLE_DDLS = [
  `CREATE TABLE IF NOT EXISTS pdev_products (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    public_id VARCHAR(40) NOT NULL,
    company_key VARCHAR(128) NOT NULL,
    title VARCHAR(500) NOT NULL,
    remark TEXT NULL,
    category_hint VARCHAR(128) NULL,
    target_platform VARCHAR(32) NULL,
    dev_status VARCHAR(32) NOT NULL DEFAULT 'new',
  goods_status VARCHAR(32) NULL,
  sales_status VARCHAR(32) NULL,
  source_status VARCHAR(32) NULL,
  purchase_price DECIMAL(12,2) NULL,
  purchase_url VARCHAR(512) NULL,
  reference_url VARCHAR(512) NULL,
  is_bundle VARCHAR(8) NULL,
  system_category VARCHAR(128) NULL,
    owner_user_id VARCHAR(128) NULL,
    created_by VARCHAR(128) NULL,
    created_at DATETIME(3) NULL,
    updated_at DATETIME(3) NULL,
    row_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_pdev_products_public_id (public_id),
    KEY idx_pdev_products_company_status_updated (company_key, dev_status, updated_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,

  // UNIQUE(company_key, platform, source_product_id) 防止同一货源被两个产品占用。
  `CREATE TABLE IF NOT EXISTS pdev_sources (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    company_key VARCHAR(128) NULL,
    pdev_product_id BIGINT UNSIGNED NOT NULL,
    platform VARCHAR(32) NOT NULL,
    source_product_id VARCHAR(255) NOT NULL,
    source_url TEXT NULL,
    supply_price DECIMAL(12,2) NULL,
    supply_currency CHAR(3) NOT NULL DEFAULT 'CNY',
    moq INT NULL,
    supplier_name VARCHAR(255) NULL,
    supply_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
    note TEXT NULL,
    created_at DATETIME(3) NULL,
    updated_at DATETIME(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_pdev_sources_natural (company_key, platform, source_product_id),
    KEY idx_pdev_sources_product (pdev_product_id),
    CONSTRAINT fk_pdev_sources_product FOREIGN KEY (pdev_product_id) REFERENCES pdev_products (id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS pdev_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    company_key VARCHAR(128) NULL,
    pdev_product_id BIGINT UNSIGNED NOT NULL,
    asset_type VARCHAR(32) NOT NULL,
    source_url TEXT NULL,
    storage_url TEXT NULL,
    sort_no INT NOT NULL DEFAULT 0,
    checksum CHAR(64) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ready',
    created_at DATETIME(3) NULL,
    updated_at DATETIME(3) NULL,
    PRIMARY KEY (id),
    KEY idx_pdev_assets_product_type_sort (pdev_product_id, asset_type, sort_no),
    CONSTRAINT fk_pdev_assets_product FOREIGN KEY (pdev_product_id) REFERENCES pdev_products (id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS pdev_variants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    company_key VARCHAR(128) NULL,
    pdev_product_id BIGINT UNSIGNED NOT NULL,
    variant_key VARCHAR(128) NOT NULL,
    spec_json JSON NOT NULL,
    supply_price DECIMAL(12,2) NULL,
    weight_kg DECIMAL(10,3) NULL,
    package_length_cm DECIMAL(10,2) NULL,
    package_width_cm DECIMAL(10,2) NULL,
    package_height_cm DECIMAL(10,2) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NULL,
    updated_at DATETIME(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_pdev_variants_key (company_key, pdev_product_id, variant_key),
    CONSTRAINT fk_pdev_variants_product FOREIGN KEY (pdev_product_id) REFERENCES pdev_products (id) ON DELETE CASCADE
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
];

// 幂等建表：4 条 CREATE TABLE IF NOT EXISTS，父表在前（子表带外键）。

// 增量列迁移：CREATE TABLE IF NOT EXISTS 对**已存在**的表不会补列，
// 所以老库需要这一段幂等 ALTER（SHOW COLUMNS 先查再决定加不加，可重复执行）。
const PDEV_PRODUCT_EXTRA_COLUMNS = [
  ["goods_status", "VARCHAR(32) NULL"],
  ["pack_form", "VARCHAR(32) NULL"],
  ["pack_outer", "VARCHAR(32) NULL"],
  ["pack_cushion", "VARCHAR(32) NULL"],
  ["pack_reinforce", "VARCHAR(32) NULL"],
  ["sample_pack_size", "VARCHAR(64) NULL"],
  ["sample_pack_weight", "DECIMAL(10,3) NULL"],
  ["base_pack_size_cm", "VARCHAR(64) NULL"],
  ["base_pack_weight_kg", "DECIMAL(10,3) NULL"],
  ["base_pack_size_inch", "VARCHAR(64) NULL"],
  ["base_pack_weight_lb", "DECIMAL(10,3) NULL"],
  ["base_pack_volume_m3", "DECIMAL(12,6) NULL"],
  ["item_size_cm", "VARCHAR(64) NULL"],
  ["item_net_weight_kg", "DECIMAL(10,3) NULL"],
  ["carton_size_cm", "VARCHAR(64) NULL"],
  ["carton_weight_kg", "DECIMAL(10,3) NULL"],
  ["carton_volume_m3", "DECIMAL(12,6) NULL"],
  ["carton_pcs", "INT NULL"],
  ["base_unit", "VARCHAR(16) NULL"],
  ["carton_layers", "INT NULL"],
  ["carton_inner_gsm", "DECIMAL(10,2) NULL"],
  ["carton_outer_gsm", "DECIMAL(10,2) NULL"],
  ["labor_cost", "DECIMAL(12,2) NULL"],
  ["carton_price", "DECIMAL(12,2) NULL"],
  ["sales_status", "VARCHAR(32) NULL"],
  ["source_status", "VARCHAR(32) NULL"],
  ["purchase_price", "DECIMAL(12,2) NULL"],
  ["purchase_url", "VARCHAR(512) NULL"],
  ["reference_url", "VARCHAR(512) NULL"],
  ["is_bundle", "VARCHAR(8) NULL"],
  ["system_category", "VARCHAR(128) NULL"]
];

async function ensurePdevColumns(pool) {
  if (!pool) return;
  let rows;
  try {
    [rows] = await pool.query("SHOW COLUMNS FROM pdev_products");
  } catch (error) {
    return; // 表还不存在：上面的 CREATE TABLE 已经带上这些列了
  }
  const existing = new Set(rows.map((row) => String(row.Field)));
  for (const [name, definition] of PDEV_PRODUCT_EXTRA_COLUMNS) {
    if (existing.has(name)) continue;
    await pool.query(`ALTER TABLE pdev_products ADD COLUMN ${name} ${definition}`);
  }
}

async function ensurePdevTables(pool) {
  await ensurePdevColumns(pool);
  if (!pool || typeof pool.query !== "function") {
    throw new Error("ensurePdevTables requires a MySQL pool with a query() method");
  }
  for (const statement of PDEV_TABLE_DDLS) {
    await pool.query(statement);
  }
}

// PDEV_TABLE_DDL（项目经理冻结名）与 PDEV_TABLE_DDLS 指向同一数组。
module.exports = {
  ensurePdevColumns, PDEV_TABLE_DDL: PDEV_TABLE_DDLS, PDEV_TABLE_DDLS, ensurePdevTables };
