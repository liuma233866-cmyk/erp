CREATE TABLE IF NOT EXISTS central_product_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  central_product_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  asset_type VARCHAR(32) NOT NULL,
  source_url TEXT NULL,
  storage_url TEXT NULL,
  checksum CHAR(64) NOT NULL,
  sort_no INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  metadata_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_central_assets_version_checksum (central_product_id, version_no, checksum),
  KEY ix_central_assets_product_version (central_product_id, version_no, sort_no),
  CONSTRAINT fk_central_assets_product FOREIGN KEY (central_product_id) REFERENCES central_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
