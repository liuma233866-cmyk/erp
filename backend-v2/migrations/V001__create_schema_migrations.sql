CREATE TABLE IF NOT EXISTS v2_schema_migrations (
  version VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  PRIMARY KEY (version),
  UNIQUE KEY uq_v2_schema_migrations_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
