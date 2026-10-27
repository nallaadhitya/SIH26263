# EduVerify Intelligence — Contributor Guide

## Project architecture

EduVerify Intelligence is a local-only prototype for APAAR ID-based student-data management and verification. The codebase is organized by deployable component:

```text
frontend/       React + JavaScript + Vite client
backend/        Node.js + Express REST API
ml-service/     Python FastAPI analytics service
data/           Local JSON prototype storage (fictional demo data only)
docs/           Architecture, API, and phase documentation
```

The frontend calls the backend over REST. The backend owns persistence through the storage interface and is the only component permitted to read/write application data or connect to MySQL. Phase 9 explicitly authorizes local MySQL, with JSON retained for isolated tests and explicit local fallback. The ML service receives only the minimum de-identified aggregates and must not access application files or MySQL directly.

## Coding conventions

- Use JavaScript (not TypeScript) in `frontend/` and `backend/`.
- Use React function components, hooks, and Vite conventions in `frontend/`.
- Keep Express routes thin; put validation, business logic, and storage access in separate modules.
- Use RESTful, versioned endpoints under `/api/v1/` when API work begins.
- Use Python type hints, PEP 8, and small focused FastAPI modules in `ml-service/`.
- Prefer descriptive names, small modules, explicit error handling, and comments only where intent is non-obvious.
- Resolve every filesystem location from the project root or a configured data directory; never use machine-specific absolute paths.
- Select storage explicitly. Never fall back from a failed MySQL operation to JSON. Use parameterized SQL, versioned/checksummed migrations and transaction-aware storage callbacks; keep Python/network calls outside database transactions.
- JSON import is an explicit operator command requiring a matching verified backup. Preserve source files and stable IDs, reject invalid/conflicting batches atomically, and never silently discard records.

## Security and privacy

- Never add real student records, real APAAR IDs, credentials, tokens, keys, or production exports.
- All sample data must be clearly fictional and use reserved examples such as `DEMO-APAAR-0001`.
- Keep `.env`, `.env.*`, generated local data, logs, and dependency/build output out of Git. Commit only `.env.example` files without secrets.
- Validate all REST input, constrain JSON-file operations to the configured data directory, and return safe error messages.
- Do not log personal data, identifiers, credentials, request bodies containing records, or stack traces to clients.
- Apply least privilege, authentication/authorization design, audit logging, and rate-limit considerations before handling sensitive workflows.

## Testing expectations

- Add automated tests alongside each feature: unit tests for business logic and API tests for REST routes.
- Test validation, authorization boundaries, storage failures, and unhappy paths—not only successful requests.
- ML changes require deterministic fixture-based tests and documented model inputs/outputs.
- Run relevant lint, test, and build commands before reporting completion. Document commands and outcomes in the task handoff.

## Phased delivery rules

- Work only on the phase explicitly requested; do not pre-implement later features.
- Preserve existing useful work and inspect the repository before modifying it.
- Keep changes small, reviewable, and documented. Update the README phase checklist when a phase is completed.
- Do not introduce MySQL, cloud services, paid APIs, or real data without explicit approval for a later phase.
- When a phase depends on an unresolved product or security decision, document it as a blocker rather than guessing.
