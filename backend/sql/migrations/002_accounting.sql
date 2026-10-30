-- Accounting layer (double-entry) + legacy-style ticketing. Run after schema.sql.
SET NAMES utf8mb4;

CREATE TABLE account_types (
  code SMALLINT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  nature ENUM('asset','liability','equity','income','expense') NOT NULL
);
INSERT INTO account_types (code, name, nature) VALUES
 (110,'Petty Cash & Bank','asset'),(120,'Receivables / Customers','asset'),(121,'Current Assets','asset'),
 (122,'Investment','asset'),(123,'Staff Salaries & Advances','asset'),(124,'Advances & Deposits','asset'),
 (130,'Fix Assets','asset'),(210,'Payables / Vendors','liability'),(211,'Airlines','liability'),
 (212,'Short term loans','liability'),(220,'Long term loans','liability'),(230,'Capital','equity'),
 (231,'Unappropriated Profit','equity'),(310,'Cost of Revenue','expense'),(320,'Operating Expenses','expense'),
 (321,'Financial Expenses','expense'),(322,'Depreciation','expense'),(410,'Sales','income'),(420,'Other Income','income');

CREATE TABLE branches (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_branch (agency_id, name)
);
CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_dept (agency_id, name)
);

CREATE TABLE accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  type_code SMALLINT NOT NULL,
  code VARCHAR(12) NOT NULL,
  name VARCHAR(200) NOT NULL,
  sys_key VARCHAR(30) NULL,            -- 'sales','commission_paid','service_charges','cash','bank'
  branch_id INT NULL,
  city VARCHAR(100) NULL,
  currency CHAR(3) NULL,
  opening_dr DECIMAL(16,2) NOT NULL DEFAULT 0,
  opening_cr DECIMAL(16,2) NOT NULL DEFAULT 0,
  opening_date DATE NULL,
  details TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acc (agency_id, code), INDEX (agency_id, type_code), INDEX (agency_id, sys_key),
  FOREIGN KEY (type_code) REFERENCES account_types(code)
);

CREATE TABLE vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  voucher_type ENUM('receipt','payment','journal','ticket_invoice','refund') NOT NULL,
  voucher_no VARCHAR(30) NOT NULL,
  voucher_date DATE NOT NULL,
  narration VARCHAR(500) NULL,
  ref_table VARCHAR(40) NULL,
  ref_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vno (agency_id, voucher_type, voucher_no), INDEX (agency_id, ref_table, ref_id)
);

CREATE TABLE gl_entries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  voucher_id INT NOT NULL,
  account_id INT NOT NULL,
  entry_date DATE NOT NULL,
  debit DECIMAL(16,2) NOT NULL DEFAULT 0,
  credit DECIMAL(16,2) NOT NULL DEFAULT 0,
  narration VARCHAR(500) NULL,
  INDEX (agency_id, account_id, entry_date), INDEX (agency_id, voucher_id)
);

CREATE TABLE airlines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  code VARCHAR(3) NOT NULL,            -- numeric ticket prefix e.g. 001
  name VARCHAR(150) NOT NULL,
  iata_code VARCHAR(4) NULL,           -- e.g. AA
  commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  wh_pct DECIMAL(5,2) NULL,
  details VARCHAR(300) NULL,
  show_flag TINYINT(1) NOT NULL DEFAULT 1,
  account_id INT NULL,
  UNIQUE KEY uq_airline (agency_id, code)
);

CREATE TABLE ticket_invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  invoice_no VARCHAR(30) NOT NULL,
  branch_id INT NULL, department_id INT NULL,
  invoice_date DATE NOT NULL, due_date DATE NULL, due_vendor DATE NULL,
  stax_invoice_no VARCHAR(40) NULL, ref_no VARCHAR(60) NULL,
  client_account_id INT NOT NULL,
  payment_terms VARCHAR(60) NULL,
  employee_id INT NULL,
  remarks VARCHAR(500) NULL,
  umrah_query_id VARCHAR(40) NULL, ticket_query_id VARCHAR(40) NULL,
  status ENUM('tentative','confirmed') NOT NULL DEFAULT 'tentative',
  supervised TINYINT(1) NOT NULL DEFAULT 0,   -- approval; GL posting happens on supervise
  active TINYINT(1) NOT NULL DEFAULT 1,
  voucher_id INT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tinv (agency_id, invoice_no), INDEX (agency_id, invoice_date), INDEX (agency_id, client_account_id)
);

CREATE TABLE ticket_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  invoice_id INT NOT NULL,
  mode VARCHAR(30) NOT NULL DEFAULT 'ticket',  -- ticket / hotel / visa / umrah / other
  line_type VARCHAR(20) NOT NULL DEFAULT 'Normal',
  passport VARCHAR(40) NULL, passenger_name VARCHAR(150) NULL, pax_type VARCHAR(10) NOT NULL DEFAULT 'Adult',
  nationality VARCHAR(60) NULL, phone_rt VARCHAR(40) NULL, group_no VARCHAR(30) NULL,
  payable_account_id INT NULL, airline_id INT NULL,
  ticket_no VARCHAR(30) NULL, con_ticket_no VARCHAR(30) NULL, ticket_type VARCHAR(20) NULL,
  sector VARCHAR(80) NULL, gds VARCHAR(20) NULL, route VARCHAR(120) NULL, pnr VARCHAR(12) NULL, gds_pnr VARCHAR(12) NULL,
  fare_class VARCHAR(4) NULL, xo VARCHAR(20) NULL, dep_date DATE NULL, return_date DATE NULL, confirmation_no VARCHAR(40) NULL,
  fare DECIMAL(14,2) NOT NULL DEFAULT 0, fare_nc DECIMAL(14,2) NOT NULL DEFAULT 0,
  sp_yi DECIMAL(14,2) NOT NULL DEFAULT 0, rg_cvt DECIMAL(14,2) NOT NULL DEFAULT 0, yq DECIMAL(14,2) NOT NULL DEFAULT 0, ced DECIMAL(14,2) NOT NULL DEFAULT 0,
  pb_adv_yq DECIMAL(14,2) NOT NULL DEFAULT 0, xz DECIMAL(14,2) NOT NULL DEFAULT 0, yd DECIMAL(14,2) NOT NULL DEFAULT 0, kb DECIMAL(14,2) NOT NULL DEFAULT 0,
  xt_ur_us DECIMAL(14,2) NOT NULL DEFAULT 0, other_tax DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_taxes DECIMAL(14,2) NOT NULL DEFAULT 0, ticket_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  com_rec_pct DECIMAL(6,2) NOT NULL DEFAULT 0, com_rec DECIMAL(14,2) NOT NULL DEFAULT 0,
  com_paid_pct DECIMAL(6,2) NOT NULL DEFAULT 0, com_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  wh_air DECIMAL(14,2) NOT NULL DEFAULT 0, insurance DECIMAL(14,2) NOT NULL DEFAULT 0, vat_paid DECIMAL(14,2) NOT NULL DEFAULT 0,
  psf DECIMAL(14,2) NOT NULL DEFAULT 0, other_charges DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_pct DECIMAL(6,2) NOT NULL DEFAULT 0, discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  wh_client DECIMAL(14,2) NOT NULL DEFAULT 0, fare_inc DECIMAL(14,2) NOT NULL DEFAULT 0, taxes_inc DECIMAL(14,2) NOT NULL DEFAULT 0,
  agent_account_id INT NULL, agent_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  vat_pct DECIMAL(6,2) NOT NULL DEFAULT 0, vat DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  payable_fc DECIMAL(14,2) NOT NULL DEFAULT 0, receivable_fc DECIMAL(14,2) NOT NULL DEFAULT 0, profit_fc DECIMAL(14,2) NOT NULL DEFAULT 0,
  payable DECIMAL(14,2) NOT NULL DEFAULT 0, receivable DECIMAL(14,2) NOT NULL DEFAULT 0, profit DECIMAL(14,2) NOT NULL DEFAULT 0,
  INDEX (agency_id, invoice_id), INDEX (agency_id, ticket_no), INDEX (agency_id, passenger_name)
);

CREATE TABLE refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  refund_no VARCHAR(30) NOT NULL,
  refund_date DATE NOT NULL,
  invoice_id INT NULL, ticket_line_id INT NULL,
  branch_id INT NULL, department_id INT NULL, employee_id INT NULL,
  client_account_id INT NOT NULL, payable_account_id INT NOT NULL,
  mode VARCHAR(30) NULL, passport VARCHAR(40) NULL, passenger VARCHAR(150) NULL, pax_type VARCHAR(10) NULL,
  date_of_issue DATE NULL, date_of_expiry DATE NULL, cnic VARCHAR(30) NULL, father_name VARCHAR(100) NULL, group_no VARCHAR(30) NULL,
  hotel VARCHAR(150) NULL, rooms_par VARCHAR(100) NULL, room_no VARCHAR(20) NULL, room_qty INT NULL, nights INT NULL, meal VARCHAR(30) NULL,
  check_out DATE NULL, rate_night DECIMAL(14,2) NULL, confirmation_no VARCHAR(40) NULL, internal_ref VARCHAR(40) NULL, particulars VARCHAR(300) NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  com_rec DECIMAL(14,2) NOT NULL DEFAULT 0, com_paid DECIMAL(14,2) NOT NULL DEFAULT 0, wh_air DECIMAL(14,2) NOT NULL DEFAULT 0, vat DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0, cancelation DECIMAL(14,2) NOT NULL DEFAULT 0, service DECIMAL(14,2) NOT NULL DEFAULT 0,
  rec_from_vendor DECIMAL(14,2) NOT NULL DEFAULT 0, pay_to_customer DECIMAL(14,2) NOT NULL DEFAULT 0,
  profit DECIMAL(14,2) NOT NULL DEFAULT 0, difference DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NULL, fx_rate DECIMAL(16,8) NOT NULL DEFAULT 1,
  agent_account_id INT NULL, agent_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  pending TINYINT(1) NOT NULL DEFAULT 0, voucher_id INT NULL, created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refund (agency_id, refund_no)
);

-- Receipts (money in) and payments (money out) with optional cheque tracking
CREATE TABLE cash_vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  kind ENUM('receipt','payment') NOT NULL,
  voucher_no VARCHAR(30) NOT NULL,
  voucher_date DATE NOT NULL,
  cash_account_id INT NOT NULL,
  party_account_id INT NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  mode ENUM('cash','cheque','bank') NOT NULL DEFAULT 'cash',
  cheque_no VARCHAR(30) NULL, cheque_date DATE NULL, bank_name VARCHAR(100) NULL,
  cleared TINYINT(1) NOT NULL DEFAULT 0, cleared_date DATE NULL,
  ticket_invoice_id INT NULL,
  narration VARCHAR(500) NULL,
  voucher_id INT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cv (agency_id, kind, voucher_no), INDEX (agency_id, kind, voucher_date)
);

CREATE TABLE cheque_formats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  bank_name VARCHAR(100) NOT NULL, bank_code VARCHAR(30) NULL, font_name VARCHAR(60) NULL,
  width DECIMAL(6,2) NULL, length DECIMAL(6,2) NULL, top_print TINYINT(1) NOT NULL DEFAULT 1,
  date_format VARCHAR(20) NULL, date_font_size DECIMAL(4,1) NOT NULL DEFAULT 9, date_width DECIMAL(6,2) NOT NULL DEFAULT 1.5,
  date_spacing DECIMAL(4,1) NOT NULL DEFAULT 0, date_top DECIMAL(6,2) NOT NULL DEFAULT 3, date_left DECIMAL(6,2) NOT NULL DEFAULT 5.5,
  amount_width DECIMAL(6,2) NOT NULL DEFAULT 1, amount_font_size DECIMAL(4,1) NOT NULL DEFAULT 9, amount_top DECIMAL(6,2) NOT NULL DEFAULT 3.5, amount_left DECIMAL(6,2) NOT NULL DEFAULT 6,
  party_width DECIMAL(6,2) NOT NULL DEFAULT 5, party_font_size DECIMAL(4,1) NOT NULL DEFAULT 9, party_top DECIMAL(6,2) NOT NULL DEFAULT 3.5, party_left DECIMAL(6,2) NOT NULL DEFAULT 1,
  words_width DECIMAL(6,2) NOT NULL DEFAULT 5, words_font_size DECIMAL(4,1) NOT NULL DEFAULT 9, words_top DECIMAL(6,2) NOT NULL DEFAULT 3.8, words_left DECIMAL(6,2) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_cf (agency_id, bank_name)
);
