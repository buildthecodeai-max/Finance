-- Umrah / group packages: a departure with a roster of pilgrims, tracked through visa and travel-document readiness.
CREATE TABLE umrah_groups (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, reference VARCHAR(30) NOT NULL, name VARCHAR(150) NOT NULL,
  departure_date DATE NOT NULL, return_date DATE NOT NULL, nights_makkah INT NOT NULL DEFAULT 0, nights_madinah INT NOT NULL DEFAULT 0,
  hotel_makkah VARCHAR(150) NULL, hotel_madinah VARCHAR(150) NULL, airline VARCHAR(100) NULL, flight_info VARCHAR(200) NULL,
  capacity INT NOT NULL DEFAULT 0, currency CHAR(3) NOT NULL, cost_per_pax DECIMAL(14,2) NOT NULL DEFAULT 0, price_per_pax DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('open','closed','departed','completed','cancelled') NOT NULL DEFAULT 'open', notes TEXT NULL,
  owner_id INT NULL, branch_id INT NULL, created_by INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_umrah_ref (agency_id, reference), INDEX (agency_id, departure_date), INDEX (agency_id, status)
);
CREATE TABLE umrah_pilgrims (
  id INT AUTO_INCREMENT PRIMARY KEY, agency_id INT NOT NULL, group_id INT NOT NULL, client_id INT NOT NULL,   -- client = who pays
  traveller_id INT NULL, visa_id INT NULL, name VARCHAR(200) NOT NULL, passport_no VARCHAR(30) NULL, passport_expiry DATE NULL, dob DATE NULL,
  gender ENUM('male','female') NULL, room_type ENUM('single','double','triple','quad') NOT NULL DEFAULT 'quad', room_no VARCHAR(20) NULL,
  status ENUM('registered','confirmed','cancelled') NOT NULL DEFAULT 'registered', notes VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (agency_id, group_id), INDEX (agency_id, client_id)
);
