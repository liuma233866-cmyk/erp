CREATE TABLE IF NOT EXISTS collection_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(40) NOT NULL,
  company_id BIGINT UNSIGNED NOT NULL,
  source VARCHAR(64) NOT NULL,
  requested_by BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL,
  item_count INT UNSIGNED NOT NULL DEFAULT 0,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  request_namespace VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_collection_batches_public_id (public_id),
  UNIQUE KEY uq_collection_batches_request (company_id, request_namespace, request_id),
  KEY ix_collection_batches_company_status (company_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
