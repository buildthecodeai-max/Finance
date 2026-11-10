-- Help requests from agencies to the platform support team, with the team reply.
CREATE TABLE help_requests (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, user_id INT NOT NULL,
  category VARCHAR(20) NOT NULL DEFAULT 'question', subject VARCHAR(160) NOT NULL, message TEXT NOT NULL,
  status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open', reply TEXT NULL, replied_by INT NULL, replied_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (agency_id, created_at), INDEX (status, created_at)
);
