-- R6: scheduled reports, exception queue, automation rules.
CREATE TABLE report_schedules (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(120) NOT NULL, report VARCHAR(40) NOT NULL,
  range_kind ENUM('last_30d','mtd','last_month','ytd') NOT NULL DEFAULT 'last_month',
  frequency ENUM('daily','weekly','monthly') NOT NULL, weekday TINYINT NULL, day_of_month TINYINT NULL,
  recipients VARCHAR(600) NOT NULL, format ENUM('csv','xlsx','pdf') NOT NULL DEFAULT 'csv', active TINYINT(1) NOT NULL DEFAULT 1,
  next_run_at DATE NOT NULL, last_run_at DATETIME NULL, last_status VARCHAR(20) NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, active, next_run_at)
);
CREATE TABLE report_runs (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, schedule_id INT NOT NULL, run_key VARCHAR(40) NOT NULL,
  status ENUM('running','ok','failed') NOT NULL DEFAULT 'running', file_key VARCHAR(300) NULL, row_count INT NULL, reconciled TINYINT(1) NULL, error VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_report_run (schedule_id, run_key), INDEX (agency_id, schedule_id)
);
CREATE TABLE exceptions (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, kind VARCHAR(40) NOT NULL, ref_table VARCHAR(40) NOT NULL, ref_id INT NOT NULL,
  severity ENUM('info','warn','critical') NOT NULL, title VARCHAR(250) NOT NULL, detail VARCHAR(500) NULL, amount DECIMAL(14,2) NULL,
  status ENUM('open','acknowledged','snoozed','resolved') NOT NULL DEFAULT 'open', snoozed_until DATE NULL, note VARCHAR(300) NULL, handled_by INT NULL,
  first_seen DATETIME NOT NULL, last_seen DATETIME NOT NULL, resolved_at DATETIME NULL,
  UNIQUE KEY uq_exception (agency_id, kind, ref_table, ref_id), INDEX (agency_id, status, severity)
);
CREATE TABLE automation_rules (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, name VARCHAR(120) NOT NULL,
  trigger_kind ENUM('invoice_overdue','quote_expiring','departure_upcoming','bill_due') NOT NULL, days INT NOT NULL DEFAULT 0,
  action ENUM('create_task','email_client') NOT NULL, task_priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal', message VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, active)
);
CREATE TABLE automation_runs (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, rule_id INT NOT NULL, ref_table VARCHAR(40) NOT NULL, ref_id INT NOT NULL,
  status ENUM('done','failed','skipped') NOT NULL, attempts INT NOT NULL DEFAULT 1, detail VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_auto (rule_id, ref_table, ref_id), INDEX (agency_id, created_at)
);
