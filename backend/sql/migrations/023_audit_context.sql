-- Richer audit context. All columns are nullable and appended, so this is an instant, non-destructive change and old rows are untouched.
-- The append-only triggers block UPDATE/DELETE of rows, not schema changes.
ALTER TABLE platform_audit_log
  ADD COLUMN actor_role VARCHAR(20) NULL,
  ADD COLUMN before_json JSON NULL,
  ADD COLUMN after_json JSON NULL,
  ADD COLUMN user_agent VARCHAR(200) NULL;

ALTER TABLE audit_log
  ADD COLUMN actor_role VARCHAR(20) NULL,
  ADD COLUMN user_agent VARCHAR(200) NULL;
