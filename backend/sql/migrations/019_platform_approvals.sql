-- Two-person approval for high-impact operator actions (currently: suspending a customer).
CREATE TABLE platform_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY, action ENUM('suspend') NOT NULL, agency_id INT NOT NULL, reason VARCHAR(300) NOT NULL,
  requested_by INT NOT NULL, requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL,
  status ENUM('pending','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'pending',
  decided_by INT NULL, decided_at DATETIME NULL, decision_note VARCHAR(300) NULL,
  INDEX (status, expires_at), INDEX (agency_id, status)
);
