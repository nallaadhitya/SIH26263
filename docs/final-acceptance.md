# Phase 10 final acceptance — 2026-10-27 (Asia/Calcutta)

Accepted for a **local SIH demonstration using fictional data**. No production readiness, official APAAR integration, real-world ML accuracy or disaster-recovery certification is claimed. Existing application JSON and the normal MySQL Windows service/database were preserved.

## Environment and inspection

Read AGENTS.md, README and relevant security/storage/MySQL/auth/student/compliance/ML/frontend/verification documentation, inspected actual implementation and Git status. Existing useful work was retained. Git had no commits, an empty index and all project source untracked. No reset/checkout or unrelated cleanup occurred. The pre-existing ignored `frontend/.tmp-smoke-75arWb/` directory was left untouched because its ownership was uncertain.

| Component | Actual environment |
| --- | --- |
| Node / npm | 22.20.0 / 10.9.3 |
| Python | 3.10.7, existing project `ml-service/.venv`, pinned requirements lock |
| Database/client/dump | Installed MySQL Community 8.0.36 |
| Acceptance database | Separate project-owned loopback port 33307 instance; generated test schemas, `utf8mb4_0900_bin`, InnoDB, two checksummed migrations |
| Browser | Installed Chrome through Playwright; isolated profile |
| Frontend build | Vite 6.4.5, 37 modules; generated JS 255.58 kB / 79.48 kB gzip |

Existing Windows `MySQL80` remained running, unconfigured and unused by fixtures. Test credentials stay under ignored `.local/mysql/`, never reports/argv/source. Fixtures use CRUD-only app credentials; migration/restore use test-only administrative credentials. No server upgrade, normal database import or new dependency installation was performed. Use patched supported components for any new installation; installed 8.0.36 is acceptance evidence only.

## Actual final results

| Executed check | Actual result |
| --- | --- |
| Full backend with `ALLOW_MYSQL_TESTS=1`, `npm test` | **257 passed / 13 suites**, no SQL skips; 158.265 seconds |
| Final targeted `npm run test:mysql` | **15 passed**, including real migrations, CLI import and persistence; 40.866 seconds |
| Frontend `npm test` | **42 passed / 3 files** |
| Python venv `python -m pytest -q` | **30 passed**; one existing Starlette/AnyIO BlockingPortal deprecation warning |
| Frontend `npm run build` | Passed |
| MySQL-backed backend `npm run smoke:ml` | Passed real private Python HTTP/inference and Express aggregates |
| MySQL-backed frontend `npm run smoke:local` | Passed real Vite proxy/cookie/CSRF and application contracts |
| MySQL-backed Chrome `npm run test:e2e` | Passed full scenario and cleanup; ML stopped, explicit UI/API failure, restarted and successful inference restored |
| Backend and frontend `npm audit --cache .npm-cache` | **0 vulnerabilities** each |
| Backend/frontend `npm ls --depth=0` | Direct dependency trees inspected |
| Python venv `python -m pip check` | No broken requirements; consistency check, not an advisory scan |
| New `npm run acceptance:restore` | Passed actual dump/restore, counts/relationships/state assertions and cleanup |
| New `npm run demo:local -- --check` | Passed actual Python/Express/Vite startup, ML stop/recovery, Express restart, repeatable seed and cleanup |

Backend coverage includes actual environment-configured MySQL startup, repeatable/checksummed migrations, runtime no-DDL privilege, restart/reconnection, literal SQL injection handling, concurrent/duplicate mutations, CSV rollback/retry/replay, atomic finding/artifact failures, account locks, outage/lock-timeout safe errors and explicit backup/dry-run/import/rerun/conflict checks. Earlier health/JSON/auth/student/compliance/ML/QR assertions remain. Selecting MySQL never silently selects JSON on failure.

Chrome exercised wrong/correct login, student create/edit/detail, invalid/valid CSV, confirmation/modal focus, deterministic capacity finding/staleness, numeric-only real Python requests, unavailable-service failure/recovery, PNG download, all five QR outcomes, all roles plus institution 002 isolation, logout/expiry, new Express/adapter persistence and keyboard/mobile layout. Expiry uses injected backend clocks, not modified production lifetimes. Normal data/local is never selected by these harnesses.

Initial audits failed because of sandbox network restrictions; approved retries returned the advisory results. Initial frontend tests/build, browser and demo Vite startup encountered esbuild ancestor-directory access denial; the same commands passed with approved filesystem access. Failed attempts are not counted as passing checks. No assertions were weakened.

## Executed dump/restore drill

`backend/scripts/acceptance-restore.js` creates two generated test schemas and checks the project-owned server data directory. It seeds the source, invokes actual `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF`, then invokes `mysql` into the separate target. Credentials use an ignored mode-600 client option file, never command-line passwords. No `--databases` option can redirect restore into the source. Application writers are idle during the dump. Cleanup removes only generated fixture schemas/files.

| Restored table | Count |
| --- | --- |
| institutions / programmes / approved_intakes | 2 / 2 / 2 |
| users / students | 5 / 1 |
| compliance_evaluations / compliance_findings | 1 / 1 |
| verification_records | 3 |
| legacy_records / json_imports | 0 / 0 |
| schema_migrations / storage_mutex | 2 / 1 |

All nine logical collections matched exactly, including IDs/hashes/timestamps/private revision/artifact claims; all 12 table counts matched. Student/programme/creator and artifact/student/institution joins had zero orphans. Restored checksummed migrations and bcrypt login worked. The same compliance evaluation was fresh with one `INTAKE_EXCEEDED` finding. Retained in-memory signing keys produced `valid`, `outdated` and `revoked` results. Keys were not stored in the dump. Cleanup completed before success output. This closes the previously unperformed **local disposable** restore drill; deployed recovery, power-loss and backup rollback reconciliation remain unvalidated.

## Security/privacy acceptance

| Requirement | Evidence and boundary |
| --- | --- |
| Passwords | Existing bcrypt cost-12 tests and SQL hash constraints; API account allowlist excludes hashes |
| Sessions/CSRF | Rotation, absolute expiry, HttpOnly/SameSite Strict, exact Origin/current token and logout replay denied; sessions still memory-only |
| Roles/institutions | Persisted ownership controls student/import/compliance/ML/QR; override attempts denied; reviewer/verifier restricted landing documented |
| ML | Exactly four numeric/null fields asserted in real requests; private key required; no student identities or browser/DB access from Python |
| QR | Dedicated keys, strict canonical HMAC checks, altered signature/version rejection, distinct valid/invalid/expired/revoked/outdated; public output excludes name/APAAR/student ID |
| SQL | Code-defined identifiers and parameterized values, literal injection test, FK/unique/check constraints; failed CSV batch leaves no partial rows |
| Failures | Explicit DB/ML/key errors; no raw SQL/credentials/records or normal-score/JSON fallback |
| Files | Environment, local config, runtime SQL/JSON, dumps, private keys, dependencies, generated artifacts/screenshots remain ignored |

Frontend navigation is not the authorization boundary. Reviewer/verifier roles have no student browse, compliance/ML, issuance or implemented cross-institution summary endpoint. Public artifact checking is deliberately minimal. No real student data, production credential or government identity service was used.

## Changed files

- `frontend/scripts/review-browser.mjs`: closes missing acceptance coverage by restarting Python after failure and requiring successful inference/UI recovery; application business rules unchanged.
- `backend/scripts/acceptance-restore.js`: safe real disposable restore with assertions and cleanup.
- `backend/scripts/demo-local.js`: fresh SQL demo, seeded references/accounts, one-seat fictional policy, ordered readiness, independent memory-only secrets, serial service-control commands and `--check` rehearsal.
- `backend/package.json`: adds `acceptance:restore` and `demo:local`; no dependency changes.
- `data/demo/sih-valid.csv`, `sih-invalid.csv`: fictional presenter fixtures.
- `.gitignore`: SQL export/dump/archive exclusions with an exception for versioned migration SQL. `.gitattributes` fixes migration SQL to LF so platform checkout conversion cannot invalidate migration checksums.
- README, `docs/mysql.md`, `docs/frontend.md`, `docs/security-review.md`: current status/restore evidence; correct stale deferred-feature wording while retaining historical review results.
- New `docs/architecture.md`, `api-summary.md`, `sih-demo.md`, `submission.md` and this report.

## Reproduce executed checks

From project root in PowerShell, with locked dependencies, venv, trusted model and Chrome installed as described in [demo setup](sih-demo.md):

```powershell
Push-Location backend
npm run db:test-server
$env:ALLOW_MYSQL_TESTS = '1'
$env:SMOKE_STORAGE_DRIVER = 'mysql'
npm test
npm run smoke:ml
npm run acceptance:restore
npm run demo:local -- --check
npm audit --cache .npm-cache
npm ls --depth=0
Pop-Location
Push-Location frontend
npm test
npm run build
npm run smoke:local
npm run test:e2e
npm audit --cache .npm-cache
npm ls --depth=0
Pop-Location
Push-Location ml-service
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m pip check
Pop-Location
Push-Location backend
npm run db:test-server -- stop
Pop-Location
Remove-Item Env:ALLOW_MYSQL_TESTS, Env:SMOKE_STORAGE_DRIVER
```

No lint script exists; no lint pass is claimed. Other commands included version/service checks, Git status/log/index/ignore/whitespace inspection, source/relative-document-link checks and runtime SHA-256 comparisons. Audit results reflect this date's executed registry checks. Installation commands are documented reproducibility steps, not a claim to reinstall the existing environment during acceptance.

Git staging required approved filesystem access and a command-only trust exception for this repository because the sandbox-created `.git` owner differs from the approved runner. No global Git trust/author configuration was changed. The initial source checkpoint contains 116 reviewed source/documentation/lock/fictional-fixture files, including migration SQL with exact checksum bytes; no known local DB secret or generated/private path was staged. Relative Markdown links and whitespace checks passed. All four existing runtime JSON-file hashes remained identical, and no generated acceptance schemas remained after checks. The source-only archive/checkpoint/hash instructions and automation identity are in [the submission brief](submission.md). Nothing is pushed or published.

## Configuration and limitations

Normal schema/user/migration/seeding/startup commands: [README](../README.md) and [mysql.md](mysql.md). Full disposable presenter setup: [sih-demo.md](sih-demo.md). Use `.env.example` for variable names only. MySQL requires explicit `STORAGE_DRIVER=mysql`, loopback host, port, database, app user and a privately prompted password. Use separate migration credentials only for `db:migrate`, then remove them before runtime. Backend alone receives DB credentials.

Generate separate secrets without printing them: PowerShell `$env:SESSION_SECRET = node -p "require('node:crypto').randomBytes(32).toString('hex')"` and an independent equivalent call for `ML_SERVICE_KEY`. Supply that same ML key privately to Python/Express; Python does not load backend `.env`. Generate and preserve the dedicated `QR_SIGNING_KEYS`/`QR_ACTIVE_KEY_ID` ring following [verification.md](verification.md). Never use VITE variables/browser storage/source/logs for secrets. Configure exact `APP_ORIGIN=http://127.0.0.1:5173`. The disposable launcher configures these privately for its own children.

Health: Express GET `http://127.0.0.1:5000/api/health` returns `{"status":"ok","service":"eduverify-backend"}`; Python GET `http://127.0.0.1:8000/health` returns `{"status":"ok","model_available":true}` when ready, 503 otherwise; Vite `http://127.0.0.1:5173/` serves HTML. Express liveness is not continuous DB readiness; startup migration checks and authenticated persisted-data requests are separate evidence.

Sessions, rate limits and CSV previews reset on Express restart. Coarse serialized whole-collection SQL callbacks limit throughput. Connection/response loss around COMMIT can leave an uncertain completed action; inspect state before retrying. No durable idempotency receipts/automatic failover exist. Backup rollback can reverse edits/revocations; keys require protected separate retention/rotation. Trusted joblib artifacts are pickle-based; a manifest does not defeat a privileged OS attacker. Synthetic metrics and syntax never establish identities, fraud or regulatory approval.

Not performed: crash/power-loss/failover tests, deployed backup/restore, independent penetration test, Python advisory-database scan, real-data accuracy/fairness evaluation, formal WCAG contrast/screen-reader audit or Edge/Firefox/Safari certification. Production requires those operational/security/privacy decisions plus HTTPS, durable sessions/audits and patched supported components. No unresolved failure remains in the executed local acceptance checks. Stop after Phase 10.
