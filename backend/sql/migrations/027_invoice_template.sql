-- Which invoice design the agency uses for client-facing invoices (booking invoices and ticket invoices).
-- Existing agencies keep the look they have today ('classic').
ALTER TABLE agencies ADD COLUMN invoice_template VARCHAR(20) NOT NULL DEFAULT 'classic';
