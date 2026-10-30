-- Operator roles, step-up re-authentication, and TOTP replay protection.
ALTER TABLE users
  ADD COLUMN platform_role ENUM('readonly','support','billing','admin') NULL,
  ADD COLUMN platform_stepup_at DATETIME NULL,
  ADD COLUMN totp_last_step BIGINT NULL;
UPDATE users SET platform_role = 'admin' WHERE is_platform_admin = 1;   -- existing operators keep full access
