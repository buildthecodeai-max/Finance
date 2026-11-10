-- A platform operator can switch a user's account off (sign-in refused, sessions ended) without deleting anything.
ALTER TABLE users ADD COLUMN disabled_at DATETIME NULL, ADD COLUMN disabled_reason VARCHAR(300) NULL;
