-- Payment runs v2: bill-based, maker-checker, export ≠ paid, settlement evidence.
ALTER TABLE agencies ADD COLUMN dual_control_runs TINYINT(1) NOT NULL DEFAULT 1;   -- approver must differ from creator and submitter

ALTER TABLE payment_runs
  MODIFY status ENUM('draft','validated','submitted','approved','exported','processing','paid','partially_paid','failed','cancelled') NOT NULL DEFAULT 'draft',
  ADD COLUMN kind ENUM('legacy','bills') NOT NULL DEFAULT 'legacy',
  ADD COLUMN bank_account_id INT NULL, ADD COLUMN notes VARCHAR(300) NULL,
  ADD COLUMN validated_at DATETIME NULL, ADD COLUMN validation_json JSON NULL,
  ADD COLUMN submitted_by INT NULL, ADD COLUMN submitted_at DATETIME NULL,
  ADD COLUMN approved_by INT NULL, ADD COLUMN approved_at DATETIME NULL,
  ADD COLUMN exported_by INT NULL, ADD COLUMN exported_at DATETIME NULL, ADD COLUMN export_format VARCHAR(10) NULL, ADD COLUMN export_checksum CHAR(64) NULL,
  ADD COLUMN settled_at DATETIME NULL, ADD COLUMN cancelled_reason VARCHAR(300) NULL, ADD INDEX idx_run_status (agency_id, status);

CREATE TABLE payment_run_items (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, run_id INT NOT NULL, bill_id INT NOT NULL, supplier_id INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  status ENUM('pending','paid','failed','removed') NOT NULL DEFAULT 'pending',
  settlement_ref VARCHAR(100) NULL, manual_reason VARCHAR(300) NULL, settled_date DATE NULL, failure_reason VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, run_id), INDEX (agency_id, bill_id, status)
);
