---
name: scale-security-privacy
description: Server and data code holds from one user to governments and enterprises - bounded, tenant-safe, secure and private
files: ["*.ts", "*.js", "*.mjs", "*.py", "*.go", "*.rs", "*.java", "*.kt", "*.cs", "*.rb", "*.php", "*.prisma", "*.sql"]
exclude: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "*.d.ts", "*.config.*", "**/scripts/**", "*.tsx", "*.jsx"]
when: select|insert|update|delete|findMany|findAll|query|router|route|handler|app\.(?:get|post|put|patch|delete)|fetch\(|prisma\.|db\.|repository|controller|service|queue|cache|redis|session|token|password|tenant
---

Write it as if it will serve billions of users and many tenants (a person at home up to a government): reads are bounded (paginated, filtered and selected in the database, never load-all then filter, no N+1), every new filter/sort has an index, state lives in the datastore not in process memory, slow work goes to background jobs, writes that can be retried are idempotent, public endpoints are rate limited.
Every handler authorizes the caller for the specific object and tenant it touches; queries are scoped by tenant; input is validated against a schema; queries are parameterized.
No secrets, tokens or personal data in logs, errors or URLs; personal data is collected only when needed and protected at rest.
Fails: any added code that breaks one of these. Passes: local scripts, fixtures and code that touches none of it.
