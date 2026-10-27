CREATE TABLE IF NOT EXISTS compliance_evaluations (
 id VARCHAR(128) PRIMARY KEY, kind VARCHAR(32) NOT NULL, schema_version INT NOT NULL,
 institution_id VARCHAR(128) NOT NULL, evaluated_at DATETIME(3) NOT NULL, evaluated_by VARCHAR(128) NOT NULL,
 input_fingerprint CHAR(64) NOT NULL, engine_version VARCHAR(64) NOT NULL, summary JSON NOT NULL, position INT NOT NULL,
 UNIQUE KEY latest_institution (institution_id), FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT,
 FOREIGN KEY (evaluated_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS compliance_findings (
 evaluation_id VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, rule_code VARCHAR(64) NOT NULL, severity VARCHAR(16) NOT NULL,
 institution_id VARCHAR(128) NOT NULL, programme_id VARCHAR(128) NULL, academic_year VARCHAR(9) NULL, document JSON NOT NULL, position INT NOT NULL,
 PRIMARY KEY (evaluation_id,id), KEY scoped_findings (institution_id,severity,programme_id,academic_year), KEY rule_lookup (institution_id,rule_code),
 FOREIGN KEY (evaluation_id) REFERENCES compliance_evaluations(id) ON DELETE CASCADE,
 FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT,
 CHECK (severity IN ('info','warning','critical'))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS verification_records (
 id VARCHAR(128) PRIMARY KEY, kind VARCHAR(32) NOT NULL, schema_version INT NOT NULL,
 student_id VARCHAR(128) NOT NULL, institution_id VARCHAR(128) NOT NULL, record_version CHAR(64) NOT NULL,
 claims JSON NOT NULL, issued_by VARCHAR(128) NOT NULL, issued_at DATETIME(3) NOT NULL, status VARCHAR(16) NOT NULL,
 revoked_at DATETIME(3) NULL, revoked_by VARCHAR(128) NULL, position INT NOT NULL,
 KEY artifact_student (student_id,status), KEY artifact_institution (institution_id,status),
 FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT,
 FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE RESTRICT,
 FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE RESTRICT,
 FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE RESTRICT,
 CHECK (status IN ('active','revoked')), CHECK ((status='active' AND revoked_at IS NULL AND revoked_by IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS legacy_records (
 collection VARCHAR(32) NOT NULL, record_key CHAR(64) NOT NULL, document JSON NOT NULL, position INT NOT NULL,
 PRIMARY KEY (collection,record_key), CHECK (collection IN ('validation-issues','verification-records','enrolments','audit-logs'))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS json_imports (
 source_digest CHAR(64) PRIMARY KEY, imported_at DATETIME(3) NOT NULL, counts JSON NOT NULL
) ENGINE=InnoDB;
