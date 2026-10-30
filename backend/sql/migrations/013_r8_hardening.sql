-- R8: login throttling, refresh-token theft detection, job heartbeats.
CREATE TABLE login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY, email_hash CHAR(64) NOT NULL, ip VARCHAR(64) NULL, success TINYINT(1) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_login (email_hash, created_at), INDEX idx_login_ip (ip, created_at)
);
ALTER TABLE refresh_tokens ADD COLUMN revoked_at DATETIME NULL, ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE system_state (
  k VARCHAR(60) PRIMARY KEY, v VARCHAR(300) NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
