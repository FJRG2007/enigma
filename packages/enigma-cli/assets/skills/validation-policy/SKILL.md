---
name: validation-policy
description: Strict frontend + backend schema validation (Zod or equivalent), schema consistency between client and server, and safe client-facing error handling. Use when handling any external input - forms, API request bodies, query params, CLI args, file parsing, or third-party payloads.
---

# Validation & Error Handling Policy

## Activation Scope

- Apply whenever the task accepts external input: forms, API endpoints, message handlers, CLI args, file parsing, or third-party payloads.
- Owns input validation, schema definition, and client-facing error handling. Defers data-layer constraints to database-expert and the security baseline to core-engineering-policy.

---

## Core Principle

- Treat all external input as untrusted.
- Reject invalid input before any business logic executes.
- Validation is a security control first and a UX feature second.

---

## Strict Validation Policy (Frontend + Backend)

- All input validation must be implemented in BOTH frontend and backend.
- Validation must always be strict and schema-based.
- Schemas must enforce full type safety (no partial or loose validation allowed).

### Frontend Validation (Mandatory)

- All forms and user inputs must use real-time validation.
- Validation must run on every relevant input change or blur event.
- Use schema-driven validation (e.g. Zod or equivalent).
- Validation must prevent invalid state before submission.
- UI must reflect validation state immediately and clearly.
- Validate cross-record constraints (uniqueness, availability, "already in use") in real time too, not just per-field type/format. When the client already holds the relevant set (the list of accounts, profiles, names, slugs it just rendered), check the input against that loaded data on every change and block submission on a conflict - do not defer the duplicate check to the server round-trip. The server still re-validates as the authority (client checks can be stale), but the user must see the conflict as they type. Mirror the server's exact rule (same pattern, case-folding, reserved values, and scope - e.g. unique per parent vs. globally) so the two never disagree; exclude the record's own current value when editing so renaming to the same name is not flagged.

### Backend / API Validation (Mandatory)

- Every API endpoint must validate all incoming data strictly.
- Validation must use the same schema definition system as the frontend whenever possible.
- No request is allowed to bypass schema validation.
- Invalid requests must be rejected before any business logic execution.
- Validate at the boundary; never trust client-side validation alone.

---

## Schema Consistency Rule

- Frontend and backend must share or mirror the same validation schema definitions.
- Schemas must be the single source of truth for data validation.
- Any mismatch between frontend and backend schemas is considered a critical issue.
- Prefer one shared schema package over duplicated definitions.

---

## Validation Standards

- Validate type, shape, range, format, and required/optional status.
- Normalize input (trim, case-fold, canonicalize) before validating equality or storing.
- Enforce explicit allowlists over denylists for constrained values.
- Set explicit limits on size, length, and array cardinality to prevent abuse.
- Fail closed: unknown or unexpected fields are rejected, not silently ignored, on sensitive endpoints.

---

## Error Handling Rules

- Client-facing errors must be generic and non-revealing.
- Never expose:
  - Database schemas
  - Stack traces
  - Internal paths
  - Service names
- Log detailed errors internally only, with enough context to debug.
- Use consistent, structured error responses (stable codes, safe messages).
- Distinguish validation errors (4xx, actionable) from internal failures (5xx, opaque to the client).
- Never leak the existence or absence of sensitive resources through error differences.