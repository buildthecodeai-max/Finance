-- External import → real invoices and ledger. Each imported sale is linked to the invoice (and its voucher) it created.
ALTER TABLE ext_txns ADD COLUMN invoice_id INT NULL, ADD COLUMN credit_note_id INT NULL, ADD COLUMN voucher_id INT NULL, ADD INDEX (agency_id, invoice_id);
ALTER TABLE ext_batches ADD COLUMN posted_invoices INT NOT NULL DEFAULT 0, ADD COLUMN posted_credits INT NOT NULL DEFAULT 0, ADD COLUMN not_posted JSON NULL;
