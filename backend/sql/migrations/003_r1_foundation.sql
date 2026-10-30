-- R1 SaaS foundation: branch scoping, agency settings, period locks, audit reasons, security events.
ALTER TABLE agencies ADD COLUMN timezone VARCHAR(50) NOT NULL DEFAULT 'UTC', ADD COLUMN locked_through DATE NULL;
ALTER TABLE memberships ADD COLUMN branch_id INT NULL;
ALTER TABLE audit_log ADD COLUMN reason VARCHAR(300) NULL;

CREATE TABLE period_locks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NOT NULL,
  action ENUM('lock','reopen') NOT NULL,
  locked_through DATE NULL,
  previous_locked_through DATE NULL,
  reason VARCHAR(300) NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at)
);

-- Denied cross-tenant references, failed permission checks etc. Append-only like audit_log.
CREATE TABLE security_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agency_id INT NULL,
  user_id INT NULL,
  ip VARCHAR(64) NULL,
  event VARCHAR(60) NOT NULL,
  detail VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at)
);
CREATE TRIGGER security_no_update BEFORE UPDATE ON security_events FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_events is append-only'; END;
CREATE TRIGGER security_no_delete BEFORE DELETE ON security_events FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'security_events is append-only'; END;
CREATE TRIGGER period_locks_no_update BEFORE UPDATE ON period_locks FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'period_locks is append-only'; END;
CREATE TRIGGER period_locks_no_delete BEFORE DELETE ON period_locks FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'period_locks is append-only'; END;
