# Deterministic compliance engine — Phase 4

Phase 9 keeps rule/response semantics and freshness fingerprints. With MySQL selected, input reads, evaluation metadata and child findings are persisted in one database transaction; SQL snapshots use normalized envelope/finding tables. The JSON envelope described below remains the service representation and fallback format. No rule or official approval was introduced. See [mysql.md](mysql.md) for current persistence guarantees and migration rejection of invalid/ambiguous legacy data.

These local prototype checks compare fictional records with explicit reference data. They do not establish fraud, authenticate APAAR IDs, or contact a government service. Category labels, quotas, exemptions, and admission constraints are not assertions of official rules. No ML, dashboard, QR or database migration is included.

## Architecture and existing relationships

`backend/compliance/engine.js` is a pure evaluator: it accepts records, references and an observation timestamp, then returns findings and aggregates. It performs no I/O and does not read the clock. `service.js` handles scoped inputs, persistence and staleness; `router.js` handles HTTP using the existing auth instance and centralized policy. The existing JSON adapter and student/import write paths are unchanged.

Existing relationships are preserved:

- Institutions: `id`, `name`, `city`, `status`.
- Programmes: `id`, `institutionId`, `name`, `level`.
- Approved intake: `id`, `programmeId`, `academicYear`, `approvedSeats`; institution is derived from the programme's `institutionId`.
- Students: existing UUID `id`, `apaarId`, `studentName`, `institutionId`, `programmeId`, `academicYear`, `admissionYear`, `admissionCategory`, `status` and audit metadata. See [students-api.md](students-api.md).
- Application categories remain `general`, `obc`, `sc`, `st`, `ews`, `other`, `not_specified`. Student create/import contracts are unchanged. There is no independent academic-year or category collection; years follow existing student syntax and category/policy constants.

Only records attributable to the caller's institution are evaluated. Other institutions, orphan intakes whose programme ownership cannot be established, and records without an institution ID cannot safely be assigned to an institution user. They require a separately authorized reference/data repair process; this phase does not expose a global audit route. Wrong or unknown programmes on an institution-owned student still produce a reference finding without disclosing another institution's programme ID.

## Reference schema and legacy data

The smallest optional extension is a `countingPolicy` object on each approved-intake row:

```json
{
  "id": "DEMO-INTAKE-001",
  "programmeId": "DEMO-PROG-001",
  "academicYear": "2026-2027",
  "approvedSeats": 60,
  "countingPolicy": {
    "includedStatuses": ["active"],
    "categoryTreatment": {
      "general": "counted",
      "obc": "counted",
      "sc": "counted",
      "st": "counted",
      "ews": "counted",
      "other": "counted",
      "not_specified": "counted"
    },
    "admissionYearRange": { "min": "2026", "max": "2026" }
  }
}
```

This is the fictional **new demo row** policy, not an official admission policy. Existing rows are never patched by seeding. Repeated `seed:demo`/`seed:accounts` runs preserve existing records by ID. No mandatory migration is needed: legacy rows remain valid JSON and generate `INTAKE_POLICY_REVIEW` findings. Tests verify byte-for-byte preservation of legacy intake files and preservation of unrelated legacy validation issues.

If configuring existing fictional local reference data, stop the backend, retain a backup inside ignored `data/local/`, and add only the policy supported by your prototype's approved assumptions. Do not delete data to get a policy seeded. Restart and explicitly evaluate. There is no reference-write API in this phase.

`includedStatuses` is a nonempty unique list from existing statuses (`active`, `inactive`, `graduated`, `withdrawn`). Other known statuses are excluded from this capacity count. `categoryTreatment` is a nonempty map whose values are:

| Treatment | Meaning |
| --- | --- |
| counted | Count one valid, unique, eligible record against this base capacity |
| excluded | Count zero against this base capacity, only because the reference explicitly says so |
| review | Leave unresolved and require manual review |

Omitted categories require review for included statuses. In addition to existing categories, the evaluator recognizes explicitly configured `nri`, `oci`, `foreign_national`, and `supernumerary` treatments for inspecting legacy/reference-backed records. It invents no quota or exemption for them. Phase 3 input validation still rejects these new category strings; changing admission entry policy needs a later explicit task. An `excluded` treatment addresses only the base capacity and does not verify any separate quota, eligibility, or supernumerary limit.

`admissionYearRange` is optional, inclusive, with four-digit string bounds from 2000–2099, ordered min to max, and max no later than the academic start year. Absence or invalid bounds produce a review finding. Unknown policy properties, unknown status/category keys, and invalid treatments invalidate the counting policy. Invalid/missing ranges do not prevent a base-capacity comparison, but they never establish admission-year compliance.

## Counting methodology

1. Select one institution, then group students by an existing institution-owned programme and exact valid academic year. Also inspect configured programme/year groups with zero students.
2. Require exactly one matching approved-intake row with a nonnegative safe integer `approvedSeats`. Multiple matches are not summed or guessed. Malformed intake years produce review findings.
3. Require an explicit valid counting policy. Legacy capacity alone is insufficient to infer how every category/status should count; `countedEnrolment` stays null in that case.
4. Validate stored records even though normal APIs already validate input. Invalid records and all institution-wide duplicate/conflicting APAAR records are unresolved and excluded from the known count, rather than double-counted. Duplicates are checked across the institution, not across institutions.
5. For remaining records, exclude statuses outside `includedStatuses`, then apply the exact category treatment. No undocumented special-seat assumption is made.
6. Compare the known count with `approvedSeats`. Equal/below gives `not_exceeded` only when no records in the group are unresolved. Unresolved rows give `requires_review`; a known count already above capacity remains `exceeded` even with additional unresolved rows.

Every comparison contains institution/programme/year, `observedRecords`, `countedEnrolment`, `excludedRecords`, `unresolvedRecords`, `approvedSeats` and `comparison`. Invalid programme/year records cannot be assigned to a valid group and receive record findings instead. A `not_exceeded` capacity comparison is not an overall compliance certification: other record, reference or policy findings may remain. This model uses student records for the selected academic year; it does not infer annual admissions from cumulative enrolment or use the separate, currently unused `enrolments` collection.

## Rule catalogue (version 1.0.0)

| Rule code | Severity | Kind | Condition |
| --- | --- | --- | --- |
| REQUIRED_FIELD_INVALID | warning | violation | Invalid/missing internal UUID or required field, field type, length or control characters |
| APAAR_FORMAT_INVALID | warning | violation | Not a 12-digit text value; leading zeroes remain intact |
| REFERENCE_INSTITUTION_INVALID | critical | violation | Evaluated institution absent from reference inputs |
| REFERENCE_PROGRAMME_INVALID | warning | violation | Unknown programme or ownership inconsistent with the institution |
| ACADEMIC_YEAR_INVALID | warning | violation | Nonconsecutive or malformed academic year outside 2000–2099 |
| ADMISSION_YEAR_INVALID | warning | violation | Malformed admission year or later than academic start year |
| RECORD_STATUS_INVALID | warning | violation | Missing/unsupported record status |
| ADMISSION_CATEGORY_UNSUPPORTED | warning | violation | Category unsupported by application and applicable reference data |
| APAAR_DUPLICATE | warning | violation | Same institution APAAR and matching writable fields across records |
| APAAR_CONFLICT | critical | requires_review | Same institution APAAR with differing writable fields |
| INTAKE_REFERENCE_REVIEW | warning | requires_review | Missing/ambiguous/invalid capacity or malformed intake academic year |
| INTAKE_POLICY_REVIEW | warning | requires_review | Missing/invalid counting policy |
| ADMISSION_POLICY_REVIEW | info | requires_review | No valid explicit admission-year range |
| ADMISSION_YEAR_POLICY_VIOLATION | warning | violation | Admission year outside explicit inclusive reference bounds |
| CATEGORY_POLICY_REVIEW | warning | requires_review | Applicable category/special-seat treatment cannot be established |
| INTAKE_COUNT_REVIEW | warning | requires_review | Invalid or duplicate/conflicting records prevent a complete count |
| INTAKE_EXCEEDED | critical | violation | Known configured count exceeds matching approvedSeats |

`violation` means a deterministic mismatch with stated application/reference rules, not wrongdoing. `requires_review` means a policy or evidence gap needs human resolution. `info` identifies an unresolved policy qualification, `warning` a record/reference issue, and `critical` a configured capacity overage, conflicting identity records requiring review, or absent institution reference. Critical findings do not automatically reject, alter or accuse an institution/student.

## Finding schema and reproducibility

Each finding contains:

```text
id                 server-derived finding-<hash> identifier
ruleCode           explicit code from the catalogue
ruleVersion        1.0.0
severity           info | warning | critical
kind               violation | requires_review
explanation        static explanation (capacity explanations may include counts)
recommendedAction  next action for correction/review
institutionId      authorized institution
programmeId        owned programme, otherwise null
academicYear       valid academic year, otherwise null
recordIds          internal UUIDs of affected records; unavailable IDs are omitted
detectedAt         server-supplied evaluation observation timestamp
```

Names, full APAAR values, account credentials and session data are never placed in findings, logs or errors. Summary totals count findings, not necessarily unique affected records. Duplicate/conflict findings group affected records; programme/year policy findings affect their group.

Finding IDs are generated deterministically on the server from rule version, code and authorized references. Repeated unchanged evaluation produces the same rule outcomes, IDs and aggregates regardless of input collection/object-key ordering. A later run has a new evaluation UUID and observation timestamp; it does not pretend the new observation happened at the old time. The engine accepts the timestamp as an argument, so tests can reproduce the full result exactly. Rule behavior changes must increment the engine/rule versions.

## API and authorization

| Endpoint | Purpose |
| --- | --- |
| POST `/api/v1/compliance/evaluate` | Explicitly evaluate and atomically save latest institution snapshot; returns metadata, findings and summary |
| GET `/api/v1/compliance/findings` | Paginated/filtered saved findings, summary and freshness metadata |
| GET `/api/v1/compliance/findings/:id` | One saved authorized finding with metadata; inaccessible/missing IDs return 404 |
| GET `/api/v1/compliance/summary` | Institution aggregate summary and freshness metadata |

All routes use the existing session/auth/CSRF middleware and central institution policy. Both institution roles have `compliance:read:own` and `compliance:evaluate:own`. Reviewers/verifiers are denied every endpoint, including counts, because no cross-institution disclosure policy has been approved. The existing reserved reviewer `regulatory:summary` permission grants no access here. Aggregate counts therefore cannot reveal another institution's students through query parameters or finding IDs.

POST accepts `{}` (or no body), optionally `{ "institutionId": "DEMO-INST-001" }` matching the authenticated institution exactly. Records, timestamps, rule results, reference data or another institution cannot be supplied by a client. Query parameters on evaluation are rejected. Evaluation requires `X-CSRF-Token` and is limited to 10 requests/IP/15 minutes. All responses use `Cache-Control: no-store`.

Findings list filters: `severity`, `ruleCode`, `kind`, `programmeId`, `academicYear`, and optional matching `institutionId`; pagination `page` defaults to 1 and `pageSize` to 20, maximum 100. Only exact matches are supported; unknown filter keys/types or invalid enum/pagination values return 400. IDs must match the server finding-ID format. Summary/detail accept only optional matching `institutionId`. Cross-institution scope requests return 403, unauthorized sessions 401, malformed IDs/requests 400, missing findings 404, rate limits 429, storage failures safe 500 responses.

Summary is always for the whole saved institution evaluation, even when the findings page is filtered. It includes:

- `totalRecordsEvaluated` and `recordsWithNoFindings` (policy/group findings also mark affected records).
- `findingsBySeverity` and `findingsByRule`.
- `manualReviewItems` and `violations`.
- `intakeComparisons` and `overIntake`, each containing only authorized institution/programme/year aggregates.
- `authenticityVerified: false` is returned alongside the summary/findings.

## Persistence and stale results

The existing `validation-issues` JSON array stores a tagged `kind: "compliance-evaluation"`, `schemaVersion: 1` envelope containing the latest snapshot per institution. It includes evaluation UUID, engine version, timestamp/user, private input fingerprint, findings and summary. Other institutions' snapshots and unrelated legacy issue entries are preserved. All replacement occurs in one existing adapter update operation, using its serialization and temporary-file rename. Failed writes preserve prior findings, and evaluation never changes student files.

No automatic evaluation runs during create, PATCH or CSV commit. That avoids claiming a two-file atomic transaction for student records plus findings. GET requests never generate findings or write replacements. Before the first evaluation they return `evaluation: null`, `summary: null`, `stale: true`, `freshness: "not_evaluated"`.

Reads, including evaluation responses after persistence, compute a fingerprint from current scoped students (ID and writable fields), institution/programme reference rows, and intake/policy rows. Input order does not affect the fingerprint. Relevant additions, deletions, field/reference/policy changes or an engine-version change mark the snapshot `stale: true`, `freshness: "stale"`; unchanged checked inputs return `stale: false`, `freshness: "matches_checked_inputs"`. Other institutions' changes do not affect this snapshot. Audit-only student timestamp/user changes are not rule inputs. Fingerprints are stored privately, never returned to clients. Saved detection timestamps stay historical until explicit reevaluation.

Every evaluated response includes `evaluation.checkedAt`. Freshness is a comparison with inputs read at that check, not a lock on future changes. Files are read separately; a simultaneous write can race across them. Use one backend process, do not externally edit live JSON or seed during writes, and rerun evaluation after changes. No multi-file transaction, durable history, legal certification or fsync/power-loss guarantee is claimed. If a write succeeds but a later freshness read fails, the API returns safe 500 even though the snapshot may have been saved; GET the latest snapshot or evaluate again. Student names, APAAR values and credentials are not copied into the findings snapshot; authorized internal record/user references are retained.

## Run locally

From the project root:

```powershell
cd backend
npm ci
npm run seed:demo
# Configure DEMO_ACCOUNT_PASSWORD locally and seed accounts as described in README.
npm test
npm run dev
```

After logging in, before logout, use the existing PowerShell session variables:

```powershell
$result = Invoke-RestMethod "$baseUrl/api/v1/compliance/evaluate" -Method Post -WebSession $authSession -Headers @{ 'X-CSRF-Token' = $loginResult.csrfToken } -ContentType 'application/json' -Body '{}'
$result.summary | ConvertTo-Json -Depth 10
Invoke-RestMethod "$baseUrl/api/v1/compliance/findings?severity=critical&page=1&pageSize=20" -WebSession $authSession
Invoke-RestMethod "$baseUrl/api/v1/compliance/summary" -WebSession $authSession
```

Run only compliance tests with `npm test -- --runTestsByPath test/compliance-engine.test.js test/compliance-api.test.js`. The full `npm test` command also runs every Phase 1–3 regression test. All fixtures remain fictional and all runtime/test JSON is ignored by Git.
