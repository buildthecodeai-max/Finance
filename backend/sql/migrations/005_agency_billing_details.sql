-- Agency tax registration and bank details printed on invoices.
ALTER TABLE agencies
  ADD COLUMN tax_number VARCHAR(40) NULL,
  ADD COLUMN bank_name VARCHAR(100) NULL,
  ADD COLUMN bank_account_name VARCHAR(150) NULL,
  ADD COLUMN bank_account_number VARCHAR(40) NULL,
  ADD COLUMN bank_routing VARCHAR(30) NULL,      -- BSB / sort code / ABA routing
  ADD COLUMN bank_iban VARCHAR(40) NULL,
  ADD COLUMN bank_swift VARCHAR(15) NULL,
  ADD COLUMN payment_instructions VARCHAR(500) NULL;
