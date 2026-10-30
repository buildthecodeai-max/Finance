-- R7: public API keys, signed webhooks (outbox + deliveries), accounting export mappings, CSV imports.
CREATE TABLE api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(100) NOT NULL, key_prefix CHAR(8) NOT NULL, key_hash CHAR(64) NOT NULL,
  scopes VARCHAR(300) NOT NULL, expires_at DATETIME NULL, revoked_at DATETIME NULL, revoked_by INT NULL, created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL, use_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_api_key (key_hash), INDEX (agency_id)
);
CREATE TABLE api_idempotency (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, idem_key VARCHAR(80) NOT NULL, status_code INT NULL, response JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_idem (agency_id, idem_key)
);
CREATE TABLE webhook_endpoints (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(100) NOT NULL, url VARCHAR(500) NOT NULL, secret_enc TEXT NOT NULL, events VARCHAR(500) NOT NULL DEFAULT '*',
  active TINYINT(1) NOT NULL DEFAULT 1, disabled_reason VARCHAR(200) NULL, consecutive_failures INT NOT NULL DEFAULT 0, last_success_at DATETIME NULL, last_failure_at DATETIME NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, active)
);
CREATE TABLE webhook_events (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, event_id CHAR(36) NOT NULL, type VARCHAR(60) NOT NULL, version INT NOT NULL DEFAULT 1, payload JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_event (event_id), INDEX (agency_id, created_at)
);
CREATE TABLE webhook_deliveries (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, endpoint_id INT NOT NULL, event_pk INT NOT NULL,
  status ENUM('pending','success','failed','dead') NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_attempt_at DATETIME NOT NULL,
  last_status_code INT NULL, last_error VARCHAR(300) NULL, delivered_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_delivery (endpoint_id, event_pk), INDEX idx_due (status, next_attempt_at), INDEX (agency_id, endpoint_id)
);
CREATE TABLE account_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, account_id INT NOT NULL, external_code VARCHAR(40) NOT NULL, external_name VARCHAR(150) NULL,
  UNIQUE KEY uq_map (agency_id, account_id)
);
CREATE TABLE accounting_exports (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, kind VARCHAR(20) NOT NULL, format VARCHAR(20) NOT NULL, date_from DATE NOT NULL, date_to DATE NOT NULL,
  row_count INT NOT NULL, checksum CHAR(64) NOT NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, created_at)
);
CREATE TABLE import_batches (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, adapter VARCHAR(30) NOT NULL, filename VARCHAR(200) NULL, mode ENUM('preview','commit') NOT NULL,
  total_rows INT NOT NULL, ok_rows INT NOT NULL, duplicate_rows INT NOT NULL, error_rows INT NOT NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, created_at)
);
ALTER TABLE bookings ADD COLUMN external_source VARCHAR(30) NULL, ADD COLUMN external_ref VARCHAR(80) NULL, ADD UNIQUE KEY uq_booking_external (agency_id, external_source, external_ref);
