-- Platform operator console: operator flag, append-only operator audit, read-only support sessions, billing holds.
ALTER TABLE users ADD COLUMN is_platform_admin TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN platform_hold TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN hold_reason VARCHAR(300) NULL;

CREATE TABLE platform_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, admin_user_id INT NOT NULL, action VARCHAR(60) NOT NULL, agency_id INT NULL, detail VARCHAR(600) NULL, reason VARCHAR(300) NULL, ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, created_at), INDEX (admin_user_id, created_at)
);
CREATE TRIGGER platform_audit_no_update BEFORE UPDATE ON platform_audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_audit_log is append-only'; END;
CREATE TRIGGER platform_audit_no_delete BEFORE DELETE ON platform_audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_audit_log is append-only'; END;

CREATE TABLE support_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY, admin_user_id INT NOT NULL, agency_id INT NOT NULL, reason VARCHAR(300) NOT NULL, expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL, revoked_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, created_at), INDEX (admin_user_id)
);
