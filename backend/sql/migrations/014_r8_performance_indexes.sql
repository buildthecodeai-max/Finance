-- R8: indexes found missing by scripts/loadtest.ts (20k invoices): client lookups scanned the whole invoices table.
ALTER TABLE invoices ADD INDEX idx_inv_client (agency_id, client_id, status), ADD INDEX idx_inv_booking (agency_id, booking_id), ADD INDEX idx_inv_issue (agency_id, issue_date);
ALTER TABLE payments ADD INDEX idx_pay_client (agency_id, client_id), ADD INDEX idx_pay_supplier (agency_id, supplier_id);
ALTER TABLE vouchers ADD INDEX idx_voucher_date (agency_id, voucher_date);
ALTER TABLE supplier_bills ADD INDEX idx_bill_supplier (agency_id, supplier_id);
ALTER TABLE booking_components ADD INDEX idx_bc_booking (agency_id, booking_id);
