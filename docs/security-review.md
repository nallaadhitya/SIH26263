# Phase 8 integration and security review

This is the historical Phase 8 JSON review. Current MySQL-backed security/regression evidence and the completed disposable restore drill are recorded in [Phase 10 acceptance](final-acceptance.md); earlier deferred-feature and unperformed-check statements below describe Phase 8 only.

Reviewed on 2026-10-27 (Asia/Calcutta). Scope: the existing local React/Vite, Express, JSON storage and Python ML prototype. Fictional data only; no MySQL, cloud integration, official APAAR service or deployment changes.

## Baseline and preservation

Before changing application code, the existing backend suite passed **234 tests / 11 suites**, frontend passed **42 tests / 3 files**, and Python passed **30 tests** with one existing Starlette/AnyIO deprecation warning. The production build and both existing HTTP smoke tests passed. Frontend test/build startup initially failed because the managed filesystem sandbox denied esbuild ancestor-directory resolution; running the same commands with approved filesystem access succeeded. This was an environment failure, not a passing test result or an application defect.

`git status --short` showed the entire existing project untracked. No reset, checkout, commit, data migration or removal of user work was performed. SHA-256 hashes of the four existing `data/local/` files were recorded and matched after review. All new test data, browser profiles, service keys and temporary downloads use isolated project-local directories. Cleanup validates the absolute parent and generated prefix before removing only those directories.

## Verified defects and fixes

| Finding | Evidence before fix | Fix and regression evidence |
| --- | --- | --- |
| Concurrent collection initialization could erase a completed write (high data-integrity impact) | A deliberately delayed first reader renamed its empty initialization over a concurrent saved record; regression returned `[]` instead of the saved row | Initializers now share one in-flight promise per collection/adapter instance; readers and queued writers await it. Failure releases the initialization so retries work |
| Explicit replacement silently erased corrupted JSON (medium integrity impact) | `writeCollection('students', [])` succeeded over malformed stored bytes | Replacement now reads/validates the existing array first, preserves corruption and throws `DataCorruptionError` |
| Queued writes retained obsolete account privileges (high authorization impact) | After middleware accepted a request, a held student queue allowed account deactivation, role removal or institution reassignment; releasing the queue still returned 201 | Central `assertCurrentAccess` reloads account, permission and institution before student/CSV/compliance persistence. Tests demonstrate 401/403 with no mutation for queued requests |
| Mobile table columns became unreadably narrow (usability/accessibility) | Actual 390-pixel browser screenshot split rule codes and headings across many tiny lines | Mobile tables keep a readable minimum width and scroll within named, keyboard-focusable regions; the browser checks overflow containment and keyboard focus styling |

The two storage regressions and three account-change cases were executed and failed against the previous implementation before their fixes. Existing assertions were preserved. One compliance corruption test now repairs its fixture explicitly with `fs.writeFile` instead of asking the normal adapter to overwrite corruption; all error/preservation assertions remain unchanged.

## Security coverage

| Boundary | Checks and result |
| --- | --- |
| Sessions/passwords | Existing real bcrypt-cost tests retained; session rotation, absolute expiry, inactive accounts, cookie replay after logout and login limits pass. Browser verifies HttpOnly/SameSite=Strict cookies, expiry UI and denied protected access after logout |
| CSRF/CORS | Mutations still require the existing synchronizer token and exact configured Origin. Foreign origins and missing tokens are denied. No permissive CORS or proxy-trust changes |
| Roles/institutions | All four roles plus the second institution exercised. Foreign student detail/issuance returns 404; institution overrides and reviewer/verifier student/compliance/ML/issuance requests are denied. Existing CSV, finding-ID and ML scope tests retained |
| Input/errors | Existing malformed JSON, unexpected fields/types, UUID/path rejection, file/row/encoding/CSV parser boundaries, request limits and static safe-error tests pass |
| Persistence | Initialization race, corruption preservation, concurrent/duplicate creates, serialized updates, interrupted rename, failed CSV/compliance/QR writes and successful retry are covered. Browser restarts the Express application with a new JsonStore and confirms persisted students plus revoked/outdated QR status |
| ML privacy/failure | Browser uses real Python inference; the harness records outgoing feature shapes and asserts exactly four numeric/null fields. Names, APAAR and internal references are absent. Stopping Python produces API 503 and a visible UI failure with no normal-result fallback |
| ML model boundary | Existing Python strict-schema, missing-value, no-fit inference, synthetic train/evaluation separation, trusted-artifact checks, private-key/origin/batch/body-limit and safe-error tests pass. ML and deterministic findings remain separate |
| QR integrity/privacy | Dedicated-key failures, canonical payloads, altered signatures/versions/key IDs, expiry, revocation, relevant changes/edit-back, minimal public output and atomic-write failures are covered. Actual browser renders all five status outcomes and downloads a real PNG |
| Secrets/files | Environment files, dependency caches, runtime JSON, Python artifacts, browser profiles/downloads and screenshots remain ignored. Test credentials are generated in memory; no real signing/service key is required or printed |

No unresolved high/critical application issue was identified within this local trust model after the verified fixes. This is a scoped code/integration review, not proof of absence of vulnerabilities or a production penetration-test certification.

## Real browser workflow

`frontend/scripts/review-browser.mjs` adds one complete browser integration scenario using Playwright and the **installed Chrome** channel. It launches temporary loopback Vite, Express and Uvicorn services, seeds isolated fictional references/accounts twice, and uses the actual UI and APIs. No inference or API response is mocked.

The workflow exercises failed/successful login, student create/edit/retrieve, invalid CSV preview, valid preview with native-modal Escape/focus return and explicit commit, policy-backed compliance/findings, real inference followed by a stopped-service failure, QR issue/download/valid/invalid/expired/revoked/outdated results, stale findings, every role, institution isolation, logout/expiry and application-instance restart persistence. QR expiry and session expiry use injected backend test clocks; production lifetimes are unchanged. The fixture's one-seat intake is explicitly fictional and generates a deterministic capacity finding for its two records.

The browser checks desktop and 390-pixel layouts, labels through role/label locators, native dialog focus, keyboard-visible focus on scrollable tables, no page-wide horizontal overflow, empty browser storage and absence of uncaught page errors. Desktop/mobile screenshots under ignored `frontend/test-results/` were visually inspected. These checks do **not** constitute a full WCAG contrast audit, screen-reader test, camera-scanner test or cross-browser/device certification.

During harness development, incorrect text/textarea locators, missing evaluation synchronization, a shared Vite-cache interference and duplicate child-process cleanup were diagnosed and corrected. Successful assertions printed before a cleanup failure were not counted as a passing command; the final success message is emitted only after cleanup, with exit code zero. Its Vite cache and browser profile are isolated from normal development. No retries weaken the expected outcomes.

## Commands and verified results

Changed files: `backend/storage/json-store.js`, `backend/auth/policy.js`, `backend/server.js`, `backend/students/service.js`, `backend/compliance/service.js`, new `backend/test/security-review.test.js`, the explicit fixture-repair setup in `backend/test/compliance-api.test.js`, `frontend/package.json` / `package-lock.json`, new `frontend/scripts/review-browser.mjs`, `frontend/src/ui.jsx` / `styles.css`, `.gitignore`, `README.md`, `docs/auth-policy.md`, `docs/students-api.md`, `docs/frontend.md` and this report. Python application/model files and the prior security assertions were preserved.

Executed review commands included all test/build/smoke commands below, both `npm audit` checks, `pip check`, `npm ls --depth=0`, Git status/ignore/diff checks and SHA-256 runtime-file comparisons. Playwright was added with `npm install --save-dev @playwright/test --cache .npm-cache --fetch-retries=0 --fetch-timeout=20000`; its locked resolved version is 1.64.1. `npm ci` below is the reproducible setup command for the team, rather than a claim that dependencies were reinstalled again during every final check.

Each block starts at the project root in PowerShell:

```powershell
cd backend
npm test
npm run smoke:ml
npm audit --cache .npm-cache
```

```powershell
cd frontend
npm ci --cache .npm-cache
npm test
npm run build
npm run smoke:local
npm run test:e2e
npm audit --cache .npm-cache
```

```powershell
cd ml-service
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m pip check
```

Browser prerequisites: installed Chrome, the existing Python venv/locked packages, and already-trained `ml-service/artifacts/`. No personal browser profile is used and no production/demo runtime credentials are required. To use an installed Edge instead, set `$env:E2E_BROWSER_CHANNEL = 'msedge'` before `npm run test:e2e`; Edge was detected but was not tested in this review. Browser/service startup errors are failures, not skips. The script does not download a browser or use a cloud service. Playwright's supported browser-channel configuration is documented in its [official browser guide](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge).

| Check | Baseline | Final |
| --- | --- | --- |
| Backend Jest | 234 passed / 11 suites | 242 passed / 12 suites |
| Frontend Vitest | 42 passed / 3 files | 42 passed / 3 files |
| Python pytest | 30 passed, one existing dependency warning | 30 passed, same warning |
| Production Vite build | Passed | Passed |
| Vite/Express HTTP smoke | Passed | Passed |
| Python/Express HTTP smoke | Passed | Passed |
| Chrome complete browser workflow | Not previously configured | Passed, one complete scenario, exit code 0 including cleanup |
| Backend npm audit | 0 advisories | 0 advisories; backend dependencies unchanged |
| Frontend npm audit | 0 advisories | 0 advisories including added Playwright 1.64.1 |
| Python `pip check` | No broken requirements | No broken requirements |

Initial audit network failures were sandbox restrictions; approved retries returned actual advisory results. No blind major upgrades or production dependencies were added. `pip check` verifies consistency, not vulnerability advisories; a Python vulnerability-database scan was not performed. Screen-reader testing, formal contrast measurements, Firefox/Safari/Edge runs, external penetration testing and power-loss/multi-process tests were not performed.

## Remaining limitations and next actions

- Keep one backend process and one shared JsonStore instance. There are no cross-process locks, multi-file transactions, fsync/power-loss guarantees or durable request receipts. Direct external JSON edits, account/reference races after the last access check, backup rollback and privileged local filesystem access remain outside these guarantees. Logout prevents subsequent authenticated requests; it is not a distributed cancellation/rollback mechanism for all work already in flight.
- Relevant student edits are atomic with their private QR revision marker; artifacts and compliance snapshots live in separate files. QR/currentness and compliance freshness are observations at the checked time. Failed HTTP responses after a completed rename can leave a completed operation: inspect state before retrying.
- Sessions, rate limits and pending CSV previews are in process memory and reset on restart. Production HTTPS, durable sessions/audits, MFA/password reset, key operations and deployment controls need a separate phase. QR keys remain dedicated, locally protected and manually rotated; lost/removed keys or restored backups do not gain historical-verification guarantees.
- Only fictional data is authorized. APAAR syntax, deterministic mismatches and synthetic ML scores never prove official identity, regulatory approval or fraud. Model pickle/joblib files remain trusted local artifacts; hashes do not defend against an OS user replacing both manifest and model.
- Default `data/local/` is ignored. A custom `DATA_DIR` is operator configuration, never an API input; choose a project-relative directory and explicitly ignore/protect it. Protect configured paths from untrusted local symlink/OS changes. No arbitrary path is accepted by collection APIs.
- Retain the automated checks for the next phase; arrange manual screen-reader/contrast review and independent Python advisory scanning before any broader use. Commit the reviewed source/lockfiles only after the team reviews the currently untracked work. MySQL migration remains deferred.
