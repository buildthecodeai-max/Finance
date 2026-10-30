-- Record management: archive instead of destroying records that finance depends on.
ALTER TABLE clients   ADD COLUMN archived_at DATETIME NULL, ADD COLUMN archived_by INT NULL, ADD INDEX idx_clients_arch (agency_id, archived_at);
ALTER TABLE suppliers ADD COLUMN archived_at DATETIME NULL, ADD COLUMN archived_by INT NULL, ADD INDEX idx_suppliers_arch (agency_id, archived_at);
ALTER TABLE bookings  ADD COLUMN archived_at DATETIME NULL, ADD COLUMN archived_by INT NULL, ADD COLUMN archive_reason VARCHAR(300) NULL, ADD INDEX idx_bookings_arch (agency_id, archived_at);
