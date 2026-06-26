# @enigmax/linter

A small, fast linter and security auditor that enforces the **Ciphera code style**
and flags hardcoded secrets. JavaScript/TypeScript is parsed with the TypeScript
compiler API, so its style checks are AST-accurate rather than regex guesses;
Python, Rust, and Prisma get the language-agnostic checks (file hygiene, blank-line
collapsing, and secret detection) with lightweight per-language lexing so blanks
inside docstrings, block comments, and multi-line strings are left alone.

Container formats - Jupyter notebooks (`.ipynb`), Astro (`.astro`), and Vue/Svelte
single-file components (`.vue`, `.svelte`) - are understood structurally: the
embedded code is extracted and linted as its real language, and the wrapper (JSON,
HTML) is never fed to the rules. Violations are mapped back to the physical line in
the original file.

It is meant to be run on demand - by a developer, by an agent as a self-check, or
wired into a project's scripts/CI - not as an always-on background process.

## Languages

| Language | Extensions | Rules applied |
| --- | --- | --- |
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | all style + audit rules |
| Python | `.py .pyi` | `no-consecutive-blank-lines`, `file-hygiene`, `no-hardcoded-secrets` |
| Rust | `.rs` | `no-consecutive-blank-lines`, `file-hygiene`, `no-hardcoded-secrets` |
| Prisma | `.prisma` | `no-consecutive-blank-lines`, `file-hygiene`, `no-hardcoded-secrets` |

The AST-based Ciphera style rules (length-sorted imports, double quotes, template
literals, semicolons, URL imports) are JavaScript/TypeScript-only by design: they
encode TS idioms and would misfire on other grammars (for example, Rust `'a'` char
literals or Python's idiomatic single quotes).

### Container formats (embedded code)

| Format | Extensions | Embedded code linted as |
| --- | --- | --- |
| Jupyter notebook | `.ipynb` | each `code` cell as **Python** (markdown/raw cells and outputs ignored; non-Python kernels skipped) |
| Astro | `.astro` | the `---` frontmatter as **TypeScript** plus every `<script>` block |
| Vue / Svelte | `.vue .svelte` | every `<script>` block, typed **TS** or **JS** by its `lang` attribute |

Only the code regions are linted - the surrounding JSON or HTML template is never
checked. The file-boundary part of `file-hygiene` (final newline, leading/trailing
blank line) is skipped for embedded fragments, since the container owns the file's
physical shape; trailing whitespace inside the code is still flagged. Every
violation's line number refers to the physical line in the original file.

## Usage

```bash
# lint the current directory
npx @enigmax/linter

# lint specific paths
npx @enigmax/linter src test

# only the security audit, or only style
npx @enigmax/linter --audit-only
npx @enigmax/linter --style-only

# apply safe formatting fixes in place, then report what remains
npx @enigmax/linter --fix

# machine-readable output
npx @enigmax/linter --json

# fail on warnings too (e.g. a changed-files commit/CI gate)
npx @enigmax/linter --strict
```

By default the CLI exits non-zero only on error-severity findings (URL/CDN imports,
hardcoded secrets). `--strict` also fails on warning-severity Ciphera style findings,
which is what a pre-commit or CI gate over changed files wants.

`--fix` rewrites only the mechanical formatting rules - trailing whitespace, blank
lines (collapsed, with leading/trailing removed), and the final newline. The AST
style rules (quotes, semicolons, imports) and the security audits are reported,
never rewritten, since fixing them safely needs real judgement. Container formats
(`.ipynb`, `.astro`, `.vue`, `.svelte`) are left untouched by `--fix`.

The bin is `enigmax-lint`. It exits non-zero when any error-severity violation is
found (URL/CDN imports, hardcoded secrets), so it can gate a commit or CI step.

## Rules

### Style (Ciphera)

| Rule | What it flags |
| --- | --- |
| `length-sorted-imports` | imports not ordered by line length, shortest first |
| `prefer-double-quotes` | single-quoted strings (where double would work) and no-interpolation template literals |
| `no-useless-concat` | string concatenation with `+` that should be a template literal |
| `require-semicolons` | statements missing a terminating semicolon - declarations (`const`/`let`/`var`), imports, exports, directives like `"use strict"`, type aliases, and class fields (function/class declarations are exempt, as their body terminates them) |
| `no-url-imports` | importing from a remote URL / CDN instead of a package name (error) |
| `no-consecutive-blank-lines` | two or more consecutive blank lines (collapse to one); ignores blanks inside strings/templates and block comments (all languages) |
| `file-hygiene` | trailing whitespace, missing or extra final newline, leading blank line (all languages) |

### Audit (security)

| Rule | What it flags |
| --- | --- |
| `no-hardcoded-secrets` | high-signal credential patterns - AWS keys, GitHub/Slack/Google/Stripe tokens, private-key blocks, and `secret/token/api_key = "..."` assignments (error, all languages) |

To keep false positives low, a match is only reported when its random portion looks
like a real credential: obvious placeholders (`your_api_key_here`, `changeme`, ...)
and low-entropy fillers (`sk-proj-000000000000`, repeated characters) are ignored.
Files named `*example*`, `*sample*`, `*template*`, `*fixture*`, `*.test.*`, and
`*.spec.*` are exempt from the secret audit entirely.

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
