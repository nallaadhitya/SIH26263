# Storage interface (Phase 9)

Services receive one adapter through `createApp({store})`. CLI entry points use `createStorage()` from `backend/storage/index.js`; `STORAGE_DRIVER` must be explicit. The frontend and Python never connect to MySQL. `mysql` failures never select JSON. `json` is allowed only for explicit local/test use, not `NODE_ENV=production` startup.

The shared compatibility interface is:

| Method | Contract |
| --- | --- |
| `readCollection(name, options?)` | Return an array from an allowlisted collection; JSON's optional missing-file initialization is irrelevant to SQL |
| `writeCollection(name, rows)` | Explicit atomic logical replacement; JSON refuses corrupted files; SQL validates references/constraints in a transaction |
| `updateCollection(name, async rows => nextRows)` | Serialized read/validate/write callback; must return an array and propagate failures |
| `withCollectionLock(name, async operation)` | Coordinate reads and nested mutations; SQL uses a database transaction, JSON uses its instance queue |
| SQL `transaction(async operation, {rollbackOnly?})` | One transaction/connection propagated with AsyncLocalStorage; nested calls join it, not independent commits/savepoints |
| SQL `ready()` / `close()` | Check the migration ledger/checksums before listening, then release pool resources on shutdown |

SQL keeps the existing array-service contract to avoid rewriting validation, authorization, imports and deterministic evaluation. It uses normalized tables and parameterized statements. Table/column identifiers come only from code-defined mappings; values use placeholders. No request supplies a table, path or database name.

One InnoDB `storage_mutex` row serializes adapter transactions **across processes/connections**. This coarse gate protects duplicate checks, full-array reconciliation and multi-collection reads/writes under the current service design. Relevant rows read in transactions use `FOR SHARE`, including permission/reference checks, so direct competing permission updates wait until the related transaction completes. No OS/process-local queue is claimed to be a database lock. The trade-off is deliberately limited throughput and whole-collection reads/updates; row-scoped repositories and SQL pagination can be a future performance task.

MySQL student mutations and CSV batches execute their validation, current-account checks, revision marker and rows in one transaction. Compliance computes inputs and saves its evaluation envelope/findings in one transaction. QR issuance holds its student snapshot through bounded local PNG generation and persistence; verification reads version/revocation consistently; revocation is one transaction. Reference/account seeding is transactional on SQL. ML reads aggregates, releases any database operations, and then calls Python: no transaction spans inference/network waiting. ML freshness compares inputs again afterward, as before.

Do not await external services, user input or unrelated network work inside a storage transaction. Do not catch a failed nested mutation and continue as though it committed. Deadlocks/lock waits roll back and return a safe busy error; the adapter does not replay callbacks that may have issued artifacts or consumed previews. An uncertain COMMIT/connection loss has an ambiguous result; inspect state before retrying. There are no durable idempotency receipts, distributed sessions or exactly-once HTTP guarantees.

Duplicate constraints return safe 409 responses; invalid field/reference constraints return 422; unavailable/busy databases return 503. Domain authorization errors retain their existing status. Driver messages, queries, connection configuration and secrets do not reach clients. SQL constraints complement existing API validation rather than replacing it.

JSON remains available for its original regression/failure tests; its single-process, multi-file and power-loss limitations still apply. See [mysql.md](mysql.md) for schemas, migration, setup and actual SQL verification.
