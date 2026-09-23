CREATE TABLE IF NOT EXISTS collection_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  collection_batch_id BIGINT UNSIGNED NOT NULL,
  company_id BIGINT UNSIGNED NOT NULL,
  source_platform VARCHAR(32) NOT NULL,
  source_product_id VARCHAR(255) NOT NULL,
  raw_payload_json JSON NOT NULL,
  central_product_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_items_batch_source (collection_batch_id, source_platform, source_product_id),
  KEY ix_collection_items_company_source (company_id, source_platform, source_product_id),
  CONSTRAINT fk_collection_items_batch FOREIGN KEY (collection_batch_id) REFERENCES collection_batches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
