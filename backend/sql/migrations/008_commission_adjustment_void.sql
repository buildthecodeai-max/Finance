ALTER TABLE commission_adjustments MODIFY status ENUM('open','approved','paid','void') NOT NULL DEFAULT 'open';
