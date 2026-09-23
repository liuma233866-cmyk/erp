CREATE TABLE IF NOT EXISTS central_product_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  central_product_id BIGINT UNSIGNED NOT NULL,
  source_platform VARCHAR(32) NOT NULL,
  source_product_id VARCHAR(255) NOT NULL,
  source_url TEXT NULL,
  raw_payload_json JSON NOT NULL,
  collected_at DATETIME(3) NOT NULL,
  collection_batch_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_central_sources_identity (company_id, source_platform, source_product_id),
  KEY ix_central_sources_product (company_id, central_product_id),
  KEY ix_central_sources_batch (collection_batch_id),
  CONSTRAINT fk_central_sources_product FOREIGN KEY (central_product_id) REFERENCES central_products (id),
  CONSTRAINT fk_central_sources_batch FOREIGN KEY (collection_batch_id) REFERENCES collection_batches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
