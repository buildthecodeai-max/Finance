-- R4: FX controls, commission engine, bank reconciliation against the ledger.

-- ---------- FX controls
ALTER TABLE exchange_rates ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'provider', ADD COLUMN created_by INT NULL, ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE agencies ADD COLUMN fx_max_age_days INT NOT NULL DEFAULT 7,
  ADD COLUMN commission_trigger ENUM('booking_confirmed','client_paid','travel_completed','supplier_paid') NOT NULL DEFAULT 'booking_confirmed';
ALTER TABLE invoices ADD COLUMN fx_source VARCHAR(30) NULL, ADD COLUMN fx_date DATE NULL;
ALTER TABLE receipts ADD COLUMN fx_source VARCHAR(30) NULL, ADD COLUMN fx_date DATE NULL;
ALTER TABLE supplier_bills ADD COLUMN fx_source VARCHAR(30) NULL, ADD COLUMN fx_date DATE NULL;

ALTER TABLE vouchers MODIFY voucher_type ENUM('receipt','payment','journal','ticket_invoice','refund','invoice','credit_note','bill','reversal','commission') NOT NULL;

-- ---------- Commission rules (versioned; every edit is a new row, old versions stay for explainability)
CREATE TABLE commission_rules (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  rule_key CHAR(36) NOT NULL, version INT NOT NULL DEFAULT 1, supersedes_id INT NULL,
  name VARCHAR(120) NOT NULL,
  kind ENUM('agent','supplier') NOT NULL DEFAULT 'agent',                -- agent = payable to agent; supplier = receivable from supplier
  basis ENUM('pct_selling','pct_margin','fixed') NOT NULL,
  rate DECIMAL(8,3) NULL, fixed_amount DECIMAL(14,2) NULL, tiers JSON NULL, deduct_overhead TINYINT(1) NOT NULL DEFAULT 0,
  branch_id INT NULL, product_type VARCHAR(20) NULL, supplier_id INT NULL, destination VARCHAR(150) NULL, agent_id INT NULL,
  effective_from DATE NULL, effective_to DATE NULL, priority INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rule_ver (agency_id, rule_key, version), INDEX (agency_id, kind, active)
);

CREATE TABLE commission_splits (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL, agent_id INT NOT NULL, pct DECIMAL(5,2) NOT NULL,
  UNIQUE KEY uq_split (agency_id, booking_id, agent_id)
);

CREATE TABLE commission_entries (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL, agent_id INT NOT NULL,
  split_pct DECIMAL(5,2) NOT NULL DEFAULT 100,
  selling_net DECIMAL(14,2) NOT NULL DEFAULT 0, supplier_cost DECIMAL(14,2) NOT NULL DEFAULT 0, overhead_alloc DECIMAL(14,2) NOT NULL DEFAULT 0, margin DECIMAL(14,2) NOT NULL DEFAULT 0,
  gross_amount DECIMAL(14,2) NOT NULL DEFAULT 0,           -- booking-level agent commission before splitting
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,                 -- this agent's share (what is approved/paid)
  override_amount DECIMAL(14,2) NULL, override_reason VARCHAR(300) NULL, override_by INT NULL,
  status ENUM('estimated','accrued','eligible','approved','paid','reversed') NOT NULL DEFAULT 'estimated',
  period CHAR(7) NULL, eligible_at DATETIME NULL, approved_at DATETIME NULL, approved_by INT NULL, paid_at DATETIME NULL,
  voucher_id INT NULL, calc_json JSON NULL, rule_summary VARCHAR(300) NULL, flags VARCHAR(200) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_entry (agency_id, booking_id, agent_id), INDEX (agency_id, status, period), INDEX (agency_id, agent_id)
);

-- Corrections after approval never edit history: they are signed adjustments applied in the next open period.
CREATE TABLE commission_adjustments (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, entry_id INT NULL, agent_id INT NOT NULL, period CHAR(7) NOT NULL,
  amount DECIMAL(14,2) NOT NULL, kind ENUM('clawback','recalc','carry_forward','manual') NOT NULL, reason VARCHAR(300) NOT NULL,
  status ENUM('open','approved','paid') NOT NULL DEFAULT 'open', voucher_id INT NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, period, status), INDEX (agency_id, entry_id)
);

CREATE TABLE commission_periods (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, period CHAR(7) NOT NULL,
  status ENUM('open','submitted','approved','paid') NOT NULL DEFAULT 'open',
  submitted_by INT NULL, submitted_at DATETIME NULL, approved_by INT NULL, approved_at DATETIME NULL, paid_at DATETIME NULL,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0, voucher_id INT NULL, pay_voucher_id INT NULL, override_reason VARCHAR(300) NULL, reopened_reason VARCHAR(300) NULL,
  UNIQUE KEY uq_cperiod (agency_id, period)
);

-- Commission the agency expects from suppliers (tracked separately from client receipts)
CREATE TABLE supplier_commissions (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL, supplier_id INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL, status ENUM('expected','received','void') NOT NULL DEFAULT 'expected', calc_json JSON NULL,
  received_date DATE NULL, voucher_id INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scomm (agency_id, booking_id, supplier_id)
);

ALTER TABLE commissions ADD COLUMN supplier_commission DECIMAL(14,2) NOT NULL DEFAULT 0, ADD COLUMN net_agency_margin DECIMAL(14,2) NOT NULL DEFAULT 0;

-- ---------- Bank reconciliation against ledger cash entries
CREATE TABLE bank_statements (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, account_id INT NOT NULL, filename VARCHAR(200) NOT NULL, statement_key VARCHAR(300) NULL,
  currency CHAR(3) NOT NULL, period_from DATE NULL, period_to DATE NULL, opening_balance DECIMAL(16,2) NULL, closing_balance DECIMAL(16,2) NULL,
  line_count INT NOT NULL DEFAULT 0, status ENUM('open','reconciled') NOT NULL DEFAULT 'open', reconciled_by INT NULL, reconciled_at DATETIME NULL, reopened_reason VARCHAR(300) NULL,
  imported_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, account_id, period_to)
);
ALTER TABLE bank_transactions DROP INDEX uq_fit,
  ADD COLUMN statement_id INT NULL, ADD COLUMN account_id INT NULL, ADD COLUMN currency CHAR(3) NULL, ADD COLUMN counterparty VARCHAR(200) NULL, ADD COLUMN reference VARCHAR(120) NULL,
  ADD COLUMN status ENUM('unmatched','matched','ignored') NOT NULL DEFAULT 'unmatched', ADD COLUMN ignore_reason VARCHAR(300) NULL, ADD COLUMN dedupe_hash CHAR(40) NULL,
  ADD UNIQUE KEY uq_bank_dedupe (agency_id, dedupe_hash), ADD INDEX idx_bank_stmt (agency_id, statement_id), ADD INDEX idx_bank_acct (agency_id, account_id, status, tx_date);

CREATE TABLE bank_matches (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, bank_txn_id INT NOT NULL, gl_entry_id BIGINT NOT NULL,
  amount DECIMAL(16,2) NOT NULL,                                   -- signed ledger effect (debit − credit) matched
  method ENUM('auto','manual','adjustment','receipt') NOT NULL DEFAULT 'manual', confidence TINYINT NULL, matched_by INT NULL, matched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bm (agency_id, bank_txn_id, gl_entry_id), INDEX (agency_id, gl_entry_id)
);
