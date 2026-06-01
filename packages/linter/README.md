# @enigmax/linter

A small, fast linter and security auditor that enforces the **Ciphera code style**
and flags hardcoded secrets. It parses TypeScript/JavaScript with the TypeScript
compiler API, so the checks are AST-accurate rather than regex guesses.

It is meant to be run on demand - by a developer, by an agent as a self-check, or
wired into a project's scripts/CI - not as an always-on background process.

## Usage

```bash
# lint the current directory
npx @enigmax/linter

# lint specific paths
npx @enigmax/linter src test

# only the security audit, or only style
npx @enigmax/linter --audit-only
npx @enigmax/linter --style-only

# machine-readable output
npx @enigmax/linter --json
```

The bin is `enigmax-lint`. It exits non-zero when any error-severity violation is
found (URL/CDN imports, hardcoded secrets), so it can gate a commit or CI step.

## Rules

### Style (Ciphera)

| Rule | What it flags |
| --- | --- |
| `length-sorted-imports` | imports not ordered by line length, shortest first |
| `prefer-double-quotes` | single-quoted strings (where double would work) and no-interpolation template literals |
| `no-useless-concat` | string concatenation with `+` that should be a template literal |
| `require-semicolons` | statements missing a terminating semicolon |
| `no-url-imports` | importing from a remote URL / CDN instead of a package name (error) |
| `file-hygiene` | trailing whitespace, missing or extra final newline, leading blank line |

### Audit (security)

| Rule | What it flags |
| --- | --- |
| `no-hardcoded-secrets` | high-signal credential patterns - AWS keys, GitHub/Slack/Google/Stripe tokens, private-key blocks, and `secret/token/api_key = "..."` assignments (error) |

Files named `*example*`, `*sample*`, `*template*`, `*fixture*`, `*.test.*`, and
`*.spec.*` are exempt from the secret audit.

## Programmatic API

```ts
import { lintFiles, lintText } from "@enigmax/linter";

const violations = lintFiles(["src"], { categories: ["audit"] });
const inline = lintText("snippet.ts", "const x = 'a'");
```

## Style scope

These rules encode the Ciphera conventions for **new** code. Per the policy,
existing files should match their established style; do not reformat working code
just to satisfy the linter.
