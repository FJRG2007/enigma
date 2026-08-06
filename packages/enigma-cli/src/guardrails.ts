/**
 * enigma guardrails: a self-contained, dependency-free convention-enforcement engine.
 *
 * Skills persuade the model but load only when it decides to (progressive disclosure),
 * so a convention that lives only in a skill is often skipped. This engine enforces
 * project conventions OUTSIDE the model, as a post-edit gate: after the agent writes a
 * file, the matching rules run and any violation is fed back so the model self-corrects
 * in the same turn - zero model tokens until a violation, and a tiny message when there
 * is one. Rules are DATA: a rule is one entry (a built-in below or a user entry in
 * ~/.enigma-guardrails.json), never new code.
 *
 * Like guard.ts, this file is BOTH (a) bundled into the CLI - cli.ts imports
 * runGuardrailsHook for the hidden `__guardrails-hook` command each agent's post-edit
 * hook invokes - and (b) the built dist/guardrails.js copied into a repo's .githooks/ as
 * a commit/CI backstop. So it stays self-contained (only Node builtins, no imports from
 * other modules) and its standalone footer fires only when this file is the program entry.
 *
 * Severity model (consistent across the agent hook and the commit backstop):
 *   - block: enforced. Agent hook exits 2 (stderr fed back to the model); commit fails.
 *   - warn:  advisory. Agent hook exits 0 (printed, non-blocking); commit prints, passes.
 *
 * Stage model (GuardrailRule.stage):
 *   - edit (default): the post-edit hook and the commit backstop, which see a WHOLE file.
 *   - diff: only the turn-end sweep in verify.ts, over the lines the change ADDED - which is
 *     what makes a rule affordable when the defect is common in code that already exists.
 *
 * Every finding the model is actually confronted with is appended to the compliance ledger
 * (recordFindings, reported by `enigma guardrails stats`), so a convention the agent keeps
 * skipping is a number rather than a memory. The turn-end output-style gate writes to that same
 * file under the `reply` stage (see LedgerStage); the convention readers exclude those rows.
 */

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve, sep } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, existsSync } from "node:fs";

export type Severity = "block" | "warn";

/** When a rule runs: on the edited file, or over the lines a change added (see GuardrailRule.stage). */
export type Stage = "edit" | "diff";

/**
 * What a ledger row is ABOUT, which is a superset of the stages a guardrail rule runs at.
 *
 * `reply` is the turn-end output-style gate (verify.ts): a finding about the agent's prose, not
 * about a convention in the code it produced. It shares this file so there is one place to look
 * for "what does the agent keep getting wrong", and it is marked so the convention readers can
 * leave it out - counting reply padding as a guardrail violation would misreport both numbers.
 */
export type LedgerStage = Stage | "reply";

/** A line whose trimmed start is a comment - the pattern scan skips these to avoid false positives. */
const COMMENT_LINE = /^\s*(\/\/|#|\*|--|<!--|\{?\/\*)/;

/**
 * fe-skeleton-loading's guard and its mitigation set, declared here because a SECOND consumer reads
 * them: viewBlankedWhileLoading skips any line this pair would already report, so one blanked view
 * never arrives as two BLOCK findings with two different messages for one fix.
 */
const SKELETON_GUARD_SRC = "\\bif\\s*\\(\\s*(isLoading|isPending|isFetching|loading|pending)\\s*\\)\\s*return\\s+(null\\b|<\\s*\\w*(Spinner|Loader|Loading|CircularProgress)\\b)";
const SKELETON_SIGNAL_SRC = "skeleton|animate-pulse|shimmer|Suspense|ContentLoader|content-loader|<\\s*Placeholder";

/** One convention rule. `file` rules regex-scan the edited file; `project` rules run a named check. */
export interface GuardrailRule {
    id: string;
    label: string;
    /** Globs the edited file must match for the rule to apply (guardrails uses globToRegExp). */
    files: string[];
    /** Globs that EXCLUDE a file from the rule even if `files` matches (e.g. test files). */
    excludeFiles?: string[];
    /**
     * Match `files`/`excludeFiles` case-insensitively. Off by default, because a glob naming an
     * exact file (CLAUDE.md) must not also match a different one (claude.md). Rules that key on
     * a WORD inside the name need it: the same screen is `login/page.tsx` in one project and
     * `LoginForm.tsx` in the next, and a case-sensitive glob silently covers only the first.
     */
    ignoreFileCase?: boolean;
    scope: "file" | "project";
    /**
     * WHEN the rule runs. "edit" (the default) is the post-edit hook and the commit backstop,
     * which see a WHOLE file - so a rule there has to be precise enough that a repository's
     * pre-existing code does not fire it, or it blocks every unrelated edit and gets switched off.
     *
     * "diff" runs ONLY in the turn-end sweep, against the lines the current change ADDED. That
     * removes the legacy backlog by construction, which is what makes a rule affordable when the
     * defect is common in existing code but must not be written again: it can only fire on code
     * the agent just produced, and it is reported once per turn rather than per edit.
     */
    stage?: Stage;
    /** file scope: regex source matching a violation on a line. */
    pattern?: string;
    /** file scope: regex flags (default "i"). Never include "g" - the engine tests line by line. */
    flags?: string;
    /**
     * file scope: when set, the rule fires ONLY if this regex does NOT match anywhere in the
     * file - i.e. "pattern present without the mitigation". Models "reads input without a
     * schema": pattern = the risky read, absent = the schema/validation signal.
     */
    absent?: string;
    /** project scope: id of a built-in check in PROJECT_CHECKS. */
    check?: string;
    /** file scope: fires when the file is larger than this many bytes (size has no regex form). */
    maxBytes?: number;
    /**
     * file scope: fires when a single project-internal module contributes more than this many
     * named import bindings to the file. A count has no regex form, and the bindings are summed
     * across every statement importing that module, so splitting one import in two cannot dodge it.
     */
    maxNamedImports?: number;
    /**
     * file scope: id of a coded check in FILE_CHECKS, for a violation with no regex form that
     * still lives inside one file (e.g. a call whose options object is missing a key, which
     * needs paren balancing to read across the lines the call spans). Like PROJECT_CHECKS these
     * are code, not data, so a user cannot add one from JSON - add a function there instead.
     */
    fileCheck?: string;
    /** Feedback shown to the model; should name the owning skill so the fix is traceable. */
    message: string;
    severity: Severity;
    skill?: string;
}

/** A single detected violation. */
export interface Finding {
    ruleId: string;
    severity: Severity;
    file: string;
    line?: number;
    message: string;
    skill?: string;
}

/**
 * Built-in rules. Precision over recall: patterns match ONLY unambiguous violations, so a
 * false positive never trains the model (or a committer) to ignore guardrails. The seed is
 * deliberately tiny; extend it via ~/.enigma-guardrails.json or by adding an entry here.
 */
export const BUILTIN_RULES: GuardrailRule[] = [
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
        pattern: "\\b(?:BIG|SMALL)?SERIAL\\b|\\bAUTO_INCREMENT\\b|\\bIDENTITY\\s*\\(|\\bGENERATED\\s+(?:ALWAYS|BY\\s+DEFAULT)\\s+AS\\s+IDENTITY\\b|@default\\(autoincrement\\(\\)\\)|@PrimaryGeneratedColumn\\(\\s*(?:\\)|[\"']increment[\"'])",
        flags: "i",
        message: "Use UUID primary keys, never auto-increment / SERIAL / IDENTITY / AUTO_INCREMENT (database-expert). Generate a UUID (prefer UUIDv7 or ULID) at the application layer or via a database uuid default.",
        severity: "block",
        skill: "database-expert",
    },
    {
        id: "db-ts-orm-prisma",
        label: "Prisma as the default ORM (TypeScript)",
        files: ["package.json", "*.sql", "schema.ts", "ormconfig.*", "data-source.ts", "knexfile.*", "drizzle.config.*"],
        scope: "project",
        check: "ts-relational-no-prisma",
        message: "This is a TypeScript project on a relational datastore without Prisma. Prefer Prisma as the default ORM for new TypeScript work (database-expert).",
        severity: "warn",
        skill: "database-expert",
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
        pattern: "provider\\s*=\\s*[\"']sqlite[\"']",
        absent: "enigma:allow-sqlite",
        message: "SQLite as the application datastore. SQLite is one file with one writer: it is right for a local-first or embedded store (a CLI's own state, a desktop or mobile app, a local cache or index, a test fixture) and wrong for anything deployed, replicated, or written to by a background worker - and moving off it later is a migration with downtime, not a config change. Default to PostgreSQL: real write concurrency, native uuid/jsonb/arrays/enums/timestamptz, partial and GIN indexes, partitioning and read replicas, plus pgvector, pg_trgm and PostGIS instead of a second service. On serverless put a pooler in front (PgBouncer, Prisma Accelerate, the provider's pooled endpoint); the constraint there is connection count, not the engine. If this datastore is deliberately local-first or embedded, mark it with an `enigma:allow-sqlite` note (database-expert).",
        severity: "block",
        skill: "database-expert",
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
        skill: "validation-policy",
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
        skill: "validation-policy",
    },
    {
        id: "val-email-normalize",
        label: "Email is normalized before it is validated",
        files: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.vue", "*.svelte"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "*.d.ts", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        message: "Email schema with no normalization. An address pasted with a leading space or typed in mixed case must reduce to ONE stored value, or the lookup misses, the uniqueness check passes, and the user ends up with a second account. Normalize inside the schema so no caller can forget it: Zod `z.string().trim().toLowerCase().pipe(z.email())` - the order matters, `z.email().trim()` validates first and rejects a pasted \" a@b.com\" - Yup `.trim().lowercase().email()`, Pydantic a `field_validator(mode=\"before\")`. Use the same schema on the client and the server. If this address must keep its case, mark it with an `enigma:allow-raw-email` note (validation-policy).",
        severity: "block",
        skill: "validation-policy",
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
        excludeFiles: [
            "*.test.*", "*.spec.*", "*.stories.*", "*.min.js",
            "**/tests/**", "tests/**", "**/__tests__/**", "__tests__/**", "**/stories/**", "stories/**",
            "**/dist/**", "dist/**", "**/build/**", "build/**", "**/_build/**", "_build/**",
            "**/node_modules/**", "node_modules/**", "**/vendor/**", "vendor/**",
        ],
        scope: "file",
        // A raw lowercase <input type="password"> (not a component) with no show/hide toggle in the
        // file. flags:"" = case-sensitive so a capitalized <Input> component is NOT matched; a
        // literal type="password" only, so a dynamic type={visible?...} toggle is not matched either.
        pattern: "^(?!.*enigma:).*<input\\b[^>]*type=[\"']password[\"']",
        flags: "",
        absent: "showPassword|setShowPassword|togglePassword|revealPassword|passwordVisible|isPasswordVisible|showPw|hidePassword|enigma:allow-raw-password-input",
        message: "Raw <input type=\"password\">: use the shared reusable Input component (which renders a show/hide toggle for passwords) instead of a bare input, or add the toggle (frontend-policy). Mark the line `enigma:` or add `enigma:allow-raw-password-input` to the file where the field is deliberately bare.",
        // BLOCK for the same reason as fe-ellipsis-without-overflow, and it is the same class of
        // routing failure: a warn is never fed back by the hook and never denies the stop at turn
        // end, while "one Input that renders a show/hide toggle for a password" is an always-on
        // kernel convention the model is expected to apply, not advice it may weigh. It is the
        // reverse of the two rules that stay warn - the criterion is the backlog, and this rule
        // has none: measured over 39316 files of the whole local
        // corpus, 75 candidate lines and 0 findings - every real password field already carries a
        // toggle, so it fires on a bare one an agent writes and on nothing else.
        severity: "block",
        skill: "frontend-policy",
    },
    {
        id: "fe-name-input-capitalize",
        label: "A person-name field capitalizes its words",
        files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        pattern: "autocomplete=\\{?[\"'](?:name|given-name|family-name|additional-name|honorific-prefix)[\"']|(?:\\bname|\\bid|\\bfor|formControlName)=\\{?[\"'](?:first[-_]?name|last[-_]?name|given[-_]?name|family[-_]?name|surname|apellidos?)[\"']",
        absent: "autocapitalize|enigma:allow-no-capitalize",
        message: "Person-name field with no capitalization rule. Phone keyboards capitalize SENTENCES, so a name typed on mobile is stored as \"juan perez\": add `autocapitalize=\"words\"` (plus `spellcheck=\"false\"` and `autocorrect=\"off\"`, and the matching `autocomplete` token). The attribute only covers typing, so normalize the value too - trim, collapse inner spaces, and uppercase the first letter of every word - on blur and again on the server, uppercasing ONLY that letter so `McDonald`, `O'Brien` and `van der Berg` survive. Best placed once in the shared Input/TextField component, selected by a prop. For a field that must keep what was typed, add an `enigma:allow-no-capitalize` note (frontend-policy, validation-policy).",
        severity: "block",
        skill: "frontend-policy",
    },
    {
        id: "fe-name-value-normalize",
        label: "A person-name value is normalized, not just autocapitalized",
        files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // The twin of fe-name-input-capitalize, and the half that actually reaches the stored
        // value: `autocapitalize` is a KEYBOARD hint. A phone honours it, a physical keyboard
        // ignores it entirely, so "juan perez" typed on a laptop is stored exactly like that and
        // the field looks broken to the user who typed it. The attribute alone clears the other
        // rule, which is how a form ends up with the attribute and no normalization at all.
        // Same person-name token set (see there for why `name`/`fullname` are excluded).
        pattern: "autocomplete=\\{?[\"'](?:name|given-name|family-name|additional-name|honorific-prefix)[\"']|(?:\\bname|\\bid|\\bfor|formControlName)=\\{?[\"'](?:first[-_]?name|last[-_]?name|given[-_]?name|family[-_]?name|surname|apellidos?)[\"']",
        absent: "capitalizeWords|capitalizeName|capitalizeEach|toTitleCase|titleCase|startCase|properCase|normalizeName|normalizePerson|capitalize\\(|charAt\\(0\\)\\.toUpperCase|enigma:allow-no-capitalize",
        message: "Person-name field with no value normalization. `autocapitalize=\"words\"` only shapes the phone keyboard - a physical keyboard ignores it, so \"juan perez\" is stored verbatim. Normalize the VALUE with the shared normalizer (validation-policy): trim, collapse inner spaces, and uppercase the first letter of every word, ONLY that letter, so `McDonald`, `O'Brien` and `van der Berg` survive. Run it on blur (never on every keystroke - it moves the caret and breaks IME composition) and again on the server, which is the copy that decides what is stored. Put it in the shared Input/TextField so the next form gets it by construction. For a field that must keep exactly what was typed, add an `enigma:allow-no-capitalize` note (validation-policy, frontend-policy).",
        severity: "block",
        skill: "validation-policy",
    },
    {
        id: "sec-password-breach-check",
        label: "A new password is checked against the breach corpus",
        files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // `autocomplete="new-password"` is the spec's own marker for a password being CREATED -
        // sign-up, reset confirmation, change password - and never appears on a sign-in form
        // (that one is `current-password`). So it selects exactly the screens where the check
        // belongs, with no path guessing. Any mention of the check anywhere in the file clears
        // it, including a call into a shared hook whose name carries `pwned`/`breach`.
        pattern: "autocomplete=\\{?[\"']new-password[\"']",
        absent: "pwnedpasswords|haveibeenpwned|hibp|pwned|breach|enigma:allow-no-breach-check",
        message: "A password is created here with no breach check. Length and symbol rules do not stop a password that is already in a credential-stuffing list. Check it against Have I Been Pwned's Pwned Passwords range API - free, no key, and the password never leaves the client: SHA-1 it, uppercase the hex, GET https://api.pwnedpasswords.com/range/<first 5 chars> with `Add-Padding: true`, and look for the remaining 35 characters in the `SUFFIX:COUNT` lines. Debounce it as the user types, abort the in-flight request when the value changes, repeat the check server-side on submit, and fail OPEN if the lookup errors so an outage never blocks a signup. For a flow that genuinely cannot reach it, add an `enigma:allow-no-breach-check` note (security-policy).",
        severity: "block",
        skill: "security-policy",
    },
    {
        id: "sec-password-identity-match",
        label: "A new password is not the account's own identity",
        files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        pattern: "autocomplete=\\{?[\"']new-password[\"']",
        absent: "userInputs|user_inputs|UserAttributeSimilarity|sameAs(?:Email|Username|Identity)|matchesIdentity|containsIdentity|identityMatch|notIdentity|personalInfo|(?:password|passwd|pwd)[^\\n]{0,60}(?:===|==|!==|\\.includes\\(|\\.indexOf\\(|\\.startsWith\\(|localeCompare)[^\\n]{0,60}(?:email|username|user_?name|handle)|(?:email|username|user_?name|handle)[^\\n]{0,60}(?:===|==|!==|\\.includes\\(|\\.indexOf\\(|\\.startsWith\\(|localeCompare)[^\\n]{0,60}(?:password|passwd|pwd)|enigma:allow-identity-password",
        message: "A password is created here with nothing stopping it from being the account's own identity. `Fjrg2007` for the user `fjrg2007` is one guess for anyone who knows the email address. Refuse a candidate that equals, contains (4 characters or more), or closely resembles the email, its local part, the username, the display name or the site name - comparing NORMALIZED values on both sides (lowercase, trim, NFKD then strip accents, drop everything that is not a letter or a digit), so `F.J.R.G_2007` and `fjrg2007` are the same string and casing is never a difference. Declare it on the OBJECT schema, since a password field cannot see the email beside it, and run it again on the server where the real identity lives. A strength meter fed `userInputs` scores this badly but is advisory - keep the refusal as its own rule. For a flow with no identity to compare against, add an `enigma:allow-identity-password` note (security-policy, validation-policy).",
        severity: "block",
        skill: "security-policy",
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
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        skill: "security-policy",
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
        pattern: "\\bwindow\\.(alert|confirm|prompt)\\s*\\(|(?<![.\\w])(alert|confirm|prompt)\\s*\\(\\s*[\"']",
        flags: "",
        message: "Native browser dialog (alert/confirm/prompt) - use a dialog/modal component that matches the page design instead of the browser's built-in. If this confirms a destructive action, use a real confirmation dialog that names what is being deleted; for an irreversible one (delete a repo/account/org, drop data) require type-to-confirm - the user types the exact resource name and the button stays disabled until it matches (frontend-policy).",
        severity: "warn",
        skill: "frontend-policy",
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
        pattern: "from\\s+[\"']moment(?:-timezone)?[\"']|require\\(\\s*[\"']moment(?:-timezone)?[\"']\\s*\\)",
        message: "moment.js is heavy and in maintenance mode. For displaying dates use <relative-time> (@github/relative-time-element) or the native Intl APIs; for date math prefer a lightweight option (date-fns, dayjs, or Temporal) (frontend-policy).",
        severity: "warn",
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        skill: "frontend-policy",
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
        pattern: "\\.role\\s*===?\\s*[\"']assistant[\"']",
        flags: "",
        absent: "ai-elements|assistant-ui|@assistant-ui|copilotkit|@copilotkit|llm-ui|@nlux|nlux|@chatscope|chatscope",
        message: "Hand-rolled AI chat UI. Use AI Elements (https://elements.ai-sdk.dev/components) - `npx ai-elements@latest add conversation message prompt-input` copies the source into @/components/ai-elements/, so it stays editable with no runtime dependency. It already solves streaming, scroll-stick-to-bottom, markdown with unclosed code fences mid-stream, and reasoning/tool-call/citation panels. Needs React + Tailwind + shadcn/ui; on any other stack build natively instead (frontend-policy).",
        severity: "warn",
        skill: "frontend-policy",
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
        message: "HTML document with a <head> but no responsive viewport meta. Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> so the page is responsive on mobile instead of rendering at desktop width (frontend-policy).",
        // STAYS warn, and it was measured rather than assumed when its two siblings were flipped
        // to block: 571 candidate lines over 39316 files produce 145 findings - generated API
        // docs, framework error templates, sample apps and one-off report pages that are all genuine
        // matches and none of them anyone's current work. That is a legacy backlog, so a block
        // would fire on every unrelated edit to those files, which is exactly the cost the
        // ellipsis and password rules do NOT carry (0 findings each). Backlog, not precision and
        // not how bad the defect is, is what decides this severity.
        severity: "warn",
        skill: "frontend-policy",
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
            "*.test.*", "*.spec.*", "*.min.css",
            "**/tests/**", "tests/**", "**/__tests__/**", "__tests__/**",
            "**/dist/**", "dist/**", "**/build/**", "build/**", "**/.next/**", ".next/**",
            "**/node_modules/**", "node_modules/**",
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
        skill: "frontend-policy",
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
        message: "This clips a value the user cannot recover: the text is ellipsised and the full string appears nowhere. A name, email, path or title is exactly the value someone needs in full, and the sample used while building is always short enough to hide the problem. Where the design system has a tooltip, wrap the element in it - that is the better answer. Otherwise give the clipping element a `title` attribute carrying the same value, written in this file's own binding syntax (`title={value}` in JSX, `:title=\"value\"` in Vue, `title={value}` in Svelte, `title=\"...\"` in plain HTML) - and where the value must be readable at a glance rather than on hover, let it wrap instead of clipping. Mark the line `enigma:allow-clipped-value` when the full value is already shown elsewhere on the screen (frontend-policy).",
        severity: "block",
        skill: "frontend-policy",
    },
    {
        id: "fe-icon-action-button",
        label: "Repeated actions are icon buttons, not text labels",
        files: ["*.tsx", "*.jsx", "*.vue", "*.svelte", "*.astro", "*.html", "*.htm", "*.ts", "*.js", "*.mts", "*.cts"],
        // Same two-form generated/vendored excludes as ui-no-em-dash: `**/x/**` needs a leading
        // segment, so it misses a root-level dist/.
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/fixtures/**", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        message: "Action button labelled with a word. A repeated row or card action (copy, edit, rename, duplicate, remove, delete, download, share, refresh) reads faster and costs far less width as an ICON button: drop the visible word for a single icon taken from the project's one icon set, and keep the action reachable without sight - aria-label=\"<Action> <what it acts on>\" for the accessible name, title=\"<Action>\" for the hover tooltip, aria-hidden=\"true\" on the icon itself (an <img> icon carries the same text as its alt instead). Keep a written label only where the design or the user asks for one, or on a primary/confirmation button whose whole job is to be read - then mark the line with an `enigma:` note, or add `enigma:allow-text-actions` to the file (frontend-policy).",
        severity: "block",
        skill: "frontend-policy",
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
        skill: "technical-writing-policy",
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
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/fixtures/**", "*.min.js",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
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
        message: "Typographic dash in user-facing text. The em dash and en dash are the clearest tell of AI-written copy and no interface needs them: use a plain hyphen \"-\", a comma, a colon, or two sentences, and write a range as \"5 to 10\". Keep one only when the dash is the subject (a typography guide) or the text is quoted verbatim - then mark the line with an `enigma:` note or add `enigma:allow-dash` to the file (technical-writing-policy).",
        severity: "block",
        skill: "technical-writing-policy",
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
        skill: "validation-policy",
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
        maxBytes: 40_000,
        message: "This memory file loads into every session in the project, so its cost is paid on every task regardless of relevance. Keep it an INDEX: move each subsystem's detail into its own doc (docs/notes/<topic>.md) and leave one line here saying what the note covers and when to read it. Route new conventions by tier - a file-local syntactic signature becomes a guardrail rule, a domain-scoped rule belongs in the owning skill (loaded on demand), and only a truly universal rule stays in memory. Turn this off with `enigma guardrails disable ctx-memory-budget`.",
        severity: "block",
    },
    {
        id: "ts-import-namespace",
        label: "Namespace import for a wide module surface",
        files: ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.jsx"],
        // Two-form generated/vendored excludes (`**/x/**` misses a root-level dist/). Declaration
        // files are excluded too: a .d.ts re-declares another module's surface, it has no call sites.
        excludeFiles: [
            "*.min.js", "*.d.ts",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // A count has no regex form, hence maxNamedImports. 9 is the budget: past that the import
        // line stops being readable, and every new export of the module widens it again. Only the
        // project's OWN modules are counted - a bare specifier (node builtin, npm package) is a
        // fixed surface the ecosystem writes as named imports, so counting those would flag
        // idiomatic code. BLOCK for the ui-no-em-dash reason: a warn exits 0 and never reaches
        // the model, and the fix is mechanical.
        maxNamedImports: 9,
        message: "Too many named bindings from one module. Import it as a namespace instead - `import * as <ns> from \"<module>\"`, then call `<ns>.thing()` - so the import stays one short line, each call site says where the symbol comes from, and a new export never widens the import again. The count sums every named import of that module in this file, so splitting the statement in two does not help; name the namespace for the module, and pick a distinct name when the natural one is already a local variable. Keep named imports for a handful of symbols. Mark a deliberate exception with an `enigma:` note on the import line (ciphera-style-policy).",
        severity: "block",
        skill: "ciphera-style-policy",
    },
    {
        id: "fe-icon-shrink",
        label: "An icon does not shrink to make room for text",
        files: ["*.css", "*.scss", "*.html", "*.htm", "*.astro", "*.vue", "*.svelte", "*.tsx", "*.jsx"],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.css",
            "**/dist/**", "**/build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "node_modules/**", "vendor/**",
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
        skill: "frontend-policy",
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
            "**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**",
            "node_modules/**", "dist/**", "build/**", "vendor/**",
        ],
        scope: "file",
        fileCheck: "ts-alias-paths",
        message: "This TypeScript project declares no path alias. Add one - `\"baseUrl\": \".\"` plus `\"paths\": { \"@/*\": [\"./src/*\"] }` - and import through it (`@/services/user`) instead of counting directories. A relative chain encodes where the importing file happens to sit, so moving either file rewrites specifiers that had nothing to do with the change; an alias is stable under both. Bundlers, tsx and Bun resolve it from tsconfig with no extra config; for Jest add moduleNameMapper. If this config is not the project's source config, mark it with an `enigma:` note (ciphera-style-policy).",
        severity: "block",
        skill: "ciphera-style-policy",
    },
    {
        id: "ts-alias-deep-relative",
        label: "Deep relative import goes through the path alias",
        files: ["*.ts", "*.tsx", "*.mts", "*.cts"],
        // Tests are excluded on purpose: a runner that has not been told about the alias (Jest
        // without moduleNameMapper) cannot resolve it, so the import that is right in src is not
        // automatically right in a test file. Same two-form generated/vendored excludes as above.
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/fixtures/**", "*.d.ts",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // Fires only when the project HAS an alias covering the target: the climb on its own is
        // correct code in a project with none, and a target outside the aliased root cannot be
        // written any other way. Measured over the corpus: every project that declares an alias
        // already uses it everywhere, so this is a scaffolding guard, not a backlog.
        fileCheck: "ts-alias-deep-relative",
        message: "Deep relative import in a project that declares a path alias. Write it through the alias instead: the chain of `../` names the directory the importing file sits in today, so moving either file breaks specifiers that had nothing to do with the change, and a reader has to count directories to see what is being imported. Keep `./sibling` and `../` for a file in the same or the parent folder - the alias is for anything further. Mark a deliberate exception with an `enigma:` note on the line (ciphera-style-policy).",
        severity: "block",
        skill: "ciphera-style-policy",
    },
    {
        id: "ts-import-extension",
        label: "No file extension in a module specifier",
        files: ["*.ts", "*.tsx"],
        // .mts/.cts are out of scope by construction: those extensions exist to pin a file to
        // Node's dual-module resolution, where the specifier extension is mandatory.
        excludeFiles: [
            "*.d.ts",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // Only under bundler/preserve resolution, and only when no such file actually exists -
        // see extensionImports for why both guards are what keep this at zero false positives.
        fileCheck: "ts-import-extension",
        message: "File extension in a module specifier. Under `\"moduleResolution\": \"bundler\"` the resolver finds the source file on its own, so an extension only pins the import to a build artifact - `.js` names a file that does not exist in the source tree, and `.ts` needs allowImportingTsExtensions and breaks the moment the project emits. Drop it and let the resolver do the work. If this project has to emit for Node's own ESM resolution instead, that is a tsconfig decision (`\"module\": \"nodenext\"`), and there the extension is required - make it once in tsconfig rather than per import (backend-policy, ciphera-style-policy).",
        severity: "block",
        skill: "ciphera-style-policy",
    },
    {
        id: "ts-legacy-module-resolution",
        label: "Modern TypeScript module resolution and target",
        files: ["tsconfig.json", "tsconfig.*.json"],
        excludeFiles: [
            "**/node_modules/**", "**/dist/**", "**/build/**", "**/vendor/**",
            "node_modules/**", "dist/**", "build/**", "vendor/**",
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
        pattern: "^(?!.*enigma:).*(?:[\"']moduleResolution[\"']\\s*:\\s*[\"']node(?:10)?[\"']|[\"']target[\"']\\s*:\\s*[\"']es(?:3|5|6|2015|2016)[\"'])",
        message: "Legacy TypeScript configuration. `\"moduleResolution\": \"node\"` is the pre-2022 resolver: it ignores a package's `exports` map, so a modern dependency resolves to the wrong entry point or not at all, and a pre-ES2017 target downlevels async/await itself. For a backend built by a bundler or run by tsx/Bun use `\"module\": \"esnext\"` with `\"moduleResolution\": \"bundler\"`; for one emitted by tsc for Node's own loader use `\"module\": \"nodenext\"` (and then specifiers DO carry `.js`). Pair either with `\"target\": \"es2022\"` and `\"strict\": true`. Mark a deliberate legacy target with an `enigma:` note on the line (backend-policy).",
        severity: "block",
        skill: "backend-policy",
    },
    {
        id: "proc-windows-hide",
        label: "Spawned process must not pop a console window",
        files: ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.jsx"],
        // Tests run in a terminal that already has a console, so a flashing window is not a
        // defect there. Same two-form generated/vendored excludes as the rules above.
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/fixtures/**", "*.min.js", "*.d.ts",
            "**/dist/**", "**/build/**", "**/_build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "_build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // A call spanning several lines has no line-regex form, hence a coded check (see
        // missingWindowsHide for the three shapes it deliberately leaves alone). BLOCK for the
        // ui-no-em-dash reason: a warn exits 0 and is reported but never required, the symptom is
        // invisible to whoever writes the code on macOS or Linux, and the fix is one key.
        fileCheck: "proc-windows-hide",
        message: "Process spawned without windowsHide. On Windows a console child started by a process that has no console of its own - a daemon, an editor hook, a detached background task - pops a real console window on screen and closes it again, which reads as something crashing. Add `windowsHide: true` to the options object; it is inert on macOS and Linux, and inert on Windows when the parent already has a console, so it is safe on every call that is not deliberately opening a terminal for the user. For one that IS (a login flow that must show a terminal), mark the call with an `enigma:` note.",
        severity: "block",
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
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.min.js",
            "**/dist/**", "**/build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "node_modules/**", "vendor/**",
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
        skill: "frontend-policy",
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
            "*login*.tsx", "*login*.jsx", "*login*.vue", "*login*.svelte", "*login*.astro", "*login*.html",
            "*signin*.tsx", "*signin*.jsx", "*signin*.vue", "*signin*.svelte", "*signin*.astro", "*signin*.html",
            "*sign-in*.tsx", "*sign-in*.jsx", "*sign-in*.vue", "*sign-in*.svelte", "*sign-in*.astro", "*sign-in*.html",
            "**/login/**", "login/**", "**/signin/**", "signin/**", "**/sign-in/**", "sign-in/**",
        ],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*",
            "**/dist/**", "**/build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // The password field is what makes this THE sign-in surface rather than a wrapper or a
        // route file; a login page that only renders <LoginForm/> has no password field and is
        // correctly left alone (the form itself is the file that must carry the link).
        pattern: "type=[\"']password[\"']|type=\\{[\"']password[\"']\\}",
        // Any recovery affordance clears the file: the link, the route, or a handler named for it.
        absent: "forgot|reset[-_ ]?password|password[-_ ]?reset|recover|olvid|recuperar|magic[-_ ]?link|enigma:allow-no-reset",
        message: "Sign-in form with no way out of a forgotten password. Every login form needs a visible \"Forgot your password?\" entry point next to the password field, leading to a real reset flow: ask for the identifier, always answer the same way (never reveal whether the account exists), email a single-use token that expires in ~15-60 minutes, and on success invalidate that token plus every other active session. If this screen is deliberately reset-less (an internal tool, SSO-only, a passwordless magic-link form), mark the file with an `enigma:allow-no-reset` note (frontend-policy, security-policy).",
        severity: "block",
        skill: "security-policy",
    },
    {
        id: "auth-signup-auto-login",
        label: "Registration signs the user in",
        ignoreFileCase: true,
        files: [
            "*register*.tsx", "*register*.jsx", "*register*.ts", "*register*.js", "*register*.vue", "*register*.svelte", "*register*.astro",
            "*signup*.tsx", "*signup*.jsx", "*signup*.ts", "*signup*.js", "*signup*.vue", "*signup*.svelte", "*signup*.astro",
            "*sign-up*.tsx", "*sign-up*.jsx", "*sign-up*.ts", "*sign-up*.js", "*sign-up*.vue", "*sign-up*.svelte", "*sign-up*.astro",
            "**/register/**", "register/**", "**/signup/**", "signup/**", "**/sign-up/**", "sign-up/**",
        ],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "**/stories/**", "*.stories.*", "*.d.ts",
            "**/dist/**", "**/build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "node_modules/**", "vendor/**",
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
        skill: "security-policy",
    },
    {
        id: "auth-rate-limit",
        label: "Rate-limit the credential endpoints",
        ignoreFileCase: true,
        files: [
            "*login*.ts", "*login*.js", "*login*.mts", "*login*.cts", "*login*.py",
            "*signin*.ts", "*signin*.js", "*sign-in*.ts", "*sign-in*.js", "*signin*.py", "*sign-in*.py",
            "*register*.ts", "*register*.js", "*signup*.ts", "*signup*.js", "*sign-up*.ts", "*sign-up*.js",
            "*register*.py", "*signup*.py", "*sign-up*.py",
            "*2fa*.ts", "*2fa*.js", "*2fa*.py", "*mfa*.ts", "*mfa*.js", "*mfa*.py", "*otp*.ts", "*otp*.js", "*otp*.py",
            "*forgot-password*.ts", "*forgot-password*.js", "*forgot-password*.py",
            "*reset-password*.ts", "*reset-password*.js", "*reset-password*.py",
            "**/login/**", "login/**", "**/signin/**", "signin/**", "**/sign-in/**", "sign-in/**",
            "**/register/**", "register/**", "**/signup/**", "signup/**", "**/sign-up/**", "sign-up/**",
            "**/2fa/**", "2fa/**", "**/mfa/**", "mfa/**", "**/otp/**", "otp/**",
            "**/forgot-password/**", "forgot-password/**", "**/reset-password/**", "reset-password/**",
        ],
        excludeFiles: [
            "*.test.*", "*.spec.*", "**/tests/**", "**/__tests__/**", "test_*.py", "*_test.py", "*.d.ts",
            "**/dist/**", "**/build/**", "**/node_modules/**", "**/vendor/**",
            "dist/**", "build/**", "node_modules/**", "vendor/**",
        ],
        scope: "file",
        // A server-side handler for the flow: the route export/registration, a framework
        // decorator, or a "use server" module (a Next server action reachable from the sign-in
        // page is an unauthenticated endpoint like any other, and it is how App Router projects
        // write this). A client component calling fetch() is deliberately not matched - it
        // cannot enforce a limit, and the file that must is the one defining the endpoint.
        pattern: "export\\s+(?:async\\s+)?function\\s+(?:POST|PUT|PATCH)\\b|export\\s+const\\s+(?:POST|PUT|PATCH)\\s*[:=]|\\b(?:router|app|api|server|fastify)\\.(?:post|put|patch)\\s*\\(|@(?:app|router|bp|blueprint)\\.(?:post|route)\\s*\\(|@Post\\s*\\(|^[\"']use server[\"']",
        // Cleared by any limiter in the file, whatever the library or the wrapper name.
        absent: "rate[-_]?limit|ratelimit|Ratelimit|RateLimiter|limiter|throttle|slowDown|slow_down|bottleneck|arcjet|leaky|token[-_]?bucket|attempts?[-_]?(?:left|remaining|count)|lockout|too[-_ ]?many[-_ ]?requests|429|enigma:allow-unlimited-auth",
        message: "Credential endpoint with no rate limiting. Login, registration, password reset and every 2FA/OTP verification are guessing surfaces: limit them BY IP (blunt, stops the broad sweep) AND BY ACCOUNT or identifier (stops the slow distributed attack the IP limit misses), count failures rather than requests, back off exponentially, and answer 429 with Retry-After. Keep the accounting server-side and identical for an unknown account, so the limiter itself does not become an account-existence oracle. If the limit is enforced upstream (gateway, middleware, WAF), note it in the file with an `enigma:allow-unlimited-auth` marker (security-policy, backend-policy).",
        severity: "block",
        skill: "security-policy",
    },
];

/**
 * Named project-level checks (return true when the convention is VIOLATED). These need
 * logic, so they are code, not data - unlike file-scope rules a user cannot add one via
 * JSON (add a function here instead). Keyed by GuardrailRule.check.
 */
export const PROJECT_CHECKS: Record<string, (projectRoot: string) => boolean> = {
    "ts-relational-no-prisma": (root) => {
        const pkg = readPkgDeps(root);
        if (!pkg) return false;
        const hasTs = "typescript" in pkg || existsSync(join(root, "tsconfig.json"));
        if (!hasTs) return false;
        const relational = ["typeorm", "sequelize", "knex", "drizzle-orm", "pg", "mysql", "mysql2", "better-sqlite3", "@mikro-orm/core"];
        if (!relational.some((d) => d in pkg)) return false;
        return !("prisma" in pkg || "@prisma/client" in pkg);
    },
};

/**
 * Named file-level checks (return one entry per violation). Same rationale as PROJECT_CHECKS:
 * they need logic rather than a line regex, so they are code and not user-authorable from JSON.
 * Keyed by GuardrailRule.fileCheck; `detail` is appended to the rule message.
 *
 * A check receives the file PATH as well as its content, because some conventions are only a
 * defect relative to something outside the file: whether the import extension is required is a
 * property of the project's module resolution, and whether an alias exists is a property of its
 * tsconfig. A check that needs neither simply ignores the second argument.
 */
export const FILE_CHECKS: Record<string, (content: string, file: string) => { line: number; detail: string; }[]> = {
    "proc-windows-hide": (content) => missingWindowsHide(content),
    "fe-server-first-mutation": (content) => serverFirstMutation(content),
    "fe-textarea-size-bounds": (content) => textareaSizeBounds(content),
    "fe-view-blanked-while-loading": (content) => viewBlankedWhileLoading(content),
    "fe-truncated-value-unreachable": (content) => truncatedValueUnreachable(content),
    "fe-page-await-no-boundary": (content, file) => pageAwaitWithoutBoundary(content, file),
    "ts-import-extension": (content, file) => extensionImports(content, file),
    "ts-alias-deep-relative": (content, file) => deepRelativeImports(content, file),
    "ts-alias-paths": (content, file) => missingPathAlias(content, file),
};

/**
 * Deterministic repairs, keyed by rule id and applied by the post-edit hook before anything is
 * reported. A violation code can fix costs the model nothing: no message, no turn, no tokens.
 * Everything else falls back to the normal block, which is the point - a fixer exists only where
 * the correct edit is mechanical and cannot be wrong.
 *
 * CONTRACT, and it is narrow on purpose: a fixer receives ONE line (the flagged one) and returns
 * its replacement, or null to decline. It can therefore never touch a byte the rule did not point
 * at. Declining is always safe; guessing is not, so a fixer returns null on anything ambiguous.
 * Coded here rather than declared in the rule for the same reason as FILE_CHECKS/PROJECT_CHECKS:
 * it needs logic, and a rule from ~/.enigma-guardrails.json must never be able to rewrite a file.
 */
export const FIXERS: Record<string, (line: string, file: string) => string | null> = {
    "fe-name-input-capitalize": (line, file) => {
        if (/autocapitalize/i.test(line)) return null;
        // Only a plain DOM <input>. A custom <Input>/<TextField>/<Controller> may not forward an
        // attribute it does not know, so writing one there would clear the rule while leaving the
        // field exactly as broken - the one outcome worse than reporting it.
        const tags = line.match(/<input\b/gi);
        if (!tags || tags.length !== 1) return null; // two inputs on one line: which one is ambiguous
        // JSX wants the DOM property casing; every other target takes the HTML attribute.
        const attr = /\.[jt]sx$/i.test(file) ? "autoCapitalize=\"words\"" : "autocapitalize=\"words\"";
        // Inserted straight after the tag name: valid wherever the tag is, and it needs no guess
        // about where the tag ENDS (it may well end several lines further down).
        return line.replace(/<input\b/i, `<input ${attr}`);
    },
    "fe-truncated-value-unreachable": (line, file) => {
        if (!/\.[jt]sx$/i.test(file)) return null; // the JSX attribute form only
        if (/title\s*=/.test(line)) return null;
        const tags = line.match(/<[a-z][a-z0-9]*\b/g);
        if (!tags || tags.length !== 1) return null; // two elements on one line: which one is ambiguous
        const match = CLIPPED_SIMPLE_VALUE.exec(line);
        if (!match) return null;
        const [, tag, attrs, expr] = match;
        // The clip must be on THIS element. A neighbour's `truncate` in the same line would
        // otherwise put the title on the wrong box.
        if (!CLIP_ONE_LINE.test(attrs!) || NOT_TEXT_BINDING.test(expr!)) return null;
        // A replacer FUNCTION, never a string: the replacement is built out of the file's own
        // source, so a `$&`, `` $` ``, `$'` or `$$` anywhere in the attributes or the expression
        // would otherwise be re-read by String.prototype.replace as a substitution token and splice
        // the wrong text in - a silent repair that corrupts the line it was meant to fix.
        const replacement = `<${tag}${attrs} title={${expr}}>`;
        return line.replace(`<${tag}${attrs}>`, () => replacement);
    },
};

/**
 * Apply every available fixer to a file's findings and re-check it. Returns what was fixed and
 * the findings that remain (re-derived from the file on disk, so a fixer that did not actually
 * clear its finding is reported rather than trusted).
 *
 * `stage` is what the re-check runs at, and it is why a DIFF-stage rule can carry a fixer at all:
 * re-checking at the edit stage would drop every diff-stage finding from `remaining`, reporting a
 * failed repair as a success. The caller decides which findings to hand over - the post-edit hook
 * passes a diff-stage finding only when it sits on a line that differs from HEAD, so a repair
 * never rewrites code the agent did not just write.
 */
export function applyFixes(file: string, findings: Finding[], stage: Stage = "edit"): { fixed: Finding[]; remaining: Finding[]; } {
    const fixable = findings.filter((f) => f.line && FIXERS[f.ruleId]);
    if (!fixable.length) return { fixed: [], remaining: findings };
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return { fixed: [], remaining: findings }; }
    const lines = content.split("\n");
    const fixed: Finding[] = [];
    for (const f of fixable) {
        const idx = f.line! - 1;
        const before = lines[idx];
        if (before === undefined) continue;
        const after = FIXERS[f.ruleId]!(before, file);
        if (after === null || after === before) continue;
        lines[idx] = after;
        fixed.push(f);
    }
    if (!fixed.length) return { fixed: [], remaining: findings };
    try { writeFileSync(file, lines.join("\n")); }
    catch { return { fixed: [], remaining: findings }; } // read-only file: report instead of fixing
    // The write has already happened, so the re-check is not allowed to discard what it recorded.
    // A hand-authored rule is user input reaching this path - a bad glob throws straight out of
    // checkFile - and letting that unwind would leave the file rewritten on disk with `fixed` lost:
    // no announcement, no ledger row, a working tree silently different from what the agent wrote.
    try { return { fixed, remaining: checkPath(file, stage) }; }
    catch { return { fixed, remaining: [] }; }
}

/** The child_process functions that start a process (and so can create a console window). */
const SPAWNERS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

/**
 * Local names a file binds to a process-spawning child_process function, covering both
 * `import { spawn } from "node:child_process"` and `const { spawn } = require("child_process")`,
 * and renames (`spawnSync as run` is tracked as `run`). Everything else the module exports is
 * ignored, which is what keeps `regex.exec` and `db.exec` out of the scan.
 */
function spawnerBindings(content: string): string[] {
    const names = new Set<string>();
    const stmt = /(?:import|(?:const|let|var))\s*\{([^}]*)\}\s*(?:from\s*|=\s*require\(\s*)["'](?:node:)?child_process["']/g;
    for (const m of content.matchAll(stmt)) {
        for (const part of m[1]!.split(",")) {
            const [orig, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
            if (orig && SPAWNERS.has(orig)) names.add(alias || orig);
        }
    }
    return [...names];
}

/**
 * Process-spawning calls whose inline options object omits `windowsHide`. On Windows a child
 * console application spawned from a process without a console of its own (a daemon, a hook, a
 * detached background task) pops a visible console window; `windowsHide: true` suppresses it.
 *
 * Precision (the reason this is code and not a regex): the call is read by BALANCING PARENS, so
 * an options object spread over several lines is judged as a whole rather than line by line, and
 * three shapes are deliberately not flagged because the file does not prove a defect -
 *   - `stdio: "inherit"`: the child runs in the user's own terminal on purpose;
 *   - options passed as a variable (`spawn(bin, args, opts)`, no inline object): unknowable here;
 *   - an object that spreads another (`{ ...spawnOpts, env }`): the spread may carry the flag.
 * An `enigma:` note inside the call is the explicit escape hatch (e.g. a deliberately visible
 * terminal). Only calls to bindings actually imported from child_process are considered, which
 * is what keeps `regex.exec(...)` and `db.exec(...)` out of the results.
 */
export function missingWindowsHide(content: string): { line: number; detail: string; }[] {
    const names = spawnerBindings(content);
    if (names.length === 0) return [];
    const out: { line: number; detail: string; }[] = [];
    const call = new RegExp(`(?<![.\\w$])(${names.join("|")})\\s*\\(`, "g");
    for (const m of content.matchAll(call)) {
        let i = m.index + m[0].length;
        for (let depth = 1; i < content.length && depth > 0; i++) {
            if (content[i] === "(") depth++;
            else if (content[i] === ")") depth--;
        }
        // Read to the end of the closing line too, so a trailing `// enigma:` note counts.
        const eol = content.indexOf("\n", i);
        const text = content.slice(m.index, eol === -1 ? content.length : eol);
        if (/windowsHide|enigma:|"inherit"|'inherit'/.test(text)) continue;
        if (!text.includes("{")) continue;                 // options come from a variable, if at all
        if (/\{[^{}]*\.\.\.[A-Za-z_$]/.test(text)) continue; // spread may already carry it
        out.push({ line: content.slice(0, m.index).split("\n").length, detail: m[1]! });
    }
    return out;
}

// --- optimistic UI: a reversible mutation that waits for the server -------------------

/** An awaited call that CHANGES server state, in the shapes a UI file actually writes. */
const MUTATING_REQUEST = /method:\s*["'`](POST|PUT|PATCH|DELETE)|\b(?:axios|api|\$fetch|http|client)\.(?:post|put|patch|delete)\s*\(/i;

/**
 * A write of the ENTITY the mutation is about: drop it from the list, patch it in place, or flip
 * its flag. Chrome flags (`setSaving(false)`, `setOpen(false)`) are deliberately NOT this shape -
 * every handler has them, including the ones that legitimately wait for the server, so counting
 * them was what produced every false positive in the first measurement.
 */
const ENTITY_WRITE = /\bset[A-Z]\w*\s*\(\s*(?:\(?\w+\)?\s*=>\s*)?[\w.]*\.(?:filter|map|slice|concat)\s*\(|\bset[A-Z]\w*\s*\(\s*!/;

/**
 * Evidence the file already applies an optimistic update and can undo it.
 *
 * The undo half is matched as CODE, not as a word: bare `rollback|revert` also matched
 * `rollbackMigration`, `revertChanges`, a `revert` class name or a comment, and any one of those
 * silently turned the rule off for every mutation in the file. Requiring a call or a known option
 * name keeps the mitigation meaningful while still clearing a real implementation.
 */
const OPTIMISTIC_SIGNAL = /useOptimistic|onMutate|optimisticData|setQueryData|rollbackOnError|\brollback\s*[(:]|\brevert\s*[(:]|previous[A-Z_]/;

/**
 * The escape hatch, and it is scoped to the HANDLER rather than the file. The rule's message tells
 * the model to mark the line, so honouring the marker file-wide would silence every other mutation
 * in the same component - a wider exemption than the one that was asked for, granted silently.
 */
const ALLOW_SERVER_FIRST = /enigma:allow-server-first/;

/** The binding an awaited call's result was assigned to (`const updated = await ...`), if any. */
const RESULT_BINDING = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?/;

/** How far the block scan looks in each direction, so a pathological file cannot stall the hook. */
const BLOCK_LOOKBACK = 120;
const BLOCK_LOOKAHEAD = 200;

/**
 * The innermost brace block containing `index`, found by balancing outwards from that line.
 *
 * Both scans stop on an EXPLICIT flag, never on `start !== index`. A one-line handler opens (or
 * closes) its block on the flagged line itself, where the positional test never trips: the scan
 * then ran on and snapped to an outer block, and the forward window could stretch the whole
 * BLOCK_LOOKAHEAD past the handler - attributing an unrelated state write to this call, which for
 * a blocking rule is a false positive with a real cost.
 */
function enclosingBlock(lines: string[], index: number): { start: number; end: number; } {
    let depth = 0;
    let start = index;
    let foundStart = false;
    for (let i = index; i >= 0 && index - i < BLOCK_LOOKBACK && !foundStart; i--) {
        const line = lines[i]!;
        for (let c = line.length - 1; c >= 0; c--) {
            if (line[c] === "}") depth++;
            else if (line[c] === "{") {
                if (depth === 0) { start = i; foundStart = true; break; }
                depth--;
            }
        }
    }
    depth = 0;
    let end = index;
    let foundEnd = false;
    for (let i = start; i < lines.length && i - start < BLOCK_LOOKAHEAD && !foundEnd; i++) {
        for (const ch of lines[i]!) {
            if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) { end = i; foundEnd = true; break; }
            }
        }
    }
    return { start, end: Math.max(end, index) };
}

/**
 * Handlers that change server state and only then touch the UI - the row is dropped, or the flag
 * flipped, AFTER the round trip - with nothing optimistic anywhere in the file.
 *
 * Three conditions make it precise, and each one removed a measured class of false positive:
 * the state write must be an ENTITY write and not a chrome flag; it must not consume the awaited
 * call's own result (a value only the server can produce cannot be applied before the call, so
 * `setPref(updated)` is correct code); and no entity write may precede the call, which is what an
 * already-optimistic handler looks like. Measured over 2762 UI files / 386 mutating request sites
 * of real product repositories: 5 findings, every one the same genuine shape (delete a row, wait,
 * then filter it out of the list), 0 false positives.
 *
 * The `absent`-style exclusion is applied HERE rather than on the rule because checkFile only
 * honours `absent` for pattern rules - a fileCheck owns its own mitigation test.
 */
export function serverFirstMutation(content: string): { line: number; detail: string; }[] {
    if (OPTIMISTIC_SIGNAL.test(content)) return [];
    const lines = content.split("\n");
    const out: { line: number; detail: string; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (COMMENT_LINE.test(line) || !MUTATING_REQUEST.test(line)) continue;
        const { start, end } = enclosingBlock(lines, i);
        if (lines.slice(start, end + 1).some((l) => ALLOW_SERVER_FIRST.test(l))) continue;
        if (lines.slice(start, i).some((l) => ENTITY_WRITE.test(l))) continue;
        // The result binding may sit a few lines above the flagged line, since the options object
        // a request is written with routinely puts `method:` below the call it belongs to.
        let binding = "";
        for (let b = i; b >= Math.max(0, i - 4) && !binding; b--) binding = RESULT_BINDING.exec(lines[b]!)?.[1] ?? "";
        const uses = binding ? new RegExp(`\\b${binding}\\b`) : null;
        const write = lines.slice(i + 1, end + 1).find((l) => {
            if (COMMENT_LINE.test(l)) return false;
            const at = ENTITY_WRITE.exec(l);
            if (!at) return false;
            // The response only excuses the wait when its value FLOWS INTO the update, so the test
            // is on the setter's argument alone. `if (res.ok) setItems(...)` uses the response as a
            // GUARD - the update still waits for the round trip, which is the defect itself - and
            // testing the whole line read that as legitimate and let it through.
            return !uses?.test(l.slice(at.index));
        });
        if (write) out.push({ line: i + 1, detail: `the UI is only updated after the request resolves: ${write.trim().slice(0, 80)}` });
    }
    return out;
}

// --- textarea: the one input the user can resize ---------------------------------------

/** A real DOM textarea. Case-SENSITIVE: a capitalised <Textarea> is a component whose own file owns the bounds. */
const TEXTAREA = /<textarea\b/;

/** A lower bound on the height: the rows attribute, an explicit minimum, or a fixed height. */
const TEXTAREA_LOWER = /\brows\s*=|\brows:\s*\d|min-h-|min-height|minHeight|\bh-\[|\bh-\d|height\s*:\s*\d/;

/** An upper bound, in the dialects a project writes it in. */
const TEXTAREA_UPPER = /max-h-|max-height|maxHeight/;

/** The element cannot be dragged, so its rows or height already fix its size. */
const TEXTAREA_FIXED = /resize-none|resize\s*:\s*none/;

/** It grows with its CONTENT, so an upper bound is needed even when it cannot be dragged. */
const TEXTAREA_AUTOSIZE = /field-?sizing|scrollHeight|autosize|auto-size|TextareaAutosize|textarea-autosize/i;

/**
 * Textareas with no floor or no ceiling on their size.
 *
 * Both bounds are read from the WHOLE file, deliberately: the fix that scales is one rule on the
 * shared component or one base stylesheet rule, and a check that kept firing after that fix would
 * train the model to ignore it. `resize-none` clears only the CEILING, and only when nothing in the
 * file autosizes - an element that cannot be dragged and does not grow is already bounded by its
 * rows, while one that grows with its content is not.
 *
 * MEASURED over a 2762-file UI corpus, 38 files of which hold a lowercase <textarea>: 17 sites in
 * 12 files carry no upper bound, every one a genuine resizable textarea, and 0 carry no lower bound
 * - so the ceiling half has a real backlog, which is what puts the rule at the diff stage, while the
 * floor half is a scaffolding guard that only fires on a bare <textarea> written from now on.
 */
export function textareaSizeBounds(content: string): { line: number; detail: string; }[] {
    const lower = TEXTAREA_LOWER.test(content);
    const upper = TEXTAREA_UPPER.test(content);
    const fixed = TEXTAREA_FIXED.test(content) && !TEXTAREA_AUTOSIZE.test(content);
    if (lower && (upper || fixed)) return [];
    const out: { line: number; detail: string; }[] = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (COMMENT_LINE.test(line) || /enigma:/.test(line) || !TEXTAREA.test(line)) continue;
        const missing: string[] = [];
        if (!lower) missing.push("no minimum size: no rows, min-height or fixed height");
        if (!upper && !fixed) missing.push("no maximum size: no max-height, and it can be dragged or grows with its content");
        if (missing.length) out.push({ line: i + 1, detail: missing.join("; ") });
    }
    return out;
}

/**
 * A whole-component early return that swaps the entire render for a placeholder:
 * `if (!data) return <XSkeleton />`, `if (loading) return <Loading />`. The returned element must
 * be named for a placeholder - that is what separates a loading branch from an empty state or a
 * permission gate, neither of which this rule is about.
 */
const VIEW_GUARD = /\bif\s*\(\s*(!?\s*[\w.]{1,30}(?:\s*(?:===|!==|==|!=)\s*[\w."']{1,20})?)\s*\)\s*return\s+<\s*\w*(Skeleton|Placeholder|Shimmer|Loading|Loader|Spinner)\b/;

/** The names a value carries when it holds the response that has not arrived yet. */
const LOADING_NAME = "loading|pending|fetching|data|resource|result|state|profile|items|rows|list|summary|overview|response";

/** The subset that names the WAIT itself, so it carries meaning as the right-hand side of a comparison. */
const LOADING_VALUE = "loading|pending|fetching";

/**
 * The guarded value, as the conditions that actually mean "the data is not here yet" are written.
 * A guard on anything else (a permission flag, a feature toggle, a selected id) is a different
 * branch and is deliberately not matched.
 *
 * Three forms, and no more: the bare flag (`isLoading`, `!data`), the react-query / SWR status
 * comparison (`status === "loading"`, `query.status === "pending"`), and a dotted read whose LAST
 * segment is one of the names above (`!query.data`). The comparison is accepted only when the
 * compared VALUE is a loading word, which is what keeps `role === "admin"` out. The input is the
 * condition with its whitespace already stripped.
 */
const VIEW_GUARD_LOADING = new RegExp(`^(?:!?(?:\\w{1,30}\\.)*(?:is)?(?:${LOADING_NAME})|(?:\\w{1,30}\\.)*\\w{1,30}(?:===|!==|==|!=)["']?(?:${LOADING_VALUE})["']?)$`, "i");

/** Chrome that is drawn from the component itself and never needed the response. */
const VIEW_CHROME_HEADING = /<\s*(h1|h2|h3|CardTitle|DialogTitle|PageHeader|SheetTitle|SectionTitle)\b/;

/** A literal text node - copy the component ships regardless of what the request returns. */
const VIEW_CHROME_TEXT = />\s*[A-Z][A-Za-z0-9 ,.'&:%/()-]{2,60}\s*</;

/** How far the body scan runs before giving up, so a pathological file cannot stall the hook. */
const VIEW_BODY_LOOKAHEAD = 400;

/** The marker, scoped to the guard's own block rather than to the file (the fe-server-first precedent). */
const ALLOW_VIEW_SKELETON = /enigma:allow-view-skeleton/;

/**
 * Whether an escape-hatch marker covers the flagged line. Scoped, never file-wide: a file-wide test
 * lets one marked guard silently exempt every other one in the same file, the lesson
 * fe-server-first-mutation already paid for. The window is the enclosing block extended one line up,
 * because "mark the line" is written either on the line itself or on the comment above it, and a
 * guard at top level has no block to carry the marker.
 */
function markedNearby(lines: string[], index: number, marker: RegExp): boolean {
    const { start, end } = enclosingBlock(lines, index);
    return lines.slice(Math.max(0, Math.min(start, index - 1)), end + 1).some((line) => marker.test(line));
}

/** fe-skeleton-loading's own pair, compiled once, to recognise the line that rule already owns. */
const SKELETON_GUARD = new RegExp(SKELETON_GUARD_SRC);
const SKELETON_SIGNAL = new RegExp(SKELETON_SIGNAL_SRC, "i");

/**
 * Views that replace themselves with placeholders while their data loads.
 *
 * The defect is the SCOPE of the guard, not the placeholder: a component that early-returns is
 * blanking everything it renders, including the parts that never depended on the request. So the
 * check reads the body BELOW the guard and reports it only when that body draws chrome of its own -
 * a heading or title element, or two literal text nodes. A loader component whose entire output is
 * built from the awaited value (`return <Inner {...data} />`, two children fed from `data`) has
 * neither, and is correctly left alone: there the region and the component are the same thing.
 *
 * A line fe-skeleton-loading would report is skipped here: that rule owns the `null` / bare-loader
 * return in a file with no placeholder signal at all, and reporting it twice would put two BLOCK
 * findings with two different messages on one line for one fix. When the file DOES carry a
 * placeholder signal the older rule is cleared by its own `absent`, so this one reports it and the
 * shape is covered exactly once either way.
 *
 * PRE-WIDENING MEASUREMENT over 7195 UI files of real product repositories, taken before the
 * condition set was widened to the status comparison and the dotted read: 25 placeholder guards, 13
 * findings, every one a genuine view (a settings page blanked for two strings, a dashboard blanked
 * for its tiles, three route components blanked below their own <h1>), 0 false positives. Skipping
 * comment lines is load-bearing - three of the corpus hits are commented-out guards. RE-MEASURED
 * after the widening and the fe-skeleton-loading suppression, over 7199 files: 10 findings, still 0
 * false positives (see docs/notes/guardrails.md for the full breakdown).
 */
export function viewBlankedWhileLoading(content: string): { line: number; detail: string; }[] {
    const lines = content.split("\n");
    const owned = !SKELETON_SIGNAL.test(content);
    const out: { line: number; detail: string; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (COMMENT_LINE.test(line) || /enigma:/.test(line)) continue;
        const match = VIEW_GUARD.exec(line);
        if (!match || !VIEW_GUARD_LOADING.test(match[1]!.replace(/\s+/g, ""))) continue;
        if (owned && SKELETON_GUARD.test(line)) continue;
        if (markedNearby(lines, i, ALLOW_VIEW_SKELETON)) continue;
        let headings = 0;
        let texts = 0;
        for (let j = i + 1; j < lines.length && j - i < VIEW_BODY_LOOKAHEAD; j++) {
            const body = lines[j]!;
            if (/^\}/.test(body)) break; // the component's own closing brace, at column 0
            if (COMMENT_LINE.test(body)) continue;
            if (VIEW_CHROME_HEADING.test(body)) headings++;
            if (VIEW_CHROME_TEXT.test(body)) texts++;
        }
        // One heading is enough (a title is chrome by definition); a single stray text node is not,
        // since it can sit inside a branch that genuinely needed the data.
        if (headings < 1 && texts < 2) continue;
        const drawn = [headings ? `${headings} heading/title element(s)` : "", texts ? `${texts} literal text node(s)` : ""].filter(Boolean).join(" and ");
        out.push({ line: i + 1, detail: `the component still draws ${drawn} below this guard, none of which needs the response` });
    }
    return out;
}

/**
 * Single-line clipping, in the dialects a project writes it in. `line-clamp` is deliberately NOT
 * here: a two-line clamp is body copy, and a tooltip on a paragraph is not the convention.
 */
const CLIP_ONE_LINE = /\btruncate\b|\btext-ellipsis\b|text-overflow\s*:\s*ellipsis/;

/**
 * A JSX/template child that is an expression: the element renders a value, not fixed copy.
 *
 * The `>` must CLOSE A TAG, which is what the lookbehind is for. Without it the pattern also
 * matched an arrow function's `=> {`, so any line holding the identifier `truncate` next to a
 * callback body - `const truncate = (s, n) => { ... }`, `useMemo(() => { ... truncate ... })` -
 * became a block finding on code that clips nothing, and the fixer correctly declined it, leaving
 * the turn denied with no exit but a marker. The excluded characters are every operator that ends
 * in `>`: `=>`, `<=`, `>=`, `!=`, `-->`, `>>`.
 *
 * And the brace must open a VALUE. SVELTE - and only Svelte - spells control flow in the same
 * braces (`{#if}`, `{#each}`, `{/if}`, `{:else}`, `{@html}`); Astro is named alongside it in most
 * accounts of this, wrongly, since its template is JSX-expression based (`{cond && <p/>}`,
 * `{list.map(...)}`) and its control features are attribute directives (`set:html`, `client:load`,
 * `is:raw`). The rule matches `.svelte` while the fixer declines every file that is not
 * `.jsx`/`.tsx`, so a block opener read as a rendered value was the arrow-function false positive
 * again, one dialect over: a denied turn with no repair available. `/` is the one sigil that is not
 * Svelte-only - it also opens a JSX COMMENT child (`>{/*`), which is no more a value than a control
 * block is. The sigils are excluded rather than the constructs, because a sigil is never the first
 * character of an expression.
 */
const DYNAMIC_CHILD = /(?<![=!<>-])>\s*\{(?![#/:@])/;

/** Any way the full value stays reachable: the native tooltip, an accessible name, or a tooltip component. */
const VALUE_REACHABLE = /\btitle\s*=|aria-label\s*=|<\s*Tooltip|TooltipTrigger|data-tooltip|hoverCard|HoverCard/i;

/** How far above the clipping line a wrapper may carry the tooltip. */
const WRAPPER_LOOKBACK = 4;

/** The marker, scoped to the clipping element's own block rather than to the file (the fe-server-first precedent). */
const ALLOW_CLIPPED_VALUE = /enigma:allow-clipped-value/;

/**
 * Values clipped to an ellipsis with the full string reachable nowhere.
 *
 * This is the one slice of variable-length text with a file-local signature, and text-overflow.md
 * records why the rest has none: the layout defect ("the name pushes the card open", "the button is
 * squashed") is a RELATION between an ancestor's overflow and a child's, so a rule written for it
 * flags correct markup - one was, and it was deleted after a browser measurement. Clipping is
 * different. The element that clips is the element that hides the value, so whether the user can
 * still read it is decided by that element and the wrapper immediately above it.
 *
 * THE CORPUS MEASUREMENT LIVES IN text-overflow.md AND IS DELIBERATELY NOT RESTATED HERE - not the
 * composition, the two widths and their per-extension splits, the findings, the fixer's share, nor
 * the sigil differential. Keeping three prose copies of one figure set in agreement is what let two
 * of them drift, so the note is the one place a number is added or corrected. What a reader of this
 * code needs from it is the ORDER OF MAGNITUDE: 88% of the corpus lines that clip a dynamic value
 * hide it with the full string reachable nowhere. That is the DEFAULT in real code rather than an
 * occasional slip, which is what puts the rule at the diff stage - an edit-stage rule would report
 * a project's existing rows on any unrelated edit to their files, forever - and what makes the
 * FIXER rather than the message the thing that pays for it, since it repairs four in five of them
 * with no message, no turn and no tokens.
 *
 * TWO WARNINGS ABOUT MEASURING IT, both paid for here. (1) A corpus scan measures VOLUME and cannot
 * validate correctness: BOTH false positives above removed zero corpus findings, and both had to be
 * found by PROBING - so a corpus count can never be the thing that clears a pattern change. (2)
 * NEVER MIX THE TWO WIDTHS. CLIP_ONE_LINE also matches the identifier `truncate`, its call sites,
 * static copy and CSS, none of which render a value, so both halves of that 88% have to be measured
 * through DYNAMIC_CHILD - counting the denominator at the wider width understates it to 43%. Every
 * figure in the note comes from ONE run over ONE file set and states the width it was taken at.
 */
export function truncatedValueUnreachable(content: string): { line: number; detail: string; }[] {
    const lines = content.split("\n");
    const out: { line: number; detail: string; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (COMMENT_LINE.test(line) || /enigma:/.test(line)) continue;
        if (!CLIP_ONE_LINE.test(line) || !DYNAMIC_CHILD.test(line)) continue;
        if (VALUE_REACHABLE.test(line)) continue;
        // A Tooltip or a titled wrapper routinely sits a few lines above the element it describes.
        if (lines.slice(Math.max(0, i - WRAPPER_LOOKBACK), i).some((l) => VALUE_REACHABLE.test(l))) continue;
        // Scoped, like the two sibling rules. The flagged line is a JSX/template CHILD, where a
        // trailing `//` comment renders as visible text - so same-line-only left this rule's single
        // exit almost unwritable.
        if (markedNearby(lines, i, ALLOW_CLIPPED_VALUE)) continue;
        out.push({ line: i + 1, detail: "the value is ellipsised here and its full text is carried by nothing on this element or its wrapper" });
    }
    return out;
}

/**
 * A lowercase DOM element whose ENTIRE child is one member expression - the shape the fixer can
 * copy into a `title`. Group 1 is the tag, reused as a backreference so the closing tag must match.
 */
const CLIPPED_SIMPLE_VALUE = /<([a-z][a-z0-9]*)\b([^<>]*)>\s*\{\s*([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\s*\}\s*<\/\1>/;

/**
 * Bindings whose value is not text: `title={children}` renders [object Object]. The dotted branch
 * carries the same names as the bare one - `{row.content}` is a ReactNode for exactly the reason
 * `{content}` is, and a title written from it is worse than the finding it cleared.
 */
const NOT_TEXT_BINDING = /^(children|icon|node|element|content|component)$|\.(children|icon|node|element|content|component)$/i;

/** An async server route component: the function whose await the router waits on. */
const ASYNC_ROUTE = /export\s+default\s+async\s+function\b/;

/**
 * A DYNAMIC read awaited in that component. Restricted to database and ORM calls on purpose: an
 * awaited `fetch` is as often a build-time CMS or docs read, where there is no runtime wait to
 * hide, and including it was what made the earlier attempt at this rule imprecise.
 */
const SERVER_DATA_AWAIT = /await\s+(prisma|db|supabase|drizzle|knex|mongoose)\b|await\s+[\w.]{1,40}\.(findMany|findUnique|findFirst|aggregate|groupBy|count|createQueryBuilder)\s*\(/;

/** A streaming boundary declared in the file itself. */
const STREAM_BOUNDARY = /<\s*Suspense\b/;

/** The marker, scoped to the awaiting block rather than to the file (the fe-server-first precedent). */
const ALLOW_BLOCKING_PAGE = /enigma:allow-blocking-page/;

/** A route's own `loading.tsx`, in every extension Next accepts for it. */
const LOADING_BOUNDARY_FILE = /^loading\.(jsx?|tsx)$/;

/**
 * Async route components that await their data with no streaming boundary anywhere above them.
 *
 * The boundary is a property of the SEGMENT, not of the file: Next applies the nearest `loading.tsx`
 * at or above the route, so the check walks up to the app directory before reporting. That walk is
 * load-bearing - 7 of the 11 measured candidates are covered by an ancestor `loading.tsx` and a
 * sibling-only test would have reported every one of them. It is also the only DISK read in the
 * engine, so it runs last, once the content has already produced a finding: a route with no awaited
 * query pays nothing for it.
 *
 * Every awaited query is reported, not just the first. The turn-end sweep keeps only findings
 * anchored to a line the change ADDED, so a single anchor on a pre-existing await made the rule
 * silent on exactly the case it is for - a route that gains a second blocking query.
 */
export function pageAwaitWithoutBoundary(content: string, file: string): { line: number; detail: string; }[] {
    if (/^\s*["']use client["']/m.test(content)) return [];
    if (!ASYNC_ROUTE.test(content)) return [];
    const lines = content.split("\n");
    // A COMMENTED-OUT <Suspense> is not a boundary, and clearing the rule on one would let the
    // finding be dismissed by pasting the fix into a comment.
    if (lines.some((l) => !COMMENT_LINE.test(l) && STREAM_BOUNDARY.test(l))) return [];
    const out: { line: number; detail: string; }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (COMMENT_LINE.test(line) || /enigma:/.test(line) || !SERVER_DATA_AWAIT.test(line)) continue;
        if (markedNearby(lines, i, ALLOW_BLOCKING_PAGE)) continue;
        out.push({ line: i + 1, detail: "the route awaits this query before it returns any markup, and neither a loading.tsx in the segment chain nor a <Suspense> boundary lets the shell paint first" });
    }
    if (!out.length || nearestLoadingBoundary(file)) return [];
    return out;
}

/**
 * Whether a `loading.tsx` covers this route, at its own segment or any ancestor up to the app root.
 *
 * Bounded by the PROJECT: without that bound the walk stopped only at an `app`/`pages`/`src` segment
 * or the filesystem root, so a route with no such ancestor read the worktree's parent, the home
 * directory and the drive root - and a stray `loading.tsx` in any of them silently cleared a BLOCK
 * rule for a route in a different repository.
 */
function nearestLoadingBoundary(file: string): boolean {
    const root = findProjectRoot(file);
    let dir = dirname(resolve(file));
    for (let i = 0; i < 20; i++) {
        try {
            if (readdirSync(dir).some((name) => LOADING_BOUNDARY_FILE.test(name))) return true;
        } catch { return false; }
        // No project root means no bound to walk within, so the route's own segment is all that is read.
        if (!root || dir === root || /[\\/](app|pages|src)$/.test(dir)) return false;
        const parent = dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
    return false;
}

// --- TypeScript module graph: path aliases and import specifiers ----------------------
//
// Three rules share this block. What they have in common is that none of them can be decided
// from the edited line alone: whether a `.js` in a specifier is required, whether an alias
// exists to import through, and where that alias points are all properties of the project's
// tsconfig, which is why they are coded checks rather than rule patterns.

/**
 * Any module specifier the file imports: `from "x"`, a bare `import "x"`, `import("x")`,
 * `require("x")`. The static forms are ANCHORED at the start of a line, which is what keeps an
 * import statement written as DATA out of the results - a test, a codemod or a generator holds
 * `'import { a } from "./a.js"'` inside a string literal, and an unanchored `from` matched it.
 * `[^;]*?` still crosses newlines, so a brace list spread over several lines is one statement.
 */
const SPECIFIER = /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']/gm;

/** Module extensions that never belong in a specifier when the bundler resolves the import. */
const MODULE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** The half of MODULE_EXT that can legitimately name a real file: a JS module imported from TS. */
const JS_EXT = /\.(js|jsx|mjs|cjs)$/i;

/** tsconfig.json lookups are repeated for every file in a directory, so the read is cached per dir. */
const tsconfigCache = new Map<string, { dir: string; text: string; } | null>();

/**
 * The nearest tsconfig.json at or above a file, with its directory. Read as TEXT, never parsed:
 * a real tsconfig carries comments and trailing commas, so JSON.parse would throw on exactly the
 * hand-written files this has to read. Every consumer below matches a specific key instead.
 */
function nearestTsconfig(file: string): { dir: string; text: string; } | null {
    let dir = dirname(resolve(file));
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
        const cached = tsconfigCache.get(dir);
        if (cached !== undefined) {
            for (const d of seen) tsconfigCache.set(d, cached);
            return cached;
        }
        seen.push(dir);
        const candidate = join(dir, "tsconfig.json");
        if (existsSync(candidate)) {
            let found: { dir: string; text: string; } | null = null;
            try { found = { dir, text: readFileSync(candidate, "utf8") }; } catch { found = null; }
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

/** The `@/*` -> `./src/*` alias a tsconfig declares, as an absolute root and the prefix to write. */
function pathAlias(cfg: { dir: string; text: string; }): { prefix: string; root: string; } | null {
    const m = /["']([^"']+)\/\*["']\s*:\s*\[\s*["']([^"']+)\/\*["']/.exec(cfg.text);
    if (!m) return null;
    const baseUrl = /["']baseUrl["']\s*:\s*["']([^"']+)["']/.exec(cfg.text)?.[1] ?? ".";
    return { prefix: m[1]!, root: resolve(cfg.dir, baseUrl, m[2]!) };
}

/** Every import specifier in a file, skipping the ones sitting on a comment or `enigma:` line. */
function specifiers(content: string): { spec: string; line: number; }[] {
    const lines = content.split("\n");
    const out: { spec: string; line: number; }[] = [];
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

/**
 * Relative specifiers carrying a module extension, in a project whose resolution is `bundler` or
 * `preserve`. The resolution mode is the whole precision story: under `node16`/`nodenext` - and
 * under plain Node ESM, which is what a `node`/`node10` project emitting ESM actually runs on -
 * the extension is REQUIRED, so flagging it there would be flagging correct code. Measured over
 * the reference corpus: 1448 extension-carrying specifiers live in such projects and are
 * deliberately left alone, against 99 in bundler-resolution projects where every one is noise.
 *
 * The second guard is the file system, and it applies to a JS extension ONLY: `./legacy.js` is
 * correct when a real `legacy.js` sits there (a JS module imported from TS under allowJs), so a
 * specifier resolving to a file that exists is not flagged. A TypeScript extension gets no such
 * pass - the source file always exists under its own name, so the check would never fire, and
 * `./thing.ts` is the shape that needs allowImportingTsExtensions and breaks on the day the
 * project emits.
 */
export function extensionImports(content: string, file: string): { line: number; detail: string; }[] {
    const cfg = nearestTsconfig(file);
    if (!cfg || !/["']module(?:Resolution)?["']\s*:\s*["'](?:bundler|preserve)["']/i.test(cfg.text)) return [];
    const dir = dirname(resolve(file));
    const out: { line: number; detail: string; }[] = [];
    for (const { spec, line } of specifiers(content)) {
        if (!/^\.\.?\//.test(spec) || !MODULE_EXT.test(spec)) continue;
        if (JS_EXT.test(spec) && existsSync(resolve(dir, spec))) continue; // really is a JS file
        out.push({ line, detail: `"${spec}" -> "${spec.replace(MODULE_EXT, "")}"` });
    }
    return out;
}

/**
 * Specifiers climbing two or more directories in a project that declares a path alias covering
 * the target. Both halves are required: the climb alone is correct code in a project with no
 * alias to use instead, and an alias that does not cover the target (a file outside the aliased
 * root) cannot be written any other way. Tests are excluded by the rule, because a runner that
 * has not been told about the alias (jest without moduleNameMapper) would fail to resolve it.
 */
export function deepRelativeImports(content: string, file: string): { line: number; detail: string; }[] {
    const cfg = nearestTsconfig(file);
    const alias = cfg && pathAlias(cfg);
    if (!alias) return [];
    const dir = dirname(resolve(file));
    const out: { line: number; detail: string; }[] = [];
    for (const { spec, line } of specifiers(content)) {
        if (!/^(?:\.\.\/){2,}/.test(spec)) continue;
        const target = resolve(dir, spec);
        const rel = target.slice(alias.root.length + 1).replace(/\\/g, "/");
        if (!target.startsWith(`${alias.root}${sep}`) || !rel) continue; // outside the aliased root
        out.push({ line, detail: `"${spec}" -> "${alias.prefix}/${rel}"` });
    }
    return out;
}

/**
 * A tsconfig.json that declares no path alias. Two guards keep it to the files where an alias is
 * actually the answer: a config that `extends` another may inherit `paths` (an accepted false
 * negative - the base is not read), and a config with no source directory beside it has nothing
 * to alias. Only the exact `tsconfig.json` basename is in scope, so the split configs a bundler
 * generates (tsconfig.node.json and friends, which exist to compile one config file) are out.
 */
export function missingPathAlias(content: string, file: string): { line: number; detail: string; }[] {
    if (/["'](?:paths|extends)["']\s*:/.test(content)) return [];
    const dir = dirname(resolve(file));
    const src = ["src", "app", "lib"].find((d) => existsSync(join(dir, d)));
    if (!src) return [];
    const anchor = content.split("\n").findIndex((l) => /["']compilerOptions["']/.test(l));
    return [{ line: anchor === -1 ? 1 : anchor + 1, detail: `no alias for ./${src}` }];
}

/**
 * One named-import statement: an optional default binding, an optional `type` keyword, the brace
 * list (which may span lines - `[^}]` crosses newlines), the specifier, and the rest of the line
 * so a trailing `// enigma:` note is part of the match.
 */
const NAMED_IMPORT = /^import[ \t]+(?:[\w$]+[ \t]*,[ \t]*)?(?:type[ \t]+)?\{([^}]*)\}[ \t]*from[ \t]*["']([^"']+)["'].*$/gm;

/** A module the project owns: relative, a subpath import, or a path alias. */
const INTERNAL_MODULE = /^\.|^#|^[@~]\//;

/**
 * Modules contributing more than `max` named bindings to one file. Counts are aggregated per
 * module across every statement, so two half-sized imports of the same module still add up.
 * A statement carrying an `enigma:` note is a deliberate exception and clears its module.
 */
export function wideNamedImports(content: string, max: number): { line: number; module: string; count: number; }[] {
    const per = new Map<string, { count: number; line: number; allowed: boolean; }>();
    for (const m of content.matchAll(NAMED_IMPORT)) {
        const mod = m[2]!;
        if (!INTERNAL_MODULE.test(mod)) continue;
        const entry = per.get(mod) ?? { count: 0, line: content.slice(0, m.index).split("\n").length, allowed: false };
        entry.count += m[1]!.split(",").filter((s) => s.trim()).length;
        if (m[0].includes("enigma:")) entry.allowed = true;
        per.set(mod, entry);
    }
    return [...per]
        .filter(([, v]) => !v.allowed && v.count > max)
        .map(([module, v]) => ({ line: v.line, module, count: v.count }));
}

/** Merged dependency map (deps + devDeps + optional/peer) of a project's package.json, or null. */
function readPkgDeps(root: string): Record<string, string> | null {
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    } catch { return null; }
}

/**
 * Translate a simple glob to an anchored RegExp (`**` crosses separators, `*` within a
 * segment, `?` one non-separator char; a no-slash glob matches the basename anywhere).
 * enigma: duplicated from guard.ts:globToRegExp on purpose - this engine must stay
 * import-free so dist/guardrails.js runs standalone in any repo. Keep the two in sync.
 */
function globToRegExp(glob: string, ignoreCase = false): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
    return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`, ignoreCase ? "i" : "");
}

/**
 * globToRegExp, memoised. The turn-end sweep runs every rule's globs against every file a change
 * touched, so the same handful of patterns was being recompiled hundreds of times per turn. The
 * compiled form is stateless here (no "g" flag, so no lastIndex), which is what makes it shareable.
 */
const globCache = new Map<string, RegExp>();
function globRe(glob: string, ignoreCase = false): RegExp {
    const key = `${ignoreCase ? "i" : "s"}:${glob}`;
    let re = globCache.get(key);
    if (!re) { re = globToRegExp(glob, ignoreCase); globCache.set(key, re); }
    return re;
}

/** The user-wide guardrails config file (custom rules + disabled built-in ids). ENIGMA_GUARDRAILS_CONFIG relocates it (tests/advanced use). */
function guardrailsConfigPath(): string {
    return process.env.ENIGMA_GUARDRAILS_CONFIG || join(homedir(), ".enigma-guardrails.json");
}

/** A JSON rule entry is usable only if it has the fields its scope needs. */
function isValidRule(r: unknown): r is GuardrailRule {
    const x = r as Partial<GuardrailRule>;
    if (!x || typeof x.id !== "string" || !Array.isArray(x.files) || typeof x.message !== "string") return false;
    if (x.severity !== "block" && x.severity !== "warn") return false;
    if (x.scope === "file") return typeof x.pattern === "string";
    if (x.scope === "project") return typeof x.check === "string";
    return false;
}

/**
 * Effective rule set: the built-ins minus any the user disabled, plus the user's own
 * custom rules. A missing/malformed config just yields the built-ins - a hand-edited
 * file never throws. Self-contained: one best-effort JSON read, no enigma imports.
 */
export function loadRules(): GuardrailRule[] {
    let disabled: string[] = [];
    let custom: GuardrailRule[] = [];
    try {
        const raw = JSON.parse(readFileSync(guardrailsConfigPath(), "utf8"));
        if (Array.isArray(raw.disabled)) disabled = raw.disabled.filter((s: unknown) => typeof s === "string");
        if (Array.isArray(raw.rules)) custom = raw.rules.filter(isValidRule);
    } catch { /* no config -> built-ins only */ }
    const off = new Set(disabled);
    return [...BUILTIN_RULES.filter((r) => !off.has(r.id)), ...custom];
}

/** Nearest ancestor dir of `file` that looks like a project root (package.json / .git / .enigma.json), or null. */
export function findProjectRoot(file: string): string | null {
    let dir = dirname(resolve(file));
    for (let i = 0; i < 40; i++) {
        const isProj = existsSync(join(dir, "package.json")) || existsSync(join(dir, ".enigma.json"));
        let hasGit = false;
        try { hasGit = statSync(join(dir, ".git")).isDirectory(); } catch { /* none */ }
        if (isProj || hasGit) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Run every applicable rule against one file's content. `projectRoot` may be null (project rules
 * then skip).
 *
 * `stage` decides which rules apply. At "edit" (the post-edit hook and the commit backstop) a
 * diff-stage rule is skipped: it is written for code a change ADDED, and running it over a whole
 * file would report a repository's existing code as a violation of the current turn. At "diff"
 * EVERY rule runs, because the turn-end sweep is also the second chance for anything the model was
 * told about mid-turn and did not fix - including the warnings the post-edit hook can only print.
 *
 * `rules` is passed in by a caller that checks MANY files, so the config file behind loadRules() is
 * read once for the batch instead of once per file.
 */
export function checkFile(file: string, content: string, projectRoot: string | null, stage: Stage = "edit", rules: GuardrailRule[] = loadRules()): Finding[] {
    const norm = file.replace(/\\/g, "/");
    const out: Finding[] = [];
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
            // "X without Y": if the mitigation regex is present anywhere, the rule does not apply.
            if (rule.absent) { try { if (new RegExp(rule.absent, "i").test(content)) continue; } catch { /* bad absent regex: ignore the guard */ } }
            let re: RegExp;
            // `?? "i"` (not `||`) so an explicit flags: "" means case-SENSITIVE (e.g. to tell a
            // lowercase DOM <input> from a capitalized <Input> component); undefined -> "i".
            try { re = new RegExp(rule.pattern, (rule.flags ?? "i").replace(/g/g, "")); } catch { continue; }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                // Skip comment lines so a pattern mentioned in a comment never false-positives
                // (covers //, #, *, /* JSDoc, -- SQL, <!-- HTML - the common line-comment prefixes).
                if (COMMENT_LINE.test(lines[i]!)) continue;
                if (re.test(lines[i]!)) out.push({ ...base, line: i + 1 });
            }
        } else if (rule.scope === "project" && rule.check && projectRoot) {
            const check = PROJECT_CHECKS[rule.check];
            if (check && check(projectRoot)) out.push({ ...base });
        }
    }
    return out;
}

/** Format findings as a compact, model-facing block. */
export function formatFindings(findings: Finding[]): string {
    return findings.map((f) => {
        const tag = f.severity === "block" ? "MUST FIX" : "SUGGESTED";
        const loc = f.line ? `:${f.line}` : "";
        const skill = f.skill ? ` [${f.skill}]` : "";
        return `${tag} ${f.file}${loc} (${f.ruleId})${skill}: ${f.message}`;
    }).join("\n");
}

/** Check a single file path directly (used by `enigma guardrails check <file>`). Returns findings. */
export function checkPath(file: string, stage: Stage = "edit"): Finding[] {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return []; }
    if (content.includes("\0")) return [];
    return checkFile(file, content, findProjectRoot(file), stage);
}

/** Run git for a probe. Returns null when the command FAILED, which empty output cannot express. */
function gitProbe(cwd: string, args: string[]): string | null {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { return null; }
}

/** A `git diff -U0` hunk header. Group 1/2 are the range in the file as it stands on disk. */
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Which of `file`'s lines differ from HEAD, as a predicate, or null when git cannot say.
 *
 * FAILING SAFE IS THE WHOLE POINT, because the caller repairs what this admits: a line the change
 * cannot be PROVEN to have touched is never eligible, since rewriting one would put code the agent
 * never wrote into someone else's diff. An untracked file is new in its entirety, so every line of
 * it qualifies; anything else that cannot be resolved - no repository, a git that failed, no HEAD
 * to diff against - yields null and nothing is repaired.
 */
function changedLineFilter(file: string): ((line: number) => boolean) | null {
    const cwd = dirname(file);
    // `--untracked-files=all`, not the default: git collapses a wholly untracked directory to a
    // single `?? src/` entry, and a brand-new file inside one would then read as tracked-and-clean.
    const status = gitProbe(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all", "--", file]);
    if (status === null) return null;
    if (/^\?\?/m.test(status)) return () => true;
    const diff = gitProbe(cwd, ["diff", "-U0", "HEAD", "--", file]);
    if (diff === null) return null;
    const changed = new Set<number>();
    for (const line of diff.split("\n")) {
        const hunk = DIFF_HUNK.exec(line);
        if (!hunk) continue;
        const start = Number(hunk[1]);
        // A hunk header omits the count when it is 1.
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let i = 0; i < count; i++) changed.add(start + i);
    }
    return (line) => changed.has(line);
}

/**
 * What the DIFF-stage rules find on the lines this file has actually changed: the findings the
 * post-edit hook may REPAIR and never reports.
 *
 * A diff-stage rule is written for code a change added, and this hook sees a whole file - which is
 * why its findings stay with the turn-end sweep, the one component that knows which lines the
 * change added. But a fixer is not a report: it costs no message and no turn, and the file here is
 * dirty by construction (the agent just wrote it), so repairing it now is a plain edit to work in
 * flight rather than a write that leaves a commit disagreeing with the working tree.
 */
function repairableDiffFindings(file: string): Finding[] {
    const rules = loadRules().filter((r) => r.stage === "diff");
    if (!rules.length) return [];
    const changed = changedLineFilter(file);
    if (!changed) return [];
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return []; }
    if (content.includes("\0")) return [];
    // A hand-authored rule is user input, and this runs after every edit the agent makes: a bad
    // one must cost the repair, never the tool call.
    try { return checkFile(file, content, findProjectRoot(file), "diff", rules).filter((f) => f.line && changed(f.line)); }
    catch { return []; }
}

/**
 * Post-edit hook entry. Given a Claude/opencode PostToolUse payload (`tool_input.file_path`)
 * - passed in, or read from stdin when omitted - scans that file and returns the process
 * exit code: 2 when any BLOCK violation is found (stderr fed back to the model), else 0.
 * WARN violations are printed to stdout (advisory) and never block.
 *
 * It REPORTS at the edit stage and REPAIRS at both, and that split is deliberate: a diff-stage
 * finding belongs to the turn-end sweep, which knows whether the change added its line, while a
 * diff-stage FIX belongs here, where the file is already dirty and the fixes are already announced.
 */
export function runGuardrailsHook(payload?: string): number {
    let file: string | undefined;
    try { file = JSON.parse(payload ?? readFileSync(0, "utf8"))?.tool_input?.file_path; } catch { /* no/invalid payload */ }
    if (!file || typeof file !== "string") return 0;
    const found = checkPath(file);
    const repairable = [...found, ...repairableDiffFindings(file)];
    if (!repairable.length) return 0;
    // Repair what code can repair first: the model is only told about what is left. Re-checked at
    // the DIFF stage, or every diff-stage finding would drop out of the re-check and a repair that
    // did not actually clear its finding would be recorded as a success.
    const { fixed } = applyFixes(file, repairable, "diff");
    if (fixed.length) process.stdout.write(`enigma guardrails (fixed)\n${fixed.map((f) => `${f.file}:${f.line} (${f.ruleId})`).join("\n")}\n`);
    recordFindings(fixed, "fixed");
    // Re-derived from disk at the edit stage - the stage this hook reports at - and only when a
    // fixer actually rewrote something; otherwise the first scan still describes the file.
    const findings = fixed.length ? checkPath(file) : found;
    if (!findings.length) return 0;
    const warns = findings.filter((f) => f.severity === "warn");
    const blocks = findings.filter((f) => f.severity === "block");
    recordFindings(warns, "warned");
    recordFindings(blocks, "blocked");
    if (warns.length) process.stdout.write(`enigma guardrails (suggestions)\n${formatFindings(warns)}\n`);
    if (blocks.length) {
        process.stderr.write(`enigma guardrails\n${formatFindings(blocks)}\nFix the above before continuing.\n`);
        return 2;
    }
    return 0;
}

// --- compliance ledger ----------------------------------------------------------------
//
// WHY IT EXISTS: a rule that is skipped leaves no trace. A block is fed back and then forgotten,
// a warn exits 0 and is never seen at all, and an auto-fix is silent by design - so "the agent
// keeps ignoring this convention" has never been answerable with anything but a memory of it.
// The ledger is the measurement channel: one line per finding the model was actually confronted
// with, which turns "it skips optimistic UI" into a count per rule, and tells a rule that fires
// constantly (a candidate for a fixer, or for being wrong) from one that never fires at all.
//
// Deliberately only the MODEL-FACING channels write here - the post-edit hook and the turn-end
// sweep. The commit backstop re-scans whole files, so recording there would bury the signal under
// a repository's pre-existing code, which is exactly what this is meant to measure the absence of.

/** What happened to a finding: repaired by code, blocked the agent, or only advised it. */
export type Outcome = "fixed" | "blocked" | "warned";

/** One recorded encounter between the agent and a rule. */
export interface LedgerEntry {
    at: string;
    rule: string;
    severity: Severity;
    outcome: Outcome;
    stage: LedgerStage;
    file: string;
    line?: number;
}

/**
 * Keep the ledger bounded: past this size the oldest entries are dropped.
 *
 * The two populations get SEPARATE quotas because they arrive at wildly different rates, and one
 * budget let the fast one evict the slow one. Convention rows are deduplicated per day (roughly one
 * per rule per day), so 2000 of them is months of the compliance history `enigma guardrails stats`
 * was built to report. Reply rows are deliberately per turn and never deduplicated, so a chatty
 * session produces them by the hundred - under a shared budget they would push the conventions out
 * of the file within days. Their own question ("is the agent still padding replies") is a
 * short-window one, so a small reserve answers it without spending the long-window one.
 */
const LEDGER_MAX_BYTES = 512 * 1024;
const LEDGER_KEEP = 2000;
const LEDGER_KEEP_REPLY = 200;

/** Where the ledger lives. ENIGMA_GUARDRAILS_LOG relocates it (required by the tests, which must never write to the real one). */
function ledgerPath(): string {
    return process.env.ENIGMA_GUARDRAILS_LOG || join(homedir(), ".enigma", "guardrail-log.jsonl");
}

/** One encounter's identity, ignoring when it happened: the same violation, seen again. */
function ledgerKey(rule: string, outcome: Outcome, file: string, line?: number): string {
    // JSON rather than a joined string: a path may contain whatever separator was picked, and two
    // different findings colliding on one key would drop a real encounter from the count.
    return JSON.stringify([rule, outcome, file, line ?? null]);
}

/**
 * Encounters already recorded TODAY, as identity keys. The turn-end sweep re-reads the whole branch
 * diff every turn, so an unfixed violation is found again on every later turn - including the
 * conversational ones that produced no code. Appending each of those would turn one violation into
 * dozens of rows, all of them in the "the agent got away with it" column, which is the single number
 * this ledger exists to report.
 */
function recordedToday(day: string): Set<string> {
    const seen = new Set<string>();
    eachLedgerEntry(1, (e) => { if (e.at.slice(0, 10) === day) seen.add(ledgerKey(e.rule, e.outcome, e.file, e.line)); });
    return seen;
}

/**
 * Append findings to the ledger. Best-effort in every failure mode: a read-only home, a missing
 * directory or a corrupt file must never turn a convention check into a broken edit, so nothing
 * here throws and nothing here blocks.
 *
 * Deduplicated per day EXCEPT for an edit-stage block and the reply stage. The edit-stage block is
 * the only case where a repeat is a genuinely new encounter: the hook exited 2, the model was
 * stopped and answered it, so seeing the same rule again means it wrote the violation again.
 * Everything else is the same violation seen twice. The edit hook re-scans the WHOLE file on every
 * write, so without this an agent touching one line of a legacy route file appends a row per
 * pre-existing violation, on every edit of that file - inflating precisely the "the agent got away
 * with it" column with code the agent never wrote, which is the one number this ledger exists to
 * report.
 *
 * The reply stage skips the dedupe because its keys are unique BY CONSTRUCTION - the style gate
 * puts the turn's identity in `line` so every reply counts separately - which leaves recordedToday
 * unable to ever match and reading the entire file for nothing. That read sits on the Stop hook,
 * whose cost model is one regex sweep over one string, and it would grow with the file these rows
 * are themselves filling.
 */
export function recordFindings(findings: Finding[], outcome: Outcome, stage: LedgerStage = "edit"): void {
    if (!findings.length) return;
    const at = new Date().toISOString();
    const dedupe = stage !== "reply" && !(stage === "edit" && outcome === "blocked");
    const seen = dedupe ? recordedToday(at.slice(0, 10)) : null;
    const rows: string[] = [];
    for (const f of findings) {
        if (seen) {
            const key = ledgerKey(f.ruleId, outcome, f.file, f.line);
            if (seen.has(key)) continue;
            seen.add(key);
        }
        rows.push(JSON.stringify({ at, rule: f.ruleId, severity: f.severity, outcome, stage, file: f.file, line: f.line } satisfies LedgerEntry));
    }
    if (!rows.length) return;
    const path = ledgerPath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        let size = 0;
        try { size = statSync(path).size; } catch { /* first write */ }
        if (size > LEDGER_MAX_BYTES) {
            const kept = rotateLedger(readFileSync(path, "utf8"));
            writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "");
        }
        appendFileSync(path, `${rows.join("\n")}\n`);
    } catch { /* the ledger is a measurement, never a gate */ }
}

/**
 * The lines that survive rotation, oldest first: the newest LEDGER_KEEP convention rows and the
 * newest LEDGER_KEEP_REPLY reply rows, each counted against its own quota so the fast population
 * cannot evict the slow one. A line too corrupt to classify ages out with the conventions - it came
 * from the same appends and there is nothing else to charge it to.
 */
function rotateLedger(text: string): string[] {
    const lines = text.split("\n").filter(Boolean);
    const kept: string[] = [];
    let conventions = 0;
    let replies = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        let reply = false;
        try { reply = (JSON.parse(line) as LedgerEntry)?.stage === "reply"; } catch { /* unclassifiable: a convention row */ }
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

/**
 * Visit every readable entry newer than `sinceDays` (0 = all), oldest first. The one reader behind
 * readLedger, countLedger and the dedupe, so a caller that only needs a count never allocates the
 * whole array - the dashboard status endpoint asks for one on every request.
 */
function eachLedgerEntry(sinceDays: number, visit: (entry: LedgerEntry) => void): void {
    let text: string;
    try { text = readFileSync(ledgerPath(), "utf8"); } catch { return; }
    const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as LedgerEntry;
            if (typeof entry?.rule !== "string") continue;
            if (cutoff && Date.parse(entry.at) < cutoff) continue;
            visit(entry);
        } catch { /* a truncated write is one lost line, not a broken report */ }
    }
}

/**
 * Is this row a CONVENTION encounter - a rule broken in the code the agent produced?
 *
 * The reply-prose rows of the output-style gate share this file but answer a different question,
 * and both readers below are the convention ones: `enigma guardrails stats` reports which
 * conventions the agent keeps breaking, and the dashboard's guardrails number counts rule
 * violations. A padded reply is neither, and it arrives once per turn, so counting it there would
 * swamp the number it was mixed into. Reply rows are read through readReplyLedger instead.
 */
function isConvention(entry: LedgerEntry): boolean {
    return entry.stage !== "reply";
}

/** Read the convention ledger, newest last. A malformed line is skipped rather than failing the read. */
export function readLedger(sinceDays = 0): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    eachLedgerEntry(sinceDays, (entry) => { if (isConvention(entry)) out.push(entry); });
    return out;
}

/** The other half of the same file: what the turn-end style gate found in the agent's replies. */
export function readReplyLedger(sinceDays = 0): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    eachLedgerEntry(sinceDays, (entry) => { if (!isConvention(entry)) out.push(entry); });
    return out;
}

/** How many convention findings were recorded in the window, without building the entry list for them. */
export function countLedger(sinceDays = 0): number {
    let count = 0;
    eachLedgerEntry(sinceDays, (entry) => { if (isConvention(entry)) count++; });
    return count;
}

/** Per-rule totals, most-violated first - the answer to "which convention does the agent keep skipping". */
export function summarizeLedger(entries: LedgerEntry[]): { rule: string; total: number; blocked: number; warned: number; fixed: number; last: string; }[] {
    const by = new Map<string, { rule: string; total: number; blocked: number; warned: number; fixed: number; last: string; }>();
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

// --- standalone commit/CI backstop -------------------------------------------------

function gitFiles(all: boolean): string[] {
    const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8", windowsHide: true });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface ScanResult { ok: boolean; blocks: Finding[]; warns: Finding[]; count: number; notRepo?: boolean; }

/** Scan staged (default) or all tracked files. Full-file scan, matching guard.ts (no changed-line intersection). */
export function runGuardrailsScan(all: boolean): ScanResult {
    let files: string[];
    try { files = gitFiles(all); }
    catch { return { ok: true, blocks: [], warns: [], count: 0, notRepo: true }; }
    const root = process.cwd();
    const blocks: Finding[] = [];
    const warns: Finding[] = [];
    for (const file of files) {
        let content: string;
        try { content = readFileSync(file, "utf8"); } catch { continue; }
        if (content.includes("\0")) continue;
        for (const f of checkFile(file, content, root)) (f.severity === "block" ? blocks : warns).push(f);
    }
    return { ok: blocks.length === 0, blocks, warns, count: files.length };
}

/** CLI entry for the standalone backstop: print results, return the exit code. */
export function runGuardrailsScanCli(all: boolean): number {
    const r = runGuardrailsScan(all);
    if (r.notRepo) { console.error("enigma-guardrails: not a git repository; nothing to check."); return 0; }
    if (r.warns.length) {
        console.error(`enigma-guardrails: ${r.warns.length} suggestion(s):`);
        for (const w of r.warns) console.error(`  ! ${formatFindings([w])}`);
    }
    if (r.blocks.length) {
        console.error(`\nenigma-guardrails: BLOCKED - ${r.blocks.length} convention violation(s):`);
        for (const b of r.blocks) console.error(`  x ${formatFindings([b])}`);
        console.error("\nTo bypass intentionally for one commit: git commit --no-verify");
        return 1;
    }
    console.log(`enigma-guardrails: ${r.count} ${all ? "tracked" : "staged"} file(s) checked, no blocking violations.`);
    return 0;
}

// Run standalone only when this file is itself the program entry (the built
// dist/guardrails.js, the copied .githooks/guardrails.mjs, or src/guardrails.ts via
// tsx). The basename guard is required because this module is also bundled into the CLI
// (cli.ts imports runGuardrailsHook); there import.meta.url and argv[1] both resolve to
// enigma.js, so a bare equality check would mis-fire on every command.
const grEntry = process.argv[1] ?? "";
const isGrEntry = /(^|[\\/])guardrails\.[mc]?[jt]s$/.test(grEntry);
if (isGrEntry && fileURLToPath(import.meta.url) === grEntry) {
    process.exit(runGuardrailsScanCli(process.argv.includes("--all")));
}
