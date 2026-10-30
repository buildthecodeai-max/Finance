-- R2: CRM, quotes (versioned), booking workspace, travellers, itinerary, tasks. Additive only.
ALTER TABLE agencies ADD COLUMN min_margin_pct DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE bookings
  ADD COLUMN status ENUM('enquiry','quoted','awaiting_client','confirmed','in_service','travel_completed','closed','on_hold','cancelled','refunded','lost') NOT NULL DEFAULT 'confirmed',
  ADD COLUMN branch_id INT NULL, ADD COLUMN channel VARCHAR(40) NULL, ADD COLUMN quote_id INT NULL, ADD COLUMN trip_purpose VARCHAR(60) NULL,
  ADD COLUMN notes TEXT NULL, ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY uq_booking_ref (agency_id, reference), ADD INDEX idx_booking_status (agency_id, status), ADD INDEX idx_booking_travel (agency_id, travel_start);

CREATE TABLE leads (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  client_id INT NULL, name VARCHAR(200) NOT NULL, email VARCHAR(255) NULL, phone VARCHAR(50) NULL,
  source VARCHAR(60) NULL, enquiry_type VARCHAR(60) NULL, destination VARCHAR(150) NULL,
  budget_min DECIMAL(14,2) NULL, budget_max DECIMAL(14,2) NULL, currency CHAR(3) NULL,
  travel_start DATE NULL, travel_end DATE NULL, party_size INT NULL,
  owner_id INT NULL, branch_id INT NULL,
  stage ENUM('new','contacted','quoted','negotiating','won','lost') NOT NULL DEFAULT 'new',
  next_action VARCHAR(200) NULL, next_action_at DATE NULL, lost_reason VARCHAR(200) NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (agency_id, stage), INDEX (agency_id, owner_id), INDEX (agency_id, email)
);

CREATE TABLE activities (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  entity_type ENUM('lead','client','quote','booking') NOT NULL, entity_id INT NOT NULL,
  kind ENUM('note','call','email','meeting','system') NOT NULL DEFAULT 'note',
  body TEXT NOT NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, entity_type, entity_id, created_at)
);

CREATE TABLE tasks (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  title VARCHAR(200) NOT NULL, due_at DATE NULL, priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status ENUM('open','done','cancelled') NOT NULL DEFAULT 'open',
  owner_id INT NULL, entity_type ENUM('lead','client','quote','booking') NULL, entity_id INT NULL,
  notes VARCHAR(500) NULL, completed_at DATETIME NULL, completed_by INT NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, status, due_at), INDEX (agency_id, owner_id), INDEX (agency_id, entity_type, entity_id)
);

CREATE TABLE quotes (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL,
  quote_no VARCHAR(30) NOT NULL, title VARCHAR(200) NOT NULL,
  client_id INT NULL, lead_id INT NULL, owner_id INT NULL, branch_id INT NULL,
  status ENUM('draft','sent','accepted','declined','expired','changes_requested','converted') NOT NULL DEFAULT 'draft',
  currency CHAR(3) NOT NULL, valid_until DATE NULL,
  current_version INT NOT NULL DEFAULT 1, accepted_version INT NULL, accepted_option VARCHAR(60) NULL,
  accepted_at DATETIME NULL, accepted_by_name VARCHAR(150) NULL, accepted_ip VARCHAR(64) NULL,
  booking_id INT NULL, public_token_hash CHAR(64) NULL, public_token_expires DATETIME NULL,
  client_message VARCHAR(1000) NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_quote_no (agency_id, quote_no), UNIQUE KEY uq_quote_token (public_token_hash), INDEX (agency_id, status), INDEX (agency_id, client_id)
);

CREATE TABLE quote_versions (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, quote_id INT NOT NULL, version INT NOT NULL,
  inclusions TEXT NULL, exclusions TEXT NULL, payment_terms TEXT NULL, cancellation_terms TEXT NULL,
  internal_notes TEXT NULL,                       -- never exposed to clients
  margin_pct DECIMAL(7,2) NULL,                   -- lowest margin across options
  margin_approved_by INT NULL, margin_approved_at DATETIME NULL,
  sent_at DATETIME NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qv (quote_id, version), INDEX (agency_id, quote_id)
);

CREATE TABLE quote_components (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, quote_id INT NOT NULL, version INT NOT NULL,
  option_name VARCHAR(60) NOT NULL DEFAULT 'Option 1', sort INT NOT NULL DEFAULT 0,
  product_type ENUM('flight','hotel','package','cruise','transfer','tour','rail','car','insurance','visa','fee','other') NOT NULL,
  supplier_id INT NULL, description VARCHAR(500) NOT NULL, service_start DATE NULL, service_end DATE NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1, unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  markup_pct DECIMAL(6,2) NOT NULL DEFAULT 0, discount_pct DECIMAL(6,2) NOT NULL DEFAULT 0, tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  unit_price DECIMAL(14,2) NOT NULL, net_total DECIMAL(14,2) NOT NULL, tax_total DECIMAL(14,2) NOT NULL, cost_total DECIMAL(14,2) NOT NULL,
  INDEX (agency_id, quote_id, version)
);

CREATE TABLE booking_components (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL,
  product_type ENUM('flight','hotel','package','cruise','transfer','tour','rail','car','insurance','visa','fee','other') NOT NULL,
  supplier_id INT NULL, supplier_ref VARCHAR(80) NULL, description VARCHAR(500) NOT NULL,
  service_start DATE NULL, service_end DATE NULL, timezone VARCHAR(50) NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1, unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  markup_pct DECIMAL(6,2) NOT NULL DEFAULT 0, discount_pct DECIMAL(6,2) NOT NULL DEFAULT 0, tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  unit_price DECIMAL(14,2) NOT NULL, net_total DECIMAL(14,2) NOT NULL, tax_total DECIMAL(14,2) NOT NULL, cost_total DECIMAL(14,2) NOT NULL,
  commission_pct DECIMAL(6,2) NULL, cancellation_terms TEXT NULL,
  -- separate status dimensions, never one overloaded field
  confirmation_status ENUM('pending','requested','confirmed','waitlisted','cancelled') NOT NULL DEFAULT 'pending',
  ticketing_status ENUM('not_applicable','pending','ticketed') NOT NULL DEFAULT 'not_applicable',
  fulfilment_status ENUM('pending','in_progress','done') NOT NULL DEFAULT 'pending',
  source_quote_component_id INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, booking_id), INDEX (agency_id, service_start)
);

CREATE TABLE travellers (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, client_id INT NULL,
  first_name VARCHAR(100) NOT NULL, last_name VARCHAR(100) NOT NULL, dob DATE NULL, nationality VARCHAR(60) NULL,
  email VARCHAR(255) NULL, phone VARCHAR(50) NULL,
  passport_enc TEXT NULL, passport_last4 CHAR(4) NULL, passport_expiry DATE NULL,   -- number is AES-256 encrypted, masked in responses
  notes VARCHAR(500) NULL,                                                           -- dietary / accessibility
  emergency_contact VARCHAR(300) NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, client_id), INDEX (agency_id, last_name)
);

CREATE TABLE booking_travellers (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL, traveller_id INT NOT NULL, room_group VARCHAR(40) NULL,
  UNIQUE KEY uq_bt (booking_id, traveller_id), INDEX (agency_id, booking_id)
);

CREATE TABLE itinerary_items (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL,
  day_date DATE NULL, day_no INT NOT NULL DEFAULT 1, start_time TIME NULL, timezone VARCHAR(50) NULL,
  title VARCHAR(200) NOT NULL, description TEXT NULL, location VARCHAR(250) NULL, supplier_id INT NULL, component_id INT NULL,
  confirmed TINYINT(1) NOT NULL DEFAULT 0, sort INT NOT NULL DEFAULT 0,
  INDEX (agency_id, booking_id, day_no, sort)
);

-- Who changed what on a booking, with reason. Append-only.
CREATE TABLE booking_changes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, booking_id INT NOT NULL,
  field VARCHAR(80) NOT NULL, old_value VARCHAR(500) NULL, new_value VARCHAR(500) NULL, reason VARCHAR(300) NULL,
  user_id INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, booking_id, created_at)
);
CREATE TRIGGER booking_changes_no_update BEFORE UPDATE ON booking_changes FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_changes is append-only'; END;
CREATE TRIGGER booking_changes_no_delete BEFORE DELETE ON booking_changes FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_changes is append-only'; END;
