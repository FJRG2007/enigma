#!/usr/bin/env node

// src/guardrails.ts
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { readFileSync, statSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
var COMMENT_LINE = /^\s*(\/\/|#|\*|--|<!--|\{?\/\*)/;
var BUILTIN_RULES = [
  {
    id: "db-uuid-pk",
    label: "UUID primary keys",
    // Basename globs (no slash) match at any depth, including the repo root; the dir
    // globs additionally catch non-standard extensions under those folders.
    files: ["*.prisma", "*.sql", "*.entity.ts", "**/migrations/**", "**/entities/**", "**/models/**"],
    scope: "file",
    // Matches only explicit auto-increment identity signals across engines/ORMs.
    // Deliberately does NOT match a plain `INTEGER PRIMARY KEY` (valid in many cases,
    // and used on purpose by enigma's own recall SQLite store).
    pattern: `\\b(?:BIG|SMALL)?SERIAL\\b|\\bAUTO_INCREMENT\\b|\\bIDENTITY\\s*\\(|\\bGENERATED\\s+(?:ALWAYS|BY\\s+DEFAULT)\\s+AS\\s+IDENTITY\\b|@default\\(autoincrement\\(\\)\\)|@PrimaryGeneratedColumn\\(\\s*(?:\\)|["']increment["'])`,
    flags: "i",
    message: "Use UUID primary keys, never auto-increment / SERIAL / IDENTITY / AUTO_INCREMENT (database-expert). Generate a UUID (prefer UUIDv7 or ULID) at the application layer or via a database uuid default.",
    severity: "block",
    skill: "database-expert"
  },
  {
    id: "db-ts-orm-prisma",
    label: "Prisma as the default ORM (TypeScript)",
    files: ["package.json", "*.sql", "schema.ts", "ormconfig.*", "data-source.ts", "knexfile.*", "drizzle.config.*"],
    scope: "project",
    check: "ts-relational-no-prisma",
    message: "This is a TypeScript project on a relational datastore without Prisma. Prefer Prisma as the default ORM for new TypeScript work (database-expert).",
    severity: "warn",
    skill: "database-expert"
  },
  {
    id: "db-sqlite-app-datastore",
    label: "PostgreSQL as the default relational engine",
    // Basename glob, so it covers schema.prisma at any depth (a `**/*.prisma` glob would
    // miss a root-level one - the documented gotcha).
    files: ["*.prisma"],
    scope: "file",
    // A Prisma DATASOURCE on sqlite: the app's own database, declared by the ORM this policy
    // already defaults to. `provider` also appears in generator blocks, but only a datasource
    // ever names sqlite, so the value alone is the discriminator.
    // WHY THIS SHAPE AND NOT A DEPENDENCY CHECK: a Prisma project declares NO sqlite driver in
    // package.json (Prisma bundles its own), so the package.json signature that would look
    // natural here misses the exact stack an agent scaffolds. Measured over the corpus: 14
    // prisma schemas, every datasource already postgresql, and 0 package.json files declaring
    // a sqlite driver at all - so this rule is a scaffolding guard with no legacy backlog to
    // flag, which is also why it is the only slice of the convention worth gating.
    pattern: `provider\\s*=\\s*["']sqlite["']`,
    absent: "enigma:allow-sqlite",
    message: "SQLite as the application datastore. SQLite is one file with one writer: it is right for a local-first or embedded store (a CLI's own state, a desktop or mobile app, a local cache or index, a test fixture) and wrong for anything deployed, replicated, or written to by a background worker - and moving off it later is a migration with downtime, not a config change. Default to PostgreSQL: real write concurrency, native uuid/jsonb/arrays/enums/timestamptz, partial and GIN indexes, partitioning and read replicas, plus pgvector, pg_trgm and PostGIS instead of a second service. On serverless put a pooler in front (PgBouncer, Prisma Accelerate, the provider's pooled endpoint); the constraint there is connection count, not the engine. If this datastore is deliberately local-first or embedded, mark it with an `enigma:allow-sqlite` note (database-expert).",
    severity: "block",
    skill: "database-expert"
  },
  {
    id: "be-validate-input-ts",
    label: "Validate request input (TypeScript)",
    files: ["*.ts", "*.js", "*.mts", "*.cts"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // Fires only on ASSIGNING the request BODY to a variable (where validation belongs) with
    // no schema-validation signal in the file. Deliberately NOT req.query/req.params (single
    // scalars, usually validated inline) and NOT a body passed as a bare arg (e.g. to a logger)
    // - real-world scanning showed those are the false-positive sources. The absent set is BROAD
    // (every common validator) so any validated file is skipped: precision over recall.
    pattern: "=\\s*req\\.body\\b|=\\s*(await\\s+)?request\\.json\\(\\)|=\\s*ctx\\.request\\.body\\b|=\\s*await\\s+c\\.req\\.json\\(",
    absent: "z\\.|\\.parse\\(|\\.safeParse\\(|\\.validate\\(|\\.assert\\(|valibot|\\byup\\b|\\bjoi\\b|\\bJoi\\b|\\bajv\\b|superstruct|typebox|@sinclair|arktype|io-ts|runtypes|@Body\\(|class-validator|express-validator|zodResolver|Type\\.Object|checkSchema|celebrate",
    message: "Reads request input without validating it. Parse every input through a schema (Zod, or valibot/yup/...) - never trust an unvalidated shape. For a tagged/event union, validate the discriminant AND that variant's body (validation-policy, backend-policy).",
    severity: "warn",
    skill: "validation-policy"
  },
  {
    id: "be-validate-input-py",
    label: "Validate request input (Python)",
    files: ["*.py"],
    excludeFiles: ["test_*.py", "*_test.py", "conftest.py", "**/tests/**"],
    scope: "file",
    // Assigns the request body to a variable with no schema-validation signal. request.data is
    // intentionally omitted (raw-bytes reads - webhook HMAC, proxying - are not schema surfaces).
    // The absent set is broad to skip any validated file (Pydantic, marshmallow, Django forms, ...).
    pattern: "=\\s*request\\.get_json\\(|=\\s*(await\\s+)?request\\.json\\b|=\\s*request\\.form\\b|=\\s*request\\.POST\\b",
    absent: "BaseModel|pydantic|marshmallow|serializers|TypeAdapter|field_validator|@validator|model_validate|is_valid\\(|forms\\.|ModelForm|cerberus|voluptuous|jsonschema|@dataclass|\\.load\\(|Schema\\(",
    message: "Reads the raw request body without a schema. Validate with Pydantic (BaseModel / model_validate) - or the stack's validator - and discriminate the payload by its type/event (validation-policy, backend-policy).",
    severity: "warn",
    skill: "validation-policy"
  },
  {
    id: "val-email-normalize",
    label: "Email is normalized before it is validated",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "*.d.ts",
      "*.min.js",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // An email schema declared with no normalization anywhere in the file. The three forms
    // cover the ecosystem: `.string()...email(` (zod 3, yup, joi), `z.email(` (zod 4) and
    // `v.email(` (valibot). Measured over ~2500 files of real product repos: 10 files declare
    // an email schema, 7 normalize nothing - all 7 genuine (invitation forms, backend request
    // schemas, an auth route), 0 false positives. `absent` keys on CASE-FOLDING only, not on
    // trimming: an email schema that trims but keeps the case still lets "A@x.com" and
    // "a@x.com" become two accounts, which is the defect. It stays file-scoped (the engine has
    // no line-scoped absent), so a file that lowercases anything at all clears - a deliberate
    // false negative, precision over recall.
    pattern: "\\.string\\(\\)[^\\n]*\\.email\\(|\\bz\\.email\\(|\\bv\\.email\\(",
    absent: "toLowerCase|lowercase\\(|normalizeEmail|enigma:allow-raw-email",
    message: 'Email schema with no normalization. An address pasted with a leading space or typed in mixed case must reduce to ONE stored value, or the lookup misses, the uniqueness check passes, and the user ends up with a second account. Normalize inside the schema so no caller can forget it: Zod `z.string().trim().toLowerCase().pipe(z.email())` - the order matters, `z.email().trim()` validates first and rejects a pasted " a@b.com" - Yup `.trim().lowercase().email()`, Pydantic a `field_validator(mode="before")`. Use the same schema on the client and the server. If this address must keep its case, mark it with an `enigma:allow-raw-email` note (validation-policy).',
    severity: "block",
    skill: "validation-policy"
  },
  // NOTE: there is deliberately no "URL check that patches the value first" rule, though that
  // exact shape is what makes a link field accept anything: `z.url().safeParse(v.startsWith("http")
  // ? v : "https://" + v)` passes for `asdf`, because `https://asdf` IS a syntactically valid URL.
  // The signature (a scheme interpolated into the string being parsed) does not survive
  // measurement: 7 hits across the corpus and 5 are legitimate canonicalization for DISPLAY or
  // parsing (build a URL to read its hostname), which is the same code shape with none of the
  // defect. Telling them apart needs to know whether the result is a VERDICT or a value, which
  // is not in the line. It stays in validation-policy ("A check that cannot fail is not
  // validation") together with the URL-or-handle canonicalization rule.
  // NOTE: no Go/Rust input-validation rule. Go's manual validation (`if in.X == ""`) is
  // idiomatic and has no detectable signature, and Rust's serde typed deserialization already
  // enforces shape - a rule for either would false-positive. The generic "validate every input"
  // principle for those languages lives in the always-on memory kernel instead.
  {
    id: "fe-password-input",
    label: "Reusable password input (show/hide)",
    files: ["*.tsx", "*.jsx"],
    scope: "file",
    // A raw lowercase <input type="password"> (not a component) with no show/hide toggle in the
    // file. flags:"" = case-sensitive so a capitalized <Input> component is NOT matched; a
    // literal type="password" only, so a dynamic type={visible?...} toggle is not matched either.
    pattern: `<input\\b[^>]*type=["']password["']`,
    flags: "",
    absent: "showPassword|setShowPassword|togglePassword|revealPassword|passwordVisible|isPasswordVisible|showPw|hidePassword",
    message: 'Raw <input type="password">: use the shared reusable Input component (which renders a show/hide toggle for passwords) instead of a bare input, or add the toggle (frontend-policy).',
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-name-input-capitalize",
    label: "A person-name field capitalizes its words",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/stories/**",
      "*.stories.*",
      "*.min.js",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // A field that holds a PERSON's name, with no autocapitalize anywhere in the file. On a
    // phone the keyboard defaults to sentence capitalization, so the user types "juan perez"
    // and that is what gets stored; `autocapitalize="words"` is the one attribute that fixes
    // it, and it is inert on a desktop keyboard.
    // PRECISION comes from the token set, measured over ~2500 files of real product repos.
    // Only names that can ONLY be a person's are matched: the HTML autofill tokens (which the
    // spec defines as the person's name) and first/last/surname/apellido field names. `name`,
    // `nombre` and `fullname` are deliberately EXCLUDED - every one of their hits in the
    // corpus was an entity name (a project, a team, a token, a webhook), which must not be
    // title-cased. With that set: 8 findings, all genuine person-name inputs, 0 false
    // positives; the one file that already sets autocapitalize is correctly cleared.
    pattern: `autocomplete=\\{?["'](?:name|given-name|family-name|additional-name|honorific-prefix)["']|(?:\\bname|\\bid|\\bfor|formControlName)=\\{?["'](?:first[-_]?name|last[-_]?name|given[-_]?name|family[-_]?name|surname|apellidos?)["']`,
    absent: "autocapitalize|enigma:allow-no-capitalize",
    message: 'Person-name field with no capitalization rule. Phone keyboards capitalize SENTENCES, so a name typed on mobile is stored as "juan perez": add `autocapitalize="words"` (plus `spellcheck="false"` and `autocorrect="off"`, and the matching `autocomplete` token). The attribute only covers typing, so normalize the value too - trim, collapse inner spaces, and uppercase the first letter of every word - on blur and again on the server, uppercasing ONLY that letter so `McDonald`, `O\'Brien` and `van der Berg` survive. Best placed once in the shared Input/TextField component, selected by a prop. For a field that must keep what was typed, add an `enigma:allow-no-capitalize` note (frontend-policy, validation-policy).',
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-no-native-dialog",
    label: "No native browser dialogs",
    files: ["*.tsx", "*.jsx", "*.ts", "*.js", "*.mts", "*.cts", "*.vue", "*.svelte", "*.astro"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // window.(alert|confirm|prompt)( is unambiguously the native dialog (window is browser-only,
    // so no false positive in a Node file). Bare alert/confirm/prompt is matched ONLY with a
    // string-literal arg - native dialogs take a string, while CLI libs (clack/inquirer) and
    // custom design-system dialogs take a {config} object, and an AI `prompt` value is a string
    // that is passed, not called with a string literal. flags:"" is case-sensitive so a
    // capitalized custom <Alert>/Confirm() is not matched; (?<![.\w]) excludes method calls.
    pattern: `\\bwindow\\.(alert|confirm|prompt)\\s*\\(|(?<![.\\w])(alert|confirm|prompt)\\s*\\(\\s*["']`,
    flags: "",
    message: "Native browser dialog (alert/confirm/prompt) - use a dialog/modal component that matches the page design instead of the browser's built-in. If this confirms a destructive action, use a real confirmation dialog that names what is being deleted; for an irreversible one (delete a repo/account/org, drop data) require type-to-confirm - the user types the exact resource name and the button stays disabled until it matches (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-date-moment",
    label: "Modern date handling (no moment.js)",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // Importing moment / moment-timezone. The `from "..."` / `require("...")` specifier is
    // unambiguous (near-zero FP): a quote must sit right before `moment`, so "react-moment"
    // and a prose "...from moment" string do not match, and comment lines are skipped anyway.
    // This is the only regex-gateable slice of the date-display convention - "use
    // <relative-time>" itself is a positive semantic recommendation the engine cannot assert.
    pattern: `from\\s+["']moment(?:-timezone)?["']|require\\(\\s*["']moment(?:-timezone)?["']\\s*\\)`,
    message: "moment.js is heavy and in maintenance mode. For displaying dates use <relative-time> (@github/relative-time-element) or the native Intl APIs; for date math prefer a lightweight option (date-fns, dayjs, or Temporal) (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-search-fuzzy",
    label: "Fuzzy search for finders (fuse.js)",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // A hand-rolled case-insensitive substring finder: a .filter(...) whose body does
    // `.toLowerCase().includes(....toLowerCase())`. The SYMMETRIC double-toLowerCase inside a
    // filter is a near-certain search box (precision over recall - a one-sided or non-filter
    // .includes is intentionally not matched). Skipped when fuse is already present in the file.
    pattern: "\\.filter\\([^;]*\\.toLowerCase\\(\\)\\.includes\\([^;]*\\.toLowerCase\\(\\)",
    absent: "fuse",
    message: "Hand-rolled substring search. For a free-text search box use fuse.js (fuzzy search): it tolerates typos and ranks matches, which is more robust and professional than a case-insensitive .includes() filter (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-skeleton-loading",
    label: "Skeletons over blank/spinner loading",
    files: ["*.tsx", "*.jsx"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // JSX only (*.tsx/*.jsx = React/Preact/Solid/RN); other frameworks use their own idioms and
    // file types, so they are never touched by this rule. A whole-component loading guard that
    // returns null or a bare spinner (blank screen until the fetch resolves) - the "page doesn't
    // render until it has data" tell. The return group matches ONLY null / a
    // *Spinner|*Loader|*Loading|CircularProgress element, so `return <Skeleton/>` is NOT matched
    // (that is the correct pattern). `absent` skips the file when ANY placeholder/skeleton signal
    // is present (skeleton, animate-pulse, shimmer, Suspense, a content-loader lib, <Placeholder>)
    // - the component already renders a placeholder somewhere. Kept to the terse one-line guard for
    // precision (a multi-line block is not matched: precision > recall).
    pattern: "\\bif\\s*\\(\\s*(isLoading|isPending|isFetching|loading|pending)\\s*\\)\\s*return\\s+(null\\b|<\\s*\\w*(Spinner|Loader|Loading|CircularProgress)\\b)",
    absent: "skeleton|animate-pulse|shimmer|Suspense|ContentLoader|content-loader|<\\s*Placeholder",
    message: "Component returns nothing (or only a spinner) while data loads, so the page stays blank until the fetch resolves. Render the shell/layout on first paint and show skeleton placeholders shaped like the final content (reserve their space to avoid layout shift) while data loads async via the API (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-ai-elements-chat",
    label: "AI chat UI via AI Elements",
    files: ["*.tsx", "*.jsx"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**"],
    scope: "file",
    // A JSX file branching on a message role of "assistant" is hand-rolled AI chat UI. The role
    // value is what makes this precise: "user"/"admin"/"owner"/"member" are the RBAC vocabulary
    // and appear far more often than chat rendering does, so matching them would false-positive
    // on every permission check - "assistant" has no meaning outside an LLM conversation.
    // Measured over a real multi-repo corpus: 15 matching files, all genuine chat surfaces, 0 FP.
    // `absent` skips a file that already uses AI Elements or another established chat-UI kit.
    pattern: `\\.role\\s*===?\\s*["']assistant["']`,
    flags: "",
    absent: "ai-elements|assistant-ui|@assistant-ui|copilotkit|@copilotkit|llm-ui|@nlux|nlux|@chatscope|chatscope",
    message: "Hand-rolled AI chat UI. Use AI Elements (https://elements.ai-sdk.dev/components) - `npx ai-elements@latest add conversation message prompt-input` copies the source into @/components/ai-elements/, so it stays editable with no runtime dependency. It already solves streaming, scroll-stick-to-bottom, markdown with unclosed code fences mid-stream, and reasoning/tool-call/citation panels. Needs React + Tailwind + shadcn/ui; on any other stack build natively instead (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-viewport-meta",
    label: "Responsive viewport meta tag",
    // Full HTML documents (a page/layout, not a fragment). Astro layouts own the <head>;
    // .vue/.svelte SFCs manage head via the framework, so they are not included. A head-fragment
    // file (Storybook preview-head.html, an injected partial) holds bare <meta>/<link> with NO
    // literal <head> tag, so it never matches the pattern either.
    files: ["*.html", "*.htm", "*.astro"],
    // EMAIL and PRINT/PDF docs are full <head> documents that OMIT viewport ON PURPOSE (mail
    // clients ignore it; print is fixed-width) - exclude those trees so they never flag.
    excludeFiles: ["**/dist/**", "**/build/**", "**/email/**", "**/emails/**", "**/mail/**", "**/mailer/**", "**/mailers/**", "**/pdf/**", "**/print/**"],
    scope: "file",
    // Fires on a web document that opens a <head> but never declares a viewport meta - the one
    // precise slice of "make it responsive": without it the page renders at desktop width on
    // mobile. `absent` skips the file when viewport is present OR when it is clearly an EMAIL
    // (mso- Outlook styles, an <!--[if mso]> conditional, -webkit-text-size-adjust reset, or MJML
    // <mj-*>) - emails legitimately have no viewport, so those must never be flagged. Together with
    // the path excludes this drives cross-stack false positives to ~zero.
    pattern: "<head[\\s>]",
    absent: "viewport|mso-|<!--\\[if\\s|-webkit-text-size-adjust|<mj-",
    message: 'HTML document with a <head> but no responsive viewport meta. Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page is responsive on mobile instead of rendering at desktop width (frontend-policy).',
    severity: "warn",
    skill: "frontend-policy"
  },
  // NOTE: there is deliberately no "a pinned sidebar needs its own scroll" rule, and no
  // "a URL in UI copy must be a link" rule, though both conventions were asked for. Neither
  // has a file-local signature this engine can read.
  //   - The sidebar defect is a RELATION between three declarations (pinned + height bound +
  //     overflow) that real stylesheets spread over several lines of one block, which a
  //     line-based scan cannot correlate; the Tailwind one-line form would be the exception,
  //     and the corpus (this repo, apps/web, references/repos) holds exactly two real
  //     sidebars, neither of them Tailwind - zero measured true positives, which is the same
  //     evidence that got the no-op-save rule rejected. It is also not a defect until the
  //     sidebar's content outgrows the viewport, so a rule would flag correct short ones.
  //   - The link one cannot tell COPY from DATA: a URL in a string is far more often an API
  //     endpoint, a default, or a docs reference in a comment than a piece of UI text, and
  //     nothing in the string says which. Both live in frontend-policy instead (Persistent
  //     Chrome Stays Put, Links In Copy Are Links).
  // NOTE: there is deliberately no "truncating flex item needs min-w-0" rule. It was written
  // and then removed after measuring it in a browser: per CSS Flexbox 4.5 a flex item's
  // automatic minimum size only applies while its computed overflow is visible, and Tailwind's
  // `truncate` sets overflow:hidden - so `flex-1 truncate` already shrinks and ellipsizes, and
  // the rule only ever flagged correct code. The real defect is an ANCESTOR flex/grid item with
  // visible overflow wrapping the truncating element, which spans two elements and so has no
  // single-line signature. It stays in frontend-policy as guidance rather than becoming a rule
  // that cries wolf.
  {
    id: "fe-ellipsis-without-overflow",
    label: "Ellipsis needs overflow hidden",
    files: ["*.css", "*.scss", "*.sass", "*.less", "*.styl", "*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "**/build/**", "*.min.css"],
    scope: "file",
    // text-overflow only applies to a box that actually overflows, so ellipsis without an
    // overflow value does nothing at all - the text just spills. The absent set covers the
    // CSS declarations and the Tailwind utilities that provide it; note it cannot simply be
    // "overflow", which would match the text-overflow property on this very line.
    pattern: "text-overflow\\s*:\\s*ellipsis",
    // Only things that actually PROVIDE the missing overflow value. Tailwind's `truncate`
    // does (it sets overflow-hidden); `text-ellipsis` does not - it is the ellipsis
    // declaration itself, so listing it would suppress the very case being flagged.
    absent: "overflow(?:-x|-y)?\\s*:\\s*(?:hidden|clip|auto|scroll)|overflow-hidden|overflow-clip|\\btruncate\\b",
    message: "text-overflow: ellipsis has no effect without an overflow value other than visible - the text overflows instead of being clipped. Add overflow: hidden (with white-space: nowrap for a single line), and keep the full value reachable via title or a tooltip (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-icon-action-button",
    label: "Repeated actions are icon buttons, not text labels",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js", "*.mts", "*.cts"],
    // Same two-form generated/vendored excludes as ui-no-em-dash: `**/x/**` needs a leading
    // segment, so it misses a root-level dist/.
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/fixtures/**",
      "*.min.js",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // A button whose ENTIRE content is one bare action verb. Three things keep this precise,
    // measured over ~1100 real UI files (this repo, apps/web and references/repos): 10 hits,
    // all genuine text action buttons, 0 false positives.
    // (1) `[^>]*` forces the whole element onto one line with NOTHING but the word inside, so
    //     a button that already carries an icon (its <svg .../> contains a '>') never matches -
    //     icon-plus-label is not the defect, a bare word is. It still catches the string-concat
    //     form ('<button data-id="' + esc(id) + '">Edit</button>') because that has no '>' either.
    // (2) The verb set is limited to actions with a universally understood glyph that repeat per
    //     row or per card. Save/Cancel/Submit/Add and any multi-word label ("Delete project") are
    //     deliberately absent: those are primary buttons whose job is to be read.
    // (3) Case-insensitive on the tag, so a <Button> component matches too; the backreference
    //     keeps the closing tag paired with the opening one.
    pattern: "^(?!.*enigma:).*<(button)\\b[^>]*>\\s*(?:Copy|Remove|Delete|Edit|Rename|Duplicate|Download|Share|Refresh|Reload)\\s*</\\1>",
    absent: "enigma:allow-text-actions",
    message: 'Action button labelled with a word. A repeated row or card action (copy, edit, rename, duplicate, remove, delete, download, share, refresh) reads faster and costs far less width as an ICON button: drop the visible word for a single icon taken from the project\'s one icon set, and keep the action reachable without sight - aria-label="<Action> <what it acts on>" for the accessible name, title="<Action>" for the hover tooltip, aria-hidden="true" on the icon itself (an <img> icon carries the same text as its alt instead). Keep a written label only where the design or the user asks for one, or on a primary/confirmation button whose whole job is to be read - then mark the line with an `enigma:` note, or add `enigma:allow-text-actions` to the file (frontend-policy).',
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "doc-no-file-tree",
    label: "No ASCII file-tree in the README",
    // README only, at any depth. Scoped deliberately: a file tree in a deliberate
    // authoring guide or tutorial (e.g. a skill-creation doc) is legitimate; the
    // auto-generated "Project Structure" tree in a README is the AI tell this targets.
    files: ["README.md", "README.mdx", "readme.md", "readme.mdx"],
    scope: "file",
    // Box-drawing branch connectors (U+251C '├' and U+2514 '└' followed by U+2500 '─') are
    // the signature of an auto-generated project-structure tree; they appear almost nowhere
    // else in prose, markdown tables, or mermaid.
    pattern: "[\\u251C\\u2514]\\u2500",
    message: "ASCII/box-drawing project-structure tree in the README. Only keep one if the user explicitly asked for it - never volunteer it. If unprompted, drop the tree and the folder-by-folder explanation: it rots when files move, is usually misaligned, and restates what the file browser shows (technical-writing-policy).",
    severity: "warn",
    skill: "technical-writing-policy"
  },
  {
    id: "ui-no-em-dash",
    label: "No typographic dash in UI copy",
    // Files that render text to a person: markup, components and the modules that hold
    // their strings. Markdown is deliberately NOT here - prose files legitimately quote
    // and vendor third-party text, so scanning them would flag content nobody wrote.
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js", "*.mts", "*.cts"],
    // The generated/vendored trees are listed twice: `**/x/**` needs a leading segment, so
    // it does NOT match a root-level `dist/main.js` - the usual place for build output.
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/fixtures/**",
      "*.min.js",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // An em dash (U+2014) or en dash (U+2013) used as PROSE PUNCTUATION: the character
    // must sit between two pieces of text ("saves time - automatically", "60-95%"). Both
    // are written as regex escapes so this file never contains the characters it forbids.
    // Two things keep this precise. (1) The text-on-both-sides requirement skips the
    // standalone glyph - `return "-"` for an empty table cell, a `<span>-</span>`
    // separator, a CLI bullet - which is a deliberate symbol, not copy, and was the only
    // real false-positive class when the rule was measured over ~1100 real UI files.
    // (2) The leading lookahead drops lines where the character is DATA rather than copy:
    // a sanitizer (.replace / normalize), a character or entity table (mdash, ndash,
    // fromCharCode, an escaped \u201x), a line the author marked with `enigma:`, or a
    // line carrying a TRAILING comment - the engine only skips a line that STARTS as a
    // comment, and a dash in a developer note is not user-facing text. `//` is matched
    // only when it is not preceded by a colon, so a URL does not silence a line.
    // `absent` gives a whole file an opt-out for genuinely quoted text.
    // HTML entities (&mdash;) are deliberately not matched: to a line regex an entity
    // table and an entity in copy are identical, so matching them would cost more than
    // it catches.
    pattern: "^(?!.*(?:enigma:|\\.replace|normali|fromCharCode|charCodeAt|mdash|ndash|\\\\u201|(?<!:)//|/\\*)).*[A-Za-z0-9)\\].,:%!?]\\s*[\\u2014\\u2013]\\s*[A-Za-z0-9(\\[\"'`]",
    absent: "enigma:allow-dash",
    message: 'Typographic dash in user-facing text. The em dash and en dash are the clearest tell of AI-written copy and no interface needs them: use a plain hyphen "-", a comma, a colon, or two sentences, and write a range as "5 to 10". Keep one only when the dash is the subject (a typography guide) or the text is quoted verbatim - then mark the line with an `enigma:` note or add `enigma:allow-dash` to the file (technical-writing-policy).',
    severity: "block",
    skill: "technical-writing-policy"
  },
  // NOTE: there is deliberately no "Save button with no dirty check" rule, even though
  // no-op detection is one of frontend-policy's headline rules. It has no file-local
  // signature that survives measurement. The dirtiness normally lives in a parent, a store
  // or a form library, so its absence from THIS file proves nothing; the policy explicitly
  // allows an enabled Save that short-circuits on click, so a missing `disabled` is not
  // evidence of the defect either; and the same markup is correct on a create form, which
  // has nothing to compare against. Measured on the corpus: 2 save buttons in 108
  // form-capable files (no signal), and the interaction-based dirty flag that WOULD be a
  // precise signature (a dirty/hasChanges flag assigned a literal true) returned 0 real
  // hits and 2 false ones, a CLI tracking whether it had rewritten a config file. A rule
  // here would fire on correct code, so it stays guidance in frontend-policy.
  // NOTE: there is deliberately no "card inside a card" or "border with no information"
  // rule, even though both are named in frontend-policy. They are RELATIONAL defects: a
  // container is redundant only relative to the ancestor it sits in and the spacing around
  // it, and a border is legitimate on an input, a table edge or a flush row list. Neither
  // has a single-line signature, so a regex over `rounded-lg border` would flag correct
  // markup on almost every screen. Visual density stays guidance in frontend-policy.
  {
    id: "be-no-leak-internal-error",
    label: "Do not leak internal errors to the client",
    files: ["*.ts", "*.js", "*.mts", "*.cts"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**"],
    scope: "file",
    // Two high-signal one-line leaks: (a) a 5xx response whose body includes a caught error's
    // .message/.stack (the Prisma/DB-error leak), or (b) a stack trace passed into any response
    // body. A 4xx validation reply carrying a constructed .message is deliberately NOT matched
    // (those can be safe). `console.error(err.message)` / `logger.error(err.stack)` are not
    // responses, so logging the real error is never flagged - only sending it out is.
    pattern: "\\.status\\(\\s*5\\d\\d\\s*\\)[^;]*\\b(err|error|e|ex|exception)\\.(message|stack)\\b|(res|reply|response)\\.(json|send|end)\\([^;]*\\b(err|error|e|ex|exception)\\.stack\\b",
    message: "Leaking an internal error to the client. Never send a caught exception's .message/.stack (or a raw ORM/DB error) in a 5xx response - it exposes your schema, ORM, and internals. Log it server-side (console.error / your logger) and return a generic message with a stable code (validation-policy, security-policy).",
    severity: "warn",
    skill: "validation-policy"
  },
  {
    id: "ctx-memory-budget",
    label: "Agent memory file within its context budget",
    // Basename globs, so this covers the file at any depth. Only the agent memory files:
    // every other doc is read on demand and costs nothing until it is opened.
    files: ["CLAUDE.md", "AGENTS.md"],
    scope: "file",
    // Size has no regex form, hence maxBytes. 40 KB is ~10k tokens paid on EVERY session
    // in the project, relevant or not - a memory file that large is already broken, and
    // the fix (an index plus on-demand docs) is mechanical, so this blocks rather than
    // warns: a warn exits 0 and never reaches the model that keeps growing the file.
    maxBytes: 4e4,
    message: "This memory file loads into every session in the project, so its cost is paid on every task regardless of relevance. Keep it an INDEX: move each subsystem's detail into its own doc (docs/notes/<topic>.md) and leave one line here saying what the note covers and when to read it. Route new conventions by tier - a file-local syntactic signature becomes a guardrail rule, a domain-scoped rule belongs in the owning skill (loaded on demand), and only a truly universal rule stays in memory. Turn this off with `enigma guardrails disable ctx-memory-budget`.",
    severity: "block"
  },
  {
    id: "ts-import-namespace",
    label: "Namespace import for a wide module surface",
    files: ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.jsx"],
    // Two-form generated/vendored excludes (`**/x/**` misses a root-level dist/). Declaration
    // files are excluded too: a .d.ts re-declares another module's surface, it has no call sites.
    excludeFiles: [
      "*.min.js",
      "*.d.ts",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // A count has no regex form, hence maxNamedImports. 9 is the budget: past that the import
    // line stops being readable, and every new export of the module widens it again. Only the
    // project's OWN modules are counted - a bare specifier (node builtin, npm package) is a
    // fixed surface the ecosystem writes as named imports, so counting those would flag
    // idiomatic code. BLOCK for the ui-no-em-dash reason: a warn exits 0 and never reaches
    // the model, and the fix is mechanical.
    maxNamedImports: 9,
    message: 'Too many named bindings from one module. Import it as a namespace instead - `import * as <ns> from "<module>"`, then call `<ns>.thing()` - so the import stays one short line, each call site says where the symbol comes from, and a new export never widens the import again. The count sums every named import of that module in this file, so splitting the statement in two does not help; name the namespace for the module, and pick a distinct name when the natural one is already a local variable. Keep named imports for a handful of symbols. Mark a deliberate exception with an `enigma:` note on the import line (ciphera-style-policy).',
    severity: "block",
    skill: "ciphera-style-policy"
  },
  {
    id: "proc-windows-hide",
    label: "Spawned process must not pop a console window",
    files: ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.jsx"],
    // Tests run in a terminal that already has a console, so a flashing window is not a
    // defect there. Same two-form generated/vendored excludes as the rules above.
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/fixtures/**",
      "*.min.js",
      "*.d.ts",
      "**/dist/**",
      "**/build/**",
      "**/_build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "_build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // A call spanning several lines has no line-regex form, hence a coded check (see
    // missingWindowsHide for the three shapes it deliberately leaves alone). BLOCK for the
    // ui-no-em-dash reason: a warn exits 0 and never reaches the model, the symptom is
    // invisible to whoever writes the code on macOS or Linux, and the fix is one key.
    fileCheck: "proc-windows-hide",
    message: "Process spawned without windowsHide. On Windows a console child started by a process that has no console of its own - a daemon, an editor hook, a detached background task - pops a real console window on screen and closes it again, which reads as something crashing. Add `windowsHide: true` to the options object; it is inert on macOS and Linux, and inert on Windows when the parent already has a console, so it is safe on every call that is not deliberately opening a terminal for the user. For one that IS (a login flow that must show a terminal), mark the call with an `enigma:` note.",
    severity: "block"
  },
  // NOTE: no rule for "render the cached snapshot, then patch only what changed". Whether a
  // fresh response REPLACES the rendered list or is reconciled into it is a property of the
  // state update, which normally lives in a store, a query library's cache or a parent - and
  // `setRows(data)` is correct code in the many views that have no snapshot to reconcile
  // against. There is no file-local evidence of the defect, so it stays in frontend-policy's
  // Client-Side Caching section.
  {
    id: "fe-mobile-drawer-full-width",
    label: "An off-canvas panel fills the phone screen",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/stories/**",
      "*.stories.*",
      "*.min.js",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // An off-canvas panel (fixed/absolute, pinned for the full height) whose width is a fixed
    // desktop size with no full-width base. Utility-class frameworks only: the same defect in
    // a stylesheet lives inside a @media block, which a line scanner cannot see.
    // PRECISION, measured over the reference corpus: the width must be a PANEL width - 100px
    // or more, 10rem or more, a Tailwind step of 40 (10rem) or more, or a fraction of the
    // viewport. Every false positive found was a hairline (`w-px` chart cursors, a `w-px`
    // resize handle, a `before:w-0.5` guide line), and that one bound removed all of them.
    // The negative lookahead carries the "unless the design says otherwise" cases: an
    // already-full-width base, a width capped by `max-w-full`, and a panel that is hidden on
    // phones anyway (the desktop half of a hidden/drawer pair).
    pattern: "^(?!.*enigma:)(?!.*(?:\\bw-full\\b|\\bmax-w-full\\b|\\bw-screen\\b|\\bhidden\\s+(?:sm|md|lg|xl):|\\bmd:hidden\\b))(?:.*\\b(?:fixed|absolute)\\b[^\"'`]*\\b(?:inset-y-0|h-full|h-screen)\\b[^\"'`]*\\bw-(?:\\[(?:\\d{3,}px|\\d{2,}rem)\\]|[4-9]\\d\\b|\\d{3}\\b|\\d/\\d\\b)|.*\\bw-(?:\\[(?:\\d{3,}px|\\d{2,}rem)\\]|[4-9]\\d\\b|\\d{3}\\b|\\d/\\d\\b)[^\"'`]*\\b(?:fixed|absolute)\\b[^\"'`]*\\b(?:inset-y-0|h-full|h-screen)\\b)",
    absent: "enigma:allow-partial-drawer",
    message: "Off-canvas panel with a desktop width. On a phone a sidebar, drawer or nav panel takes the WHOLE screen - `w-full` as the base, with the desktop width added at a breakpoint (`w-full md:w-80`) or capped by `max-w-*`. A 320px panel on a 360px screen leaves a sliver of dead content behind it, and a panel wider than the viewport is simply cut off. Keep it dismissible: a close control, the backdrop, and Escape. If the design deliberately wants a partial-width panel on mobile, put an `enigma:` note on the line or `enigma:allow-partial-drawer` in the file (frontend-policy).",
    severity: "block",
    skill: "frontend-policy"
  },
  // AUTH. Three defects an agent building a sign-in flow reproduces constantly, each with a
  // file-local signature. They fire only in files NAMED for the flow they belong to
  // (*login*, *register*, *2fa*, ...), which is what keeps them off the rest of a codebase:
  // "password" and "redirect to /login" appear everywhere, but not in a file called login.tsx
  // that is not the sign-in surface. The semantic half of each - token lifetime, lockout
  // policy, what a reset email may reveal - has no signature and lives in security-policy.
  {
    id: "auth-password-reset-entry",
    label: "Login form offers a way to recover the password",
    ignoreFileCase: true,
    // Named for the flow, either way a project spells it: in the FILE name (login-form.tsx)
    // or in the DIRECTORY (app/(auth)/login/page.tsx, the Next App Router shape - a basename
    // glob would miss every one of those). Dir globs are listed twice because `**/x/**` does
    // not match a root-level `x/`, the same gotcha the excludes above carry.
    files: [
      "*login*.tsx",
      "*login*.jsx",
      "*login*.vue",
      "*login*.svelte",
      "*login*.astro",
      "*login*.html",
      "*signin*.tsx",
      "*signin*.jsx",
      "*signin*.vue",
      "*signin*.svelte",
      "*signin*.astro",
      "*signin*.html",
      "*sign-in*.tsx",
      "*sign-in*.jsx",
      "*sign-in*.vue",
      "*sign-in*.svelte",
      "*sign-in*.astro",
      "*sign-in*.html",
      "**/login/**",
      "login/**",
      "**/signin/**",
      "signin/**",
      "**/sign-in/**",
      "sign-in/**"
    ],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/stories/**",
      "*.stories.*",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // The password field is what makes this THE sign-in surface rather than a wrapper or a
    // route file; a login page that only renders <LoginForm/> has no password field and is
    // correctly left alone (the form itself is the file that must carry the link).
    pattern: `type=["']password["']|type=\\{["']password["']\\}`,
    // Any recovery affordance clears the file: the link, the route, or a handler named for it.
    absent: "forgot|reset[-_ ]?password|password[-_ ]?reset|recover|olvid|recuperar|magic[-_ ]?link|enigma:allow-no-reset",
    message: 'Sign-in form with no way out of a forgotten password. Every login form needs a visible "Forgot your password?" entry point next to the password field, leading to a real reset flow: ask for the identifier, always answer the same way (never reveal whether the account exists), email a single-use token that expires in ~15-60 minutes, and on success invalidate that token plus every other active session. If this screen is deliberately reset-less (an internal tool, SSO-only, a passwordless magic-link form), mark the file with an `enigma:allow-no-reset` note (frontend-policy, security-policy).',
    severity: "block",
    skill: "security-policy"
  },
  {
    id: "auth-signup-auto-login",
    label: "Registration signs the user in",
    ignoreFileCase: true,
    files: [
      "*register*.tsx",
      "*register*.jsx",
      "*register*.ts",
      "*register*.js",
      "*register*.vue",
      "*register*.svelte",
      "*register*.astro",
      "*signup*.tsx",
      "*signup*.jsx",
      "*signup*.ts",
      "*signup*.js",
      "*signup*.vue",
      "*signup*.svelte",
      "*signup*.astro",
      "*sign-up*.tsx",
      "*sign-up*.jsx",
      "*sign-up*.ts",
      "*sign-up*.js",
      "*sign-up*.vue",
      "*sign-up*.svelte",
      "*sign-up*.astro",
      "**/register/**",
      "register/**",
      "**/signup/**",
      "signup/**",
      "**/sign-up/**",
      "sign-up/**"
    ],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/stories/**",
      "*.stories.*",
      "*.d.ts",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // Only a PROGRAMMATIC redirect to the sign-in route counts. An `href="/login"` is the
    // "already have an account?" link every sign-up form carries and is not the defect, so
    // the pattern requires a navigation CALL - which is the code path that runs after the
    // account is created.
    pattern: "(?:push|replace|redirect|navigate|goto|assign)\\(\\s*[\"'`][^\"'`]*/(?:login|signin|sign-in)\\b|location(?:\\.href)?\\s*=\\s*[\"'`][^\"'`]*/(?:login|signin|sign-in)\\b|(?:push|replace|navigate)\\(\\s*\\{[^}]*name:\\s*[\"'`](?:login|signin|sign-in)[\"'`]",
    // Any session-establishing call in the file means the redirect is some other path
    // (an already-registered branch, an error case), so the file is cleared.
    absent: "signIn\\(|signInWith|createSession|setSession|startSession|newSession|setAuthCookie|setAuthToken|setToken\\(|setAuth\\(|login\\(|logIn\\(|authenticate\\(|session\\.save|sessionStorage\\.setItem\\([\"'`](?:token|session)|cookies\\(\\)\\.set|setUser\\(|enigma:allow-login-redirect",
    message: "Registration sends the user to the sign-in screen instead of signing them in. A successful sign-up already proves the credentials: establish the session right there and land the user in the app. Keep email verification asynchronous (let them in, ask them to confirm, and gate only the actions that need a verified address) rather than parking them on a login form to type what they just typed. If this redirect is deliberate (an admin creating someone else's account, an approval queue), mark the file with an `enigma:allow-login-redirect` note (backend-policy, security-policy).",
    severity: "block",
    skill: "security-policy"
  },
  {
    id: "auth-rate-limit",
    label: "Rate-limit the credential endpoints",
    ignoreFileCase: true,
    files: [
      "*login*.ts",
      "*login*.js",
      "*login*.mts",
      "*login*.cts",
      "*login*.py",
      "*signin*.ts",
      "*signin*.js",
      "*sign-in*.ts",
      "*sign-in*.js",
      "*signin*.py",
      "*sign-in*.py",
      "*register*.ts",
      "*register*.js",
      "*signup*.ts",
      "*signup*.js",
      "*sign-up*.ts",
      "*sign-up*.js",
      "*register*.py",
      "*signup*.py",
      "*sign-up*.py",
      "*2fa*.ts",
      "*2fa*.js",
      "*2fa*.py",
      "*mfa*.ts",
      "*mfa*.js",
      "*mfa*.py",
      "*otp*.ts",
      "*otp*.js",
      "*otp*.py",
      "*forgot-password*.ts",
      "*forgot-password*.js",
      "*forgot-password*.py",
      "*reset-password*.ts",
      "*reset-password*.js",
      "*reset-password*.py",
      "**/login/**",
      "login/**",
      "**/signin/**",
      "signin/**",
      "**/sign-in/**",
      "sign-in/**",
      "**/register/**",
      "register/**",
      "**/signup/**",
      "signup/**",
      "**/sign-up/**",
      "sign-up/**",
      "**/2fa/**",
      "2fa/**",
      "**/mfa/**",
      "mfa/**",
      "**/otp/**",
      "otp/**",
      "**/forgot-password/**",
      "forgot-password/**",
      "**/reset-password/**",
      "reset-password/**"
    ],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "test_*.py",
      "*_test.py",
      "*.d.ts",
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/**",
      "build/**",
      "node_modules/**",
      "vendor/**"
    ],
    scope: "file",
    // A server-side handler for the flow: the route export/registration, a framework
    // decorator, or a "use server" module (a Next server action reachable from the sign-in
    // page is an unauthenticated endpoint like any other, and it is how App Router projects
    // write this). A client component calling fetch() is deliberately not matched - it
    // cannot enforce a limit, and the file that must is the one defining the endpoint.
    pattern: `export\\s+(?:async\\s+)?function\\s+(?:POST|PUT|PATCH)\\b|export\\s+const\\s+(?:POST|PUT|PATCH)\\s*[:=]|\\b(?:router|app|api|server|fastify)\\.(?:post|put|patch)\\s*\\(|@(?:app|router|bp|blueprint)\\.(?:post|route)\\s*\\(|@Post\\s*\\(|^["']use server["']`,
    // Cleared by any limiter in the file, whatever the library or the wrapper name.
    absent: "rate[-_]?limit|ratelimit|Ratelimit|RateLimiter|limiter|throttle|slowDown|slow_down|bottleneck|arcjet|leaky|token[-_]?bucket|attempts?[-_]?(?:left|remaining|count)|lockout|too[-_ ]?many[-_ ]?requests|429|enigma:allow-unlimited-auth",
    message: "Credential endpoint with no rate limiting. Login, registration, password reset and every 2FA/OTP verification are guessing surfaces: limit them BY IP (blunt, stops the broad sweep) AND BY ACCOUNT or identifier (stops the slow distributed attack the IP limit misses), count failures rather than requests, back off exponentially, and answer 429 with Retry-After. Keep the accounting server-side and identical for an unknown account, so the limiter itself does not become an account-existence oracle. If the limit is enforced upstream (gateway, middleware, WAF), note it in the file with an `enigma:allow-unlimited-auth` marker (security-policy, backend-policy).",
    severity: "block",
    skill: "security-policy"
  }
];
var PROJECT_CHECKS = {
  "ts-relational-no-prisma": (root) => {
    const pkg = readPkgDeps(root);
    if (!pkg) return false;
    const hasTs = "typescript" in pkg || existsSync(join(root, "tsconfig.json"));
    if (!hasTs) return false;
    const relational = ["typeorm", "sequelize", "knex", "drizzle-orm", "pg", "mysql", "mysql2", "better-sqlite3", "@mikro-orm/core"];
    if (!relational.some((d) => d in pkg)) return false;
    return !("prisma" in pkg || "@prisma/client" in pkg);
  }
};
var FILE_CHECKS = {
  "proc-windows-hide": (content) => missingWindowsHide(content)
};
var SPAWNERS = /* @__PURE__ */ new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
function spawnerBindings(content) {
  const names = /* @__PURE__ */ new Set();
  const stmt = /(?:import|(?:const|let|var))\s*\{([^}]*)\}\s*(?:from\s*|=\s*require\(\s*)["'](?:node:)?child_process["']/g;
  for (const m of content.matchAll(stmt)) {
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if (orig && SPAWNERS.has(orig)) names.add(alias || orig);
    }
  }
  return [...names];
}
function missingWindowsHide(content) {
  const names = spawnerBindings(content);
  if (names.length === 0) return [];
  const out = [];
  const call = new RegExp(`(?<![.\\w$])(${names.join("|")})\\s*\\(`, "g");
  for (const m of content.matchAll(call)) {
    let i = m.index + m[0].length;
    for (let depth = 1; i < content.length && depth > 0; i++) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") depth--;
    }
    const eol = content.indexOf("\n", i);
    const text = content.slice(m.index, eol === -1 ? content.length : eol);
    if (/windowsHide|enigma:|"inherit"|'inherit'/.test(text)) continue;
    if (!text.includes("{")) continue;
    if (/\{[^{}]*\.\.\.[A-Za-z_$]/.test(text)) continue;
    out.push({ line: content.slice(0, m.index).split("\n").length, detail: m[1] });
  }
  return out;
}
var NAMED_IMPORT = /^import[ \t]+(?:[\w$]+[ \t]*,[ \t]*)?(?:type[ \t]+)?\{([^}]*)\}[ \t]*from[ \t]*["']([^"']+)["'].*$/gm;
var INTERNAL_MODULE = /^\.|^#|^[@~]\//;
function wideNamedImports(content, max) {
  const per = /* @__PURE__ */ new Map();
  for (const m of content.matchAll(NAMED_IMPORT)) {
    const mod = m[2];
    if (!INTERNAL_MODULE.test(mod)) continue;
    const entry = per.get(mod) ?? { count: 0, line: content.slice(0, m.index).split("\n").length, allowed: false };
    entry.count += m[1].split(",").filter((s) => s.trim()).length;
    if (m[0].includes("enigma:")) entry.allowed = true;
    per.set(mod, entry);
  }
  return [...per].filter(([, v]) => !v.allowed && v.count > max).map(([module, v]) => ({ line: v.line, module, count: v.count }));
}
function readPkgDeps(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  } catch {
    return null;
  }
}
function globToRegExp(glob, ignoreCase = false) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`, ignoreCase ? "i" : "");
}
function guardrailsConfigPath() {
  return process.env.ENIGMA_GUARDRAILS_CONFIG || join(homedir(), ".enigma-guardrails.json");
}
function isValidRule(r) {
  const x = r;
  if (!x || typeof x.id !== "string" || !Array.isArray(x.files) || typeof x.message !== "string") return false;
  if (x.severity !== "block" && x.severity !== "warn") return false;
  if (x.scope === "file") return typeof x.pattern === "string";
  if (x.scope === "project") return typeof x.check === "string";
  return false;
}
function loadRules() {
  let disabled = [];
  let custom = [];
  try {
    const raw = JSON.parse(readFileSync(guardrailsConfigPath(), "utf8"));
    if (Array.isArray(raw.disabled)) disabled = raw.disabled.filter((s) => typeof s === "string");
    if (Array.isArray(raw.rules)) custom = raw.rules.filter(isValidRule);
  } catch {
  }
  const off = new Set(disabled);
  return [...BUILTIN_RULES.filter((r) => !off.has(r.id)), ...custom];
}
function findProjectRoot(file) {
  let dir = dirname(resolve(file));
  for (let i = 0; i < 40; i++) {
    const isProj = existsSync(join(dir, "package.json")) || existsSync(join(dir, ".enigma.json"));
    let hasGit = false;
    try {
      hasGit = statSync(join(dir, ".git")).isDirectory();
    } catch {
    }
    if (isProj || hasGit) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function checkFile(file, content, projectRoot) {
  const norm = file.replace(/\\/g, "/");
  const out = [];
  for (const rule of loadRules()) {
    if (!rule.files.some((g) => globToRegExp(g, rule.ignoreFileCase).test(norm))) continue;
    if (rule.excludeFiles?.some((g) => globToRegExp(g, rule.ignoreFileCase).test(norm))) continue;
    const base = { ruleId: rule.id, severity: rule.severity, file: norm, message: rule.message, skill: rule.skill };
    if (rule.scope === "file" && rule.maxBytes) {
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > rule.maxBytes) out.push({ ...base, message: `${rule.message} (${bytes} bytes, budget ${rule.maxBytes})` });
    } else if (rule.scope === "file" && rule.maxNamedImports) {
      for (const w of wideNamedImports(content, rule.maxNamedImports)) {
        out.push({ ...base, line: w.line, message: `${rule.message} (${w.count} bindings from "${w.module}", budget ${rule.maxNamedImports})` });
      }
    } else if (rule.scope === "file" && rule.fileCheck) {
      const check = FILE_CHECKS[rule.fileCheck];
      for (const hit of check ? check(content) : []) {
        out.push({ ...base, line: hit.line, message: `${rule.message} (${hit.detail})` });
      }
    } else if (rule.scope === "file" && rule.pattern) {
      if (rule.absent) {
        try {
          if (new RegExp(rule.absent, "i").test(content)) continue;
        } catch {
        }
      }
      let re;
      try {
        re = new RegExp(rule.pattern, (rule.flags ?? "i").replace(/g/g, ""));
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (COMMENT_LINE.test(lines[i])) continue;
        if (re.test(lines[i])) out.push({ ...base, line: i + 1 });
      }
    } else if (rule.scope === "project" && rule.check && projectRoot) {
      const check = PROJECT_CHECKS[rule.check];
      if (check && check(projectRoot)) out.push({ ...base });
    }
  }
  return out;
}
function formatFindings(findings) {
  return findings.map((f) => {
    const tag = f.severity === "block" ? "MUST FIX" : "SUGGESTED";
    const loc = f.line ? `:${f.line}` : "";
    const skill = f.skill ? ` [${f.skill}]` : "";
    return `${tag} ${f.file}${loc} (${f.ruleId})${skill}: ${f.message}`;
  }).join("\n");
}
function checkPath(file) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\0")) return [];
  return checkFile(file, content, findProjectRoot(file));
}
function runGuardrailsHook(payload) {
  let file;
  try {
    file = JSON.parse(payload ?? readFileSync(0, "utf8"))?.tool_input?.file_path;
  } catch {
  }
  if (!file || typeof file !== "string") return 0;
  const findings = checkPath(file);
  if (!findings.length) return 0;
  const warns = findings.filter((f) => f.severity === "warn");
  const blocks = findings.filter((f) => f.severity === "block");
  if (warns.length) process.stdout.write(`enigma guardrails (suggestions)
${formatFindings(warns)}
`);
  if (blocks.length) {
    process.stderr.write(`enigma guardrails
${formatFindings(blocks)}
Fix the above before continuing.
`);
    return 2;
  }
  return 0;
}
function gitFiles(all) {
  const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8", windowsHide: true });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}
function runGuardrailsScan(all) {
  let files;
  try {
    files = gitFiles(all);
  } catch {
    return { ok: true, blocks: [], warns: [], count: 0, notRepo: true };
  }
  const root = process.cwd();
  const blocks = [];
  const warns = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    for (const f of checkFile(file, content, root)) (f.severity === "block" ? blocks : warns).push(f);
  }
  return { ok: blocks.length === 0, blocks, warns, count: files.length };
}
function runGuardrailsScanCli(all) {
  const r = runGuardrailsScan(all);
  if (r.notRepo) {
    console.error("enigma-guardrails: not a git repository; nothing to check.");
    return 0;
  }
  if (r.warns.length) {
    console.error(`enigma-guardrails: ${r.warns.length} suggestion(s):`);
    for (const w of r.warns) console.error(`  ! ${formatFindings([w])}`);
  }
  if (r.blocks.length) {
    console.error(`
enigma-guardrails: BLOCKED - ${r.blocks.length} convention violation(s):`);
    for (const b of r.blocks) console.error(`  x ${formatFindings([b])}`);
    console.error("\nTo bypass intentionally for one commit: git commit --no-verify");
    return 1;
  }
  console.log(`enigma-guardrails: ${r.count} ${all ? "tracked" : "staged"} file(s) checked, no blocking violations.`);
  return 0;
}
var grEntry = process.argv[1] ?? "";
var isGrEntry = /(^|[\\/])guardrails\.[mc]?[jt]s$/.test(grEntry);
if (isGrEntry && fileURLToPath(import.meta.url) === grEntry) {
  process.exit(runGuardrailsScanCli(process.argv.includes("--all")));
}
export {
  BUILTIN_RULES,
  FILE_CHECKS,
  PROJECT_CHECKS,
  checkFile,
  checkPath,
  findProjectRoot,
  formatFindings,
  loadRules,
  missingWindowsHide,
  runGuardrailsHook,
  runGuardrailsScan,
  runGuardrailsScanCli,
  wideNamedImports
};
