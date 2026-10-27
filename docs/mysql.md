# Phase 9 local MySQL migration

MySQL is explicitly authorized in this phase. The existing JSON files remain unchanged and are not automatically imported. Select the adapter through `STORAGE_DRIVER`; no connection failure falls back to JSON. React/REST contracts, bcrypt hashes, scoped roles, CSRF, sessions, compliance rules, Python features and dedicated QR HMAC semantics are preserved. Official APAAR authenticity remains unverified.

## Audited schemas and relationships

The audit covered every `readCollection`, `writeCollection`, `updateCollection` and `withCollectionLock` caller, seeds, both HTTP smoke scripts, the Chrome harness, private QR revisions, and the actual evaluation/artifact envelopes. Existing collections map as follows:

| Collection | SQL storage and constraints |
| --- | --- |
| institutions | `institutions`: stable string ID, name/city/status; referenced IDs cannot be deleted/renamed while in use |
| programmes | `programmes`: institution FK, name/level; `(id,institution_id)` owner key |
| approved-intakes | `approved_intakes`: programme FK, academic-year text, unsigned seats, nullable JSON counting policy; unique programme/year |
| users | `users`: stable ID, display name, unique normalized email, bcrypt hash, role/status, nullable institution FK and UTC timestamps; institution roles require an institution and other roles do not have one |
| students | `students`: original fields/audit metadata plus nullable private edit revision; APAAR is 12-character text preserving leading zeroes; unique `(institution_id,apaar_id)`; composite programme/institution FK enforces ownership; actor FKs reference users |
| validation-issues | `compliance_evaluations` plus `compliance_findings`: one latest evaluation per institution, actor/time/engine/fingerprint/summary and ordered findings, cascade only from replaced evaluation to its findings |
| verification-records | `verification_records`: opaque artifact ID, student/institution/actor FKs, private fingerprint, public claims (no MAC/key), timestamps/status/revoker; restrictive deletion preserves audit references |
| enrolments, audit-logs | Reserved by earlier phases, with no active application model/callers; preserve explicitly supplied legacy objects in `legacy_records`, without inventing enrolment/counting or audit semantics |
| unrelated legacy issue/artifact entries | Also preserved in `legacy_records`, tagged by approved collection, with stable digest key and logical array position |

Supporting tables: `schema_migrations` (ordered SHA-256 migration ledger), `storage_mutex` (transaction gate), and `json_imports` (source digest/time/counts). There are indexes for institution/status, programme/year/status, institution-scoped severity/rule findings and student/status artifacts. Keys use the database's required `utf8mb4_0900_bin` collation so case-sensitive identifiers match JavaScript behavior. Connection encoding uses `UTF8MB4_BIN` for compatibility with the driver's one-byte handshake collation ID; table collation remains `utf8mb4_0900_bin`.

Most fields are mapped to real typed columns. Only genuinely structured fields (intake policies, summary, claims, finding record-ID arrays/envelopes and undefined legacy objects) use JSON. Dates use `DATETIME(3)` in UTC and return ISO text. Stable IDs and hashes are preserved. API field allowlists remain unchanged; the QR revision stays private. Findings' full documented minimal envelope is retained with typed indexed projections; unexpected fields or cross-institution finding envelopes are rejected. Legacy/audit JSON cannot carry named signing/session/service/password secrets, and configured secret values are rejected by the adapter.

Current APIs do not delete institutions, users, programmes or students. SQL uses `RESTRICT` rather than cascading away source data, students or issued artifacts. An operator must retain referenced history or design an explicit later retention workflow. JSON can contain malformed or ambiguous manual legacy rows that SQL deliberately refuses: duplicate institution APAAR, duplicate intake programme/year, orphan references, missing required audit metadata, unsupported fields, malformed hashes or duplicate IDs must be reviewed before import. Nothing is silently discarded or converted into official identity assurance.

## Migrations and transaction boundaries

`001_core.sql` creates the gate, reference, account and student tables. `002_evaluations_artifacts.sql` creates evaluations/findings, artifacts, legacy storage and import tracking. `db:migrate` uses a database-scoped advisory lock and checksums; applied migrations must remain an exact prefix of the checked-in ordered files. Runtime startup checks the full ledger; it does not run DDL or seed/import data.

MySQL DDL implicitly commits: migration statements are restartable `CREATE TABLE IF NOT EXISTS`/seed statements, with the ledger entry written after the complete file succeeds. DDL is not claimed to roll back as one transaction. On interrupted DDL, stop application traffic, inspect the partial schema and rerun the same unmodified migration. Do not edit an applied file or fake its ledger checksum; add a new versioned migration. Back up before structural changes.

Student creates/PATCH, CSV batches, actor checks and revision updates are transactional. Constraints arbitrate duplicate races even across adapter instances. Compliance envelope/findings replacement is atomic. QR issuance/version checks/revocation coordinate through the same database transaction gate. SQL seeding is atomic. The coarse gate and share locks intentionally favor correctness over throughput. See [storage-interface.md](storage-interface.md).

Deadlocks/lock timeouts roll back, return safe 503 and require an explicit retry after checking state. Unexpected outages also return 503; reconnection uses a fresh pool connection. Callbacks are not automatically replayed. Connection loss around COMMIT or an HTTP response can still leave an uncertain completed action: inspect students/latest evaluation/artifact status before retrying. CSV previews and sessions remain process-local and are lost on application restart. The health route remains process liveness; startup migration validation and successful data requests are separate readiness evidence.

## Local installation and least-privilege setup

Use a current **MySQL 8.4 LTS** Community release for a new local installation. Follow the [official Windows installation instructions](https://dev.mysql.com/doc/refman/8.4/en/windows-install-archive.html). This machine already had **MySQL 8.0.36** binaries, which were reused for an isolated test instance; its existing Windows service/database was not changed. The old installed version is test evidence, not a recommendation to run an unpatched server or expose it on a network.

For your normal local instance, bind MySQL to loopback, disable unnecessary remote accounts, and log into the administrative MySQL client with `mysql -u root -p`. Choose separate local credentials interactively. Example SQL, replacing placeholders **inside your local admin session**:

```sql
CREATE DATABASE eduverify_local CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE USER 'eduverify_migrator'@'localhost' IDENTIFIED BY '<choose-local-migration-password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON eduverify_local.* TO 'eduverify_migrator'@'localhost';
CREATE USER 'eduverify_app'@'localhost' IDENTIFIED BY '<choose-different-local-app-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON eduverify_local.* TO 'eduverify_app'@'localhost';
```

Do not commit actual SQL passwords. Runtime has no CREATE/ALTER/DROP/TRIGGER privileges; migration credentials are used only by the explicit CLI, never the API pool. Use a separate admin/backup role for restore/export operations. Keep the server local: current configuration rejects remote hosts. A future network deployment must add verified TLS, host/account restrictions and a separate deployment review rather than removing this restriction.

From project root in PowerShell:

```powershell
cd backend
npm ci --cache .npm-cache
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Edit ignored .env: STORAGE_DRIVER=mysql; MYSQL_HOST=127.0.0.1;
# MYSQL_PORT=3306; MYSQL_DATABASE=eduverify_local; MYSQL_USER=eduverify_app.
$dbCredential = Get-Credential -UserName 'eduverify_app' -Message 'Enter the local application DB password'
$env:MYSQL_PASSWORD = $dbCredential.GetNetworkCredential().Password
Remove-Variable dbCredential
$migrationCredential = Get-Credential -UserName 'eduverify_migrator' -Message 'Enter the migration DB password'
$env:MYSQL_MIGRATION_USER = $migrationCredential.UserName
$env:MYSQL_MIGRATION_PASSWORD = $migrationCredential.GetNetworkCredential().Password
Remove-Variable migrationCredential
npm run db:migrate
Remove-Item Env:MYSQL_MIGRATION_USER, Env:MYSQL_MIGRATION_PASSWORD
npm run seed:demo
# Use the README's DEMO_ACCOUNT_PASSWORD prompt before running:
npm run seed:accounts
$env:APP_ORIGIN = 'http://127.0.0.1:5173'
npm run dev
```

Do not copy over an existing `.env`. Passwords have no default and must remain in ignored environment configuration; `MYSQL_MIGRATION_USER`/`MYSQL_MIGRATION_PASSWORD` are optional CLI overrides, not required runtime secrets. `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, and `MYSQL_PASSWORD` must all be explicitly configured for MySQL. No database/account is auto-created by app startup. Startup fails safely if configuration/connection/schema validation fails. `STORAGE_DRIVER=json` is an explicit local fallback using the original data directory; production-mode startup refuses it.

Keep `SESSION_SECRET`, `ML_SERVICE_KEY` and `QR_SIGNING_KEYS` independent of the database password. QR configuration rejects direct reuse of the current DB password as well as session/ML keys. Signing keys are not stored in MySQL. Existing hashes and dedicated HMAC design remain intact.

Startup order: local MySQL → explicit schema migration and chosen demo seeding/import → Python ML with its existing offline artifact/key → Express with separate DB/ML/QR configuration and exact UI origin → Vite. Python may be omitted for student/compliance/QR use; ML then fails explicitly. Use the earlier README frontend/Python commands. No frontend `VITE_*` variable may hold DB credentials.

## Explicit JSON backup/import

Stop JSON writers before backup/import. Use only fictional source data. The utility reads **only the nine approved collection filenames**, not other exports/test/model/dataset files in the directory. Missing files mean empty collections; malformed roots/records fail. It never writes to source files. Backup and source directories must be explicit, distinct, project-relative paths.

From `backend/`, with MySQL configuration/migrations ready:

```powershell
# Ensure the parent directory exists; choose a NEW unused backup folder.
New-Item -ItemType Directory -Force ../data/backups | Out-Null
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --create-backup
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --dry-run
# Inspect counts. Applying is a separate explicit action:
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --apply --fictional-data
```

Directory arguments resolve from the project root even when the command runs in `backend/`. The backup manifest records each known source-file hash (including absence); the importer verifies both current source and backup bytes. A changed source/backup requires a new reviewed backup. The backup command refuses an existing destination. Backups include sensitive hashes/fictional records and must stay ignored/protected locally.

Dry run executes actual target inserts/constraints inside a transaction and rolls it back, reporting `wouldImport`, `skipped` and `rejected`; `imported` stays zero. Apply requires `--apply --fictional-data`. The operator's fictional-data assertion is not an automated way to determine whether identities are real. Imports follow FK dependency order, preserve IDs/bcrypt hashes, normalize equivalent timestamps to UTC ISO and commit the entire batch or none. Invalid/conflicting targets reject the batch with safe counts; no rows are silently dropped or overwritten. Existing identical IDs/records are skipped; changed records under the same ID reject. `json_imports` records a successful source digest/count summary, while reruns still compare current target content. A skipped count means an exact normalized match, not authenticity.

No normal `data/local/` import was executed during implementation. Only isolated fictional test fixtures were explicitly backed up, dry-run, imported and rerun to verify this utility. Original runtime hashes stayed unchanged. Preserve the files after cutover; reverting to JSON does not copy later SQL changes back. Reconcile data explicitly before changing adapters.

## SQL backup/restore

Stop application writers for the reviewed local backup procedure, retain dedicated QR keys separately, and create an ignored output directory. With appropriate local backup credentials, from project root:

```powershell
New-Item -ItemType Directory -Force .local/backups | Out-Null
mysqldump -h 127.0.0.1 -P 3306 -u root -p --single-transaction --no-tablespaces --set-gtid-purged=OFF --result-file=.local/backups/eduverify.sql eduverify_local
```

The prompt keeps the password out of command history. The dump contains hashes/records; protect it. No plaintext application password or QR signing key belongs in tables/dumps. For restore, create a **separate empty** database with the same binary collation using an authorized local administrator, then use the MySQL client's `SOURCE` command:

```sql
CREATE DATABASE eduverify_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
USE eduverify_restore;
SOURCE .local/backups/eduverify.sql;
```

Run the client from the project root so the source path resolves correctly. Check the migration ledger, counts, constraints and verification states before selecting that database in the backend. Never restore destructively over a live database as an automatic recovery step. Restoring older data can reverse revocations/edits; reconcile that history and signing-key availability before trusting restored QR status.

Phase 10 executed a real `mysqldump`/`mysql` restore drill against two separate generated disposable databases. All nine logical collections and 12 table counts, key relationships, fresh compliance and valid/outdated/revoked QR states matched. Run `npm run acceptance:restore` from `backend/` with `ALLOW_MYSQL_TESTS=1` and the project test server ready to repeat it. Neither the normal application database nor source JSON is selected by that helper. See [final acceptance](final-acceptance.md). This is not a crash/power-loss test or a restore of a deployed installation.

## Isolated database verification

The optional helper reuses an installed `mysqld` binary, creates **only** ignored `.local/mysql/` files, binds port 33307 on loopback, disables X protocol/local infile, and generates separate credentials without printing them. It does not install a Windows service or touch existing MySQL data. Its private config is `.local/mysql/test-config.json`. An already installed binary must be discoverable as `mysqld` or supplied through `MYSQLD_PATH`; all data paths remain project-relative. This helper is for isolated tests, not production provisioning. Protect its private directory with OS access controls (Windows ACLs as applicable).

```powershell
# From project root:
cd backend
npm run db:test-server
$env:ALLOW_MYSQL_TESTS = '1'
npm test
npm run test:mysql
$env:SMOKE_STORAGE_DRIVER = 'mysql'
npm run smoke:ml
cd ../frontend
npm test
npm run build
npm run smoke:local
npm run test:e2e
# Stop only the helper's verified project-local instance after tests:
cd ../backend
npm run db:test-server -- stop
```

Without `ALLOW_MYSQL_TESTS=1`, the MySQL integration cases are explicitly skipped by the ordinary backend command, not counted as SQL verification. The phase handoff reports runs where they were enabled. `SMOKE_STORAGE_DRIVER=mysql` makes both existing smoke scripts and the browser harness create separate random `eduverify_test_<hex>` databases; no smoke uses the configured normal application database. Missing test configuration is an error, never JSON fallback. Test helpers validate database names and delete only their own generated schemas; they also close pools and local services. JSON adapter tests remain separate and unchanged in purpose. The foundation HTTP test now injects JSON explicitly rather than relying on an implicit backend default.

## Limitations and evidence

The prototype keeps its array-shaped persistence interface and a coarse database transaction gate, which limits throughput and loads whole collections. This is correct local prototype behavior, not a production scaling claim. SQL snapshots are transactionally consistent for cooperating adapter operations; privileged manual modifications to arbitrary finding/legacy JSON or bypassing application invariants remain outside the API trust model. Session/previews/rate limits are still in memory. No Python network request is inside a DB transaction. No exactly-once response, automated failover, key recovery, SQL server upgrade, remote TLS deployment, backup rollback protection or real APAAR integration is claimed.

Executed Phase 9 verification:

| Check | Actual result |
| --- | --- |
| Full backend with `ALLOW_MYSQL_TESTS=1` | **257 passed / 13 suites**, including the original 242 tests and 15 new configuration/MySQL cases |
| Final targeted `test:mysql` run | **15 passed**, including real environment-configured backend startup and CLI backup/dry-run/apply |
| Frontend Vitest | **42 passed / 3 files** |
| Python pytest / pip check | **30 passed**; one existing Starlette/AnyIO deprecation warning; no broken requirements |
| Production frontend build | Passed |
| `smoke:local` with MySQL selected | Passed against a generated isolated SQL database |
| `smoke:ml` with MySQL selected | Passed with real Python inference and SQL-backed Express |
| Complete Chrome/Vite/Express/Python workflow with MySQL | Passed, exit code 0 including cleanup; new adapter/application instance retained records and QR status |
| Backend dependency audit after MySQL2 install | Zero advisories; driver resolved to **mysql2 3.24.6** |

The import fixture contained **14 logical records**: two institutions, two programmes, two intakes, five bcrypt-hashed users, one student, one compliance evaluation and one issued artifact, plus one derived finding row. Its real CLI backup and dry run succeeded without persisted target rows; apply preserved IDs/hashes and the original QR verified against the imported snapshot. Reruns skipped identical records. Changed target data, invalid UUIDs/references, duplicate IDs, plaintext-password hashes and modified backups were rejected without partial persistence. An unrelated generated-data file was not imported. Only test fixtures were migrated; the original `.gitkeep` and three runtime JSON file hashes matched the pre-change values.

Database tests also exercised independent-adapter duplicate races, simultaneous student updates, constraint/permission checks, a real mid-CSV trigger failure/retry, finding and artifact write/revocation failures, a killed database connection with rollback/reconnection, real lock timeout, and permission-row locking. A deadlock code is classified safely; an actual deadlock victim-selection scenario was not forced. No server crash/power-loss, normal-user cutover or dump/restore drill was executed. Application/pool restart and reconnect were demonstrated, not automated multi-node failover.

Initial npm registry access was sandbox-blocked and succeeded on an approved retry. The first driver handshake rejected a high-numbered connection collation; using the compatible UTF8MB4_BIN connection encoding fixed it while retaining the database binary collation. The first SQL test run exposed FK-dependent import ordering and a server/driver FK-error-name difference; both were fixed and rerun. An incomplete early fixture was cleaned only after verifying the project-owned server path, empty records and no active connections. All generated test schemas were removed, the project instance was stopped, and the existing Windows `MySQL80` service remained running.

Changed/new files are under `backend/storage/` (factory, MySQL adapter/config/model, SQL migrations/runner, verified JSON import and isolated fixture helpers), `backend/scripts/` (migration/import/test-instance utilities and selected-adapter seeds/smoke), `backend/test/mysql.test.js`, explicit JSON injection in the original foundation test, narrow transaction integration in `backend/server.js`/`compliance/service.js`, dedicated-key reuse checks, backend package/lock/environment example, the frontend smoke/browser harnesses, ignore rules, `AGENTS.md`, README and phase-specific API/storage guides. Frontend application screens, Python model/service behavior, existing JSON-adapter assertions and role permissions were preserved.

No blocking issue remains for the verified local prototype. Normal-user database provisioning/import is deliberately an explicit operator action. The already installed 8.0.36 instance was isolated for verification; use a current compatible LTS security release for new setups. The new schema was not installed into or tested against the machine's pre-existing normal database/service data.
