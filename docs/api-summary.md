# Implemented API summary

Express defaults to `http://127.0.0.1:5000`; Vite forwards same-origin `/api` requests. Domain routes use `/api/v1/`; existing health/auth routes remain unversioned. Requests and responses are JSON except CSV upload and the issued QR PNG data URL. There is no student-delete, reference-list, reviewer cross-institution dataset, training or official APAAR endpoint.

| Method and path | Access and behavior |
| --- | --- |
| GET `/api/health` | Public process liveness: `{"status":"ok","service":"eduverify-backend"}`; not continuous DB readiness |
| GET `/api/auth/csrf` | Establish session and obtain synchronizer token |
| POST `/api/auth/login` | CSRF; email/password; rotates session/token; safe public account fields only |
| GET `/api/auth/me` | Authenticated public account fields |
| POST `/api/auth/logout` | Session + CSRF; invalidate session |
| GET `/api/v1/students` | Admin/operator, own institution; filters/pagination |
| GET `/api/v1/students/:id` | Admin/operator, persisted own institution only |
| POST `/api/v1/students` | Admin/operator + CSRF; validate and create |
| PATCH `/api/v1/students/:id` | Admin/operator + CSRF; validate merged record and atomically change private revision |
| POST `/api/v1/students/import/preview` | Admin/operator + CSRF; multipart `file`, CSV at most 256 KiB/500 data rows; report and eligible pending token |
| POST `/api/v1/students/import/commit` | Admin/operator + CSRF; `previewToken`; revalidate/insert entire batch transactionally |
| POST `/api/v1/compliance/evaluate` | Admin/operator + CSRF; explicit own-institution snapshot/evaluation |
| GET `/api/v1/compliance/summary` | Admin/operator; saved own-institution summary and freshness |
| GET `/api/v1/compliance/findings` | Admin/operator; own saved findings with filters/pagination |
| GET `/api/v1/compliance/findings/:id` | Admin/operator; one authorized saved finding |
| POST `/api/v1/ml/evaluate` | Admin/operator + CSRF; own aggregates, real inference and input freshness check |
| POST `/api/v1/verification/issue` | Admin/operator + CSRF; own `studentId`; persist artifact before returning signed text/PNG |
| POST `/api/v1/verification/revoke` | Admin/operator + CSRF; own `artifactId`; idempotent withdrawal |
| POST `/api/v1/verification/verify` | Public; exact signed `payload`; minimal integrity/current-state result |
| GET `/api/v1/regulatory/summary` | Regulatory reviewer only; de-identified institution aggregates and an aggregate count of potential active cross-institution identifier conflicts; no student records or identifiers |

Protected mutations require the current `X-CSRF-Token` and an allowed browser Origin. Login email is normalized; unknown/inactive accounts use the same safe error. Institution overrides cannot expand access; foreign student IDs appear absent (404). Invalid bodies/filters use 400/422, duplicates/conflicts 409, denied access 401/403, limits 429 and unavailable DB/ML/key services explicit 5xx. Unexpected errors do not echo SQL, credentials or records. See the detailed [auth](auth-policy.md), [students](students-api.md), [compliance](compliance-api.md), [ML](ml-service.md) and [QR](verification.md) contracts for exact schemas and exceptions.

Python is private loopback HTTP on port 8000 by default:

| Method and path | Behavior |
| --- | --- |
| GET `/health` | `{"status":"ok","model_available":true}` when ready; 503/unavailable otherwise |
| GET `/model/info` | Requires `X-ML-Service-Key`; trusted model metadata |
| POST `/predict` | Requires internal key; strict batch of four numeric/null features, up to 100 groups |

Browser Origin headers are rejected by Python. It receives no institution IDs, student IDs, names, APAAR, credentials or QR keys. There is no browser-to-Python API flow.
