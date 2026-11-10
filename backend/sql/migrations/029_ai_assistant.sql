-- AI assistant. A platform operator decides per agency: follow the plan (default), always on, or off, and may cap monthly use.
ALTER TABLE agencies ADD COLUMN ai_access VARCHAR(8) NOT NULL DEFAULT 'plan', ADD COLUMN ai_monthly_limit INT NULL;
-- One row per AI request, for the monthly limit and for showing usage to the operator. No prompts or answers are stored.
CREATE TABLE ai_usage (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, user_id INT NULL, kind VARCHAR(20) NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0, output_tokens INT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at)
);
-- Growth and Scale include it; Starter does not.
UPDATE plans SET features = CONCAT(features, ',ai_assistant') WHERE code IN ('growth', 'scale') AND FIND_IN_SET('ai_assistant', features) = 0;
