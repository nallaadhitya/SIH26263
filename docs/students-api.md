# Student management API — Phase 3

Phase 9 preserves this REST contract with explicitly selected MySQL storage. Student validation/duplicate checks, current-account checks, private revision updates and CSV bulk persistence share real SQL transactions. Database uniqueness is scoped to institution/APAAR; leading zeroes remain text. References and actor IDs are enforced with foreign keys. No delete API is added; SQL restricts deletion of referenced history. JSON file/rename limitations below describe the retained JSON fallback. See [mysql.md](mysql.md).

This is a fictional-data local prototype. Numeric APAAR values in fixtures are synthetic format examples, not issued identities. Exactly 12 digits is a syntax rule only: official APAAR authenticity is **not verified**, and no government database is queried. Do not import real student records.

## Authorization and common behavior

The base path is `/api/v1/students`, following `AGENTS.md`'s versioned domain-API convention. The unversioned `/api/students` alias is intentionally not registered. Existing `/api/auth/*` and `/api/health` routes are unchanged.

All endpoints require the existing session cookie. POST/PATCH also require the current `X-CSRF-Token` from login. Use GET `/api/auth/csrf` before login and the rotated token returned by successful login afterwards. Student responses use `Cache-Control: no-store`.

Phase 4 adds a separate [explicit compliance evaluation workflow](compliance-api.md). Student create, PATCH and CSV commit do not write compliance findings. Existing saved evaluations become stale when their relevant inputs change, and compliance reads report that staleness until an authorized user evaluates again.

Both `institution_admin` and `institution_operator` receive `student:read:own`, `student:write:own`, and `student:import:own` through the central policy. All student endpoints deny `regulatory_reviewer` and `authorized_verifier`. No cross-institution student access is granted. See [auth-policy.md](auth-policy.md).

The current account is reloaded for every request. Lists filter by that account's institution. Create defaults the institution from the account; an explicitly supplied institution must match exactly. Record lookups and updates use persisted ownership. A record outside the caller's institution returns the same 404 as an absent record. Body/query/CSV institution changes never change the authenticated scope. No duplicate check reveals another institution's identifiers.

## Data model

Phase 7 preserves the public field allowlist. Relevant PATCH changes additionally set a private `verificationRevision` marker in the same atomic student write; clients cannot supply or read it. New/imported records keep their prior shape, and legacy records need no migration. This marker plus private content fingerprints invalidates older signed artifacts, including after API edit-and-restore. No-op edits do not invalidate artifacts. See [verification.md](verification.md) for issuance rules and single-process guarantees. Student mutations still do not write compliance findings or verification artifacts to a second file.

| Field | Rules |
| --- | --- |
| id | Server-generated UUID v4, immutable |
| apaarId | Required string of exactly 12 ASCII digits; leading zeroes preserved |
| studentName | Required text, at most 256 characters |
| institutionId | Existing institution; must match the account; defaults from the account on JSON create |
| programmeId | Required existing programme belonging to that institution |
| academicYear | Required consecutive `YYYY-YYYY` years, 2000–2099, such as `2026-2027` |
| admissionYear | Required four-digit string, 2000–2099, no later than academic start year |
| admissionCategory | `general`, `obc`, `sc`, `st`, `ews`, `other`, `not_specified`; defaults to `not_specified` |
| status | `active`, `inactive`, `graduated`, `withdrawn`; defaults to `active` |
| createdAt, updatedAt | Server-generated ISO timestamps |
| createdBy, updatedBy | Server-derived user IDs; original creation metadata is preserved on PATCH |

All submitted values must be strings, at most 256 characters and without control characters. Values are trimmed for validation/storage; institution scope must match before normalization. Blank required values fail. Unknown JSON fields and client-assigned metadata are rejected. PATCH accepts a nonempty subset of writable fields, merges with the current stored record, then revalidates the whole record. No additional personal information is stored.

Reference schema is unchanged: institutions use `id`; programmes use `id` and `institutionId`. The demo programme `DEMO-PROG-001` belongs to `DEMO-INST-001`, and `DEMO-PROG-002` belongs to `DEMO-INST-002`. Approved intakes remain untouched.

## Endpoints

| Method/path | Behavior |
| --- | --- |
| GET `/api/v1/students` | Returns `{ records, page, pageSize, total }`, scoped to caller |
| GET `/api/v1/students/:id` | Returns `{ student }` or 404 |
| POST `/api/v1/students` | Creates one validated record; 201 `{ student }` |
| PATCH `/api/v1/students/:id` | Updates one authorized record; 200 `{ student }` |
| POST `/api/v1/students/import/preview` | Accepts multipart CSV; returns validation report and optional preview token; no storage writes |
| POST `/api/v1/students/import/commit` | Accepts JSON `{ "previewToken": "..." }`; revalidates and atomically inserts all rows; 201 `{ imported }` |

Lists support `page` (default 1), `pageSize` (default 20, maximum 100), and exact `programmeId`, `academicYear`, `status` filters. An optional `institutionId` filter must match the account. Unsupported query fields or invalid pagination return 400. Ordering is ascending creation time then internal UUID. Full records, including APAAR strings, are returned only to permitted institution users; response fields are explicitly allowlisted.

JSON create example (synthetic identifiers):

```json
{
  "apaarId": "000000000001",
  "studentName": "Fictional Demo Learner",
  "programmeId": "DEMO-PROG-001",
  "academicYear": "2026-2027",
  "admissionYear": "2026",
  "admissionCategory": "general",
  "status": "active"
}
```

## CSV format and limits

Upload one file in multipart field `file`, with a `.csv` filename and MIME `text/csv`, `application/csv`, or `application/vnd.ms-excel`. No additional multipart fields/files are accepted. Filename and MIME checks are only the first gate; UTF-8 decoding, CSV syntax, headers, fields, references, and scope are also checked on the server. Files remain in memory and are never saved as uploads. Parsing uses [csv-parse](https://csv.js.org/parse/options/) and bounded multipart uploads use [Multer](https://expressjs.com/en/resources/middleware/multer/).

- Maximum file size: 256 KiB; empty uploads fail.
- Maximum data rows: 500; at least one row is required.
- Maximum field length: 256 characters; maximum parsed record size: 4096 characters.
- Required headers: `apaarId,studentName,institutionId,programmeId,academicYear,admissionYear`.
- Optional headers: `admissionCategory,status`.
- Header order may vary. Names are exact, case-sensitive, unique; unknown, missing or duplicate headers fail.
- UTF-8 BOM, CRLF, quoted delimiters and escaped quotes are supported. Embedded newlines are parsed correctly but fail the field control-character rule. Non-UTF-8 and malformed quotes fail safely.
- Blank rows are reported as invalid; they are never silently dropped. Extra/missing columns invalidate the affected row. Row numbers count logical CSV records starting at 2 after the header, including blank records; quoted newlines do not create additional logical rows.

Use [data/demo/students-template.csv](../data/demo/students-template.csv), which references the seeded institution/programme. Keep APAAR cells as text in spreadsheet editors so they do not strip zeroes before upload.

## Preview, review, commit

1. Authenticate and upload CSV to `/import/preview` with CSRF. Scope violations reject the request with 403. Structural file errors return 400/413/415. Preview uses read-only JSON reads: even missing collections are not initialized.
2. Inspect `{ summary, rows, authenticityVerified: false }`. Summary counts `total`, `valid`, `invalid`, `duplicate`, and `conflict`. Rows report `rowNumber`, `classification`, and static field/code/message errors without echoing names or APAAR values.
3. Only an entirely valid batch receives a cryptographically random `previewToken` plus `expiresAt`. The server retains a private copy of the parsed contents. The token is bound to the user ID, institution, and login session; it expires after 10 minutes. Restart clears previews. At most 100 pending previews are retained per process; expired entries are pruned when creating previews.
4. Commit only `{ previewToken }` with CSRF. Client-supplied rows, approval flags, institution changes or preview reports are rejected. Session and account permissions are checked again. All retained rows are revalidated against current reference and student records inside the existing serialized `students` update operation.
5. Duplicate/invalid/conflicting rows abort the entire batch with 409. No valid subset is inserted and no records are overwritten. On success, one atomic collection replacement inserts every row with server IDs and audit metadata. The token is consumed. Concurrent/repeated attempts cannot duplicate records; a consumed/in-progress token returns 409. Different previews for the same IDs are caught by serialized revalidation.

`duplicate` means the same APAAR and normalized record fields repeat within the institution/import. `conflict` means that APAAR is associated with differing record fields and requires human review. Invalid fields take classification precedence, with duplicate/conflict details retained in row errors. These categories do not assert fraud. APAAR duplicates outside the permitted institution are intentionally not checked or disclosed. This phase models one institution record per APAAR; multi-enrolment/history needs a later explicit model.

## Errors and persistence limitations

Phase 8 rechecks current account permission/institution inside queued student/CSV mutations before persistence. The adapter now coordinates first-time initialization across concurrent readers/writers and refuses `writeCollection` replacement over corrupted JSON. Repair corrupt files explicitly with the service stopped and a protected local backup. The existing single-process/multi-file limitations below still apply. See [security-review.md](security-review.md).

- 400: invalid request shape, UUID, pagination, CSV syntax/header or multipart limits.
- 401: missing, invalid, expired or inactive authentication.
- 403: role, institution or CSRF denial.
- 404: absent or inaccessible student record.
- 409: duplicate/conflicting record, changed import, expired/consumed/unavailable preview.
- 413: file/body too large or empty CSV upload.
- 415: unsupported uploaded file type.
- 422: invalid student field/reference values; response includes static validation details.
- 429: import request limit or pending preview capacity reached.
- 500: storage/internal failure; no paths, record values, credentials or stack traces are returned.

Import preview and commit share a 20-request/IP/15-minute limit; normal authentication limits still apply separately. No request bodies or APAAR IDs are logged by these handlers.

All student writes use the existing `JsonStore.updateCollection` per-collection queue and temporary-file rename, with duplicate checks inside the queue. A failed rename preserves the last complete file and removes the temporary file; the preview remains retryable. Tests inject rename failure and verify byte-for-byte preservation and successful retry. A process crash after rename but before response can leave a completed import without a success response. After restart, authenticate again and inspect records: replayed contents will be caught as duplicates, but durable import receipts are not implemented.

Run exactly one backend process sharing one adapter. The JSON queue is not a cross-process lock; reference/account files and students are not a multi-file transaction. Requests already in progress can race with direct external edits to accounts/reference JSON. Do not edit live JSON or run seeding concurrently with writes. Atomic rename prevents partial imports from ordinary write failures; power-loss durability and file/directory fsync are not guaranteed by the Phase 1 adapter. Runtime JSON stays ignored under `data/local/`; test artifacts use ignored, project-local directories.

## Local checks

From the project root:

```powershell
cd backend
npm ci
npm run seed:demo
# Configure DEMO_ACCOUNT_PASSWORD locally and run npm run seed:accounts if needed.
npm test
npm run dev
```

The complete suite retains all Phase 1/2 tests and adds student role/isolation, validation, CSV limits, no-write preview, token binding, commit revalidation, concurrency, safe responses and write-failure recovery tests. Frontend, analytics, ML, QR, MySQL and government integrations are outside this phase.
