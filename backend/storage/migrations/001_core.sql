CREATE TABLE IF NOT EXISTS storage_mutex (id TINYINT PRIMARY KEY, CHECK (id = 1)) ENGINE=InnoDB;
INSERT IGNORE INTO storage_mutex (id) VALUES (1);
CREATE TABLE IF NOT EXISTS institutions (
 id VARCHAR(128) PRIMARY KEY, name VARCHAR(256) NOT NULL, city VARCHAR(256) NOT NULL, status VARCHAR(32) NOT NULL, position INT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS programmes (
 id VARCHAR(128) PRIMARY KEY, institution_id VARCHAR(128) NOT NULL, name VARCHAR(256) NOT NULL, level VARCHAR(64) NOT NULL, position INT NOT NULL,
 UNIQUE KEY programme_owner (id,institution_id), FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS approved_intakes (
 id VARCHAR(128) PRIMARY KEY, programme_id VARCHAR(128) NOT NULL, academic_year VARCHAR(9) NOT NULL, approved_seats INT UNSIGNED NOT NULL, counting_policy JSON NULL, position INT NOT NULL,
 UNIQUE KEY intake_programme_year (programme_id,academic_year), FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS users (
 id VARCHAR(128) PRIMARY KEY, display_name VARCHAR(256) NOT NULL, email VARCHAR(254) NOT NULL, password_hash VARCHAR(100) NOT NULL,
 role VARCHAR(32) NOT NULL, institution_id VARCHAR(128) NULL, status VARCHAR(32) NOT NULL,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, position INT NOT NULL,
 UNIQUE KEY user_email (email), KEY user_institution_status (institution_id,status),
 FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK (role IN ('institution_admin','institution_operator','regulatory_reviewer','authorized_verifier')),
 CHECK ((role IN ('institution_admin','institution_operator') AND institution_id IS NOT NULL) OR (role IN ('regulatory_reviewer','authorized_verifier') AND institution_id IS NULL)),
 CHECK (email = LOWER(TRIM(email))), CHECK (password_hash REGEXP '^\\$2[aby]\\$[0-9]{2}\\$[./A-Za-z0-9]{53}$')
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS students (
 id VARCHAR(128) PRIMARY KEY, institution_id VARCHAR(128) NOT NULL, programme_id VARCHAR(128) NOT NULL,
 apaar_id VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, student_name VARCHAR(256) NOT NULL,
 academic_year VARCHAR(9) NOT NULL, admission_year VARCHAR(4) NOT NULL, admission_category VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL,
 verification_revision VARCHAR(36) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 created_by VARCHAR(128) NOT NULL, updated_by VARCHAR(128) NOT NULL, position INT NOT NULL,
 UNIQUE KEY institution_apaar (institution_id,apaar_id), KEY student_group (institution_id,programme_id,academic_year,status),
 FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY (programme_id,institution_id) REFERENCES programmes(id,institution_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK (apaar_id REGEXP '^[0-9]{12}$'), CHECK (status IN ('active','inactive','graduated','withdrawn')),
 CHECK (admission_category IN ('general','obc','sc','st','ews','other','not_specified'))
) ENGINE=InnoDB;
