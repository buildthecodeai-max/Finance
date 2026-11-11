-- Local wallet payments (JazzCash, Easypaisa): an agency pays for a plan period in PKR. One row per attempt.
-- Plans are priced in their own currency, so a plan can be paid this way only when it has a PKR price.
ALTER TABLE plans ADD COLUMN price_monthly_pkr DECIMAL(12,2) NULL, ADD COLUMN price_yearly_pkr DECIMAL(12,2) NULL;

CREATE TABLE local_payments (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, plan_id INT NOT NULL, billing_interval ENUM('monthly','yearly') NOT NULL,
  provider ENUM('jazzcash','easypaisa') NOT NULL, txn_ref VARCHAR(40) NOT NULL, amount_pkr DECIMAL(12,2) NOT NULL,
  status ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  gateway_code VARCHAR(20) NULL, gateway_message VARCHAR(300) NULL, provider_ref VARCHAR(80) NULL,
  settled_by ENUM('gateway','operator') NULL, created_by INT NULL, confirmed_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_local_txn (txn_ref), INDEX (agency_id, id), INDEX (status, id)
);
