---
name: validation-policy
description: Strict frontend + backend schema validation (Zod or equivalent), normalization before validation (one shared normalizer on both sides - trim, lowercase the email, capitalize each word of a name, canonicalize a profile link or handle) and the rule that a check which cannot fail is not validation, cross-field rules declared on the object schema rather than the field (password against the email or username, confirmation fields, date ranges), schema consistency between client and server, and safe client-facing error handling. Use when handling any external input - forms, API request bodies, query params, CLI args, file parsing, or third-party payloads.
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
- **Every field, not only the famous formats.** Email and password get validated because their rules are obvious; the fields next to them (a profile link, a phone, a job title, a website) are the ones shipped open. Give each field a rule and show its error inline: a format check where there is a format, a max length everywhere, and an "empty after trimming" check where the value is required. A field whose only rule is `z.string()` is an unvalidated field.
- Validate cross-record constraints (uniqueness, availability, "already in use") in real time too, not just per-field type/format. When the client already holds the relevant set (the list of accounts, profiles, names, slugs it just rendered), check the input against that loaded data on every change and block submission on a conflict - do not defer the duplicate check to the server round-trip (this gives instant feedback and spares a redundant request and its DB query). The server still re-validates as the authority (client checks can be stale), but the user must see the conflict as they type. Mirror the server's exact rule (same pattern, case-folding, reserved values, and scope - e.g. unique per parent vs. globally) so the two never disagree; exclude the record's own current value when editing so renaming to the same name is not flagged.

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

## Normalize Before You Validate (Client And Server)

Input arrives shaped by whoever typed it: a leading space from a paste, a name in lowercase from a phone keyboard, an address in mixed case, a profile link carrying tracking parameters. Normalize first, validate the normalized value, store that same value. Both sides do it - the client so the user sees what will be stored, the server because a request does not have to come from your form.

- Keep the normalizers in ONE module that the client and the server both import, next to the schema they belong to. Two copies drift, and the day they disagree the server rejects what the form accepted.
- Normalize INSIDE the schema wherever the validator supports it, so no caller can forget. Zod: `z.string().trim().toLowerCase().pipe(z.email())`. Order matters: `z.email().trim()` validates before trimming and rejects a pasted `" a@b.com"`. Yup: `.trim().lowercase().email()`. Pydantic: a `field_validator(mode="before")`.
- Default for every string field: trim both ends, collapse runs of inner whitespace, strip control and zero-width characters, and normalize Unicode to NFC so a composed and a decomposed accent are the same value.
- The server normalizes again, always. A client that skipped it, an API client, a script, and a replayed request all reach the same handler.

Per field kind (defaults - override only with a reason):

| Field | Normalizes to |
| --- | --- |
| Email | trim, lowercase, then validate. Store it lowercased so lookups and uniqueness never miss. |
| Person name (full name, first, last) | trim, collapse inner spaces, uppercase the first letter of every word - and ONLY that letter, so `McDonald`, `O'Brien`, `van der Berg` and `Jean-Luc` survive. Split on spaces, hyphens and apostrophes. |
| Username, handle, slug | trim, drop a leading `@`, lowercase when the identifier is case-insensitive, then check the allowed character set. |
| Profile link (LinkedIn, GitHub, X, Instagram) | accept BOTH a full URL and a bare handle, canonicalize to one stored form, check the host is the expected domain, and drop query and tracking parameters. |
| URL | trim, add the scheme when missing, lowercase the host, drop a trailing slash. |
| Phone | strip spaces, dots, dashes and parentheses, keep the leading `+`, store E.164. |
| Number, date, money | parse into the canonical type at the boundary; never store the localized string. |

### A check that cannot fail is not validation

- Never patch the value into validity and then check the patched value. `z.url().safeParse(v.startsWith("http") ? v : "https://" + v)` accepts `asdf`, `pepe`, and every other single token, because `https://asdf` is a syntactically valid URL. The field looks validated, has an error slot, and rejects nothing.
- Canonicalizing and validating are two steps, in that order. Canonicalize (add the scheme, strip the `@`), then apply a check the canonical value can still fail: the host contains a dot, the host is the expected domain, the path has the expected shape.
- Before calling a field done, type three wrong values into it and confirm each is rejected. A validator nobody has watched fail is unverified.
- The same applies to a permissive fallback: an `.optional()` that swallows `""`, a `catch()` that returns a default, or a `refine` that returns `true` on anything it cannot parse.

### A rule about two fields lives on the object, not the field

Some rules cannot be expressed where the field is declared, because the field cannot see its siblings. `z.string().min(12)` for a password is a complete-looking schema that has no way to know the email sitting next to it, which is how "the password may not be your email" ends up unimplemented on a form that otherwise validates everything.

- Put cross-field rules on the OBJECT schema (`.superRefine`/`.refine` in Zod, a `model_validator` in Pydantic), and attach the error to the field the user has to change so it renders in that field's error slot, not at the top of the form.
- The recurring ones: password against the email, its local part, the username, the display name and the site name (normalized on both sides, per security-policy); the confirmation field against the password; a start date against an end date; a "one of these is required" pair.
- Give the object schema everything it needs to compare. On the server the identity usually comes from the account being modified rather than the request body, so build the schema with that value in scope (a factory that takes the identifiers and returns the schema) instead of trusting whatever the client sent.
- The client mirrors the same object schema so the conflict shows as the user types, and the server runs it again as the authority.

---

## Validation Standards

- Validate type, shape, range, format, and required/optional status.
- Normalize input (trim, case-fold, canonicalize) before validating equality or storing, per the section above.
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
- Concretely: in a catch block never return the caught error's `message`/`stack` or the raw error object to the client. A leaked ORM/DB error like `Invalid prisma.driveItemMeta.findMany() invocation: Inconsistent column data: Error creating UUID...` exposes your ORM, table/column names, and internals to an attacker. Log the real error server-side (`console.error` or your logger) and respond with a generic message plus a stable code. This is about 5xx internal failures; a 4xx validation reply may carry a safe, caller-actionable message you constructed, never a raw framework/ORM error.
- Use consistent, structured error responses (stable codes, safe messages).
- Distinguish validation errors (4xx, actionable) from internal failures (5xx, opaque to the client).
- Never leak the existence or absence of sensitive resources through error differences.