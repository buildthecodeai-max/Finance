-- Platform-wide settings an operator can change from the console, stored encrypted. Used first for the AI provider key.
CREATE TABLE platform_settings (
  k VARCHAR(60) NOT NULL PRIMARY KEY, v_enc TEXT NOT NULL, hint VARCHAR(20) NULL,           -- hint = the last few characters, so the console can show which key is in use without ever showing the key
  updated_by INT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
