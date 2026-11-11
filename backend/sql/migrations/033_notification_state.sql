-- Which notifications each person has read. The notifications themselves are worked out from live data, so only the read marks are stored.
CREATE TABLE notification_state (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, user_id INT NOT NULL, nkey VARCHAR(120) NOT NULL,
  read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_note (agency_id, user_id, nkey), INDEX (read_at)
);
