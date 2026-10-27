# EduVerify Intelligence

Local-only prototype foundation for SIH26263: APAAR ID-based student-data management and verification.

> Privacy rule: this repository must contain fictional demo data only. Never add real student data or real APAAR IDs.

## Current status

Phase 10 is complete: final MySQL-backed regression, both HTTP smoke tests, the complete Chrome workflow (including ML failure/recovery), disposable dump/restore and demo-launcher checks passed. This remains a local fictional-data prototype, not production certification or official APAAR verification. Start with the [final acceptance evidence](docs/final-acceptance.md), [repeatable SIH demo and installation/troubleshooting](docs/sih-demo.md), [submission brief](docs/submission.md), [architecture/data flow](docs/architecture.md), and [API summary](docs/api-summary.md). The [MySQL setup guide](docs/mysql.md) and [storage interface](docs/storage-interface.md) describe normal local configuration; no existing JSON is automatically imported or deleted.

## Planned structure

```text
EduVerify/
├── frontend/             # React + JavaScript + Vite
├── backend/              # Node.js + Express REST API
├── ml-service/           # Python + FastAPI + pandas + NumPy + scikit-learn
├── data/
│   ├── demo/             # Committable fictional fixtures
│   └── local/            # Runtime JSON storage; ignored by Git
├── docs/                 # Design and API documentation
├── AGENTS.md             # Engineering and safety rules
└── .gitignore
```

## Technology decisions

- Frontend: React, JavaScript, Vite
- Backend: Node.js, Express, REST APIs
- Persistence: explicitly configured local MySQL; JSON retained for isolated tests and controlled local fallback
- ML service: Python, FastAPI, pandas, NumPy, scikit-learn
- Development: local only
- Database: local MySQL, authorized in Phase 9; no cloud database or paid service

## Backend setup and commands

Prerequisite: Node.js 22.20+ and npm. First create the local database and separate application/migration users using [docs/mysql.md](docs/mysql.md). MySQL configuration is mandatory when selected; app startup never creates a schema or falls back to JSON. From the project root in PowerShell:

```powershell
cd backend
npm ci --cache .npm-cache
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# Edit ignored .env with the non-secret MySQL settings in .env.example.
$dbCredential = Get-Credential -UserName 'eduverify_app' -Message 'Enter the local MySQL application password'
$env:MYSQL_PASSWORD = $dbCredential.GetNetworkCredential().Password
Remove-Variable dbCredential
# Configure separate migration credentials locally as described in docs/mysql.md.
npm run db:migrate
npm run seed:demo
npm test
npm run dev
```

The backend starts at `http://localhost:5000`; check it with `Invoke-RestMethod http://localhost:5000/api/health`.

For a one-time non-watching start, run `npm start`. Keep database passwords and migration credentials out of source control; clear migration credentials before starting the runtime server. `STORAGE_DRIVER=mysql` uses the MySQL variables in `.env.example`. An explicitly selected `STORAGE_DRIVER=json` uses `DATA_DIR` as a project-relative local fallback; production-mode startup refuses JSON. See the MySQL guide for the complete credential/migration commands and least-privilege grants.

The backend binds to `127.0.0.1` for local use. Set `APP_ORIGIN` to the exact browser origin if you change the port. No cross-origin browser access is enabled.

## Demo accounts and authentication testing

From `backend/`, install the locked dependencies with `npm ci`. Then configure a password locally and seed accounts:

```powershell
# Use your own password; the prompt keeps it out of command history.
$demoCredential = Get-Credential -UserName 'admin@demo.example' -Message 'Choose a local demo password (12+ characters, at most 72 UTF-8 bytes)'
$env:DEMO_ACCOUNT_PASSWORD = $demoCredential.GetNetworkCredential().Password
npm run seed:accounts
Remove-Item Env:DEMO_ACCOUNT_PASSWORD
```

This creates the fictional reference institutions and five accounts. All newly created demo accounts use the password you supplied. Existing accounts, hashes, and timestamps are preserved on repeat runs; reseeding is not a password-reset mechanism. There is no built-in or committed password.

| Email | Role | Institution |
| --- | --- | --- |
| admin@demo.example | institution_admin | DEMO-INST-001 |
| operator@demo.example | institution_operator | DEMO-INST-001 |
| admin2@demo.example | institution_admin | DEMO-INST-002 |
| reviewer@demo.example | regulatory_reviewer | none |
| verifier@demo.example | authorized_verifier | none |

Start `npm run dev` in one terminal. In another PowerShell terminal, log in using the password chosen during seeding:

```powershell
$loginCredential = Get-Credential -UserName 'admin@demo.example' -Message 'Enter your local demo password'
$baseUrl = 'http://localhost:5000'
$csrf = Invoke-RestMethod "$baseUrl/api/auth/csrf" -SessionVariable authSession
$loginBody = @{ email = $loginCredential.UserName; password = $loginCredential.GetNetworkCredential().Password } | ConvertTo-Json
$loginResult = Invoke-RestMethod "$baseUrl/api/auth/login" -Method Post -WebSession $authSession -ContentType 'application/json' -Headers @{ 'X-CSRF-Token' = $csrf.csrfToken } -Body $loginBody
Remove-Variable loginBody, loginCredential
Invoke-RestMethod "$baseUrl/api/auth/me" -WebSession $authSession
Invoke-RestMethod "$baseUrl/api/auth/logout" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken }
# The next request should return HTTP 401.
Invoke-RestMethod "$baseUrl/api/auth/me" -WebSession $authSession
```

Login accepts only `email` and `password`. Emails are trimmed and lowercased. Failed/disabled accounts return the same error. Login rotates both the session ID and CSRF token; use the new token for logout and future protected mutations. Authentication responses never include password hashes.

## Authentication design and local security limits

- Users are stored through the selected adapter (MySQL `users` table, or ignored JSON fallback), with preserved bcrypt hashes (cost 12), fixed roles, institution scope, status, and creation/update timestamps.
- `express-session` keeps sessions in process memory. The cookie contains only a signed session ID, with `HttpOnly`, `SameSite=Strict`, and a 30-minute maximum lifetime. The server also checks an absolute deadline. Restarting the backend logs everyone out.
- Local HTTP requires `COOKIE_SECURE=false`. HTTPS deployments would require `COOKIE_SECURE=true` and deployment review. The default session-cookie signing key is generated randomly at startup; an optional `SESSION_SECRET` belongs only in ignored local environment configuration. QR signing requires its own explicitly configured key and has no generated fallback.
- GET `/api/auth/csrf` issues a session-bound synchronizer token. All auth POSTs require `X-CSRF-Token`; supplied origins must match `APP_ORIGIN`, and cross-site fetches are rejected. Tokens belong only in client memory, never localStorage, URLs, or logs. See the [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- Login is limited to 10 requests per IP per 15 minutes. Auth routes also have a 100-request limit per IP per 15 minutes. Limiter state resets on restart. Do not enable proxy trust without a deployment-specific review.
- Every authenticated request reloads the account so inactive accounts, changed roles, and changed institution assignments take effect. Permission checks default to denial. See [docs/auth-policy.md](docs/auth-policy.md) for integration requirements and the role matrix.
- Memory sessions and process-local rate limits are appropriate only for this single-process local prototype; Express [documents MemoryStore's production limitations](https://expressjs.com/en/resources/middleware/session/). JSON files provide no multi-process transaction or OS-user isolation. Keep the backend local and protect filesystem access.
- Password reset, MFA, account provisioning APIs, durable authentication audit trails, distributed sessions, and production hardening are deferred. Demo accounts share a locally chosen password for convenience; use fictional data only.

## Data handling

- SQL is selected explicitly. Preserve legacy JSON in `data/local/`; JSON fallback writes only to that or another explicitly configured relative data directory.
- Use `data/demo/` only for fictional, reviewable fixtures.
- Do not use real APAAR IDs; the reserved format `DEMO-APAAR-0001` is suitable for fixtures.
- Student validation now requires 12-digit text. The [CSV template](data/demo/students-template.csv) therefore uses synthetic, leading-zero numeric placeholders, not issued APAAR IDs. A format check never verifies official APAAR authenticity; no government service is contacted.

## Student management and CSV import

Institution admins and operators can list, retrieve, create, update, preview and commit students only in their own institution. Regulatory reviewers and authorized verifiers have no access to student endpoints. All writes retain the existing CSRF checks.

After following the login example above, use the same authenticated PowerShell session **before logging out**:

```powershell
Invoke-RestMethod "$baseUrl/api/v1/students?page=1&pageSize=20" -WebSession $authSession
# Multipart -Form requires PowerShell 7+. Start this terminal from the project root.
$csvFile = Get-Item './data/demo/students-template.csv'
$preview = Invoke-RestMethod "$baseUrl/api/v1/students/import/preview" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -Form @{ file = $csvFile }
$preview.summary
# Inspect all row results. Only fully valid previews receive a token.
$preview.rows | ConvertTo-Json -Depth 8
if ($preview.previewToken) {
  $commitBody = @{ previewToken = $preview.previewToken } | ConvertTo-Json
  Invoke-RestMethod "$baseUrl/api/v1/students/import/commit" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -ContentType 'application/json' -Body $commitBody
}
```

Uploads accept one UTF-8 CSV file of at most 256 KiB and 500 rows, with fields of at most 256 characters. Preview never writes JSON files. Commit revalidates all rows and uses one atomic collection replacement; mixed valid/invalid batches are rejected as a whole. Preview tokens expire after 10 minutes and are bound to the user, institution, and login session. Keep tokens in memory.

Run all regression and Phase 3 tests from `backend/` with `npm test`, or run student tests with `npm test -- --runTestsByPath test/students.test.js`. Use `npm run dev` for local development. JSON storage and import tokens support one backend process only; no multi-process transaction or power-loss durability guarantee is provided. See [the API guide](docs/students-api.md) for retry and recovery behavior.

## Deterministic compliance evaluation

Institution admins and operators can explicitly evaluate their institution through `POST /api/v1/compliance/evaluate`. Findings and aggregate summaries stay scoped to that institution; reviewers and verifiers cannot access these endpoints. Evaluation does not alter student records.

Checks cover required fields, APAAR syntax, duplicate/conflicting records, institution/programme references, academic/admission years, supported categories, and capacity against a matching programme/year intake. Findings distinguish `violation` from `requires_review`; they never determine fraud or authenticate official APAAR IDs.

Approved-intake rows retain `programmeId`, `academicYear`, and `approvedSeats`. An optional `countingPolicy` defines counted statuses, per-category treatment, and an admission-year range. **Existing JSON files are not automatically changed.** Legacy rows without policy produce review findings instead of guessed capacity conclusions. New demo intake rows include an explicitly fictional policy. See the [reference-policy example and migration guidance](docs/compliance-api.md#reference-schema-and-legacy-data) before configuring existing local data.

With the existing authenticated PowerShell session, run this before logout:

```powershell
$evaluation = Invoke-RestMethod "$baseUrl/api/v1/compliance/evaluate" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -ContentType 'application/json' -Body '{}'
$evaluation.summary | ConvertTo-Json -Depth 10
Invoke-RestMethod "$baseUrl/api/v1/compliance/findings?page=1&pageSize=20" -WebSession $authSession
Invoke-RestMethod "$baseUrl/api/v1/compliance/summary" -WebSession $authSession
```

The latest evaluation is saved atomically in the existing ignored `data/local/validation-issues.json` collection. Reads compare a fingerprint of current scoped inputs with the saved snapshot and return `stale` and `freshness`; after a student/reference change, explicitly evaluate again. `matches_checked_inputs` describes the checked snapshot, not a transactional or permanent compliance guarantee. No multi-file transaction is claimed.

From `backend/`, use `npm test` for the full regression suite or `npm test -- --runTestsByPath test/compliance-engine.test.js test/compliance-api.test.js` for compliance tests. No additional dependency or service is required for deterministic compliance. QR artifacts are a separate integrity workflow described below.

## Local ML service

The ML service uses FastAPI, pandas, NumPy and scikit-learn. Python 3.10.7 on Windows was tested; dependencies are pinned for that environment. From the project root:

```powershell
python -m venv ml-service/.venv
.\ml-service\.venv\Scripts\python.exe -m pip install --no-cache-dir -r ml-service/requirements-lock.txt
cd ml-service
.\.venv\Scripts\python.exe -m ml_app.train
.\.venv\Scripts\python.exe -m pytest -q
```

Training is an explicit offline command. It writes only ignored `ml-service/artifacts/` files, never application `data/`. The API only loads the locally trained artifact and never trains on submitted records.

In this same terminal, choose a local shared service key of at least 32 characters. Enter the **same value** in the backend terminal below; do not paste it into source or command history:

```powershell
$mlCredential = Get-Credential -UserName 'local-ml' -Message 'Enter a local shared service key (32+ characters)'
$env:ML_SERVICE_KEY = $mlCredential.GetNetworkCredential().Password
Remove-Variable mlCredential
.\.venv\Scripts\python.exe -m uvicorn ml_app.api:app --host 127.0.0.1 --port 8000 --no-access-log
```

In a second terminal, from the project root:

```powershell
cd backend
$mlCredential = Get-Credential -UserName 'local-ml' -Message 'Enter the SAME local ML service key'
$env:ML_SERVICE_KEY = $mlCredential.GetNetworkCredential().Password
Remove-Variable mlCredential
npm ci
npm run dev
```

The default `ML_SERVICE_URL` is `http://127.0.0.1:8000`; `ML_TIMEOUT_MS` defaults to 3000. Optional backend overrides belong in ignored `backend/.env`. Python reads its service key from the process environment. Start Python before requesting ML evaluation. Health is available at `http://127.0.0.1:8000/health`; internal metadata/prediction endpoints require the key and reject browser origins. Browser clients must call Express.

After normal Express login, before logout:

```powershell
$mlResult = Invoke-RestMethod "$baseUrl/api/v1/ml/evaluate" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -ContentType 'application/json' -Body '{}'
$mlResult | ConvertTo-Json -Depth 10
```

Only institution admins/operators can request their own results. Express sends four numeric aggregates per programme/year; no names, APAAR values, record IDs or institution IDs go to Python. ML scores are review signals, not compliance decisions or identity verification. Results are not persisted, and the response checks whether source inputs changed during inference. Timeout, unavailable-service and malformed-response errors are explicit failures.

Run all Node tests with `cd backend` then `npm test`, and all Python tests with `cd ml-service` then `.\.venv\Scripts\python.exe -m pytest -q` (each `cd` shown here assumes the project root). After training, `npm run smoke:ml` from `backend/` automatically starts temporary local services and tests real HTTP integration using ephemeral credentials and isolated fictional data. It stops both services and removes only its own temporary test directory.

The held-out **synthetic-demo** evaluation produced precision **0.9231**, recall **1.0000**, F1 **0.9600**, and confusion matrix `[[195, 5], [0, 60]]` (true normal/unusual rows; predicted normal/review columns). These deliberately extreme examples are not real-world ground truth. Feature definitions, threshold, dataset separation, actual evaluation details and limitations are in [docs/ml-service.md](docs/ml-service.md).

## React frontend and dashboards (Phase 6)

Use Node.js 22.20+ and the locked dependencies. From the project root in PowerShell:

```powershell
cd frontend
npm ci --cache .npm-cache
npm test
npm run build
npm run dev
```

Open **http://127.0.0.1:5173**. The UI uses a same-origin `/api` proxy to Express at `127.0.0.1:5000`. The optional public `frontend/.env` setting is `VITE_API_BASE_URL=/api`, as shown in `.env.example`. Only relative same-origin API paths are accepted. Never put service keys, passwords or session secrets in `VITE_*` variables.

Start services in this order: (1) Python ML, using the training/key instructions above; (2) Express, with the **same ML key** plus the exact frontend origin below; (3) Vite. Python is optional for student/compliance workflows; ML requests explicitly fail if it is unavailable. In the backend terminal, before starting Express:

```powershell
# From project root; keep the ML_SERVICE_KEY configured above in this terminal.
cd backend
$env:APP_ORIGIN = 'http://127.0.0.1:5173'
npm run dev
```

Use that exact browser URL, not `localhost:5173`, unless you also update `APP_ORIGIN`. Restart Express after changing its configuration. Cookies and CSRF headers pass through Vite without changing the browser Origin; no backend CORS or authorization checks were relaxed. Stop the backend before demo seeding; follow the earlier account password prompt and never commit credentials. Use your locally chosen password at login.

Institution admins/operators can use the overview, paginated student list/detail/create/edit, CSV preview/confirmation, compliance findings/evaluation, separate ML review and owned-record QR issuance/revocation. Reviewers/verifiers receive a restricted landing page and the public artifact-status screen; the UI makes no restricted data requests for them. Existing programme IDs must be entered manually because no reference-list API exists; seeded fictional IDs are documented in [the frontend guide](docs/frontend.md).

The dashboard displays actual student totals and saved compliance summaries. Policy-unavailable counts remain unknown; stale snapshots require explicit reevaluation. ML status/results exist only in the current session and are cleared after local student changes or logout. Failed inference never becomes a normal result. All forms use fictional data only; APAAR format validation is not official verification.

Additional checks, each starting from the project root:

```powershell
cd frontend
npm run smoke:local
# Starts/stops temporary Vite and Express servers; isolated fictional data only.
```

```powershell
cd backend
npm test
npm run smoke:ml
```

```powershell
cd ml-service
.\.venv\Scripts\python.exe -m pytest -q
```

`npm run build` writes ignored `frontend/dist/`. For a local build preview, stop the Vite development server and run `npm run preview`; it uses the same port/proxy and origin. This is not a production deployment configuration. Component tests use Vitest, jsdom and Testing Library; the real HTTP smoke checks the proxy and API contracts. Phase 8 adds a separate real-browser workflow below. Automated checks do not replace screen-reader or formal contrast review. See [docs/frontend.md](docs/frontend.md) for architecture and remaining limits.

## QR artifacts and record integrity (Phase 7)

From the project root, in the backend PowerShell terminal, configure a **dedicated** random key before starting Express:

```powershell
cd backend
npm ci --cache .npm-cache
$env:QR_ACTIVE_KEY_ID = 'local-1'
$env:QR_SIGNING_KEYS = node -p "JSON.stringify({'local-1':require('node:crypto').randomBytes(32).toString('base64')})"
$env:APP_ORIGIN = 'http://127.0.0.1:5173'
npm run dev
```

This captures the generated key in the environment without printing it. Keep the ML key separate. For persistence across terminal sessions, protect the key ring in ignored `backend/.env`; do not regenerate it if existing artifacts must remain verifiable. No key or malformed configuration returns explicit service errors for issue/verify while the other application workflows remain available. Never put QR keys in source, logs or `VITE_*` variables.

Start Vite using the earlier frontend commands and open **http://127.0.0.1:5173**. Institution admins/operators can open a permitted student detail, issue a QR, download its PNG, copy the signed payload, and explicitly revoke the artifact. Issuance requires an active, valid, nonduplicate institution record; it does not imply compliance approval. Reviewers/verifiers cannot issue or browse records. Anyone may open **Public artifact verification** from the login page or **Verification** after login and paste a payload.

Endpoints are POST `/api/v1/verification/issue` (`studentId`, session/CSRF), POST `/api/v1/verification/verify` (`payload`, public), and POST `/api/v1/verification/revoke` (`artifactId`, session/CSRF). QR text contains only schema/issuer/key ID, opaque artifact and snapshot IDs, issue/expiry times and HMAC-SHA256. It contains no student name, APAAR, full record or student ID. Public output distinguishes valid, invalid, expired, revoked and outdated, and separates signature integrity from current-record status. Official APAAR authenticity is always **not verified**.

Artifacts expire after 24 hours. Relevant student edits change a private marker atomically with the student; earlier artifacts become outdated even after an API edit is reversed. Legacy records need no migration. Revocation is persisted in the existing `verification-records` collection. Queue coordination covers API writes in one process; external edits, multiple processes and backup rollback remain limitations. A valid result is a point-in-time observation, not identity proof or a regulatory certificate.

The existing `npm test` commands include verification security/UI tests. `npm run smoke:local` now also exercises real PNG issuance, anonymous verification, version invalidation and revocation through Vite/Express; `npm run smoke:ml` retains real Python integration. Camera scanning and image decoding are not implemented; payload entry is supported. Full setup, API examples, permissions, canonical serialization, key rotation/recovery, privacy decisions and concurrency limits are in [docs/verification.md](docs/verification.md).

## Integration and security review (Phase 8)

Before running the complete browser check, install the locked backend/frontend dependencies and set up/train Python using the earlier commands. An installed **Chrome** browser is required by default. From the project root:

```powershell
cd frontend
npm ci --cache .npm-cache
npm run test:e2e
```

This starts temporary loopback Vite, Express and Python services, generates ephemeral test credentials/keys, and uses isolated fictional data. It exercises all roles, student management, invalid/valid CSV workflows, compliance/staleness, real ML success and failure after stopping Python, all QR outcomes, logout/expiry, restart persistence and mobile/keyboard checks. It uses a separate browser profile and Vite cache under an ignored temporary project folder, then stops its services and validates cleanup paths. Normal `data/local/` records and your browser profile are untouched. No manually running backend or configured production keys are required. To select an already installed Edge, set `$env:E2E_BROWSER_CHANNEL = 'msedge'`; only Chrome was exercised here. Desktop/mobile screenshots are ignored under `frontend/test-results/`.

Continue running `npm test` in backend and frontend, Python `pytest`, `npm run build`, `npm run smoke:local` and `npm run smoke:ml`. Dependency checks are `npm audit --cache .npm-cache` from both Node folders and `.\.venv\Scripts\python.exe -m pip check` from `ml-service/`. `pip check` is a consistency check, not a Python advisory scan. No automatic major upgrades are performed.

Final results: **242 backend tests**, **42 frontend tests**, **30 Python tests**, production build, both existing smoke tests and the complete Chrome workflow passed. Both npm audits reported zero vulnerabilities. Python reported no broken requirements and one existing Starlette/AnyIO deprecation warning. See [the review report](docs/security-review.md) for baseline results, reproduced failures, fixes, coverage, exact commands and checks not performed.

Storage initialization now coordinates readers/writers in one adapter instance, and explicit replacement refuses malformed JSON rather than erasing it. Stop the backend, preserve a protected local backup and repair corrupted data explicitly; ordinary application writes are not a repair mechanism. Student/CSV/compliance mutations reload account permissions at the write boundary, including after waiting for a collection queue. Cross-file account changes after that check, multi-process access, power loss, backup rollback and uncertain completed writes remain limitations. The default data directory is ignored; explicitly ignore/protect any custom project-relative `DATA_DIR`. This review is not production certification or official APAAR verification.

## Local MySQL migration (Phase 9)

See [docs/mysql.md](docs/mysql.md) for audited schema/relationships, installation, separate DDL/runtime users, explicit storage selection, transactions, backup/restore and migration recovery. The storage adapter uses MySQL2 prepared values and normalized tables while retaining the existing collection callbacks. It never sends database credentials to React/Python or stores QR signing keys in MySQL. Dedicated QR keys must differ from the database password.

Versioned migrations create references/accounts/students, evaluation envelopes/findings, verification artifacts, preserved legacy entries and the migration/import ledgers. A database transaction gate coordinates writes across connections; shared row locks protect checked account/reference state. Unique institution/APAAR and programme/year constraints plus foreign keys enforce database integrity. APAAR remains text; constraints do not verify official identity.

JSON import is a separate operator action, not startup behavior. Stop JSON writers and create a new ignored backup directory first. From `backend/`, with MySQL selected/configured and migrations applied:

```powershell
New-Item -ItemType Directory -Force ../data/backups | Out-Null
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --create-backup
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --dry-run
# Inspect the safe counts before choosing to apply:
npm run db:import-json -- --source data/local --backup data/backups/before-phase9 --apply --fictional-data
```

Only approved collection files are read. The backup and current source must match byte-for-byte; dry runs validate real SQL constraints and roll back. Apply preserves identifiers/hashes, skips identical target rows, rejects conflicts/invalid batches without partial import, and never modifies the source. No normal `data/local/` import was performed by the agent; fixture migration was tested in isolation. Earlier phase descriptions of JSON files apply to JSON fallback; SQL operations use the corresponding tables/transactions now.

For repeatable verification using already installed `mysqld` binaries and an isolated project-owned instance (not the existing MySQL Windows service):

```powershell
# Start at project root:
cd backend
npm run db:test-server
$env:ALLOW_MYSQL_TESTS = '1'
npm test
$env:SMOKE_STORAGE_DRIVER = 'mysql'
npm run smoke:ml
cd ../frontend
npm test
npm run build
npm run smoke:local
npm run test:e2e
cd ../backend
npm run db:test-server -- stop
```

The helper's data/credentials stay under ignored `.local/mysql/`, bound to loopback port 33307; separate generated `eduverify_test_<hex>` databases are created/dropped by each fixture. `ALLOW_MYSQL_TESTS=1` is required for database tests; without it, SQL cases are explicitly skipped and do not constitute MySQL verification. `SMOKE_STORAGE_DRIVER=mysql` selects isolated SQL for both existing smoke tests and the browser scenario; missing SQL configuration fails rather than silently switching adapters. Current MySQL 8.4 LTS is recommended for new setups; the already installed 8.0.36 binaries were used only for local isolated verification and were not upgraded.

Actual Phase 9 results: **257 backend tests** (all SQL cases enabled), **42 frontend tests**, **30 Python tests**, production build, both MySQL-backed smoke tests and the complete MySQL-backed Chrome workflow passed. The final targeted database suite passed all 15 cases, including real CLI fixture migration. The backend npm audit reported zero vulnerabilities. Original runtime JSON hashes were unchanged; no normal-user data was imported. See the guide for fixture counts, tested failures and untested restore/power-loss limits.

Startup order is MySQL/schema → chosen demo seeding or explicit import → Python ML → Express → Vite. Preserve SQL backups and dedicated signing keys separately; restoring older data can reverse revocations/edits. Sessions, previews and limits remain in memory. The compatibility adapter serializes whole-collection callbacks, so throughput is limited. Deadlock/outage errors roll back safely, but ambiguous COMMIT/HTTP outcomes still require reconciliation before retry. No production, automatic failover, exactly-once, power-loss or real APAAR guarantee is claimed. Full test evidence and remaining limitations are in [docs/mysql.md](docs/mysql.md).

## Phased implementation checklist

- [x] Phase 0 — Repository foundation, architecture, privacy/security conventions, and local data boundaries
- [x] Phase 1 — Express backend foundation, local JSON storage, health endpoint, seed script, and automated tests
- [x] Phase 2 — Authentication, cookie sessions, role-based permissions, institution isolation, and demo accounts
- [x] Phase 3 — Institution-scoped student management and validated CSV preview/commit
- [x] Phase 4 — Deterministic compliance rules, institution-scoped findings, summaries and staleness checks
- [x] Phase 5 — Local synthetic Isolation Forest service, scoped Express integration and evaluation
- [x] Phase 6 — React frontend, role-aware dashboards and existing API workflows
- [x] Phase 7 — Signed QR artifacts, public minimal verification, record invalidation and revocation
- [x] Phase 8 — Integration/security review, verified fixes and complete browser workflow
- [x] Phase 9 — Local MySQL adapter, relational migrations, transactional workflows and explicit backed-up JSON import
- [x] Phase 10 — Final MySQL-backed acceptance, real disposable dump/restore, repeatable SIH demo and submission documentation
- [ ] Later — Production hardening and deployment planning

## Working agreement

Read [AGENTS.md](AGENTS.md) before changing the project. It defines architecture, security constraints, coding conventions, tests, and phase boundaries.
