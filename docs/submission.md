# EduVerify Intelligence — SIH26263 submission brief

## Abstract

EduVerify Intelligence is a local prototype for institution-scoped student data management, policy-based compliance review and integrity verification. A React interface calls an Express REST backend backed by explicitly selected MySQL. Authorized institution users create/edit fictional records and preview CSV batches before transactional import. Deterministic rules compare stored data against configured references and intake counting policies, retaining dated findings with freshness checks. A separate Python FastAPI service applies an offline-trained Isolation Forest to four de-identified numeric aggregates and returns human-review signals. HMAC-authenticated QR artifacts provide minimal public integrity/current-state checks without exposing student names or APAAR values. Role restrictions, institution boundaries, CSRF-protected sessions and safe error handling are enforced in Express. Acceptance uses isolated MySQL fixtures and real browser/Python workflows. This is a fictional-data demonstration, not official APAAR verification, a government integration or a production-certified platform.

## Problem and implemented response

| Problem | Implemented response | Boundary |
| --- | --- | --- |
| Institution data is difficult to validate consistently | Validated own-institution create/edit and CSV preview/revalidation | Syntax/reference consistency does not prove identity |
| Intake policy findings can be unclear or outdated | Explicit deterministic evaluation, policy/count context and stale snapshot indication | Only configured fictional policies; unknown policy stays unresolved |
| Unusual aggregate patterns need review | De-identified numeric Isolation Forest inference | Synthetic-only training/evaluation; no real-world accuracy or fraud claim |
| Shared record snapshots may be changed or withdrawn | Signed opaque QR claims with persisted revision, revocation and expiry checks | Online EduVerify integrity status; HMAC is not an independently verifiable public-key certificate |
| Cross-institution disclosure is risky | Backend roles, persisted resource ownership, minimal public results | Reviewer/verifier landing pages intentionally restricted |

## Submission contents

- [Setup and phase checklist](../README.md)
- [Architecture, data flow and relational diagram](architecture.md)
- [Implemented API summary](api-summary.md), with linked full contracts
- [Schema, two versioned migrations and least-privilege setup](mysql.md)
- [Storage and transaction interface](storage-interface.md)
- [ML methodology and synthetic evaluation limitations](ml-service.md)
- [Authentication/privacy policy](auth-policy.md), [QR integrity/privacy](verification.md), historical [security review](security-review.md)
- [Final acceptance evidence and limitations](final-acceptance.md)
- [Repeatable 5–7 minute demonstration and troubleshooting](sih-demo.md)
- Source, dependency lockfiles, automated checks, fictional CSV fixtures and `.env.example` variable names

Do not package dependencies, environments, model pickle files, generated datasets, database files/dumps, runtime records, screenshots, logs or private credentials. Recreate trusted model artifacts offline from the checked-in trainer. A Git checkpoint identifies the reviewed source; nothing is automatically pushed or published. Keep actual signing keys separately protected if retaining any issued artifacts beyond a disposable run.

The final local source archive is `.local/submission/EduVerify-phase10.zip`; its sibling SHA-256 file and `checkpoint.txt` identify the exact Git commit. The archive is ignored/generated, contains committed source only, and must be extracted into a new folder before setup. It intentionally contains no generated model, dependencies, database or runtime credentials. From project root, after reviewing/committing changes, the equivalent packaging commands are:

```powershell
New-Item -ItemType Directory -Force .local/submission | Out-Null
git rev-parse HEAD | Set-Content .local/submission/checkpoint.txt
git archive --format=zip --prefix=EduVerify/ --output=.local/submission/EduVerify-phase10.zip HEAD
(Get-FileHash .local/submission/EduVerify-phase10.zip -Algorithm SHA256).Hash | Set-Content .local/submission/EduVerify-phase10.zip.sha256
```

Verify the archive contents exclude ignored/private/generated paths before sharing. The Phase 10 initial checkpoint uses an explicit `EduVerify Acceptance <acceptance@demo.example>` automation identity because the repository had no configured author; it does not attribute this work to a user or alter their Git configuration.

## Before broader use

Require a patched supported database/runtime, real HTTPS deployment controls, reviewed secret/backup rotation and restore operations, durable sessions/limits/previews/audit strategy, ambiguous-commit reconciliation/idempotency design, scoped SQL performance work, accessibility and independent security testing, Python advisory scanning, and a separately authorized real-data/privacy/government-integration policy. A successful disposable restore drill does not validate disaster recovery of a deployed installation. No broader use of real student information is authorized by this prototype.
