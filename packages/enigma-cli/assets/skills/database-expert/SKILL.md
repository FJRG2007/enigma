---
name: database-expert
description: Senior database architecture - engine selection (PostgreSQL is the default relational engine for anything deployed or multi-writer; SQLite only for local-first, embedded, single-writer stores), ORM selection (TypeScript/JavaScript/Node/Bun projects use Prisma over PostgreSQL unless the user or the requirements name another ORM), schema design, normalization and anti-duplication, query/index optimization, query cost and latency discipline (bounded reads, filtering and paginating in the database rather than in application code, round-trip count, expensive COUNT(*) totals, precomputed aggregates, statement timeouts and pooling, EXPLAIN on realistic data), scalability (partitioning, sharding, replication), and RGPD/GDPR encryption of sensitive data. Use when designing, modifying, migrating, querying, or reviewing any database, schema, SQL, ORM model, or persistence layer, and when choosing the datastore for a new project's stack.
---

# Database Expert Policy (Senior Data Architecture Standards)

## Activation Scope

- Apply this skill whenever the task involves designing, modifying, migrating, querying, or reviewing any database.
- Covers relational (PostgreSQL, MySQL, SQL Server, etc.), document, key-value, wide-column, graph, time-series, and vector stores.
- The agent must operate as a senior data architect: every schema, index, query, and migration is treated as production infrastructure that must scale to large volume.

---

## Prime Directives (Non-Negotiable)

1. ALWAYS optimize the database for optimal queries.
2. NEVER duplicate data, unless the value is expensive to compute AND the use case justifies persisting it.
3. ALWAYS encrypt data that legally or contractually requires it (RGPD/GDPR and equivalents).
4. ALWAYS design for large-scale growth: optimal, scalable, fast, and secure by default.
5. ALWAYS use UUID primary keys and identifiers; NEVER use auto-increment, serial, or IDENTITY integer IDs.

- These five directives take priority over convenience or speed of implementation.
- If a request conflicts with them, surface the conflict and propose the compliant alternative before proceeding.

---

## Engine Selection (Default: PostgreSQL)

- For anything that will be deployed, grow, or be written to by more than one process, the default relational engine is **PostgreSQL**. Pick it without being asked; when something else is chosen, say in one line what constraint forced it.
- What makes it the default and not a preference: real write concurrency (MVCC, no database-wide writer lock), the types the rest of this policy assumes (native `uuid`, `jsonb`, arrays, enums, ranges, `timestamptz`), partial, expression and GIN indexes, generated columns, materialized views, declarative partitioning, logical replication and read replicas, and extensions that each remove a service from the stack (`pgvector` for embeddings, `pg_trgm` for fuzzy search, PostGIS for geo, `pg_cron` for schedules).
- SQLite is one file with one writer. It is the right default for a local-first or embedded store - a CLI's own state, a desktop or mobile app, an agent's local cache or index, a test fixture, an offline replica - and the wrong one for a web or API backend, anything running more than one instance, anything a background worker writes to, or anything with a managed-hosting story. Starting there and growing out of it is a migration with downtime, not a config change.
- MySQL/MariaDB only when the platform, the host or the team requires it. SQL Server or Oracle only where it is already the environment.
- Do not add a second datastore before PostgreSQL runs out. It handles queues (`SELECT ... FOR UPDATE SKIP LOCKED`), full-text search, vectors, JSON documents and counters well past early scale. Add Redis, a search engine or a vector database when a measured limit demands it, not as part of the initial stack.
- Serverless and edge runtimes still get PostgreSQL: the problem there is connection count, not the engine, so put a pooler in front (PgBouncer, Prisma Accelerate, the provider's pooled endpoint) instead of switching to a file database.
- Wire it the same way every time: the ORM below, migrations committed to version control, the connection string from the environment and never in the repo, and pooling configured before the first load test rather than after the first outage.

---

## ORM Selection (TypeScript/JavaScript: Prisma)

- Every TypeScript, JavaScript, Node, Bun or Deno project uses **Prisma over PostgreSQL**. Pick it without being asked - it is the default stack, not one option among several to weigh up.
- Use something else only when the user asks for another ORM, or the requirements or the existing codebase already commit to one. Then follow that choice and say in one line what it is.
- Treat Prisma as the schema's source of truth: `schema.prisma` defines the models, `prisma migrate` generates the migrations and they are committed, and the generated client is the query path. Do not hand-write parallel DDL for the same tables.
- Raw SQL stays available for what the query builder does poorly - `$queryRaw` with parameters, never interpolated input.
- The identifier policy below still applies: UUID primary keys - `@id @default(uuid(7))` where the installed Prisma version accepts the version argument, otherwise an application-generated UUIDv7/ULID - and never `autoincrement()`.

---

## Identifier Policy (Non-Negotiable)

- Every primary key and every externally exposed identifier MUST be a UUID. NEVER use auto-increment, SERIAL, BIGSERIAL, IDENTITY, AUTO_INCREMENT, or any incrementing integer/sequence as an entity ID - no exceptions, in any datastore.
- Prefer monotonic UUIDv7 or ULID for index locality and write performance; use random UUIDv4 only when unpredictability matters more than locality. Store IDs in a native UUID type (or 16-byte binary), not a formatted string column where the engine offers UUID.
- Why: sequential integer IDs are enumerable (IDOR/scraping risk), leak row counts and growth rate, and collide across shards, replicas, and offline/merge flows. UUIDs can be generated client-side before insert and stay unique across distributed systems.
- Generate the identifier at the application/domain layer (or via a database UUID default) so an entity owns its identity before it is persisted.
- Natural/business keys may still back UNIQUE constraints, but the surrogate primary key is always a UUID.

---

## Rule Priority Hierarchy

When database rules conflict, apply this order:

1. Legal/regulatory compliance (RGPD/GDPR, data residency, retention) and security
2. Data integrity and correctness (single source of truth, transactional consistency)
3. Anti-duplication / normalization
4. Query performance and index strategy
5. Scalability (partitioning, sharding, replication)
6. Storage efficiency
7. Operational simplicity and developer experience

---

## Normalization & Anti-Duplication (Highest Engineering Priority)

### Single Source of Truth

- Every piece of critical information must live in exactly one authoritative place.
- Reference data through foreign keys, relations, or IDs - never copy full objects or repeated values.
- Before adding any field or table, verify the information cannot already be derived from or joined to existing data.

### Normalization Baseline

- Default to a normalized model (target 3NF / BCNF) for transactional/OLTP schemas.
- Eliminate update, insertion, and deletion anomalies by removing redundant columns.
- Extract repeating groups and multi-valued attributes into their own tables.

### Controlled Denormalization (Exception, Not Default)

Denormalize ONLY when at least one holds, and document why:

- Recalculation/aggregation cost is significant and measured.
- A read-heavy hot path requires it for latency or throughput.
- Scalability, caching, or analytics/reporting workloads require it.

Any denormalized or duplicated value MUST have:

- A clear, documented synchronization strategy (triggers, transactional writes, CDC, materialized views, or scheduled refresh).
- A defined source of truth it is derived from.
- An invalidation/consistency model (when and how it is refreshed).

### Derived & Calculable Data

- Do NOT persist easily calculable data; compute it at read time when cost is low and consistency matters.
- Persist derived/aggregated values only when recomputation is expensive or required for performance/analytics.
- When persisting derived data, prefer materialized views or summary tables over scattered duplicate columns.

### A Pure Function Of A Key Needs No Column

The rules above are about a value computed from other columns. A stronger case is worth looking for first: a value that is a pure function of an id you already hold needs no column, no row, and no cache. Same id, same answer, in every process, forever.

- The shapes this covers: a human-readable label for an opaque id (a session, a run, an invite), an avatar colour or identicon, a bucket or shard assignment, a rollout cohort, a deterministic seed. Hash the id with a small stable function you own (FNV-1a, xxHash, or the leading bytes of a digest) and index into a fixed list.
- The function must be stable across processes and versions of the runtime: no clock, no locale, no random seed, and not a language built-in whose value is unspecified (JavaScript has no string hash at all; a JVM `hashCode` is specified for `String` but not for most other types). Write the few lines yourself rather than depending on a package for them.
- STATE THE TRADEOFF BEFORE CHOOSING, because it is not reversible in either direction. Derived means the mapping lives in the code, so editing the function or the list silently renames everything that already exists. Stored means the value is fixed forever, at the cost of a column, a write path and a backfill.
- The test is what the value is FOR. A convenience label the user reads and forgets is derived. An identity they will use to refer to the thing ("the Pegasus run", a share URL, anything they can search or that appears in an invoice) is data: store it on creation, seeded by the same function if you like.
- Do not derive across a boundary you do not own: a value another system persists, or one the user can rename, is data by definition.
- The same question applies before adding a row, not only a column: a join table that only ever expresses a rule ("everyone in this org is a member") is a query, and a settings row that only ever holds the defaults is an absence.

---

## Query & Index Optimization (Always)

### Schema for Query Patterns

- Design the schema around the real access patterns, not only the entity model.
- Choose correct, minimal data types (smallest type that safely fits; native date/time, numeric, boolean, UUID, enum types).
- The surrogate primary key is always a UUID (see Identifier Policy) - never an auto-increment/IDENTITY integer; prefer monotonic UUIDv7 or ULID over random UUIDv4 for write locality and index health.

### Indexing Rules

- Index every column used in JOIN, WHERE, ORDER BY, and GROUP BY on hot paths.
- Build composite indexes following the most-selective / equality-then-range column order; respect leftmost-prefix usage.
- Use covering indexes (INCLUDE columns) to enable index-only scans for hot read paths.
- Add partial/filtered indexes for skewed predicates (e.g. status = 'active').
- Do NOT over-index: every index has write and storage cost. Remove redundant and unused indexes.
- Add foreign-key-backing indexes on child columns to keep joins and cascades fast.

### Query Standards

- Select only the columns needed; never SELECT * on hot paths.
- Use set-based operations; avoid N+1 query patterns and per-row round trips.
- Use keyset/seek pagination for large or deep result sets instead of large OFFSET.
- Prefer EXISTS over IN for correlated existence checks on large sets.
- Keep predicates sargable: avoid wrapping indexed columns in functions or implicit casts.
- Validate every non-trivial query with EXPLAIN / EXPLAIN ANALYZE and confirm index usage before shipping.
- Use parameterized/prepared statements exclusively - never build SQL by string concatenation.

### Cost, Latency & Round Trips (Know What The Query Costs)

Every query has a price - rows examined, IO, CPU, connection time, and on a managed database an actual bill. Write it knowing the number, not hoping it is small. "It was fast locally" is not a measurement: a seq scan over 200 development rows and over 20 million production rows look identical from the app.

- **Every query is bounded.** A read that can return an unbounded set carries an explicit `LIMIT` (and the pagination that goes with it). A list endpoint with no cap is an outage waiting for the row count to grow.
- **Filter, sort, aggregate and paginate in the DATABASE.** Fetching a table to slice, sort, count or sum it in application code moves the whole result over the wire and throws most of it away - and no index can help once the rows have left the engine.
- **Count the round trips, not just the queries.** A loop issuing one query per item pays the network latency every iteration: replace it with one set-based statement (a single `IN`, a join, or the ORM's `include`/`select` for the relation). Two round trips at 30 ms are cheaper than twenty perfect queries.
- **Ask only for what you use.** Column lists over `SELECT *`, and on an ORM an explicit `select` - it is also what makes an index-only scan possible, and it keeps a `TEXT`/`JSONB` column you never read out of every row you fetch.
- **Total counts are expensive.** `COUNT(*)` with the same filters as the page is a second full pass over the matched rows. Prefer "load more"/keyset paging with no total, an approximate count (`reltuples`, a cheap estimator) for a scale hint, or a maintained counter when the exact number is genuinely part of the product.
- **Aggregations over large tables are precomputed, not recomputed per request.** A rollup table, a materialized view refreshed on a schedule, or an incrementally maintained counter - a dashboard that aggregates the whole history on every load will not survive its own success.
- **Give every statement a timeout** (`statement_timeout` per role or per transaction) so one pathological query cannot pin a connection and cascade into pool exhaustion. Pair it with a pool sized to the database's real connection ceiling, through a pooler in serverless (a function per request otherwise opens a connection per request).
- **Never hold a transaction open across an external call.** An HTTP request or a queue publish inside a transaction holds its locks for the remote service's latency, including its timeouts.
- **Measure against realistic volume before shipping.** `EXPLAIN ANALYZE` on production-like data, and read the two numbers that matter: rows examined versus rows returned. A large ratio means the index does not match the predicate you actually wrote, whatever the plan calls itself.
- **Set a budget for the hot path and check it.** Name the target (a simple read in single-digit milliseconds; a page load's queries in tens, not hundreds), keep the query count per request visible in logs or traces, and treat a regression as a defect. Caching an expensive read is the last step, not the fix for a query that was never designed (backend-policy owns the cache layer and its invalidation).

---

## Scalability (Design for Large Scale by Default)

- Assume the largest tables will grow continuously; plan partitioning before it becomes urgent.
- Partition large tables by range (time) or hash (tenant/key) according to access pattern.
- Separate read and write paths where load justifies it (read replicas, CQRS).
- Define a sharding/tenancy strategy early for multi-tenant or high-volume systems.
- Use connection pooling (e.g. PgBouncer or equivalent) and set sane pool limits.
- Cache expensive, stable reads at the appropriate layer with explicit invalidation; never cache without an invalidation plan.
- Keep transactions short; avoid long-held locks and large single transactions that block scaling.
- Use append-friendly, monotonic keys to reduce index fragmentation and hot-page contention at scale.

---

## RGPD/GDPR Compliance & Data Protection

### Classification First

- Classify all data on entry: personal data, special-category (sensitive) data, secrets/credentials, and non-personal.
- Apply data minimization: collect and store only what is strictly necessary for the stated purpose.
- Attach a lawful basis and retention period to every category of personal data.

### Encryption Requirements

- Encrypt data in transit (TLS) for all client-server and service-service connections.
- Encrypt data at rest for any datastore holding personal or sensitive data (disk/volume or TDE-level encryption).
- Apply application-level / column-level encryption for special-category data and high-risk fields (e.g. national IDs, health, financial, biometric, precise location).
- Use authenticated encryption (e.g. AES-256-GCM) with managed keys; never invent cryptographic schemes.

### Secrets, Passwords, and Tokens

- NEVER store passwords reversibly. Hash with a strong, salted, memory-hard algorithm (Argon2id preferred; bcrypt/scrypt acceptable).
- Store API keys/tokens hashed when only verification is needed; encrypt when the plaintext must be retrievable.
- Keep encryption keys and DB credentials in a managed secret store / KMS, never in the schema, code, or repo.

### Searchability vs Confidentiality

- When encrypted fields must be searched, use blind indexes / deterministic HMAC of normalized values for equality lookups - not plaintext columns.
- Accept that strong encryption breaks range/sort queries; design access patterns accordingly (separate lookup tokens, tokenization).

### Data Subject Rights & Lifecycle

- Support access, rectification, portability, and erasure ("right to be forgotten") by design.
- Prefer crypto-shredding (destroy the key) or hard deletion for erasure; ensure soft-delete flags do not silently retain personal data beyond its retention period.
- Pseudonymize or anonymize personal data used in analytics, logs, and non-production environments.
- Enforce retention windows with automated purge jobs; never retain personal data indefinitely "just in case".
- Maintain auditability: record who accessed or changed sensitive data, without logging the sensitive values themselves.

---

## Data Integrity & Constraints

- Enforce integrity at the database level, not only in application code:
  - PRIMARY KEY on every table.
  - FOREIGN KEY constraints with explicit ON DELETE / ON UPDATE behavior.
  - NOT NULL, UNIQUE, CHECK, and proper DEFAULT constraints to encode invariants.
- Use transactions with the correct isolation level for multi-step writes; keep them atomic.
- Use optimistic concurrency (version column) or appropriate locking to prevent lost updates.
- Validate at the application layer too, but treat DB constraints as the last line of defense.

---

## Migrations & Operations

- All schema changes go through versioned, reversible, idempotent migrations checked into the repo.
- Write forward (up) and rollback (down) paths; never alter production schema manually.
- Design migrations to be safe under load: additive first, backfill in batches, then enforce constraints.
- For large tables, avoid blocking operations; prefer online/concurrent index builds and non-blocking column changes.
- Decouple deploys from schema changes using expand-and-contract (add new -> migrate -> switch -> remove old).
- Never run a destructive migration without a verified backup and a tested rollback.
- Ensure backups are encrypted, periodically restore-tested, and cover point-in-time recovery for critical data.

---

## Observability

- Enable and review slow-query logging; set explicit thresholds.
- Track index usage and remove dead indexes; watch table/index bloat and cache hit ratios.
- Monitor replication lag, connection saturation, lock waits, and deadlocks.
- Make query plans reproducible in review: include EXPLAIN output for non-trivial changes.

---

## Security (Beyond Encryption)

- Apply least privilege: distinct DB roles per service; no application using a superuser/owner role.
- Grant only the minimum privileges per role; never expose broad GRANTs.
- Treat all external input as untrusted; parameterize every query to prevent SQL injection.
- Use Row-Level Security (RLS) or equivalent for multi-tenant isolation where supported.
- Never expose internal DB errors, schemas, or stack traces to clients.
- Restrict network access to the database; no public exposure of database ports.

---

## Anti-Patterns (Never Do)

- Using auto-increment / serial / IDENTITY integer primary keys, or exposing sequential numeric IDs instead of UUIDs.
- Shipping a query whose cost was never measured on realistic data, or an unbounded read with no `LIMIT`.
- Fetching rows to filter, sort, count or paginate them in application code.
- Querying inside a loop when one set-based statement would do.
- Duplicating data without a documented sync strategy and justification.
- Storing easily computable values that should be derived at read time.
- SELECT * on hot paths or fetching columns that are not used.
- Building SQL via string concatenation / interpolation of user input.
- Storing passwords or secrets in plaintext or with reversible/weak hashing.
- Using EAV ("entity-attribute-value") or storing structured data as opaque blobs/JSON when a relational model fits and must be queried.
- Adding indexes blindly or leaving unused indexes in place.
- Large OFFSET pagination on big tables.
- Running destructive or blocking migrations without backups, batching, or a rollback path.
- Retaining personal data past its retention period or beyond its stated purpose.

---

## Delivery Standard

For any database task, the agent must:

1. Identify access patterns, data sensitivity, and expected scale before designing.
2. Produce a normalized schema with explicit constraints, types, keys, and indexes.
3. Mark every personal/sensitive field with its protection (encryption, hashing, retention).
4. Justify any denormalization or persisted derived data, with its sync strategy.
5. Provide reversible, batched migrations and validate hot queries with query plans.