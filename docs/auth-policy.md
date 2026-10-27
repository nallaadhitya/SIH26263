# Access policy (through Phase 9)

Phase 9 changes persistence, not permissions. MySQL stores the same public account/profile fields and bcrypt hashes; role/scope/status checks and session/CSRF contracts remain. SQL write transactions include account/reference checks with shared row locks and serialize permission-sensitive mutations. Sessions still use the existing process-memory store. See [mysql.md](mysql.md); JSON-specific limitations in earlier phase notes apply to fallback.

`GET /api/auth/me` exposes the caller's public account profile. Phase 3 adds institution-scoped student APIs under `/api/v1/students`. Login, logout, and CSRF bootstrap retain `/api/auth/` as explicitly requested.

Student and compliance access use explicitly scoped capabilities. Cross-institution regulatory summaries remain deferred. Phase 7 adds a minimal public artifact-status check, with separate institution-scoped issuance/revocation permissions.

| Role | Reserved capabilities | Institution restriction |
| --- | --- | --- |
| institution_admin | institution:read, institution:manage, student:read:own, student:write:own, student:import:own, compliance:read:own, compliance:evaluate:own, ml:evaluate:own, verification:issue:own, verification:revoke:own | Own institution only |
| institution_operator | institution:read, student:read:own, student:write:own, student:import:own, compliance:read:own, compliance:evaluate:own, ml:evaluate:own, verification:issue:own, verification:revoke:own | Own institution only |
| regulatory_reviewer | regulatory:summary | Only a future explicitly designed, aggregate/de-identified summary; no raw records |
| authorized_verifier | verification:request (reserved) | Public artifact-status check only, also available anonymously; no student browsing |

No role receives unrestricted `student:read`. Reviewers and verifiers cannot list, retrieve, create, update, preview, or import student records. Undefined roles or permissions are denied. Institution accounts must reference an existing institution at login and on subsequent requests. API input cannot choose the authenticated role or institution. Phase 3 explicitly permits both institution admins and operators to manage their own students; it does not grant operators general institution-management permission.

Phase 4 permits both institution roles to evaluate and read only their own compliance findings and aggregates. Reviewers and verifiers are denied all compliance endpoints, including summary counts; the reserved `regulatory:summary` capability does not authorize these endpoints. No cross-institution aggregate disclosure or minimum aggregation threshold policy has been adopted, so those roles cannot infer restricted student counts through this API. See [compliance-api.md](compliance-api.md).

Phase 5 grants `ml:evaluate:own` only to institution admins/operators. The Express ML route retains authentication, CSRF, institution checks and rate limits, then reloads permissions again before releasing results from Python. Role/status/institution changes during inference can deny the response. Reviewers/verifiers receive no ML result or aggregate access. Python receives only numeric feature rows and requires a separate local shared service key; it never receives the user's cookie or session. Browser clients cannot authenticate to the internal Python API with an Express cookie. See [ml-service.md](ml-service.md).

## Middleware integration

Phase 7 permits admins/operators to issue and revoke artifacts for institution-owned records using session/CSRF and central permissions, with account checks repeated inside queued operations. Reviewers/verifiers are denied issuance/revocation. POST `/api/v1/verification/verify` is deliberately public, read-only and rate-limited; it grants no record access, requires the complete signed text, and returns only status/integrity/currentness/check time plus the explicit lack of official APAAR verification. It does not use the reserved verifier capability to authorize student data. See [verification.md](verification.md).

`createAuth({ store })` in `backend/auth/index.js` returns an auth router plus reusable `sessionMiddleware`, `requireAuthentication`, and `requireCsrf` middleware. The server creates one instance, using one shared JSON store. Reuse this same auth instance when future domain routes are approved so they use the same session store.

For a protected route, apply middleware in this order:

1. Session middleware.
2. `requireAuthentication` to load the current account from JSON and validate status/role/scope.
3. `requireCsrf` for mutations (the middleware allows safe methods through).
4. `requirePermission(permission)` from `backend/auth/policy.js`.
5. For institution resources, `requireInstitution(resolveInstitutionId)` from that module.

For collection routes, derive scope from the authenticated account and constrain queries accordingly. For a route to an existing record, load the record and derive the institution from that persisted record, not from a submitted body/query institution ID. An institution URL parameter is suitable only when it identifies the institution resource itself. Always apply both the capability and institution checks before returning or mutating data. Do not interpret a reviewer capability as permission to return arbitrary cross-institution records.

The original Phase 2 synthetic-resource tests are preserved. Phase 3 tests additionally exercise real student routes, institution isolation, and changes to account permissions between preview and commit. [Student API documentation](students-api.md) describes the route behavior and import limits.

## Accounts and sessions

Phase 8 adds a central `assertCurrentAccess` checkpoint before student create/PATCH, CSV commit and compliance snapshot persistence. It reloads the account, capability and institution after queue waits, denying deactivated accounts or changed scope/roles before mutation. This does not make account/reference/student files a transaction and does not cancel or roll back every operation already in flight. See [security-review.md](security-review.md) for executed queued-change regressions and remaining boundaries.

Accounts contain `id`, `displayName`, normalized `email`, `passwordHash`, `role`, `institutionId` (or null), `status`, `createdAt`, and `updatedAt`. Demo seeding uses stable IDs and reserved `.example` emails. Timestamps reflect actual creation; repeated seeding preserves the records. No public registration or account-update endpoint exists.

Session state contains a user ID, an absolute expiry, and a random CSRF token. Passwords and account hashes are not stored in cookies or session state. Login regenerates the session to prevent fixation. Logout destroys the server session and clears the cookie, so a captured cookie cannot be replayed afterwards. Sessions are intentionally ephemeral; user records remain in local JSON.
