-- TravelFinance Pro schema (MySQL 8 / MariaDB 10.5+). Run: mysql -u user -p dbname < schema.sql
-- Multi-tenancy: every business table carries agency_id. users is global; roles live in memberships.
SET NAMES utf8mb4;

CREATE TABLE agencies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'USD',
  tax_label VARCHAR(10) NOT NULL DEFAULT 'GST',
  address TEXT NULL,
  next_invoice_no INT NOT NULL DEFAULT 1,
  invoice_prefix VARCHAR(10) NOT NULL DEFAULT 'INV-',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  totp_secret_enc TEXT NULL,
  totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memberships (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('admin','finance_manager','agent','viewer') NOT NULL,
  default_commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_member (agency_id, user_id),
  FOREIGN KEY (agency_id) REFERENCES agencies(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE refresh_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  address TEXT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  payment_terms_days INT NOT NULL DEFAULT 14,
  billing_preference ENUM('email','post','portal') NOT NULL DEFAULT 'email',
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id)
);

CREATE TABLE suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NULL,
  supplier_type ENUM('airline','hotel','cruise','transfer','tour_operator','other') NOT NULL DEFAULT 'other',
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  payment_terms_days INT NOT NULL DEFAULT 30,
  commission_override_pct DECIMAL(5,2) NULL,
  bank_details_enc TEXT NULL, -- AES-256-GCM, JSON payload
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id)
);

CREATE TABLE bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  client_id INT NOT NULL,
  agent_id INT NULL,
  reference VARCHAR(50) NOT NULL,
  destination VARCHAR(120) NULL,
  travel_start DATE NULL,
  travel_end DATE NULL,
  overhead DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id), INDEX (agency_id, client_id)
);

CREATE TABLE invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  number VARCHAR(30) NOT NULL,
  booking_id INT NULL,
  client_id INT NOT NULL,
  created_by INT NOT NULL,
  status ENUM('draft','reviewed','sent','partially_paid','paid','overdue','void') NOT NULL DEFAULT 'draft',
  currency CHAR(3) NOT NULL,
  fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1, -- invoice currency -> agency base currency
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  total DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  pdf_key VARCHAR(300) NULL,
  sent_at DATETIME NULL,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv (agency_id, number),
  INDEX (agency_id, status), INDEX (agency_id, due_date)
);

CREATE TABLE invoice_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  invoice_id INT NOT NULL,
  product_type ENUM('flight','hotel','package','cruise','transfer','other') NOT NULL,
  supplier_id INT NULL,
  description VARCHAR(500) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  markup_pct DECIMAL(6,2) NOT NULL DEFAULT 0,
  unit_price DECIMAL(14,2) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_net DECIMAL(14,2) NOT NULL,
  line_tax DECIMAL(14,2) NOT NULL,
  INDEX (agency_id, invoice_id)
);

CREATE TABLE invoice_installments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  invoice_id INT NOT NULL,
  label VARCHAR(100) NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  paid TINYINT(1) NOT NULL DEFAULT 0,
  INDEX (agency_id, invoice_id)
);

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  direction ENUM('inbound','outbound') NOT NULL,
  method ENUM('bank_transfer','stripe','direct_debit','cash') NOT NULL,
  invoice_id INT NULL,
  client_id INT NULL,
  supplier_id INT NULL,
  run_id INT NULL,
  amount DECIMAL(14,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  paid_at DATE NOT NULL,
  reference VARCHAR(100) NULL,
  stripe_id VARCHAR(100) NULL,
  reconciled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, direction, paid_at), INDEX (agency_id, invoice_id),
  UNIQUE KEY uq_stripe (agency_id, stripe_id)
);

CREATE TABLE payment_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  run_date DATE NOT NULL,
  currency CHAR(3) NOT NULL,
  status ENUM('draft','approved','exported') NOT NULL DEFAULT 'draft',
  total DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_by INT NOT NULL,
  remittance_key VARCHAR(300) NULL,
  INDEX (agency_id)
);

CREATE TABLE commissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  booking_id INT NOT NULL,
  agent_id INT NULL,
  period CHAR(7) NOT NULL, -- YYYY-MM
  selling_price DECIMAL(14,2) NOT NULL,
  supplier_cost DECIMAL(14,2) NOT NULL,
  overhead DECIMAL(14,2) NOT NULL,
  net_commission DECIMAL(14,2) NOT NULL,
  agent_amount DECIMAL(14,2) NOT NULL,
  status ENUM('accrued','closed') NOT NULL DEFAULT 'accrued',
  UNIQUE KEY uq_booking (agency_id, booking_id),
  INDEX (agency_id, period)
);

CREATE TABLE commission_closes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  period CHAR(7) NOT NULL,
  closed_by INT NOT NULL,
  closed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_close (agency_id, period)
);

CREATE TABLE expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  category VARCHAR(80) NOT NULL,
  description VARCHAR(300) NULL,
  amount DECIMAL(14,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  incurred_on DATE NOT NULL,
  INDEX (agency_id, incurred_on)
);

CREATE TABLE exchange_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  rate_date DATE NOT NULL,
  base CHAR(3) NOT NULL,
  quote CHAR(3) NOT NULL,
  rate DECIMAL(16,8) NOT NULL, -- 1 base = rate quote
  UNIQUE KEY uq_rate (agency_id, rate_date, base, quote)
);

CREATE TABLE bank_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  tx_date DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL, -- + credit, - debit
  description VARCHAR(500) NULL,
  fitid VARCHAR(100) NULL,
  matched_payment_id INT NULL,
  statement_key VARCHAR(300) NULL,
  INDEX (agency_id, tx_date), UNIQUE KEY uq_fit (agency_id, fitid)
);

CREATE TABLE reminders_sent (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  invoice_id INT NOT NULL,
  offset_days INT NOT NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rem (agency_id, invoice_id, offset_days)
);

CREATE TABLE integrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  provider ENUM('xero','quickbooks') NOT NULL,
  tenant_ref VARCHAR(100) NULL,
  tokens_enc TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_int (agency_id, provider)
);

-- Append-only audit log: triggers reject UPDATE and DELETE.
CREATE TABLE audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  user_id INT NULL,
  ip VARCHAR(64) NULL,
  action ENUM('create','update','delete') NOT NULL,
  entity VARCHAR(60) NOT NULL,
  entity_id BIGINT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (agency_id, created_at)
);

CREATE TABLE api_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NULL,
  user_id INT NULL,
  ip VARCHAR(64) NULL,
  method VARCHAR(8) NOT NULL,
  endpoint VARCHAR(300) NOT NULL,
  status_code SMALLINT NOT NULL,
  ms INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at)
);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'; END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only'; END;
