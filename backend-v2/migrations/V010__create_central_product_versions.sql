CREATE TABLE IF NOT EXISTS central_product_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  central_product_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  payload_json JSON NOT NULL,
  change_reason VARCHAR(64) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_central_versions_product_version (central_product_id, version_no),
  CONSTRAINT fk_central_versions_product FOREIGN KEY (central_product_id) REFERENCES central_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
