# Phase 6 frontend

Phase 9 preserves frontend API contracts and adds MySQL selection only to isolated smoke/browser infrastructure. Set `ALLOW_MYSQL_TESTS=1` and `SMOKE_STORAGE_DRIVER=mysql` after starting the project test database; the harness obtains a new SQL adapter for its application-restart check and cleans up its generated database. The browser receives no DB credentials and never connects directly. See [mysql.md](mysql.md).

Phase 8 adds `npm run test:e2e`, using Playwright with installed Chrome and real temporary Vite/Express/Python services. It uses an isolated browser profile/cache, fictional data and ephemeral credentials; see [security-review.md](security-review.md) for prerequisites, executed workflows and results. Mobile tables now scroll at a readable width within named, keyboard-focusable regions. Screen-reader and formal contrast certification remain outside the performed checks.

Phase 7 extends this client with `Verification.jsx`/`verification.css`: owned-record issuance/PNG download and revocation within student detail, plus a public payload-entry screen reachable before or after login. Reviewers/verifiers gain this minimal status screen without gaining student/compliance/ML access. POST `/api/v1/verification/issue`, `/revoke` and public `/verify` use the existing centralized API service and in-memory request handling. No camera/image scanner is claimed. The existing HTTP smoke now also covers QR issuance/public checking/outdated/revoked outcomes. See [verification.md](verification.md) for setup, privacy and integrity/currentness semantics.

React function components, JavaScript and plain CSS run through Vite. No large UI framework, client-side authentication substitute or new backend endpoint was added. Existing Express policy, API contracts, JSON storage, ML boundaries and regression tests are unchanged.

## Structure and responsibilities

- `frontend/src/api.js`: same-origin API base, credentialed fetch, 15-second timeout, in-memory CSRF, safe status errors and session-expiry notification. Old in-flight responses are discarded after a session change. Mutations are never automatically retried.
- `contracts.js`: validates response fields consumed by views before rendering.
- `App.jsx`: history-based public routes (`/`, `/login`, `/verify`, `/workspace`), authentication bootstrap, login/logout, user identity, role-aware navigation and in-memory ML result lifecycle.
- `Landing.jsx`: public institutional landing page with capability, workflow, security, and prototype-limit disclosures. It has no live statistics or privileged API calls.
- `students.jsx`: paginated exact filters, detail, create/edit validation and writable-field allowlist.
- `Import.jsx`: bounded file selection, row classifications, explicit native-modal confirmation, server-confirmed import result and uncertain-commit recovery.
- `Reviews.jsx`: live institution overview, saved deterministic findings and freshness, policy-based capacity comparisons, separate explicit ML evaluation.
- `ui.jsx` / `styles.css`: shared controls, tables, pagination, status messages, submission lock, focus-visible styling, responsive layout and modal focus handling.
- `src/test/`: Vitest/Testing Library tests; `scripts/smoke-local.mjs`: actual Vite-to-Express HTTP contract smoke with isolated generated credentials and fictional fixtures.

## Session and API integration

On load, GET `/api/auth/csrf` obtains a token and GET `/api/auth/me` checks the session. Login POST sends only normalized email/password and the CSRF header. It installs the rotated token in module memory. Logout POST uses that token and clears the UI only when confirmed (or a 401 invalidates the session). No password, cookie, CSRF or import token is stored in browser storage. Password input is cleared after every login attempt.

Institution roles call the existing `/api/v1/students` list/detail/create/PATCH and `/import/preview`, `/import/commit`; `/api/v1/compliance/summary`, `/findings`, `/evaluate`; and `/api/v1/ml/evaluate`. Institution ownership comes from Express. No institution-switch control exists. Reviewer/verifier/unknown roles call only authentication endpoints and see no student/compliance/ML navigation or counts. UI visibility is not a security boundary.

The browser never contacts FastAPI and never receives its key. `VITE_API_BASE_URL` is a public same-origin relative path (default `/api`), not a secret or a Python URL. The local Vite proxy forwards it to Express without rewriting Origin. Configure backend `APP_ORIGIN=http://127.0.0.1:5173`. Both Vite dev and build-preview bind loopback with strict port 5173. Session cookies remain HttpOnly and SameSite=Strict; backend CSRF/origin checks remain enabled.

## Data and workflow interpretation

Student lists omit APAAR values visually; authorized detail/edit screens show them when needed. Input remains text to preserve leading zeroes. Exactly twelve digits is a syntax check, never official identity verification. Required references are validated by Express. There is no reference-list API: enter the existing programme ID supplied by the local administrator. With untouched demo seeds, `DEMO-INST-001` owns `DEMO-PROG-001` and `DEMO-INST-002` owns `DEMO-PROG-002`. These reference examples are documentation, not hardcoded live UI options.

CSV preview is not an import. All row numbers, classifications and field errors are rendered as text; only a fully valid server preview can be confirmed. Tokens stay in memory and are discarded on file change, navigation, session expiry or commit attempt. Expired/used/revalidated previews require a fresh preview. An uncertain write response must be reconciled against the student list before retrying; no partial import or durable receipt is claimed. Same-screen duplicate submissions are locked, while backend replay/concurrency safeguards remain authoritative.

Compliance severity and rule code are displayed alongside explanation, context, recommended action and deterministic mismatch versus manual-review kind. Summary counts are findings, not unique students. Intake comparisons show unknown counts when policy is absent rather than inventing capacity conclusions. The saved evaluation timestamp and checked freshness are visible. Changes do not silently trigger evaluation.

ML uses only the Express aggregate endpoint. It displays model version, threshold, score (not probability), review flag, missing features, skipped records and staleness. An unavailable/failed service has no normal score or zero-review conclusion. No eligible data means no assessment. Current-session ML results are cleared after local student writes/imports; other-tab/external changes are not pushed to the client, so explicitly reevaluate after changes. This synthetic model cannot establish fraud or official authenticity.

## Checks and limits

Use the exact PowerShell setup/start/test commands in README. Frontend tests exercise auth success/failure/expiry/logout, all roles and restricted calls, student validation/create/edit/detail/filter/pagination, repeated submit suppression, CSV confirmation/errors, compliance staleness and evaluation failures, ML unavailable/rendering, safe response handling, timeout and old-session response rejection. The HTTP smoke exercises real cookie/CSRF forwarding, student create/edit/list/detail, CSV preview/commit/replay, evaluation/staleness, explicit ML failure, logout and reviewer denial; it does not use runtime `data/local/`.

Native labels, buttons, semantic tables, live status/alert regions, skip link, visible focus, responsive overflow and a native modal support keyboard access. jsdom does not replace browser/screen-reader testing. Phase 8's Chrome workflow checks actual keyboard/dialog behavior and desktop/mobile rendering; it does not certify all assistive technology or contrast requirements. Test fixtures use mocked HTTP only for component tests; the separate HTTP smoke tests real Express contracts. The Phase 5 ML smoke and Phase 8 browser workflow test real Python inference.

Navigation and form drafts are memory-only. Public routes remain available on refresh; `/workspace` rechecks the session and redirects an unauthenticated visitor to `/login`. There are no reference-edit APIs, autosave, realtime cross-tab synchronization, production hosting or durable ML history. Sessions and rate limits remain in memory. QR and explicitly selected MySQL are implemented in Phases 7/9 as described above; official APAAR APIs and production deployment remain deferred. [Phase 10 acceptance](final-acceptance.md) records the current MySQL-backed browser results, including ML stop/recovery.
