-- SMS notifications: per-agency Twilio credentials (encrypted) and a log of every text sent.
CREATE TABLE sms_settings (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, provider VARCHAR(20) NOT NULL DEFAULT 'twilio', config_enc TEXT NOT NULL,   -- {sid, token, from} as AES-GCM ciphertext
  default_cc VARCHAR(6) NULL, updated_by INT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_sms_agency (agency_id)
);
CREATE TABLE sms_log (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, to_number VARCHAR(20) NOT NULL, body VARCHAR(500) NOT NULL, status ENUM('sent','failed') NOT NULL, error VARCHAR(300) NULL,
  provider_ref VARCHAR(60) NULL, client_id INT NULL, entity_type VARCHAR(20) NULL, entity_id INT NULL, user_id INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at), INDEX (agency_id, client_id)
);
