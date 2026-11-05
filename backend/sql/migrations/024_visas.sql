-- Visa processing: one file per applicant, tracked from document collection to the decision.
CREATE TABLE visa_applications (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, reference VARCHAR(30) NOT NULL,
  client_id INT NOT NULL, booking_id INT NULL, traveller_id INT NULL, supplier_id INT NULL,   -- supplier = visa agent / embassy account
  applicant_name VARCHAR(200) NOT NULL, passport_no VARCHAR(30) NULL, nationality VARCHAR(60) NULL,
  country VARCHAR(80) NOT NULL, visa_type VARCHAR(40) NOT NULL DEFAULT 'tourist', entry_type ENUM('single','multiple') NOT NULL DEFAULT 'single',
  status ENUM('docs_pending','docs_received','submitted','in_process','approved','rejected','collected','cancelled') NOT NULL DEFAULT 'docs_pending',
  submitted_on DATE NULL, expected_on DATE NULL, decided_on DATE NULL,
  visa_number VARCHAR(60) NULL, valid_from DATE NULL, valid_until DATE NULL, embassy_ref VARCHAR(80) NULL,
  currency CHAR(3) NOT NULL, cost DECIMAL(14,2) NOT NULL DEFAULT 0, price DECIMAL(14,2) NOT NULL DEFAULT 0,   -- cost = embassy/agent fee, price = charged to the client
  notes TEXT NULL, owner_id INT NULL, branch_id INT NULL, created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visa_ref (agency_id, reference), INDEX (agency_id, status), INDEX (agency_id, client_id), INDEX (agency_id, booking_id), INDEX (agency_id, valid_until)
);
CREATE TABLE visa_events (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, visa_id INT NOT NULL, status VARCHAR(30) NOT NULL, note VARCHAR(300) NULL, user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, visa_id)
);
