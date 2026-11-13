-- External Import: staged uploads (batches + rows), committed external transactions, payment allocations and saved column mappings.
-- Nothing here touches invoices/payments/GL; committed records link to existing clients and travellers.

CREATE TABLE ext_mapping_templates (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(100) NOT NULL,
  mapping JSON NOT NULL, payer_hint VARCHAR(200) NULL, created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ext_tpl (agency_id, name)
);

CREATE TABLE ext_batches (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL, file_format ENUM('xlsx','csv','pdf') NOT NULL, file_size INT NOT NULL, file_hash CHAR(64) NOT NULL, file_key VARCHAR(300) NULL,
  status ENUM('processing','review','importing','imported','cancelled','failed','rolled_back') NOT NULL DEFAULT 'processing',
  stage VARCHAR(60) NULL, progress TINYINT NOT NULL DEFAULT 0, error VARCHAR(500) NULL,
  sheets JSON NULL, mapping JSON NULL, template_id INT NULL,
  payer_name VARCHAR(200) NULL, payer_client_id INT NULL, currency CHAR(3) NULL,
  total_rows INT NOT NULL DEFAULT 0, valid_rows INT NOT NULL DEFAULT 0, error_rows INT NOT NULL DEFAULT 0, duplicate_rows INT NOT NULL DEFAULT 0, skipped_rows INT NOT NULL DEFAULT 0,
  imported_rows INT NOT NULL DEFAULT 0, failed_rows INT NOT NULL DEFAULT 0, unmatched_payments INT NOT NULL DEFAULT 0,
  total_gross DECIMAL(16,2) NOT NULL DEFAULT 0, total_service DECIMAL(16,2) NOT NULL DEFAULT 0, total_net DECIMAL(16,2) NOT NULL DEFAULT 0,
  total_debit DECIMAL(16,2) NOT NULL DEFAULT 0, total_credit DECIMAL(16,2) NOT NULL DEFAULT 0, total_payments DECIMAL(16,2) NOT NULL DEFAULT 0,
  imported_amount DECIMAL(16,2) NOT NULL DEFAULT 0, control JSON NULL,
  uploaded_by INT NULL, uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_by INT NULL, committed_at DATETIME NULL, rolled_back_by INT NULL, rolled_back_at DATETIME NULL, rollback_reason VARCHAR(300) NULL,
  INDEX (agency_id, id), INDEX (agency_id, file_hash)
);

CREATE TABLE ext_rows (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, batch_id INT NOT NULL,
  sheet VARCHAR(100) NOT NULL, src_row INT NOT NULL, section VARCHAR(60) NULL,
  raw JSON NOT NULL, data JSON NULL,
  status ENUM('ok','warning','error','duplicate','skipped','imported','failed') NOT NULL DEFAULT 'ok',
  problems JSON NULL, dedupe_key CHAR(40) NULL,
  dup_txn_id INT NULL, dup_kind ENUM('exact','changed','in_file') NULL,
  action ENUM('import','skip','update','separate') NOT NULL DEFAULT 'import', action_reason VARCHAR(300) NULL,
  match_json JSON NULL, txn_id INT NULL, edited TINYINT(1) NOT NULL DEFAULT 0,
  INDEX (agency_id, batch_id, id), INDEX (agency_id, batch_id, status)
);

CREATE TABLE ext_txns (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, batch_id INT NOT NULL, row_id INT NULL,
  kind ENUM('sale','credit_note','refund','exchange','payment','reversal') NOT NULL,
  section VARCHAR(60) NULL, doc_type VARCHAR(40) NULL,
  invoice_no VARCHAR(60) NULL, invoice_date DATE NULL, txn_date DATE NOT NULL, payment_date DATE NULL, booking_date DATE NULL,
  passenger_name VARCHAR(200) NULL, passenger_key VARCHAR(200) NULL, traveller_id INT NULL, pax_ref VARCHAR(60) NULL, contact VARCHAR(200) NULL,
  client_id INT NULL, payer_name VARCHAR(200) NULL,
  pnr VARCHAR(30) NULL, ticket_no VARCHAR(40) NULL, payment_ref VARCHAR(100) NULL,
  sector VARCHAR(120) NULL, origin VARCHAR(60) NULL, destination VARCHAR(60) NULL, airline VARCHAR(80) NULL, flight_no VARCHAR(20) NULL,
  travel_date DATE NULL, return_date DATE NULL,
  currency CHAR(3) NOT NULL,
  gross DECIMAL(14,2) NOT NULL DEFAULT 0, tax DECIMAL(14,2) NOT NULL DEFAULT 0, service_charge DECIMAL(14,2) NOT NULL DEFAULT 0,
  net DECIMAL(14,2) NOT NULL DEFAULT 0,        -- signed: sales/exchanges +, credit notes/refunds −, payments = amount received (+)
  debit DECIMAL(14,2) NOT NULL DEFAULT 0, credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  pay_status VARCHAR(30) NULL, description VARCHAR(300) NULL, remarks VARCHAR(500) NULL,
  status ENUM('active','rolled_back','superseded') NOT NULL DEFAULT 'active', supersedes_id INT NULL,
  dedupe_key CHAR(40) NULL, weak_key CHAR(40) NULL, source_file VARCHAR(255) NOT NULL, source_sheet VARCHAR(100) NULL, source_row INT NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, status, txn_date), INDEX (agency_id, invoice_no), INDEX (agency_id, pnr), INDEX (agency_id, ticket_no),
  INDEX (agency_id, passenger_key), INDEX (agency_id, client_id), INDEX (agency_id, batch_id), INDEX (agency_id, dedupe_key), INDEX (agency_id, weak_key)
);

CREATE TABLE ext_allocations (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, payment_txn_id INT NOT NULL, invoice_no VARCHAR(60) NOT NULL,
  amount DECIMAL(14,2) NOT NULL, method ENUM('invoice_no','pax_pnr','ticket','reference','amount_date','manual') NOT NULL,
  confidence TINYINT NOT NULL DEFAULT 0, status ENUM('suggested','confirmed','rejected') NOT NULL DEFAULT 'suggested',
  decided_by INT NULL, decided_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, payment_txn_id), INDEX (agency_id, invoice_no, status)
);

-- Human-readable, append-only history of everything done to an import (the generic audit_log also records row-level changes).
CREATE TABLE ext_events (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, batch_id INT NULL, txn_id INT NULL,
  action VARCHAR(40) NOT NULL, detail VARCHAR(500) NULL, before_json JSON NULL, after_json JSON NULL,
  user_id INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, batch_id, id), INDEX (agency_id, txn_id)
);
