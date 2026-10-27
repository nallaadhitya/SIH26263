# Phase 7: EduVerify QR verification

Phase 9 preserves these cryptographic/API semantics with transactional MySQL persistence when selected. The artifact collection maps to `verification_records`; student/version/actor checks coordinate within a database transaction rather than a JSON-only instance queue. QR keys must also be distinct from the database password and never enter tables. JSON-specific file limitations below describe the retained fallback. See [mysql.md](mysql.md) and [storage-interface.md](storage-interface.md) for current transaction, key/backup and restrictive deletion behavior.

This local feature verifies an **EduVerify-issued artifact**. A valid HMAC establishes integrity under a configured EduVerify key; a separate storage check establishes whether its signed snapshot matches the source record at check time. Neither result proves a student's identity, official APAAR authenticity, source-data correctness, regulatory approval or overall compliance. All demonstration records must remain fictional.

## Threat model and disclosure

The design addresses altered/unsigned/malformed QR text, forged or guessed artifact references, use of expired/revoked/outdated artifacts, unauthorized issuance/revocation, institution switching, ordinary write failures and concurrent edits through this single backend instance.

The backend process, dedicated signing keys, JSON filesystem and local clock are trusted. Someone with local process/filesystem access can compromise these assumptions. An authorized issuer can enter incorrect source data; signing does not make that data correct. A QR can be copied and replayed during its validity period; possession never identifies the presenter. This is an online status check, not an offline certificate or regulatory attestation.

Verification is public, read-only and accepts **only the complete signed payload**, not a student/APAAR/artifact lookup query. Public results contain no names, APAAR values, student IDs, institution IDs, programme IDs, record fields, key IDs, signatures or storage paths. Invalid/unknown artifacts receive the same `invalid` shape; random references alone cannot query record existence. A holder of a legitimately issued payload can learn its status, which is the intended disclosure. Rate limiting is per direct IP, with no proxy-trust change.

## Cryptographic and QR design

The backend uses Node's standard `crypto.createHmac('sha256', key)` and `crypto.timingSafeEqual` on equal-length 32-byte MACs. See the [Node crypto API](https://nodejs.org/api/crypto.html). HMAC suits this single trusted local verifier: the same secret authenticates issuance and verification. Every key holder could generate MACs, so this is not a publicly independently verifiable digital signature. A future externally verifiable design would require separate reviewed asymmetric keys and distribution policy.

The QR library is [`qrcode` 1.5.4](https://github.com/soldair/node-qrcode), returning PNG images at 420 pixels with error correction M and a four-module quiet zone. The image contains raw signed text, not a link or student record. No PII is placed in filenames or URLs. Download filenames use only an opaque artifact UUID.

Payload JSON fields, in exact order:

| Field | Meaning |
| --- | --- |
| `v` | Integer schema version, currently 1 |
| `iss` | Fixed `eduverify-local` issuer identifier |
| `kid` | Configured key ID, 1–32 ASCII letters/digits/underscore/hyphen |
| `aid` | Random opaque artifact UUID v4; not a student ID |
| `rev` | Random opaque snapshot revision UUID v4; bound privately to the record fingerprint |
| `iat` | Integer issue time, UTC Unix seconds |
| `exp` | Exactly `iat + 86400`: 24-hour expiry |
| `sig` | Unpadded canonical base64url HMAC, 43 characters |

The MAC input is UTF-8 `EduVerify QR HMAC-SHA256 v1\n` followed by `JSON.stringify([v, iss, kid, aid, rev, iat, exp])`. Exact field order, types and allowed values are validated before comparison. The accepted outer JSON must be exactly the compact representation emitted by issuance: unknown/missing fields, duplicate keys, reordered fields, extra whitespace, unsupported versions, future issue times, noncanonical encodings and payloads over 2048 UTF-8 bytes are rejected. Paste the issued text unchanged; the UI trims surrounding whitespace only.

The private fingerprint is SHA-256 over a fixed-order array containing internal student ID, private edit marker (or null for legacy/unmodified records), and all writable student fields. **The fingerprint is never in the QR or public responses**; `rev` is a random reference to that private snapshot. The database must contain a matching persisted issuance envelope as well as a valid MAC. No unsigned or keyless fallback exists.

## Dedicated local key setup

From the project root in the backend PowerShell terminal:

```powershell
cd backend
# Generates a NEW key without printing it or putting its value in command history.
$env:QR_ACTIVE_KEY_ID = 'local-1'
$env:QR_SIGNING_KEYS = node -p "JSON.stringify({'local-1':require('node:crypto').randomBytes(32).toString('base64')})"
$env:APP_ORIGIN = 'http://127.0.0.1:5173'
npm ci --cache .npm-cache
npm run dev
```

Keep the existing `ML_SERVICE_KEY` configuration separately if using ML. Never reuse the ML key or session secret for QR. The key ring must be a JSON object mapping 1–5 distinct IDs to distinct, canonical standard-base64 values encoding **exactly 32 random bytes**. Configuration rejects direct reuse of the currently configured ML/session secret in encoded or raw form. Independent generation remains required; historical reuse cannot be detected.

Do not display, log, commit or add these values to `VITE_*` variables. `backend/.env` is ignored and may hold a persistent local key ring; protect it using local OS access controls. For a `.env` entry, use `QR_SIGNING_KEYS='{"local-1":"YOUR_LOCALLY_GENERATED_BASE64_VALUE"}'` and `QR_ACTIVE_KEY_ID=local-1`, substituting the locally generated value without committing it. This placeholder is not a usable key. Do not regenerate keys on every restart if existing artifacts must remain verifiable.

No configuration: other application workflows remain available, but issue/verify return 503. Malformed key rings fail closed. With a valid retained ring but missing/unknown active ID, issuance returns 503; retained keys can still verify existing artifacts. Unknown payload key IDs return `invalid`, not unsigned acceptance. Revocation needs authorization/storage but does not require an available signing key.

For rotation, stop the backend; retain the old key and add a new, independently generated key under a new ID, then select the new active ID and restart. Old payloads remain verifiable with the retained key until expiry/revocation. Never change key material under an existing ID. Removing a key makes all its artifacts `invalid`, including otherwise unexpired ones. For compromise, remove the affected key and revoke affected artifacts through an authorized local workflow; restore service with a new key ID. Protect keys and data together in local backups. Loss of keys prevents their MAC verification; recreating a different key does not recover old artifacts. Restoring older data can undo revocation/edit markers: reconcile backups before trusting restored status. There is no anti-rollback storage or automatic key rotation.

## Issuance policy and endpoints

All routes use `/api/v1/verification`, set `Cache-Control: no-store`, reject query parameters and allow only the stated body fields. Backend permission checks remain authoritative.

| Endpoint | Access/body | Result |
| --- | --- | --- |
| POST `/issue` | Institution admin/operator; session + CSRF; `{ "studentId": "<owned UUID>" }` | 201: opaque artifact/revision, issuer, issue/expiry time, signed `payload`, PNG `qrDataUrl`, `officialApaarAuthenticity: "not_verified"` |
| POST `/verify` | Public; `{ "payload": "<exact signed QR text>" }`; no session or CSRF required | 200: minimal status result below |
| POST `/revoke` | Institution admin/operator; session + CSRF; `{ "artifactId": "<owned artifact UUID>" }` | 200 `{ "status": "revoked" }`; repeat is idempotent |

Issuance requires an existing institution-owned, active student with valid current application fields and institution/programme references, and no duplicate/conflicting APAAR within that institution. The backend never reveals another institution's ownership/duplicates. A foreign/missing source ID produces the same 404. No saved compliance evaluation, ML score or regulatory approval is required or implied. Record validation is the existing student validator, not a government verification service.

Institution admins/operators receive `verification:issue:own` and `verification:revoke:own`. Reviewers/verifiers cannot issue/revoke or browse students; they can use the same minimal public verification check as anyone else. Accounts are reloaded inside queued issuance/revocation, and issuance rechecks permissions again after asynchronous QR generation before saving. Process-local limits are 60 public checks/IP/15 minutes and 20 combined issuance/revocation requests/IP/15 minutes. Existing authentication limits still apply.

Public verification result:

```json
{
  "status": "valid",
  "integrityValid": true,
  "recordCurrent": true,
  "checkedAt": "<server ISO timestamp>",
  "officialApaarAuthenticity": "not_verified"
}
```

| Status | Integrity | Current | Interpretation |
| --- | --- | --- | --- |
| valid | true | true | MAC, persisted issuance and current private record fingerprint match at check time |
| invalid | false | null | Payload/signature/key/issuance cannot be validated; no current-record assertion |
| revoked | true | null | Authentic persisted artifact was explicitly withdrawn; current record not assessed |
| expired | true | null | Authentic persisted artifact passed its expiry; current record not assessed |
| outdated | true | false | Authentic artifact's source record disappeared/changed, including ownership changes |

Malformed body envelopes return 400. Malformed payload text returns 200 `invalid`. A valid MAC without a persisted matching issuance is invalid; integrity is intentionally not disclosed independently for unknown artifacts. Revoked takes precedence over expired, then source-version status is checked. Missing key configuration is 503; corrupt/unreadable JSON or failed writes return a safe 500; malformed relevant persisted envelopes return 503. These service errors never become a successful verification outcome. Invalid source requirements return 422, auth/permissions use 401/403, and rate limits return 429. No secret or signature failure internals are echoed.

## Versioning, concurrency and auditability

Issuance stores a `kind: verification-artifact`, schemaVersion-1 envelope in the already-approved `verification-records` collection. It contains opaque artifact ID, internal student/institution references, private fingerprint, signed claims (without MAC/key), issuer user/time, status and optional revoker user/time. No student names, APAAR values or signing secrets are copied there. Existing unrelated entries are preserved. Issuance/revocation envelopes provide the audit trail; no second audit-file write is claimed to be atomic.

New/imported students keep their previous creation shape. On a relevant API PATCH, `StudentService` adds/changes a private random `verificationRevision` marker in the **same atomic students write**. API responses still use the original allowlist, so this field is not exposed or accepted in requests. Subsequent relevant edits, including restoration of old field values, generate a different marker and cannot revive older artifacts. Legacy records need no migration: their original fingerprint uses null for the marker; the first edit activates it. No-op edits and audit-only timestamp changes do not invalidate artifacts. Name, APAAR, institution, programme, year, category and status all affect the fingerprint. Deletion/missing records yield outdated. Compliance evaluations and ML inference do not alter the student revision or issue artifacts.

`JsonStore.withCollectionLock` reuses the existing per-instance write queue for coordinated reads without rewriting data. All verification paths acquire locks in students → verification-records order. Issuance holds the student queue while validating, rendering and persisting; verification holds both queues while reading and comparing. Student API writes already participate in that same queue; revocation uses the existing artifact update queue. Failed artifact writes release no payload and preserve prior bytes through atomic rename. A write followed by a lost HTTP response may leave a saved artifact; repeating issue creates another independently revocable artifact, not a durable idempotent receipt.

This is **one process, one shared JsonStore instance** coordination, not an OS lock or multi-file transaction. Account/reference files are not locked together with students/artifacts, so direct external edits can race; do not edit live JSON or seed while the service is active. Another process bypasses these queues. External content changes are detected when they differ at check time, but an external edit-and-restore/backup rollback can defeat historical invalidation. Local privileged modification of artifacts/status/keys is outside the threat model. No fsync/power-loss, append-only history, tamper-evident filesystem or permanent-current guarantee is claimed. `checkedAt` is a point-in-time observation; a later edit/revocation can change the next result.

## PowerShell API example

After following README login instructions, before logging out (use `http://localhost:5000` with its matching origin for direct API testing, or the configured UI origin through Vite):

```powershell
# Obtain an actual owned UUID from the existing authorized student list.
$students = Invoke-RestMethod "$baseUrl/api/v1/students?page=1&pageSize=20" -WebSession $authSession
$issueBody = @{ studentId = $students.records[0].id } | ConvertTo-Json
$issued = Invoke-RestMethod "$baseUrl/api/v1/verification/issue" -Method Post -WebSession $authSession -ContentType 'application/json' -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -Body $issueBody
$verifyBody = @{ payload = $issued.payload } | ConvertTo-Json
# Public: deliberately no WebSession.
Invoke-RestMethod "$baseUrl/api/v1/verification/verify" -Method Post -ContentType 'application/json' -Body $verifyBody
$revokeBody = @{ artifactId = $issued.artifactId } | ConvertTo-Json
Invoke-RestMethod "$baseUrl/api/v1/verification/revoke" -Method Post -WebSession $authSession -ContentType 'application/json' -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -Body $revokeBody
```

## Frontend and tests

Start Express with keys and the exact Vite origin as above, then `cd frontend; npm run dev` in a separate terminal starting from the project root. Open `http://127.0.0.1:5173`. Institution users open Students → View → Issue QR artifact, then download the PNG or copy the signed text; revocation requires explicit confirmation. The Verification screen accepts text and shows signature/current status separately. It is also accessible from the login page without authentication, and from reviewer/verifier navigation. Payloads/results are memory-only; nothing is placed in URLs, local/sessionStorage or application logs.

Camera scanning and QR image decoding/upload are not implemented. Payload entry is the tested local workflow; use an external reader that returns plain QR text if needed, and do not upload artifacts/student data to online decoders. Manual camera/screen-reader/browser testing is not claimed by jsdom tests. A downloaded QR may become revoked, expired or outdated after download; check online each time. The UI can revoke its most recently issued artifact; older artifacts can be revoked through the authorized API using their opaque ID. There is no artifact-list endpoint or public student detail lookup.

From the project root, use separate PowerShell blocks:

```powershell
cd backend
npm test
npm run smoke:ml
```

```powershell
cd frontend
npm test
npm run build
npm run smoke:local
```

```powershell
cd ml-service
.\.venv\Scripts\python.exe -m pytest -q
```

New backend tests use deterministic test-only keys and an injected clock. They cover MAC tampering, canonical parsing, unsupported versions/key IDs, invalid/missing/reused keys, rotation, privacy, expiry, revocation, every relevant source field, edit-and-restore, role/scope/CSRF checks, request limits, concurrent issuance/edits, authorization changes during generation, corrupted storage, QR-render failure and failed atomic writes/retry. Frontend tests cover issuance/download/revocation, safe errors, duplicate submission suppression, minimal requests, all outcome states, inconsistent-response rejection and public/reviewer navigation. The HTTP smoke exercises real Vite/Express PNG issuance, anonymous verification, outdated and revoked results alongside the previous workflows; ML smoke still exercises actual Python inference. No tests write real runtime data or configure production keys.
