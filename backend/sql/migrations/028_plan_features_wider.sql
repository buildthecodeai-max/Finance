-- Plans can carry any number of custom features and sub-features ("Reports > Excel export"), so the list needs more room.
ALTER TABLE plans MODIFY features VARCHAR(1500) NOT NULL DEFAULT '';
