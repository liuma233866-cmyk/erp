CREATE TABLE IF NOT EXISTS publish_claims (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  platform VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  business_key VARCHAR(255) NOT NULL,
  publish_job_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL,
  lease_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_publish_claims_business (company_id, platform, shop_id, business_key),
  KEY ix_publish_claims_lease (status, lease_until),
  KEY ix_publish_claims_job (publish_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
