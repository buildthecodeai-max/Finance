-- Module-level access control on plans.
-- allowed_modules: comma-separated module codes. NULL = all modules allowed (backward-compatible).
-- Module codes: crm, ticketing, finance, accounting, insights
-- overview and administration groups are always visible regardless of this setting.
ALTER TABLE plans ADD COLUMN allowed_modules TEXT NULL COMMENT 'comma-separated module codes; NULL = all modules';
