-- Subscription billing: plans (platform-wide), one subscription per agency, billing history and an idempotent event log.
CREATE TABLE plans (
  id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE, name VARCHAR(60) NOT NULL, description VARCHAR(200) NULL,
  price_monthly DECIMAL(10,2) NOT NULL, price_yearly DECIMAL(10,2) NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'USD', trial_days INT NOT NULL DEFAULT 14,
  max_seats INT NULL, max_branches INT NULL, max_bookings_month INT NULL,            -- NULL = unlimited
  features VARCHAR(300) NOT NULL DEFAULT '', support_level VARCHAR(30) NOT NULL DEFAULT 'email',
  stripe_price_monthly VARCHAR(80) NULL, stripe_price_yearly VARCHAR(80) NULL, active TINYINT(1) NOT NULL DEFAULT 1, sort INT NOT NULL DEFAULT 0
);
INSERT INTO plans (code, name, description, price_monthly, price_yearly, trial_days, max_seats, max_branches, max_bookings_month, features, support_level, sort) VALUES
 ('starter', 'Starter', 'For a solo agent or a very small agency', 49, 490, 14, 3, 1, 100, 'portal,accounting_export', 'email', 1),
 ('growth',  'Growth',  'For growing agencies that want automation and integrations', 149, 1490, 14, 10, 5, 1000, 'portal,accounting_export,automation,scheduled_reports,integrations,api', 'priority', 2),
 ('scale',   'Scale',   'For multi-branch agencies and host agencies', 399, 3990, 14, 50, 50, NULL, 'portal,accounting_export,automation,scheduled_reports,integrations,api', 'dedicated', 3);

CREATE TABLE subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL UNIQUE, plan_id INT NOT NULL,
  status ENUM('trialing','active','past_due','grace','suspended','cancelled') NOT NULL DEFAULT 'trialing',
  billing_interval ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  trial_ends_at DATETIME NULL, current_period_start DATETIME NULL, current_period_end DATETIME NULL, grace_until DATETIME NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0, pending_plan_id INT NULL, pending_interval ENUM('monthly','yearly') NULL,
  stripe_customer_id VARCHAR(80) NULL, stripe_subscription_id VARCHAR(80) NULL, is_manual TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (status), INDEX (stripe_customer_id), INDEX (stripe_subscription_id)
);
CREATE TABLE billing_events (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, kind VARCHAR(40) NOT NULL, detail VARCHAR(400) NULL,
  event_key VARCHAR(120) NULL,                                   -- Stripe event id, or "<kind>:<period>" for reminders: unique, so replays and re-runs do nothing
  created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_billing_event (event_key), INDEX (agency_id, created_at)
);
CREATE TABLE subscription_invoices (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, stripe_invoice_id VARCHAR(80) NOT NULL, number VARCHAR(60) NULL,
  amount DECIMAL(10,2) NOT NULL, currency CHAR(3) NOT NULL, status ENUM('paid','open','failed','void') NOT NULL, period_start DATETIME NULL, period_end DATETIME NULL,
  hosted_url VARCHAR(500) NULL, paid_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_sub_invoice (stripe_invoice_id), INDEX (agency_id, created_at)
);
-- Existing agencies get a 30-day trial of Growth so nobody is locked out by the upgrade.
INSERT INTO subscriptions (agency_id, plan_id, status, trial_ends_at) SELECT a.id, (SELECT id FROM plans WHERE code = 'growth'), 'trialing', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY) FROM agencies a;
