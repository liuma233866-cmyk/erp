CREATE TABLE IF NOT EXISTS v2_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id VARCHAR(128) NOT NULL,
  company_id BIGINT UNSIGNED NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(128) NULL,
  outcome VARCHAR(32) NOT NULL,
  status_code SMALLINT UNSIGNED NOT NULL,
  metadata_json JSON NULL,
  occurred_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_v2_audit_logs_request (request_id),
  KEY ix_v2_audit_logs_company_time (company_id, occurred_at),
  KEY ix_v2_audit_logs_resource (resource_type, resource_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
