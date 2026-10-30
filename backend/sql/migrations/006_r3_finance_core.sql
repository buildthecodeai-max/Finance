-- R3 finance core: invoice posting, receipts+allocations, credit notes, client refunds, supplier bills, maker-checker.
ALTER TABLE agencies
  ADD COLUMN approval_threshold DECIMAL(14,2) NOT NULL DEFAULT 0,      -- base-currency amount above which a second person must approve (0 = off)
  ADD COLUMN bill_tolerance_pct DECIMAL(5,2) NOT NULL DEFAULT 2;       -- supplier bill vs booking cost tolerance

ALTER TABLE vouchers
  MODIFY voucher_type ENUM('receipt','payment','journal','ticket_invoice','refund','invoice','credit_note','bill','reversal') NOT NULL,
  ADD COLUMN reversed_by INT NULL, ADD COLUMN reversal_of INT NULL;

ALTER TABLE clients   ADD COLUMN account_id INT NULL;   -- receivable control account (type 120)
ALTER TABLE suppliers ADD COLUMN account_id INT NULL;   -- payable control account (type 210)

ALTER TABLE invoices
  MODIFY status ENUM('draft','reviewed','sent','partially_paid','paid','overdue','void','credited') NOT NULL DEFAULT 'draft',
  ADD COLUMN amount_credited DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN voucher_id INT NULL, ADD COLUMN snapshot_json JSON NULL,   -- exactly what was issued
  ADD COLUMN voided_at DATETIME NULL, ADD COLUMN void_reason VARCHAR(300) NULL, ADD COLUMN void_voucher_id INT NULL;

ALTER TABLE payments
  ADD COLUMN receipt_id INT NULL, ADD COLUMN bill_id INT NULL, ADD COLUMN voucher_id INT NULL,   -- voucher_id here = FX-difference voucher
  ADD COLUMN voided TINYINT(1) NOT NULL DEFAULT 0, ADD INDEX idx_pay_receipt (agency_id, receipt_id), ADD INDEX idx_pay_bill (agency_id, bill_id);

CREATE TABLE receipts (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  receipt_no VARCHAR(30) NOT NULL, client_id INT NOT NULL, cash_account_id INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL, currency CHAR(3) NOT NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  receipt_date DATE NOT NULL, method ENUM('bank_transfer','stripe','direct_debit','cash') NOT NULL, reference VARCHAR(100) NULL, narration VARCHAR(300) NULL,
  unallocated DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('posted','voided') NOT NULL DEFAULT 'posted',
  voucher_id INT NULL, void_voucher_id INT NULL, void_reason VARCHAR(300) NULL,
  idem_key VARCHAR(80) NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_receipt_no (agency_id, receipt_no), UNIQUE KEY uq_receipt_idem (agency_id, idem_key), INDEX (agency_id, client_id, receipt_date)
);

CREATE TABLE credit_notes (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  cn_no VARCHAR(30) NOT NULL, invoice_id INT NOT NULL, client_id INT NOT NULL, issue_date DATE NOT NULL, reason VARCHAR(300) NOT NULL,
  currency CHAR(3) NOT NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  subtotal DECIMAL(14,2) NOT NULL DEFAULT 0, tax_total DECIMAL(14,2) NOT NULL DEFAULT 0, total DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('draft','issued','void') NOT NULL DEFAULT 'draft',
  voucher_id INT NULL, void_voucher_id INT NULL, created_by INT NULL, issued_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cn (agency_id, cn_no), INDEX (agency_id, invoice_id)
);
CREATE TABLE credit_note_lines (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, credit_note_id INT NOT NULL,
  description VARCHAR(300) NOT NULL, amount DECIMAL(14,2) NOT NULL, tax DECIMAL(14,2) NOT NULL DEFAULT 0, INDEX (agency_id, credit_note_id)
);

CREATE TABLE client_refunds (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  refund_no VARCHAR(30) NOT NULL, client_id INT NOT NULL, invoice_id INT NOT NULL, amount DECIMAL(14,2) NOT NULL,
  currency CHAR(3) NOT NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1, method ENUM('bank_transfer','stripe','direct_debit','cash') NOT NULL, cash_account_id INT NOT NULL,
  reason VARCHAR(300) NOT NULL, status ENUM('requested','approved','paid','rejected') NOT NULL DEFAULT 'requested',
  requested_by INT NOT NULL, approved_by INT NULL, approved_at DATETIME NULL, paid_at DATE NULL, voucher_id INT NULL, payment_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_cr (agency_id, refund_no), INDEX (agency_id, invoice_id)
);

CREATE TABLE supplier_bills (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  bill_no VARCHAR(30) NOT NULL, supplier_id INT NOT NULL, supplier_ref VARCHAR(80) NOT NULL,    -- supplier's own invoice number
  bill_date DATE NOT NULL, due_date DATE NOT NULL, currency CHAR(3) NOT NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  subtotal DECIMAL(14,2) NOT NULL DEFAULT 0, tax_total DECIMAL(14,2) NOT NULL DEFAULT 0, total DECIMAL(14,2) NOT NULL DEFAULT 0, amount_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('draft','pending_approval','approved','partially_paid','paid','void') NOT NULL DEFAULT 'draft',
  booking_id INT NULL, notes VARCHAR(500) NULL, mismatch_note VARCHAR(500) NULL, override_reason VARCHAR(300) NULL,
  created_by INT NOT NULL, approved_by INT NULL, approved_at DATETIME NULL, voucher_id INT NULL, void_voucher_id INT NULL, void_reason VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bill_no (agency_id, bill_no), UNIQUE KEY uq_bill_ref (agency_id, supplier_id, supplier_ref), INDEX (agency_id, status, due_date)
);
CREATE TABLE supplier_bill_lines (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, bill_id INT NOT NULL, component_id INT NULL,
  description VARCHAR(300) NOT NULL, amount DECIMAL(14,2) NOT NULL, tax DECIMAL(14,2) NOT NULL DEFAULT 0, INDEX (agency_id, bill_id), INDEX (agency_id, component_id)
);
