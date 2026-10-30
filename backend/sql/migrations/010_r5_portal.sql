-- R5: client portal + payment links, support requests, delivery log.
CREATE TABLE portal_links (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, client_id INT NOT NULL,
  scope ENUM('portal','invoice') NOT NULL DEFAULT 'portal', invoice_id INT NULL,
  token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, revoked_at DATETIME NULL, revoked_by INT NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL, use_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_portal_token (token_hash), INDEX (agency_id, client_id)
);
CREATE TABLE support_requests (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, client_id INT NOT NULL, booking_id INT NULL, link_id INT NULL,
  subject VARCHAR(200) NOT NULL, message TEXT NOT NULL, status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open',
  response TEXT NULL, responded_by INT NULL, responded_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, status), INDEX (agency_id, client_id)
);
CREATE TABLE delivery_log (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, kind VARCHAR(30) NOT NULL, ref_table VARCHAR(40) NULL, ref_id INT NULL,
  recipient VARCHAR(255) NOT NULL, subject VARCHAR(250) NULL, status ENUM('sent','failed','skipped') NOT NULL, error VARCHAR(300) NULL,
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, created_at)
);
