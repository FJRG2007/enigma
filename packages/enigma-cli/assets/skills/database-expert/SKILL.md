---
name: database-expert
description: Senior database architecture - schema design, normalization and anti-duplication, query/index optimization, scalability (partitioning, sharding, replication), and RGPD/GDPR encryption of sensitive data. Use when designing, modifying, migrating, querying, or reviewing any database, schema, SQL, ORM model, or persistence layer.
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

- These four directives take priority over convenience or speed of implementation.
- If a request conflicts with them, surface the conflict and propose the compliant alternative before proceeding.

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

---

## Query & Index Optimization (Always)

### Schema for Query Patterns

- Design the schema around the real access patterns, not only the entity model.
- Choose correct, minimal data types (smallest type that safely fits; native date/time, numeric, boolean, UUID, enum types).
- Use surrogate keys (BIGINT identity / UUIDv7 or ULID for distributed inserts) where natural keys are unstable or wide.
- Prefer monotonic keys (UUIDv7/ULID) over UUIDv4 for write locality and index health.

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