#!/usr/bin/env node

// src/guardrails.ts
import { homedir } from "os";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { dirname, join, resolve, sep } from "path";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "fs";
var COMMENT_LINE = /^\s*(\/\/|#|\*|--|<!--|\{?\/\*)/;
var SKELETON_GUARD_SRC = "\\bif\\s*\\(\\s*(isLoading|isPending|isFetching|loading|pending)\\s*\\)\\s*return\\s+(null\\b|<\\s*\\w*(Spinner|Loader|Loading|CircularProgress)\\b)";
var SKELETON_SIGNAL_SRC = "skeleton|animate-pulse|shimmer|Suspense|ContentLoader|content-loader|<\\s*Placeholder";
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
    id: "fe-marquee-duration",
    label: "Looping row driven by a speed, not a duration",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.css", "*.scss", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "*.min.css",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    ignoreFileCase: true,
    scope: "file",
    // Only newly written code: a duration-driven marquee is common in existing
    // pages, and the rule has to name the one being added, not the backlog.
    stage: "diff",
    // A duration named on the same line as the looping row it drives. Requiring
    // both words keeps every unrelated animation-duration out of the match.
    pattern: "(marquee|ticker|logo-?wall|infinite-?scroll)[^\\n]*(animation-duration|animationDuration|--duration)|(animation-duration|animationDuration|--duration)[^\\n]*(marquee|ticker|logo-?wall|infinite-?scroll)",
    absent: "px/s|pixels per second|pixelsPerSecond|\\bspeed\\b|@enigmax/primitives|useMarquee|createMarquee|enigma:allow-marquee-duration",
    message: "Looping row driven by a duration. A lap is as long as its content, so the speed becomes content/duration and the row runs faster every time an item is added - measured at 45, 67 and 87 px/s for one rail at 10, 15 and 20 items. Take a speed in px/s and derive the duration, or use the primitive that already does: `enigma add marquee` (@enigmax/primitives), which also measures the lap from the DOM instead of computing it. Mark the line `enigma:allow-marquee-duration` when the duration is genuinely the contract.",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-pointer-capture-drag",
    label: "Drag bound to window, not setPointerCapture",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    stage: "diff",
    pattern: "\\.setPointerCapture\\s*\\(",
    absent: "enigma:allow-pointer-capture",
    message: "setPointerCapture retargets the compatibility mouse events too, so a plain click on a descendant arrives on the capturing element and the descendant's link never opens - a row of nine logo links quietly stops being nine links and nothing in the source looks wrong. Bind pointermove/pointerup/pointercancel to `window` instead, which is all the capture was for: a mousedown already captures the mouse at the OS level, so a release outside the window still arrives. Fine when the element has no interactive descendants (a slider thumb, a resize handle) - mark it `enigma:allow-pointer-capture` there (frontend-policy).",
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-password-input",
    label: "Reusable password input (show/hide)",
    files: ["*.tsx", "*.jsx"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/stories/**",
      "stories/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/_build/**",
      "_build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    // A raw lowercase <input type="password"> (not a component) with no show/hide toggle in the
    // file. flags:"" = case-sensitive so a capitalized <Input> component is NOT matched; a
    // literal type="password" only, so a dynamic type={visible?...} toggle is not matched either.
    pattern: `^(?!.*enigma:).*<input\\b[^>]*type=["']password["']`,
    flags: "",
    absent: "showPassword|setShowPassword|togglePassword|revealPassword|passwordVisible|isPasswordVisible|showPw|hidePassword|enigma:allow-raw-password-input",
    message: 'Raw <input type="password">: use the shared reusable Input component (which renders a show/hide toggle for passwords) instead of a bare input, or add the toggle (frontend-policy). Mark the line `enigma:` or add `enigma:allow-raw-password-input` to the file where the field is deliberately bare.',
    // BLOCK for the same reason as fe-ellipsis-without-overflow, and it is the same class of
    // routing failure: a warn is never fed back by the hook and never denies the stop at turn
    // end, while "one Input that renders a show/hide toggle for a password" is an always-on
    // kernel convention the model is expected to apply, not advice it may weigh. It is the
    // reverse of the two rules that stay warn - the criterion is the backlog, and this rule
    // has none: measured over 39316 files of the whole local
    // corpus, 75 candidate lines and 0 findings - every real password field already carries a
    // toggle, so it fires on a bare one an agent writes and on nothing else.
    severity: "block",
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
    id: "fe-name-value-normalize",
    label: "A person-name value is normalized, not just autocapitalized",
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
    // The twin of fe-name-input-capitalize, and the half that actually reaches the stored
    // value: `autocapitalize` is a KEYBOARD hint. A phone honours it, a physical keyboard
    // ignores it entirely, so "juan perez" typed on a laptop is stored exactly like that and
    // the field looks broken to the user who typed it. The attribute alone clears the other
    // rule, which is how a form ends up with the attribute and no normalization at all.
    // Same person-name token set (see there for why `name`/`fullname` are excluded).
    pattern: `autocomplete=\\{?["'](?:name|given-name|family-name|additional-name|honorific-prefix)["']|(?:\\bname|\\bid|\\bfor|formControlName)=\\{?["'](?:first[-_]?name|last[-_]?name|given[-_]?name|family[-_]?name|surname|apellidos?)["']`,
    absent: "capitalizeWords|capitalizeName|capitalizeEach|toTitleCase|titleCase|startCase|properCase|normalizeName|normalizePerson|capitalize\\(|charAt\\(0\\)\\.toUpperCase|enigma:allow-no-capitalize",
    message: 'Person-name field with no value normalization. `autocapitalize="words"` only shapes the phone keyboard - a physical keyboard ignores it, so "juan perez" is stored verbatim. Normalize the VALUE with the shared normalizer (validation-policy): trim, collapse inner spaces, and uppercase the first letter of every word, ONLY that letter, so `McDonald`, `O\'Brien` and `van der Berg` survive. Run it on blur (never on every keystroke - it moves the caret and breaks IME composition) and again on the server, which is the copy that decides what is stored. Put it in the shared Input/TextField so the next form gets it by construction. For a field that must keep exactly what was typed, add an `enigma:allow-no-capitalize` note (validation-policy, frontend-policy).',
    severity: "block",
    skill: "validation-policy"
  },
  {
    id: "fe-password-reveal-hand-rolled",
    label: "Password reveal toggled by hand",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    stage: "diff",
    // The ternary that switches a field's type, in either order. Precise enough that
    // it does not fire on anything else that mentions both words.
    pattern: `["']password["']\\s*:\\s*["']text["']|["']text["']\\s*:\\s*["']password["']`,
    absent: "@enigmax/primitives|useInput|createInput|<Input|enigma:allow-password-toggle",
    message: 'A password reveal written by hand. Three things go wrong here and each has been measured: a `<button>` with no `type="button"` defaults to submit, so looking at your password posts the half-filled form; pressing the button pulls focus out of the field unless `mousedown` is prevented; and assigning `input.type` inside a click handler resets the caret to 0 in Chromium ONE MACROTASK later, so a restore that runs inline silently loses. `enigma add input` (@enigmax/primitives) is that behaviour with a test for each, and brings the generator, the strength meter and the breach check as props you can leave off. Mark the line `enigma:allow-password-toggle` to keep your own.',
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "sec-generated-secret-math-random",
    label: "A secret generated from Math.random",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    // Both orders on one line: the word that says what is being made, and the call
    // that makes it predictable.
    pattern: "(?:password|passphrase|secret|token|otp|api[_-]?key|recovery[_-]?code|session[_-]?id)[^\\n]{0,80}Math\\.random|Math\\.random[^\\n]{0,80}(?:password|passphrase|secret|token|otp|api[_-]?key|recovery[_-]?code|session[_-]?id)",
    absent: "getRandomValues|randomBytes|randomUUID|enigma:allow-insecure-random",
    message: "A secret built from Math.random. It is a fast PRNG, not a CSPRNG: its state is recoverable from a handful of outputs, so anyone who sees one generated value can predict the next. Use `crypto.getRandomValues` in a browser or `crypto.randomBytes` in Node, and draw each index by REJECTION rather than `% alphabet.length`, which is biased because 2^32 is not a multiple of most alphabet sizes. `enigma add input` (@enigmax/primitives) exports `generatePassword` doing both, and throwing rather than falling back when no CSPRNG is available - a generator that quietly produces predictable secrets is worse than one that refuses, because nothing downstream can tell the difference. Mark the line `enigma:allow-insecure-random` where the value is genuinely not a secret.",
    severity: "block",
    skill: "security-policy"
  },
  {
    id: "fe-clipboard-fallback-unchecked",
    label: "Copy fallback whose result is thrown away",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    stage: "diff",
    // A bare statement: the call is not assigned, returned, or tested. execCommand
    // returns a boolean saying whether the copy happened, and this shape discards it.
    pattern: `^[\\t ]*document\\.execCommand\\(["']copy["']\\)\\s*;`,
    absent: "enigma:allow-unchecked-copy",
    message: 'The clipboard fallback\'s result is discarded. `document.execCommand("copy")` RETURNS whether the copy happened - it fails silently under a clipboard-guard extension, in a cross-origin frame, and without a user gesture - so a button that flashes a tick after calling it is telling the reader something it never checked, and they find out on paste. Test the return value and show the confirmation only when it is true. While you are there: give the scratch textarea `position: fixed` and `opacity: 0`, because appending a visible one scrolls the page to the bottom on every copy. Mark the line `enigma:allow-unchecked-copy` where the outcome genuinely does not matter (frontend-policy).',
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "fe-relative-time-hand-rolled",
    label: "Relative time computed by hand",
    files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.astro", "*.vue", "*.svelte"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "*.min.js",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/node_modules/**",
      "node_modules/**",
      "**/vendor/**",
      "vendor/**"
    ],
    scope: "file",
    stage: "diff",
    // A millisecond difference divided into units - the shape every hand-rolled
    // "3 hours ago" has, and one a real formatter never needs.
    pattern: "(?:Date\\.now\\(\\)|getTime\\(\\))[^\\n]{0,60}-[^\\n]{0,60}\\/\\s*(?:1000|60000|3600000|86400000|1000\\s*\\*)",
    absent: "@enigmax/utils|RelativeTime|relativeTimeView|relative-time-element|Intl\\.RelativeTimeFormat|date-fns|dayjs|luxon|moment|enigma:allow-manual-relative-time",
    message: '"3 hours ago" computed from a millisecond difference. Three things this misses: it is English-only, where `Intl.RelativeTimeFormat` speaks the reader\'s language; it renders once and then goes stale, so a page left open says "3 hours ago" tomorrow; and a timestamp with no zone (`2026-08-13 22:41:00` out of a date column) is read as LOCAL time by `new Date()`, which puts every reader away from the server hours out - silently, because a wrong time is still a valid one. `enigma add relative-time` (@enigmax/utils) handles all three and renders the absolute date as a fallback, so a server render and a reader without JavaScript still see a real date. Mark the line `enigma:allow-manual-relative-time` when the arithmetic is the point.',
    severity: "warn",
    skill: "frontend-policy"
  },
  {
    id: "sec-password-breach-check",
    label: "A new password is checked against the breach corpus",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js"],
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
    // `autocomplete="new-password"` is the spec's own marker for a password being CREATED -
    // sign-up, reset confirmation, change password - and never appears on a sign-in form
    // (that one is `current-password`). So it selects exactly the screens where the check
    // belongs, with no path guessing. Any mention of the check anywhere in the file clears
    // it, including a call into a shared hook whose name carries `pwned`/`breach`.
    pattern: `autocomplete=\\{?["']new-password["']`,
    absent: "pwnedpasswords|haveibeenpwned|hibp|pwned|breach|enigma:allow-no-breach-check",
    message: "A password is created here with no breach check. Length and symbol rules do not stop a password that is already in a credential-stuffing list. Check it against Have I Been Pwned's Pwned Passwords range API - free, no key, and the password never leaves the client: SHA-1 it, uppercase the hex, GET https://api.pwnedpasswords.com/range/<first 5 chars> with `Add-Padding: true`, and look for the remaining 35 characters in the `SUFFIX:COUNT` lines. `enigma add password-breach` (@enigmax/utils) is exactly that call, with the padding header, the decoy entries rejected and the range responses cached. Debounce it as the user types, abort the in-flight request when the value changes, repeat the check server-side on submit, and fail OPEN if the lookup errors so an outage never blocks a signup. For a flow that genuinely cannot reach it, add an `enigma:allow-no-breach-check` note (security-policy).",
    severity: "block",
    skill: "security-policy"
  },
  {
    id: "sec-password-identity-match",
    label: "A new password is not the account's own identity",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js"],
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
    // The twin of sec-password-breach-check over the same selector, for the same reason the
    // name rules are two: one `absent` cannot express "breach check AND identity check", and
    // a file that does one is routinely missing the other. Same precision inheritance -
    // `autocomplete="new-password"` marks a password being CREATED and nothing else.
    // The `absent` set is deliberately NOT `email|username`: every sign-up form on earth
    // mentions both, so keying on them would clear the rule everywhere it matters. It clears
    // only on evidence of a COMPARISON - zxcvbn fed the user's own inputs (advisory, but a
    // form gating on its score is a real implementation), Django's similarity validator, a
    // helper named for the check, or password and an identifier on the same line either side
    // of an equality/containment operator.
    pattern: `autocomplete=\\{?["']new-password["']`,
    absent: "userInputs|user_inputs|UserAttributeSimilarity|sameAs(?:Email|Username|Identity)|matchesIdentity|containsIdentity|identityMatch|notIdentity|personalInfo|(?:password|passwd|pwd)[^\\n]{0,60}(?:===|==|!==|\\.includes\\(|\\.indexOf\\(|\\.startsWith\\(|localeCompare)[^\\n]{0,60}(?:email|username|user_?name|handle)|(?:email|username|user_?name|handle)[^\\n]{0,60}(?:===|==|!==|\\.includes\\(|\\.indexOf\\(|\\.startsWith\\(|localeCompare)[^\\n]{0,60}(?:password|passwd|pwd)|enigma:allow-identity-password",
    message: "A password is created here with nothing stopping it from being the account's own identity. `Fjrg2007` for the user `fjrg2007` is one guess for anyone who knows the email address. Refuse a candidate that equals, contains (4 characters or more), or closely resembles the email, its local part, the username, the display name or the site name - comparing NORMALIZED values on both sides (lowercase, trim, NFKD then strip accents, drop everything that is not a letter or a digit), so `F.J.R.G_2007` and `fjrg2007` are the same string and casing is never a difference. Declare it on the OBJECT schema, since a password field cannot see the email beside it, and run it again on the server where the real identity lives. A strength meter fed `userInputs` scores this badly but is advisory - keep the refusal as its own rule; `enigma add input` (@enigmax/primitives) takes `strength={{ userInputs }}` and reports it. For a flow with no identity to compare against, add an `enigma:allow-identity-password` note (security-policy, validation-policy).",
    severity: "block",
    skill: "security-policy"
  },
  // NOTE: no rule for the navigation conventions - nav entries carrying icons, a long nav
  // grouped into labelled sections, and a Cmd/Ctrl+K command palette once the app has enough
  // to hunt through. All three were measured and rejected; they live in frontend-policy's
  // "Navigation Is Structured, Not A Growing List" and "Search & Filtering" sections only.
  // The signature would have to be DENSITY - a file rendering many destinations - and density
  // does not separate the app shell (where these belong) from a landing page or a docs page
  // (where an icon per link and a palette would both be wrong). Measured over the corpus:
  // 174 UI files, 29 with 8 or more links, and of the 4 with no search affordance every one
  // is marketing or static docs - zero true positives, the same evidence that rejected the
  // no-op-save and pinned-sidebar rules. Keying on a *sidebar*/*nav* filename instead found
  // 2 candidates in the whole corpus, both terminal (ink) menus, so it has no signal either.
  {
    id: "fe-tracking-before-consent",
    label: "Non-essential tracking waits for consent",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js", "*.mts", "*.cts"],
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
    // The loaders and call sites of the common analytics/ads/replay vendors. Each one sets
    // non-essential storage the moment it runs, so what matters is whether ANY consent
    // handling exists in the same file - the gate, a Consent Mode default, or the stored
    // decision being read. `consent` on its own clears it, deliberately generous: this rule
    // catches the snippet pasted straight into the layout, not a considered implementation.
    pattern: "googletagmanager\\.com|google-analytics\\.com|gtag\\(|dataLayer\\.push|connect\\.facebook\\.net|fbq\\(|mixpanel\\.|posthog\\.(?:init|capture)|amplitude\\.(?:init|getInstance)|static\\.hotjar\\.com|clarity\\.ms|cdn\\.segment\\.com",
    absent: "consent|gdpr|cookieBanner|cookie-banner|CookieConsent|enigma:allow-no-consent",
    message: "Analytics, ads or session replay loading with no consent gate in sight. Everything outside the strictly necessary group (session, CSRF, load balancing, the consent record) stays off until the user answers the banner - swapping the cookie for `localStorage` does not change that. Load the vendor only after the stored decision says so (or start in Consent Mode with everything denied and update on accept), make Reject as reachable as Accept, and keep the decision withdrawable. If this file genuinely runs after the gate, add an `enigma:allow-no-consent` note (security-policy, frontend-policy).",
    severity: "block",
    skill: "security-policy"
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
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.stories.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/_build/**",
      "_build/**",
      "**/.next/**",
      ".next/**",
      "**/out/**",
      "out/**",
      "**/node_modules/**"
    ],
    scope: "file",
    // A hand-rolled case-insensitive substring finder inside a `.filter(...)`, in the two
    // spellings that are near-certainly a search box. (a) SYMMETRIC: both sides lowercased,
    // which nothing but a case-insensitive text match is written for. (b) ONE-SIDED, where the
    // haystack is lowercased and the needle is a binding NAMED for a search box
    // (search/query/term/keyword/needle) - the name is what replaces the second
    // toLowerCase as evidence, and it is what keeps a plain membership test
    // (`.filter(x => ids.includes(x))`) out. `filter` is deliberately NOT one of those
    // names: `statusFilter`/`activeTagFilter` is the PICKED-VALUE case this rule's own
    // escape hatch exists for, so accepting it would make the rule fire on exactly what
    // it sanctions. It costs no measured hit - every one-sided finding in the corpus is
    // named search/query/needle. Widening to ANY `.filter(....includes(` was measured and
    // rejected: 171 further lines in 124 files, overwhelmingly membership tests.
    pattern: "\\.filter\\((?:[^;]*\\.toLowerCase\\(\\)\\.includes\\([^;]*\\.toLowerCase\\(\\)|[^;]*\\.toLowerCase\\(\\)\\.includes\\(\\s*[\\w.]*(?:search|query|term|keyword|needle)[\\w.]*\\s*\\))",
    // Word-bounded: a bare `fuse` is a substring of "refuse" and "confuse", and this rule
    // BLOCKS - a stray word in a comment silently switching a gate off is the failure mode
    // an escape hatch is supposed to make deliberate.
    absent: "\\bfuse\\b|enigma:allow-substring-search",
    // DIFF stage, and the severity is what this rule is FOR: it shipped as a `warn`, a warn
    // exits 0 and never reaches the model, so the convention it carries has never once been
    // enforced - which is exactly how an agent ships a dashboard full of hand-rolled finders
    // while frontend-policy says to use fuse.js. Blocking at the EDIT stage was not available:
    // MEASURED with the engine's own rule over 4313 UI files of real product repositories,
    // 17 candidate lines in 16 files, 17 findings - a command menu, a combobox, a tag input,
    // a plugin search, a source picker, a project selector, an icon picker, three gateway
    // tables - every one a genuine hand-rolled search box and 0 false positives, but also a
    // backlog an edit-stage block would deny a turn over on every unrelated edit to those
    // files. Against the ADDED lines there is no backlog by construction, so the rule can
    // only fire on a finder the agent just wrote. The one borderline finding (filtering a
    // session list by IP) is exactly what the escape hatch is for. Two of the seventeen are
    // what the word boundary on `fuse` recovered: a tooltip in that file says a call is
    // "refused", which silently cleared the rule for both of its search boxes.
    stage: "diff",
    message: "Hand-rolled substring search. A `.includes()` filter only finds a match the user typed exactly: it misses a typo, a transposition, a missing accent and any word typed out of order, and it cannot rank - so the best match sits wherever the source array happened to put it. Use fuse.js over the already-loaded data (keys per searchable field, `threshold` around 0.3, and re-run it per keystroke - debouncing belongs to the server-backed part, not to an in-memory search). Mark the line `enigma:allow-substring-search` when this is not a free-text search box: filtering by an id, a tag, a status or any value the user picks rather than types, or a project that takes no runtime dependency (dependency-policy) and matches by hand on purpose (frontend-policy).",
    severity: "block",
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
    // here - NOT because it is correct (a whole-component return blanks the view either way) but
    // because that shape needs the body read to tell a blanked view from a loader whose whole
    // output is the awaited data, which is fe-view-blanked-while-loading's job at the diff stage.
    // `absent` skips the file when ANY placeholder/skeleton signal
    // is present (skeleton, animate-pulse, shimmer, Suspense, a content-loader lib, <Placeholder>)
    // - the component already renders a placeholder somewhere. Kept to the terse one-line guard for
    // precision (a multi-line block is not matched: precision > recall).
    pattern: SKELETON_GUARD_SRC,
    absent: SKELETON_SIGNAL_SRC,
    message: "Component returns nothing (or only a spinner) while data loads, so the whole page stays blank until the fetch resolves. Render the shell on first paint - nav, headings, card frames, table chrome, filters, and any value you already hold - and skeleton ONLY the region whose data is missing, shaped like the real content with its space reserved so nothing shifts when it lands. A region that does not depend on this request is not loading and must render now (frontend-policy).",
    // BLOCK, changed from warn: this is the rule for the defect users keep reporting (a page
    // that renders nothing until its data arrives), and as a warn it exited 0 - printed to
    // stdout and never fed back to the model, which is precisely why the model kept writing
    // it. Same reasoning as ui-no-em-dash. The pattern is a terse one-line guard cleared by
    // any placeholder signal in the file, so there is no legacy backlog to flag.
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-server-first-mutation",
    label: "Optimistic update for a reversible mutation",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // DIFF stage, and that is the whole reason this rule can exist. Measured over 2762 UI files
    // of real product repositories, 116 of the 140 files that mutate anything hold no optimistic
    // update at all - a legacy backlog an edit-stage rule would fire on forever, which is how a
    // gate teaches people to ignore it. Against the lines a turn ADDED there is no backlog: it
    // fires only on a mutation the agent just wrote.
    stage: "diff",
    fileCheck: "fe-server-first-mutation",
    message: "This mutation waits for the server before it touches the UI: the row is only dropped (or the flag only flipped) after the request resolves, so the interface freezes for the whole round trip on an action that cannot really fail in an interesting way. Apply the change to local state FIRST, then send the request, and on failure restore the value you saved and say what failed - a silent revert is worse than the wait. Where the delete is reversible, prefer acting immediately with an Undo affordance over a confirmation prompt. Mark the line `enigma:allow-server-first` when the server's response is genuinely required before the UI may change (a payment, a server-assigned identifier, an irreversible action) (frontend-policy).",
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-textarea-size-bounds",
    label: "Textarea declares a minimum and a maximum size",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // DIFF stage, for the reason the measurement gave: 17 corpus textarea sites carry no upper
    // bound, so an edit-stage rule would report a project's existing forms on every unrelated
    // edit to the same file. Against the lines a change adds there is no backlog, and the rule
    // can be as strict as the convention actually is.
    stage: "diff",
    fileCheck: "fe-textarea-size-bounds",
    message: "A textarea is the only input the user can resize, so it is the only one that can break a layout after it has rendered. Give it both bounds: `rows` (or a min-height) so it never collapses below a usable size, and a max-height so dragging it - or letting it grow with its content - cannot push the page apart. Prefer `resize: vertical` so the column width survives, and put the bounds on the shared Textarea component rather than on each usage. Mark the line `enigma:allow-unbounded-textarea` when the surface owns its viewport (a full-page editor, a code surface) or the design calls for something else (frontend-policy).",
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-view-blanked-while-loading",
    label: "Only the waiting region is a placeholder, not the whole view",
    files: ["*.tsx", "*.jsx"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // The hole fe-skeleton-loading left open, and the reason the defect kept shipping after that
    // rule went to BLOCK: it matches only `return null` / `return <Spinner/>` and deliberately
    // treats `return <Skeleton/>` as the correct pattern. It is not - a whole-component early
    // return swaps the ENTIRE view for placeholders, so a page whose headings, tabs, filters and
    // card frames never depended on the response still renders as a grey page. The old rule's
    // `absent` makes it worse: any skeleton anywhere in the file clears it, so drawing a
    // full-view skeleton is the one way to satisfy the gate while committing the defect.
    // DIFF stage: 13 of these lived in the corpus BEFORE the condition set was widened - a
    // standing backlog an edit-stage rule would re-report on every unrelated edit to the same
    // file. Current figure, after the widening and the fe-skeleton-loading suppression: 10
    // findings over 7199 files, still 0 false positives.
    stage: "diff",
    fileCheck: "fe-view-blanked-while-loading",
    message: "This loading guard returns from the whole component, so the entire view becomes placeholders until the request resolves - a full-page loader with rounded corners. The elements listed below do not depend on the response and must paint on the first tick: headings, tab bars, filters, search, buttons, table and card chrome, and any value already in hand (a name from the route, a count from the cache). Move the guard INSIDE the region that is actually waiting - render the shell, and skeleton only the rows, the chart or the tiles - or hand the region to a child component that owns its own request. Mark the line `enigma:allow-view-skeleton` when the component genuinely renders nothing but the awaited data (frontend-policy).",
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-unbounded-remote-list",
    label: "A list from the server is rendered whole",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // The ask: "el modelo no lo integra si no se lo pides". Infinite scroll and pagination
    // live in frontend-policy, a skill that is read when it happens to be, so a screen that
    // will hold thousands of rows ships rendering every one. This is that rule at the tier
    // where it cannot be skipped.
    //
    // MEASURED over 1345 component files of references/repos + packages + apps: 0 findings,
    // 0 false positives, and it fires on both synthetic positives. THE RECALL IS THE HONEST
    // CAVEAT and it is why the skill still owns the convention: only ONE file in that corpus
    // binds a fetched collection in a shape a file-local check can see. Mature apps read
    // their lists through a custom hook or take them as a prop, and the fetch is then several
    // hops away - unknowable from the one file the engine is given. What this DOES cover is
    // the shape an agent writes when it is asked for a screen: fetch and render in the same
    // component, which is exactly the case the report was about.
    //
    // The first cut asked only "does the file fetch" and "does the file map", and flagged 76
    // files - nearly all of them mapping a module constant (STEPS.map) in a component that
    // fetched something unrelated. Tying the rendered list to the binding that produced it is
    // the whole precision story.
    stage: "diff",
    fileCheck: "fe-unbounded-remote-list",
    message: "This list comes from the server and every row of it is rendered, so the screen is only as fast as the smallest dataset anyone tested it with. Bound it: ask the server for a page (cursor or offset) and load the next one as the user reaches the end - virtualized infinite scroll is the default, explicit pagination the deliberate exception when the design or the user calls for it. Whichever you pick, the list needs its loading, empty and end-of-list states. Mark the line `enigma:allow-unbounded-list` when the collection is bounded by construction and say what bounds it (frontend-policy, database-expert).",
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-page-await-no-boundary",
    label: "Server route streams its shell before its data",
    files: ["page.tsx", "page.jsx"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // The other half of the same report ("the data arrives inside the first HTML, which slows the
    // navigation down"). An awaited query in an async route component holds the WHOLE navigation:
    // the router has nothing to commit until it resolves, so the previous page stays on screen and
    // the app feels stuck. This was rejected as a rule once, when it was framed as "do not fetch on
    // the server" - a judgement call a regex cannot make, since a static page awaiting build-time
    // content is correct. Framed as "an async route that awaits a query declares a streaming
    // boundary" it is mechanical, and the fix is never wrong: a `loading.tsx` in the segment (or any
    // ancestor) or a <Suspense> around the data region both let the shell paint immediately.
    // MEASURED over 1127 route files / 159 async route components: 11 candidates, 7 already covered
    // by a loading.tsx up their segment chain, 4 route files - reported at 5 anchors, since every
    // awaited query gets its own.
    stage: "diff",
    fileCheck: "fe-page-await-no-boundary",
    message: "This route awaits its data before it returns anything, so the navigation blocks for the whole query: the router holds the old page on screen until the query resolves, and the data ships inside the first HTML instead of the shell shipping first. Give the segment a streaming boundary - add a `loading.tsx` beside this page (the shell paints at once and this subtree streams in), or wrap only the data-dependent region in <Suspense> with a skeleton fallback and keep the awaited call inside it. Where the view is interactive anyway, let the client component own the request and render from the cache first. Mark the line `enigma:allow-blocking-page` when the page must not commit until the data is known (frontend-policy).",
    severity: "block",
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
    // STAYS warn, and it was measured rather than assumed when its two siblings were flipped
    // to block: 571 candidate lines over 39316 files produce 145 findings - generated API
    // docs, framework error templates, sample apps and one-off report pages that are all genuine
    // matches and none of them anyone's current work. That is a legacy backlog, so a block
    // would fire on every unrelated edit to those files, which is exactly the cost the
    // ellipsis and password rules do NOT carry (0 findings each). Backlog, not precision and
    // not how bad the defect is, is what decides this severity.
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
  // that cries wolf. Three neighbours of it were measured over 9072 UI files and rejected for the
  // same reason - whether a value is BOUNDED is not in the line: `whitespace-nowrap` on a dynamic
  // value with no clipping (91 hits, and the majority are correct - dates, amounts, durations and
  // short type labels are exactly what nowrap is for), a fixed-width box holding an unclipped
  // value (207, same), and a translated string inside a hard box (10 candidates, about half of
  // them `sr-only` spans or an input placeholder where visual width does not apply). What IS
  // gateable is the CLIPPING half, below: the element that clips is the element that hides the
  // value, so it alone decides whether the user can still read it.
  {
    id: "fe-ellipsis-without-overflow",
    label: "Ellipsis needs overflow hidden",
    files: ["*.css", "*.scss", "*.sass", "*.less", "*.styl", "*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "*.min.css",
      "**/tests/**",
      "tests/**",
      "**/__tests__/**",
      "__tests__/**",
      "**/dist/**",
      "dist/**",
      "**/build/**",
      "build/**",
      "**/.next/**",
      ".next/**",
      "**/node_modules/**",
      "node_modules/**"
    ],
    scope: "file",
    // text-overflow only applies to a box that actually overflows, so ellipsis without an
    // overflow value does nothing at all - the text just spills. The absent set covers the
    // CSS declarations and the Tailwind utilities that provide it; note it cannot simply be
    // "overflow", which would match the text-overflow property on this very line.
    pattern: "^(?!.*enigma:).*text-overflow\\s*:\\s*ellipsis",
    // Only things that actually PROVIDE the missing overflow value. Tailwind's `truncate`
    // does (it sets overflow-hidden); `text-ellipsis` does not - it is the ellipsis
    // declaration itself, so listing it would suppress the very case being flagged.
    absent: "overflow(?:-x|-y)?\\s*:\\s*(?:hidden|clip|auto|scroll)|overflow-hidden|overflow-clip|\\btruncate\\b|enigma:allow-inert-ellipsis",
    message: "text-overflow: ellipsis has no effect without an overflow value other than visible - the text overflows instead of being clipped. Add overflow: hidden (with white-space: nowrap for a single line), and keep the full value reachable via title or a tooltip (frontend-policy). Mark the line `enigma:` or add `enigma:allow-inert-ellipsis` to the file when the overflow value is set from another file (a shared utility class, an inherited base rule).",
    // BLOCK, and the reason is the fe-skeleton-loading lesson rather than the severity of the
    // defect: a warn exits 0, so runGuardrailsHook prints it where the model never reads it,
    // and the only channel that can carry a warning - the turn-end sweep - writes it into the
    // message only when a blocking finding fires in the same sweep, and never decides the exit
    // code itself. So the one gate for a defect the model keeps writing could report it but
    // never require the fix. Affordable here, and
    // this is the half that had to be measured, because there is no legacy backlog: measured
    // with this rule over 10253 UI files of the whole local corpus (this repo, apps, and every
    // sibling product repo on the machine), 116 candidate lines in 40 files carry the
    // declaration and NOT ONE of them is missing its overflow value. So it is a scaffolding
    // guard like db-sqlite-app-datastore and sec-password-identity-match: it fires when an
    // agent writes a new ellipsis, never on a project's existing stylesheets.
    severity: "block",
    skill: "frontend-policy"
  },
  {
    id: "fe-truncated-value-unreachable",
    label: "A clipped value keeps its full text reachable",
    files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
    excludeFiles: ["*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**", "**/node_modules/**"],
    scope: "file",
    // The half of variable-length text that HAS a signature. text-overflow.md records why the
    // layout half does not - the defect spans an ancestor and its child, and a rule written for
    // it flagged correct code and was deleted. Clipping is different: the element that clips is
    // the element that hides the value, so the question "can the user still read it?" is answered
    // by that element and its immediate wrapper, and nothing else.
    // DIFF stage, and not optional: hiding the value is what a clipped dynamic value does by
    // default - the great majority of the measured corpus's clipped values carry their text
    // nowhere - so an edit-stage rule would report a project's rows forever. The figures are in
    // text-overflow.md and are deliberately not repeated here.
    stage: "diff",
    fileCheck: "fe-truncated-value-unreachable",
    message: 'This clips a value the user cannot recover: the text is ellipsised and the full string appears nowhere. A name, email, path or title is exactly the value someone needs in full, and the sample used while building is always short enough to hide the problem. Where the design system has a tooltip, wrap the element in it - that is the better answer. Otherwise give the clipping element a `title` attribute carrying the same value, written in this file\'s own binding syntax (`title={value}` in JSX, `:title="value"` in Vue, `title={value}` in Svelte, `title="..."` in plain HTML) - and where the value must be readable at a glance rather than on hover, let it wrap instead of clipping. Mark the line `enigma:allow-clipped-value` when the full value is already shown elsewhere on the screen (frontend-policy).',
    severity: "block",
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
  // NOTE: there is deliberately no rule for "a server component awaits its data before it
  // returns markup". It is the other half of the blank-first-paint complaint, but the shape
  // (`export default async function Page()` with an awaited value and no Suspense boundary) is
  // ALSO how a correct statically-generated page is written - the corpus's one match is a docs
  // page awaiting its MDX at build time, where there is no runtime wait to hide. Whether the
  // await costs the user anything depends on where the page renders and whether the data is
  // static, and none of that is in the file. It stays in frontend-policy's Instant First Paint.
  // NOTE: there is deliberately no rule for "a fixed-length one-time code submits itself when
  // the last digit lands". The selector would be precise (`autocomplete="one-time-code"`, the
  // same marker sec-password-breach-check keys on), but the DEFECT has no file-local form: the
  // submit normally lives in a parent, a form library or a mutation hook, so its absence from
  // the field's file proves nothing, and the three guards that make auto-submit safe (once per
  // distinct complete value, no re-fire after a failure, no auto-retry on 429) are behaviour a
  // regex cannot read at all. It stays in frontend-policy's auth section, with the attempt-cap
  // half in security-policy.
  // NOTE: sec-operator-env-leak covers the operator's HOME PATH and nothing else, though the
  // policy it serves also names deployment domains, host names, server IPs and internal email
  // addresses. Those have no exact signature: the domain a project deploys to is legitimately
  // in its own code, and a rule keyed on "a URL that is not example.com" would flag most of
  // every codebase. The home path is different - the string can be compared against the actual
  // machine, so the check is exact rather than heuristic. The rest stays in security-policy and
  // git-policy, where a reader can weigh it.
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
    // STAYS warn on the same measurement, and this is the uncomfortable one: 29 candidate
    // lines produce 24 findings and every one is a real leak in a real backend, several of
    // them in one product's route files. Severity here is not a judgement about how bad the
    // defect is - it is whether the gate can block without firing on work nobody is doing
    // today, and 24 pre-existing leaks in live route files means it cannot. The rule that
    // would carry this is a DIFF-stage block (the fe-truncated-value-unreachable shape,
    // which exists for exactly a defect that is the default in existing code).
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
    // warns: a warn exits 0 and reaches the model that keeps growing the file only when a
    // blocking finding fires in the same turn-end sweep, so it is reported and never required.
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
    id: "fe-icon-shrink",
    label: "An icon does not shrink to make room for text",
    files: ["*.css", "*.scss", "*.html", "*.htm", "*.astro", "*.vue", "*.svelte", "*.tsx", "*.jsx"],
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/stories/**",
      "*.stories.*",
      "*.min.css",
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
    // `flex-shrink: 1` is the default, so in a row of icon plus text the browser takes width
    // from BOTH when the text runs long - and the icon, having no content to reflow, is simply
    // squashed. An explicit width/height does not protect it (that is the base size, not the
    // minimum) and an <svg> scales with its viewBox rather than clipping, so it deforms
    // silently instead of overflowing visibly.
    // Two gateable shapes, one per styling model. (a) A STYLESHEET rule sizing an svg/img on
    // one line: the size bound (<= 64px) is what makes it an ICON rather than a picture -
    // a hero image at 640px SHOULD shrink with the viewport, and pinning it would be the
    // wrong fix. (b) A UTILITY-CLASS line carrying a flex container, an icon element and an
    // icon size class together; the flex requirement is what keeps this off the rest of the
    // markup, and it is why a multi-line JSX icon is out of reach by construction (the same
    // accepted recall loss as fe-icon-action-button). Case-SENSITIVE so `[A-Z]\w*` means a
    // component tag (<ExternalLink>, <Avatar>) and not every lowercase element.
    pattern: "^(?!.*enigma:)(?:(?=.*\\bflex\\b)(?=.*<(?:svg|img|[A-Z][A-Za-z0-9]*)\\b).*\\b(?:h-\\d(?:\\.\\d)?[ \\t]+w-\\d(?:\\.\\d)?|w-\\d(?:\\.\\d)?[ \\t]+h-\\d(?:\\.\\d)?|size-\\d(?:\\.\\d)?)\\b|[^{}/]*\\b(?:svg|img)[ \\t]*(?:,[^{}]*)?\\{[^}]*\\bwidth:[ \\t]*(?:[1-9]|[1-5]\\d|6[0-4])px)",
    flags: "",
    // A file that already pins an icon anywhere is treated as having made the decision. This
    // is deliberately leaky (one guarded rule clears the file) because the fix that scales is
    // a single base rule - `svg { flex-shrink: 0 }` - not a repetition per selector, and a
    // rule that kept firing after that fix would train the model to ignore it.
    absent: "flex-shrink:\\s*0|\\bshrink-0\\b|\\bflex-none\\b|flex:\\s*(?:none|0 0)|enigma:allow-shrinking-icon",
    message: "Icon sized but not pinned. `flex-shrink: 1` is the default, so when the text beside it runs long the browser takes width from the ICON too - and having no content to reflow, a 14px glyph ends up rendered 4px wide next to a long name. The explicit width/height does not prevent it: that is the base size, not the minimum, and an svg scales with its viewBox instead of clipping, so it deforms silently. Give anything with a fixed intrinsic size - icon, avatar, badge, status dot, spinner - `flex-shrink: 0` (Tailwind `shrink-0`), and let the TEXT be what truncates. Set it once where the icons are defined (`svg { flex-shrink: 0 }` in the base stylesheet, or inside the shared Icon component) rather than per row. Mark a deliberate exception with an `enigma:` note on the line or `enigma:allow-shrinking-icon` in the file (frontend-policy).",
    severity: "block",
    skill: "frontend-policy"
  },
  // TYPESCRIPT MODULE GRAPH. Three rules that keep a TS project's imports stable as it grows:
  // the project declares an alias, deep climbs go through it, and no specifier carries a build
  // artifact's extension. All three are decided against the project's tsconfig rather than the
  // edited line, which is why each is a coded check (see the module-graph block below).
  {
    id: "ts-alias-paths",
    label: "TypeScript project declares a path alias",
    // The exact basename only: the split configs a bundler generates (tsconfig.node.json,
    // tsconfig.app.json) exist to compile one config file and have no source tree to alias.
    files: ["tsconfig.json"],
    excludeFiles: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/vendor/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "vendor/**"
    ],
    scope: "file",
    fileCheck: "ts-alias-paths",
    message: 'This TypeScript project declares no path alias. Add one - `"baseUrl": "."` plus `"paths": { "@/*": ["./src/*"] }` - and import through it (`@/services/user`) instead of counting directories. A relative chain encodes where the importing file happens to sit, so moving either file rewrites specifiers that had nothing to do with the change; an alias is stable under both. Bundlers, tsx and Bun resolve it from tsconfig with no extra config; for Jest add moduleNameMapper. If this config is not the project\'s source config, mark it with an `enigma:` note (ciphera-style-policy).',
    severity: "block",
    skill: "ciphera-style-policy"
  },
  {
    id: "ts-alias-deep-relative",
    label: "Deep relative import goes through the path alias",
    files: ["*.ts", "*.tsx", "*.mts", "*.cts"],
    // Tests are excluded on purpose: a runner that has not been told about the alias (Jest
    // without moduleNameMapper) cannot resolve it, so the import that is right in src is not
    // automatically right in a test file. Same two-form generated/vendored excludes as above.
    excludeFiles: [
      "*.test.*",
      "*.spec.*",
      "**/tests/**",
      "**/__tests__/**",
      "**/fixtures/**",
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
    // Fires only when the project HAS an alias covering the target: the climb on its own is
    // correct code in a project with none, and a target outside the aliased root cannot be
    // written any other way. Measured over the corpus: every project that declares an alias
    // already uses it everywhere, so this is a scaffolding guard, not a backlog.
    fileCheck: "ts-alias-deep-relative",
    message: "Deep relative import in a project that declares a path alias. Write it through the alias instead: the chain of `../` names the directory the importing file sits in today, so moving either file breaks specifiers that had nothing to do with the change, and a reader has to count directories to see what is being imported. Keep `./sibling` and `../` for a file in the same or the parent folder - the alias is for anything further. Mark a deliberate exception with an `enigma:` note on the line (ciphera-style-policy).",
    severity: "block",
    skill: "ciphera-style-policy"
  },
  {
    id: "ts-import-extension",
    label: "No file extension in a module specifier",
    files: ["*.ts", "*.tsx"],
    // .mts/.cts are out of scope by construction: those extensions exist to pin a file to
    // Node's dual-module resolution, where the specifier extension is mandatory.
    excludeFiles: [
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
    // Only under bundler/preserve resolution, and only when no such file actually exists -
    // see extensionImports for why both guards are what keep this at zero false positives.
    fileCheck: "ts-import-extension",
    message: 'File extension in a module specifier. Under `"moduleResolution": "bundler"` the resolver finds the source file on its own, so an extension only pins the import to a build artifact - `.js` names a file that does not exist in the source tree, and `.ts` needs allowImportingTsExtensions and breaks the moment the project emits. Drop it and let the resolver do the work. If this project has to emit for Node\'s own ESM resolution instead, that is a tsconfig decision (`"module": "nodenext"`), and there the extension is required - make it once in tsconfig rather than per import (backend-policy, ciphera-style-policy).',
    severity: "block",
    skill: "ciphera-style-policy"
  },
  {
    id: "ts-legacy-module-resolution",
    label: "Modern TypeScript module resolution and target",
    files: ["tsconfig.json", "tsconfig.*.json"],
    excludeFiles: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/vendor/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "vendor/**"
    ],
    scope: "file",
    // `node`/`node10` is TypeScript's own legacy resolver: it predates package.json "exports",
    // so a modern dependency resolves to the wrong entry point or not at all. A pre-ES2017
    // target is the same class of decision - it downlevels async/await itself. Both are
    // single, unambiguous values, which is what makes this a pattern rule rather than a
    // check; a project that genuinely needs ES5 output marks the line.
    // THE TARGET BOUND IS DELIBERATELY LOWER THAN THE ADVICE. backend-policy asks for es2022,
    // but `"target": "es2017"` is what create-next-app still ships and what several stock
    // configs default to, and in a Next app SWC compiles the output anyway so the value
    // barely matters - blocking the ecosystem's own template is how a rule teaches people to
    // ignore it. The skill persuades toward es2022; the gate only stops what is unambiguous.
    pattern: `^(?!.*enigma:).*(?:["']moduleResolution["']\\s*:\\s*["']node(?:10)?["']|["']target["']\\s*:\\s*["']es(?:3|5|6|2015|2016)["'])`,
    message: 'Legacy TypeScript configuration. `"moduleResolution": "node"` is the pre-2022 resolver: it ignores a package\'s `exports` map, so a modern dependency resolves to the wrong entry point or not at all, and a pre-ES2017 target downlevels async/await itself. For a backend built by a bundler or run by tsx/Bun use `"module": "esnext"` with `"moduleResolution": "bundler"`; for one emitted by tsc for Node\'s own loader use `"module": "nodenext"` (and then specifiers DO carry `.js`). Pair either with `"target": "es2022"` and `"strict": true`. Mark a deliberate legacy target with an `enigma:` note on the line (backend-policy).',
    severity: "block",
    skill: "backend-policy"
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
    // ui-no-em-dash reason: a warn exits 0 and is reported but never required, the symptom is
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
  },
  {
    id: "sec-operator-env-leak",
    label: "Do not publish the operator's own environment",
    // Every text file a change touches: the leak lands in source and comments, but just as
    // often in a README, a snapshot, a config, or a log somebody committed by accident.
    files: ["**"],
    excludeFiles: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/vendor/**",
      "**/.next/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "vendor/**",
      "*.lock",
      "*.lockb",
      "package-lock.json",
      "*.min.js",
      "*.map"
    ],
    scope: "file",
    // DIFF stage, for the reason the stage exists: a machine's own paths are all over the
    // logs and scratch files a long-lived repository already carries, and a rule that
    // reports those on an unrelated edit gets switched off within a day. Here it can only
    // fire on a line the current change ADDED - which is exactly the moment to catch it,
    // because after the push the value is in the history for good.
    stage: "diff",
    fileCheck: "sec-operator-env-leak",
    message: "This line carries THIS machine's home directory into a tracked file. A path with the OS account name in it publishes who you are and how your machine is laid out, and a commit keeps it forever - the same class as a deployment domain, a host name, a server IP or an internal email address, none of which belong in code, comments, docs, examples, fixtures, or a committed log. Write a placeholder (`<project-root>`, `$HOME`, `%USERPROFILE%`) or a repository-relative path, and keep the real value in the local gitignored config that already holds it. Being handed a path or a URL to work with is permission to USE it, never permission to publish it - only an explicit request to put that value in the file is (security-policy, git-policy).",
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
  "proc-windows-hide": (content) => missingWindowsHide(content),
  "fe-server-first-mutation": (content) => serverFirstMutation(content),
  "fe-textarea-size-bounds": (content) => textareaSizeBounds(content),
  "fe-view-blanked-while-loading": (content) => viewBlankedWhileLoading(content),
  "fe-truncated-value-unreachable": (content) => truncatedValueUnreachable(content),
  "fe-unbounded-remote-list": (content) => unboundedRemoteList(content),
  "fe-page-await-no-boundary": (content, file) => pageAwaitWithoutBoundary(content, file),
  "ts-import-extension": (content, file) => extensionImports(content, file),
  "ts-alias-deep-relative": (content, file) => deepRelativeImports(content, file),
  "ts-alias-paths": (content, file) => missingPathAlias(content, file),
  "sec-operator-env-leak": (content) => operatorHomePathLeak(content)
};
var FIXERS = {
  "fe-name-input-capitalize": (line, file) => {
    if (/autocapitalize/i.test(line)) return null;
    const tags = line.match(/<input\b/gi);
    if (!tags || tags.length !== 1) return null;
    const attr = /\.[jt]sx$/i.test(file) ? 'autoCapitalize="words"' : 'autocapitalize="words"';
    return line.replace(/<input\b/i, `<input ${attr}`);
  },
  "fe-truncated-value-unreachable": (line, file) => {
    if (!/\.[jt]sx$/i.test(file)) return null;
    if (/title\s*=/.test(line)) return null;
    const tags = line.match(/<[a-z][a-z0-9]*\b/g);
    if (!tags || tags.length !== 1) return null;
    const match = CLIPPED_SIMPLE_VALUE.exec(line);
    if (!match) return null;
    const [, tag, attrs, expr] = match;
    if (!CLIP_ONE_LINE.test(attrs) || NOT_TEXT_BINDING.test(expr)) return null;
    const replacement = `<${tag}${attrs} title={${expr}}>`;
    return line.replace(`<${tag}${attrs}>`, () => replacement);
  }
};
function applyFixes(file, findings, stage = "edit") {
  const fixable = findings.filter((f) => f.line && FIXERS[f.ruleId]);
  if (!fixable.length) return { fixed: [], remaining: findings };
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { fixed: [], remaining: findings };
  }
  const lines = content.split("\n");
  const fixed = [];
  for (const f of fixable) {
    const idx = f.line - 1;
    const before = lines[idx];
    if (before === void 0) continue;
    const after = FIXERS[f.ruleId](before, file);
    if (after === null || after === before) continue;
    lines[idx] = after;
    fixed.push(f);
  }
  if (!fixed.length) return { fixed: [], remaining: findings };
  try {
    writeFileSync(file, lines.join("\n"));
  } catch {
    return { fixed: [], remaining: findings };
  }
  try {
    return { fixed, remaining: checkPath(file, stage) };
  } catch {
    return { fixed, remaining: [] };
  }
}
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
var MUTATING_REQUEST = /method:\s*["'`](POST|PUT|PATCH|DELETE)|\b(?:axios|api|\$fetch|http|client)\.(?:post|put|patch|delete)\s*\(/i;
var ENTITY_WRITE = /\bset[A-Z]\w*\s*\(\s*(?:\(?\w+\)?\s*=>\s*)?[\w.]*\.(?:filter|map|slice|concat)\s*\(|\bset[A-Z]\w*\s*\(\s*!/;
var OPTIMISTIC_SIGNAL = /useOptimistic|onMutate|optimisticData|setQueryData|rollbackOnError|\brollback\s*[(:]|\brevert\s*[(:]|previous[A-Z_]/;
var ALLOW_SERVER_FIRST = /enigma:allow-server-first/;
var RESULT_BINDING = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?/;
var BLOCK_LOOKBACK = 120;
var BLOCK_LOOKAHEAD = 200;
function enclosingBlock(lines, index) {
  let depth = 0;
  let start = index;
  let foundStart = false;
  for (let i = index; i >= 0 && index - i < BLOCK_LOOKBACK && !foundStart; i--) {
    const line = lines[i];
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === "}") depth++;
      else if (line[c] === "{") {
        if (depth === 0) {
          start = i;
          foundStart = true;
          break;
        }
        depth--;
      }
    }
  }
  depth = 0;
  let end = index;
  let foundEnd = false;
  for (let i = start; i < lines.length && i - start < BLOCK_LOOKAHEAD && !foundEnd; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          foundEnd = true;
          break;
        }
      }
    }
  }
  return { start, end: Math.max(end, index) };
}
function serverFirstMutation(content) {
  if (OPTIMISTIC_SIGNAL.test(content)) return [];
  const lines = content.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || !MUTATING_REQUEST.test(line)) continue;
    const { start, end } = enclosingBlock(lines, i);
    if (lines.slice(start, end + 1).some((l) => ALLOW_SERVER_FIRST.test(l))) continue;
    if (lines.slice(start, i).some((l) => ENTITY_WRITE.test(l))) continue;
    let binding = "";
    for (let b = i; b >= Math.max(0, i - 4) && !binding; b--) binding = RESULT_BINDING.exec(lines[b])?.[1] ?? "";
    const uses = binding ? new RegExp(`\\b${binding}\\b`) : null;
    const write = lines.slice(i + 1, end + 1).find((l) => {
      if (COMMENT_LINE.test(l)) return false;
      const at = ENTITY_WRITE.exec(l);
      if (!at) return false;
      return !uses?.test(l.slice(at.index));
    });
    if (write) out.push({ line: i + 1, detail: `the UI is only updated after the request resolves: ${write.trim().slice(0, 80)}` });
  }
  return out;
}
var TEXTAREA = /<textarea\b/;
var TEXTAREA_LOWER = /\brows\s*=|\brows:\s*\d|min-h-|min-height|minHeight|\bh-\[|\bh-\d|height\s*:\s*\d/;
var TEXTAREA_UPPER = /max-h-|max-height|maxHeight/;
var TEXTAREA_FIXED = /resize-none|resize\s*:\s*none/;
var TEXTAREA_AUTOSIZE = /field-?sizing|scrollHeight|autosize|auto-size|TextareaAutosize|textarea-autosize/i;
function textareaSizeBounds(content) {
  const lower = TEXTAREA_LOWER.test(content);
  const upper = TEXTAREA_UPPER.test(content);
  const fixed = TEXTAREA_FIXED.test(content) && !TEXTAREA_AUTOSIZE.test(content);
  if (lower && (upper || fixed)) return [];
  const out = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || /enigma:/.test(line) || !TEXTAREA.test(line)) continue;
    const missing = [];
    if (!lower) missing.push("no minimum size: no rows, min-height or fixed height");
    if (!upper && !fixed) missing.push("no maximum size: no max-height, and it can be dragged or grows with its content");
    if (missing.length) out.push({ line: i + 1, detail: missing.join("; ") });
  }
  return out;
}
var VIEW_GUARD = /\bif\s*\(\s*(!?\s*[\w.]{1,30}(?:\s*(?:===|!==|==|!=)\s*[\w."']{1,20})?)\s*\)\s*return\s+<\s*\w*(Skeleton|Placeholder|Shimmer|Loading|Loader|Spinner)\b/;
var LOADING_NAME = "loading|pending|fetching|data|resource|result|state|profile|items|rows|list|summary|overview|response";
var LOADING_VALUE = "loading|pending|fetching";
var VIEW_GUARD_LOADING = new RegExp(`^(?:!?(?:\\w{1,30}\\.)*(?:is)?(?:${LOADING_NAME})|(?:\\w{1,30}\\.)*\\w{1,30}(?:===|!==|==|!=)["']?(?:${LOADING_VALUE})["']?)$`, "i");
var VIEW_CHROME_HEADING = /<\s*(h1|h2|h3|CardTitle|DialogTitle|PageHeader|SheetTitle|SectionTitle)\b/;
var VIEW_CHROME_TEXT = />\s*[A-Z][A-Za-z0-9 ,.'&:%/()-]{2,60}\s*</;
var VIEW_BODY_LOOKAHEAD = 400;
var ALLOW_VIEW_SKELETON = /enigma:allow-view-skeleton/;
function markedNearby(lines, index, marker) {
  const { start, end } = enclosingBlock(lines, index);
  return lines.slice(Math.max(0, Math.min(start, index - 1)), end + 1).some((line) => marker.test(line));
}
var SKELETON_GUARD = new RegExp(SKELETON_GUARD_SRC);
var SKELETON_SIGNAL = new RegExp(SKELETON_SIGNAL_SRC, "i");
function viewBlankedWhileLoading(content) {
  const lines = content.split("\n");
  const owned = !SKELETON_SIGNAL.test(content);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || /enigma:/.test(line)) continue;
    const match = VIEW_GUARD.exec(line);
    if (!match || !VIEW_GUARD_LOADING.test(match[1].replace(/\s+/g, ""))) continue;
    if (owned && SKELETON_GUARD.test(line)) continue;
    if (markedNearby(lines, i, ALLOW_VIEW_SKELETON)) continue;
    let headings = 0;
    let texts = 0;
    for (let j = i + 1; j < lines.length && j - i < VIEW_BODY_LOOKAHEAD; j++) {
      const body = lines[j];
      if (/^\}/.test(body)) break;
      if (COMMENT_LINE.test(body)) continue;
      if (VIEW_CHROME_HEADING.test(body)) headings++;
      if (VIEW_CHROME_TEXT.test(body)) texts++;
    }
    if (headings < 1 && texts < 2) continue;
    const drawn = [headings ? `${headings} heading/title element(s)` : "", texts ? `${texts} literal text node(s)` : ""].filter(Boolean).join(" and ");
    out.push({ line: i + 1, detail: `the component still draws ${drawn} below this guard, none of which needs the response` });
  }
  return out;
}
var REMOTE_COLLECTION_BINDINGS = [
  /const\s+\{\s*data\s*:\s*(\w+)[^}]*\}\s*=\s*use\w*Query\s*\(/g,
  /const\s+\{\s*data\s*:\s*(\w+)[^}]*\}\s*=\s*useSWR\s*\(/g,
  /const\s+\{\s*(data)\s*[,}][^=]*=\s*use\w*Query\s*\(/g,
  /const\s+\{\s*(data)\s*[,}][^=]*=\s*useSWR\s*\(/g,
  /const\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*\.findMany\s*\(/g,
  /const\s+\{\s*data\s*:\s*(\w+)[^}]*\}\s*=\s*await\s+[\w.]*\.from\s*\(/g,
  /const\s+(\w+)\s*=\s*await\s+[\w.]*\.(?:list|getAll|findAll|scan)\s*\(/g,
  /const\s+(\w+)\s*=\s*await\s+getDocs\s*\(/g,
  /const\s+(\w+)\s*=\s*useLoaderData\s*(?:<[^>]*>)?\s*\(/g,
  /const\s+(\w+)\s*=\s*await\s+\(?\s*await\s+fetch\s*\([^;]*\)\s*\)?\.json\s*\(/g
];
var LIST_BOUNDED = /useInfiniteQuery|useSWRInfinite|fetchNextPage|hasNextPage|loadMore|load_more|IntersectionObserver|useVirtualizer|react-window|react-virtual\b|virtua\b|VirtualList|Virtuoso|FlatList|RecyclerListView|paginat|pageSize|page_size|perPage|per_page|\bcursor\b|\boffset\b|\.slice\s*\(|\btake\s*:|\blimit\s*:|\bLIMIT\b|\bfirst\s*:|\brange\s*\(/i;
var ALLOW_UNBOUNDED_LIST = /enigma:allow-unbounded-list/;
function remoteCollectionNames(content) {
  const names = /* @__PURE__ */ new Set();
  for (const re of REMOTE_COLLECTION_BINDINGS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) if (m[1]) names.add(m[1]);
  }
  return [...names].filter((n) => !/^[A-Z0-9_]+$/.test(n));
}
function unboundedRemoteList(content) {
  const names = remoteCollectionNames(content);
  if (names.length === 0 || LIST_BOUNDED.test(content)) return [];
  const alt = names.join("|");
  const renders = new RegExp(
    `\\{\\s*(?:${alt})\\b[\\w.?\\[\\]]*\\s*\\.\\s*(?:map|flatMap)\\s*\\(|v-for\\s*=\\s*["'][^"']*\\bin\\s+(?:${alt})\\b|\\{#each\\s+(?:${alt})\\b`
  );
  const lines = content.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || /enigma:/.test(line)) continue;
    if (!renders.test(line)) continue;
    if (markedNearby(lines, i, ALLOW_UNBOUNDED_LIST)) continue;
    out.push({ line: i + 1, detail: `'${names.join("', '")}' comes from the server and every row of it is rendered` });
    break;
  }
  return out;
}
var CLIP_ONE_LINE = /\btruncate\b|\btext-ellipsis\b|text-overflow\s*:\s*ellipsis/;
var DYNAMIC_CHILD = /(?<![=!<>-])>\s*\{(?![#/:@])/;
var VALUE_REACHABLE = /\btitle\s*=|aria-label\s*=|<\s*Tooltip|TooltipTrigger|data-tooltip|hoverCard|HoverCard/i;
var WRAPPER_LOOKBACK = 4;
var ALLOW_CLIPPED_VALUE = /enigma:allow-clipped-value/;
function truncatedValueUnreachable(content) {
  const lines = content.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || /enigma:/.test(line)) continue;
    if (!CLIP_ONE_LINE.test(line) || !DYNAMIC_CHILD.test(line)) continue;
    if (VALUE_REACHABLE.test(line)) continue;
    if (lines.slice(Math.max(0, i - WRAPPER_LOOKBACK), i).some((l) => VALUE_REACHABLE.test(l))) continue;
    if (markedNearby(lines, i, ALLOW_CLIPPED_VALUE)) continue;
    out.push({ line: i + 1, detail: "the value is ellipsised here and its full text is carried by nothing on this element or its wrapper" });
  }
  return out;
}
var CLIPPED_SIMPLE_VALUE = /<([a-z][a-z0-9]*)\b([^<>]*)>\s*\{\s*([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\s*\}\s*<\/\1>/;
var NOT_TEXT_BINDING = /^(children|icon|node|element|content|component)$|\.(children|icon|node|element|content|component)$/i;
var ASYNC_ROUTE = /export\s+default\s+async\s+function\b/;
var SERVER_DATA_AWAIT = /await\s+(prisma|db|supabase|drizzle|knex|mongoose)\b|await\s+[\w.]{1,40}\.(findMany|findUnique|findFirst|aggregate|groupBy|count|createQueryBuilder)\s*\(/;
var STREAM_BOUNDARY = /<\s*Suspense\b/;
var ALLOW_BLOCKING_PAGE = /enigma:allow-blocking-page/;
var LOADING_BOUNDARY_FILE = /^loading\.(jsx?|tsx)$/;
function pageAwaitWithoutBoundary(content, file) {
  if (/^\s*["']use client["']/m.test(content)) return [];
  if (!ASYNC_ROUTE.test(content)) return [];
  const lines = content.split("\n");
  if (lines.some((l) => !COMMENT_LINE.test(l) && STREAM_BOUNDARY.test(l))) return [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line) || /enigma:/.test(line) || !SERVER_DATA_AWAIT.test(line)) continue;
    if (markedNearby(lines, i, ALLOW_BLOCKING_PAGE)) continue;
    out.push({ line: i + 1, detail: "the route awaits this query before it returns any markup, and neither a loading.tsx in the segment chain nor a <Suspense> boundary lets the shell paint first" });
  }
  if (!out.length || nearestLoadingBoundary(file)) return [];
  return out;
}
function nearestLoadingBoundary(file) {
  const root = findProjectRoot(file);
  let dir = dirname(resolve(file));
  for (let i = 0; i < 20; i++) {
    try {
      if (readdirSync(dir).some((name) => LOADING_BOUNDARY_FILE.test(name))) return true;
    } catch {
      return false;
    }
    if (!root || dir === root || /[\\/](app|pages|src)$/.test(dir)) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}
var SPECIFIER = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']/gm;
var MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
var JS_EXT = /\.(js|jsx|mjs|cjs)$/i;
var tsconfigCache = /* @__PURE__ */ new Map();
function nearestTsconfig(file) {
  let dir = dirname(resolve(file));
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const cached = tsconfigCache.get(dir);
    if (cached !== void 0) {
      for (const d of seen) tsconfigCache.set(d, cached);
      return cached;
    }
    seen.push(dir);
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      let found = null;
      try {
        found = { dir, text: readFileSync(candidate, "utf8") };
      } catch {
        found = null;
      }
      for (const d of seen) tsconfigCache.set(d, found);
      return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of seen) tsconfigCache.set(d, null);
  return null;
}
function pathAlias(cfg) {
  const m = /["']([^"']+)\/\*["']\s*:\s*\[\s*["']([^"']+)\/\*["']/.exec(cfg.text);
  if (!m) return null;
  const baseUrl = /["']baseUrl["']\s*:\s*["']([^"']+)["']/.exec(cfg.text)?.[1] ?? ".";
  return { prefix: m[1], root: resolve(cfg.dir, baseUrl, m[2]) };
}
function specifiers(content) {
  const lines = content.split("\n");
  const out = [];
  for (const m of content.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    const line = content.slice(0, m.index).split("\n").length;
    const text = lines[line - 1] ?? "";
    if (COMMENT_LINE.test(text) || text.includes("enigma:")) continue;
    out.push({ spec, line });
  }
  return out;
}
function extensionImports(content, file) {
  const cfg = nearestTsconfig(file);
  if (!cfg || !/["']module(?:Resolution)?["']\s*:\s*["'](?:bundler|preserve)["']/i.test(cfg.text)) return [];
  const dir = dirname(resolve(file));
  const out = [];
  for (const { spec, line } of specifiers(content)) {
    if (!/^\.\.?\//.test(spec) || !MODULE_EXT.test(spec)) continue;
    if (JS_EXT.test(spec) && existsSync(resolve(dir, spec))) continue;
    out.push({ line, detail: `"${spec}" -> "${spec.replace(MODULE_EXT, "")}"` });
  }
  return out;
}
function deepRelativeImports(content, file) {
  const cfg = nearestTsconfig(file);
  const alias = cfg && pathAlias(cfg);
  if (!alias) return [];
  const dir = dirname(resolve(file));
  const out = [];
  for (const { spec, line } of specifiers(content)) {
    if (!/^(?:\.\.\/){2,}/.test(spec)) continue;
    const target = resolve(dir, spec);
    const rel = target.slice(alias.root.length + 1).replace(/\\/g, "/");
    if (!target.startsWith(`${alias.root}${sep}`) || !rel) continue;
    out.push({ line, detail: `"${spec}" -> "${alias.prefix}/${rel}"` });
  }
  return out;
}
function missingPathAlias(content, file) {
  if (/["'](?:paths|extends)["']\s*:/.test(content)) return [];
  const dir = dirname(resolve(file));
  const src = ["src", "app", "lib"].find((d) => existsSync(join(dir, d)));
  if (!src) return [];
  const anchor = content.split("\n").findIndex((l) => /["']compilerOptions["']/.test(l));
  return [{ line: anchor === -1 ? 1 : anchor + 1, detail: `no alias for ./${src}` }];
}
var NAMED_IMPORT = /^import[ \t]+(?:[\w$]+[ \t]*,[ \t]*)?(?:type[ \t]+)?\{([^}]*)\}[ \t]*from[ \t]*["']([^"']+)["'].*$/gm;
var GENERIC_ACCOUNTS = /* @__PURE__ */ new Set(["runner", "root", "ubuntu", "debian", "vagrant", "node", "user", "users", "developer", "ec2-user", "codespace", "gitpod", "jenkins", "circleci", "travis", "docker", "app"]);
function operatorHome() {
  const env = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return env?.trim() || homedir();
}
function operatorHomePathLeak(content) {
  const home = operatorHome();
  if (!home || home.length < 6) return [];
  const account = home.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  if (!account || GENERIC_ACCOUNTS.has(account.toLowerCase())) return [];
  const forms = [home];
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(home);
  if (drive) forms.push(`/${drive[1].toLowerCase()}/${drive[2]}`);
  const alt = forms.map((f) => f.split(/[\\/]/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]")).join("|");
  let re;
  try {
    re = new RegExp(`(?:${alt})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, "i");
  } catch {
    return [];
  }
  const out = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push({ line: i + 1, detail: "the path resolves to this machine's home directory" });
  }
  return out;
}
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
var globCache = /* @__PURE__ */ new Map();
function globRe(glob, ignoreCase = false) {
  const key = `${ignoreCase ? "i" : "s"}:${glob}`;
  let re = globCache.get(key);
  if (!re) {
    re = globToRegExp(glob, ignoreCase);
    globCache.set(key, re);
  }
  return re;
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
function checkFile(file, content, projectRoot, stage = "edit", rules = loadRules()) {
  const norm = file.replace(/\\/g, "/");
  const out = [];
  for (const rule of rules) {
    if (stage === "edit" && rule.stage === "diff") continue;
    if (!rule.files.some((g) => globRe(g, rule.ignoreFileCase).test(norm))) continue;
    if (rule.excludeFiles?.some((g) => globRe(g, rule.ignoreFileCase).test(norm))) continue;
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
      for (const hit of check ? check(content, file) : []) {
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
function checkPath(file, stage = "edit") {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\0")) return [];
  return checkFile(file, content, findProjectRoot(file), stage);
}
function gitProbe(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
}
var DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
function changedLineFilter(file) {
  const cwd = dirname(file);
  const status = gitProbe(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all", "--", file]);
  if (status === null) return null;
  if (/^\?\?/m.test(status)) return () => true;
  const diff = gitProbe(cwd, ["diff", "-U0", "HEAD", "--", file]);
  if (diff === null) return null;
  const changed = /* @__PURE__ */ new Set();
  for (const line of diff.split("\n")) {
    const hunk = DIFF_HUNK.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === void 0 ? 1 : Number(hunk[2]);
    for (let i = 0; i < count; i++) changed.add(start + i);
  }
  return (line) => changed.has(line);
}
function repairableDiffFindings(file) {
  const rules = loadRules().filter((r) => r.stage === "diff");
  if (!rules.length) return [];
  const changed = changedLineFilter(file);
  if (!changed) return [];
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (content.includes("\0")) return [];
  try {
    return checkFile(file, content, findProjectRoot(file), "diff", rules).filter((f) => f.line && changed(f.line));
  } catch {
    return [];
  }
}
function runGuardrailsHook(payload) {
  let file;
  try {
    file = JSON.parse(payload ?? readFileSync(0, "utf8"))?.tool_input?.file_path;
  } catch {
  }
  if (!file || typeof file !== "string") return 0;
  const found = checkPath(file);
  const repairable = [...found, ...repairableDiffFindings(file)];
  if (!repairable.length) return 0;
  const { fixed } = applyFixes(file, repairable, "diff");
  if (fixed.length) process.stdout.write(`enigma guardrails (fixed)
${fixed.map((f) => `${f.file}:${f.line} (${f.ruleId})`).join("\n")}
`);
  recordFindings(fixed, "fixed");
  const findings = fixed.length ? checkPath(file) : found;
  if (!findings.length) return 0;
  const warns = findings.filter((f) => f.severity === "warn");
  const blocks = findings.filter((f) => f.severity === "block");
  recordFindings(warns, "warned");
  recordFindings(blocks, "blocked");
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
var LEDGER_MAX_BYTES = 512 * 1024;
var LEDGER_KEEP = 2e3;
var LEDGER_KEEP_REPLY = 200;
function ledgerPath() {
  return process.env.ENIGMA_GUARDRAILS_LOG || join(homedir(), ".enigma", "guardrail-log.jsonl");
}
function ledgerKey(rule, outcome, file, line) {
  return JSON.stringify([rule, outcome, file, line ?? null]);
}
function recordedToday(day) {
  const seen = /* @__PURE__ */ new Set();
  eachLedgerEntry(1, (e) => {
    if (e.at.slice(0, 10) === day) seen.add(ledgerKey(e.rule, e.outcome, e.file, e.line));
  });
  return seen;
}
function recordFindings(findings, outcome, stage = "edit") {
  if (!findings.length) return;
  try {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const dedupe = stage !== "reply" && !(stage === "edit" && outcome === "blocked");
    const seen = dedupe ? recordedToday(at.slice(0, 10)) : null;
    const rows = [];
    for (const f of findings) {
      if (seen) {
        const key = ledgerKey(f.ruleId, outcome, f.file, f.line);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(JSON.stringify({ at, rule: f.ruleId, severity: f.severity, outcome, stage, file: f.file, line: f.line }));
    }
    if (!rows.length) return;
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
    }
    if (size > LEDGER_MAX_BYTES) {
      const kept = rotateLedger(readFileSync(path, "utf8"));
      writeFileSync(path, kept.length ? `${kept.join("\n")}
` : "");
    }
    appendFileSync(path, `${rows.join("\n")}
`);
  } catch {
  }
}
function rotateLedger(text) {
  const lines = text.split("\n").filter(Boolean);
  const kept = [];
  let conventions = 0;
  let replies = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    let reply = false;
    try {
      reply = JSON.parse(line)?.stage === "reply";
    } catch {
    }
    if (reply) {
      if (replies >= LEDGER_KEEP_REPLY) continue;
      replies++;
    } else {
      if (conventions >= LEDGER_KEEP) continue;
      conventions++;
    }
    kept.push(line);
  }
  return kept.reverse();
}
function eachLedgerEntry(sinceDays, visit) {
  let text;
  try {
    text = readFileSync(ledgerPath(), "utf8");
  } catch {
    return;
  }
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 864e5 : 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.rule !== "string") continue;
      if (cutoff && Date.parse(entry.at) < cutoff) continue;
      visit(entry);
    } catch {
    }
  }
}
function isConvention(entry) {
  return entry.stage !== "reply";
}
function readLedger(sinceDays = 0) {
  const out = [];
  eachLedgerEntry(sinceDays, (entry) => {
    if (isConvention(entry)) out.push(entry);
  });
  return out;
}
function readReplyLedger(sinceDays = 0) {
  const out = [];
  eachLedgerEntry(sinceDays, (entry) => {
    if (!isConvention(entry)) out.push(entry);
  });
  return out;
}
function countLedger(sinceDays = 0) {
  let count = 0;
  eachLedgerEntry(sinceDays, (entry) => {
    if (isConvention(entry)) count++;
  });
  return count;
}
function summarizeLedger(entries) {
  const by = /* @__PURE__ */ new Map();
  for (const e of entries) {
    const row = by.get(e.rule) || { rule: e.rule, total: 0, blocked: 0, warned: 0, fixed: 0, last: e.at };
    row.total++;
    if (e.outcome === "blocked") row.blocked++;
    else if (e.outcome === "warned") row.warned++;
    else row.fixed++;
    if (e.at > row.last) row.last = e.at;
    by.set(e.rule, row);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule));
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
  FIXERS,
  PROJECT_CHECKS,
  applyFixes,
  checkFile,
  checkPath,
  countLedger,
  deepRelativeImports,
  extensionImports,
  findProjectRoot,
  formatFindings,
  loadRules,
  missingPathAlias,
  missingWindowsHide,
  operatorHomePathLeak,
  pageAwaitWithoutBoundary,
  readLedger,
  readReplyLedger,
  recordFindings,
  remoteCollectionNames,
  runGuardrailsHook,
  runGuardrailsScan,
  runGuardrailsScanCli,
  serverFirstMutation,
  summarizeLedger,
  textareaSizeBounds,
  truncatedValueUnreachable,
  unboundedRemoteList,
  viewBlankedWhileLoading,
  wideNamedImports
};
