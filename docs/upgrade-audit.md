# Professional platform upgrade audit

Date: 2026-10-27. This audit was made from the implementation, tests, package manifests and existing phase evidence; documentation claims were not treated as implementation evidence.

## Baseline

The working tree was clean before this upgrade. The repository has one prior commit, `098ca21 Complete Phase 10 acceptance and SIH demo package`. The baseline backend Jest command completed successfully in this environment. MySQL-, browser-, and Python-dependent evidence is recorded in `docs/final-acceptance.md`, but those services were not assumed to be running for this upgrade.

## Implemented capability inventory

| Area | Status | Evidence and assessment |
| --- | --- | --- |
| Session authentication, CSRF, rate limits and role policy | IMPLEMENTED | `backend/auth/`, `backend/server.js`, `backend/test/auth.test.js` |
| Institution-scoped student CRUD and pagination | IMPLEMENTED | `backend/students/`, `frontend/src/students.jsx`, student API tests |
| Preview-token CSV validation and atomic commit | IMPLEMENTED | `backend/students/csv.js`, `service.js`, `frontend/src/Import.jsx`, student/workflow tests |
| Deterministic compliance evaluation/freshness | IMPLEMENTED | `backend/compliance/`, `frontend/src/Reviews.jsx`, compliance tests |
| ML aggregate review boundary | IMPLEMENTED | `backend/ml/`, `ml-service/ml_app/`, ML API/client/Python tests |
| Signed QR issuance, revocation and public status | IMPLEMENTED | `backend/verification/`, `frontend/src/Verification.jsx`, verification tests |
| MySQL adapter, migrations and controlled JSON support | IMPLEMENTED | `backend/storage/`, migrations, `mysql.test.js` |
| Institution dashboard | PARTIALLY IMPLEMENTED | It reads real scoped student and compliance data, but only exposes the metrics the current APIs provide. |
| Shared enterprise UI system and responsive shell | PARTIALLY IMPLEMENTED | Reusable primitives exist in `frontend/src/ui.jsx`; the shell and global visual system needed refinement. |
| Regulatory reviewer monitoring portal | MISSING | The policy correctly withholds student/compliance/ML data and the UI explicitly identifies regulatory monitoring as deferred. No authorized aggregate endpoint exists. |
| Reports/exports/audit-history UI | MISSING | No corresponding authorized API is present; implementing a static view would misrepresent the product. |
| Official APAAR verification or government integration | MISSING BY DESIGN | The implementation repeatedly documents that it checks format only. |
| Complete current-environment MySQL/browser/ML execution | NEEDS VERIFICATION | Historic evidence exists, but dependent services were not started in this UI-focused upgrade. |

## Reuse and change plan

The existing React pages, `api.js` validation boundary, role navigation gate, and UI primitives are reusable and retained. `App.jsx` and `styles.css` are the appropriate focused change points for Phase 1 because they improve the application shell without changing API contracts, permissions, persistence, or workflow semantics.

Relevant regression coverage: frontend workflow/API/verification tests, frontend production build, backend auth/student/compliance/ML/verification suites, and the existing optional MySQL and browser checks when their local prerequisites are available.

## Deliberate scope decisions

No regulatory dashboard, export, audit-history, global search, or notification feature was fabricated in the frontend. Each would require an authorized backend contract first. This upgrade therefore improves visual hierarchy, responsive behavior, role context, and states around the existing real workflows while preserving the restricted landing experience for regulatory and verifier roles.

## Role-portal follow-up

The Institution Portal is the existing admin/operator workspace. This follow-up adds a real `GET /api/v1/regulatory/summary` endpoint and AICTE Monitoring Portal for `regulatory_reviewer`; it returns only institution-level totals and an aggregate potential-conflict count, never student records or identifiers. The `authorized_verifier` now lands in a distinct Verification Portal that reuses the constrained signed-artifact checker. Submission tracking, regulatory resolution/audit history, exports, programme-reference management APIs, persisted verification requests/history, and official APAAR lookups remain **MISSING** because no safe server contracts or configured policy/data model currently support them.
