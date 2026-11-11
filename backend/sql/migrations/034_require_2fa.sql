-- A platform operator can require a person to use two-factor sign-in. Until they have set it up they cannot use the app.
ALTER TABLE users ADD COLUMN totp_required TINYINT(1) NOT NULL DEFAULT 0;
