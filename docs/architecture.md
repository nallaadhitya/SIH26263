# System architecture and data flow

The implemented SIH26263 prototype is local only. Express owns application persistence; neither React nor Python has database credentials or application-file access.

```mermaid
flowchart LR
    Browser[React JavaScript UI] -->|same-origin /api via Vite proxy| API[Express REST API]
    API --> Auth[Session CSRF and role/institution policy]
    Auth --> Services[Students CSV compliance ML orchestration QR]
    Services --> Store[Explicit storage adapter]
    Store -->|parameterized queries and transactions| DB[(Local MySQL InnoDB)]
    Store -. explicit local/test selection only .-> JSON[(Ignored local JSON)]
    Services -->|four numeric/null aggregate features and private service key| ML[Local Python FastAPI]
    ML --> Model[Trusted offline-trained Isolation Forest]
    ML -->|scores and review flags| API
    Keys[Protected process environment] --> API
    Keys --> ML
```

MySQL failure never selects JSON. Runtime checks the migration ledger before listening. The transaction gate coordinates array-shaped service callbacks across connections; permission/reference rows are locked during related mutations. Network inference happens outside database transactions. [Storage contracts](storage-interface.md) and [schema/migration details](mysql.md) describe the implementation and its limits.

```mermaid
flowchart TD
    User[Authenticated institution user] --> Submit[Create or edit student / preview CSV]
    Submit --> Validate[Allowlisted fields syntax references and institution checks]
    Validate --> Preview[CSV report and session-bound pending token]
    Preview --> Confirm[Explicit confirmation and revalidation]
    Validate --> Write[Transactional student write with private revision]
    Confirm --> Write
    Write --> SQL[(MySQL)]
    User --> Evaluate[Explicit compliance evaluation]
    SQL --> Evaluate
    Evaluate --> Policy[Deterministic rules and configured intake counting policy]
    Policy --> Snapshot[Atomic latest evaluation and findings]
    Snapshot --> SQL
    SQL --> Aggregates[Institution programme/year numeric aggregates]
    Aggregates --> Python[Python inference without student identities]
    Python --> Review[Transient scores for human review]
    User --> Issue[Authorized QR issuance from current record]
    SQL --> Issue
    Issue --> Artifact[Persist opaque claims and private snapshot binding]
    Artifact --> SQL
    Issue --> Payload[HMAC-authenticated text and PNG]
    Payload --> Public[Public integrity/status request]
    Public --> Check[Verify MAC persisted issuance revocation expiry and current revision]
    SQL --> Check
    Check --> Result[Minimal valid / invalid / expired / revoked / outdated result]
```

Relevant edits stale saved compliance evaluations and invalidate prior QR snapshots; they do not silently reevaluate, rerun ML or issue a new artifact. CSV preview never writes student rows. All-or-nothing commit rechecks authorization and current references. A name/APAAR never appears in public QR output or the Python request. UI summaries come from actual APIs; missing policy/ML service is not interpreted as a normal result.

```mermaid
erDiagram
    institutions ||--o{ programmes : owns
    institutions ||--o{ users : scopes
    institutions ||--o{ students : owns
    programmes ||--o{ approved_intakes : configures
    programmes ||--o{ students : enrolls
    users ||--o{ students : creates_updates
    institutions ||--o| compliance_evaluations : latest
    compliance_evaluations ||--o{ compliance_findings : contains
    students ||--o{ verification_records : snapshots
    users ||--o{ verification_records : issues_revokes
```

The student/programme FK also checks institution ownership. Institution/APAAR and programme/year intake pairs are unique. Foreign keys restrict source deletion; only evaluation replacement cascades to that evaluation's findings. Supporting tables are `schema_migrations`, `storage_mutex`, `json_imports` and `legacy_records`. Dates are UTC, APAAR is text and private edit markers stay outside API field allowlists. Two checksummed SQL migrations are applied explicitly; MySQL DDL is restartable rather than one rollbackable transaction. No schema redesign was introduced for acceptance.
