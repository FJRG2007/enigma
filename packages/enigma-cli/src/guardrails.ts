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
 */

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type Severity = "block" | "warn";

/** A line whose trimmed start is a comment - the pattern scan skips these to avoid false positives. */
const COMMENT_LINE = /^\s*(\/\/|#|\*|--|<!--|\{?\/\*)/;

/** One convention rule. `file` rules regex-scan the edited file; `project` rules run a named check. */
export interface GuardrailRule {
    id: string;
    label: string;
    /** Globs the edited file must match for the rule to apply (guardrails uses globToRegExp). */
    files: string[];
    /** Globs that EXCLUDE a file from the rule even if `files` matches (e.g. test files). */
    excludeFiles?: string[];
    scope: "file" | "project";
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
        pattern: "<input\\b[^>]*type=[\"']password[\"']",
        flags: "",
        absent: "showPassword|setShowPassword|togglePassword|revealPassword|passwordVisible|isPasswordVisible|showPw|hidePassword",
        message: "Raw <input type=\"password\">: use the shared reusable Input component (which renders a show/hide toggle for passwords) instead of a bare input, or add the toggle (frontend-policy).",
        severity: "warn",
        skill: "frontend-policy",
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
        // (that is the correct pattern). `absent` skips the file when ANY placeholder/skeleton signal
        // is present (skeleton, animate-pulse, shimmer, Suspense, a content-loader lib, <Placeholder>)
        // - the component already renders a placeholder somewhere. Kept to the terse one-line guard for
        // precision (a multi-line block is not matched: precision > recall).
        pattern: "\\bif\\s*\\(\\s*(isLoading|isPending|isFetching|loading|pending)\\s*\\)\\s*return\\s+(null\\b|<\\s*\\w*(Spinner|Loader|Loading|CircularProgress)\\b)",
        absent: "skeleton|animate-pulse|shimmer|Suspense|ContentLoader|content-loader|<\\s*Placeholder",
        message: "Component returns nothing (or only a spinner) while data loads, so the page stays blank until the fetch resolves. Render the shell/layout on first paint and show skeleton placeholders shaped like the final content (reserve their space to avoid layout shift) while data loads async via the API (frontend-policy).",
        severity: "warn",
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
        severity: "warn",
        skill: "frontend-policy",
    },
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
        // warns: a warn exits 0 and never reaches the model that keeps growing the file.
        maxBytes: 40_000,
        message: "This memory file loads into every session in the project, so its cost is paid on every task regardless of relevance. Keep it an INDEX: move each subsystem's detail into its own doc (docs/notes/<topic>.md) and leave one line here saying what the note covers and when to read it. Route new conventions by tier - a file-local syntactic signature becomes a guardrail rule, a domain-scoped rule belongs in the owning skill (loaded on demand), and only a truly universal rule stays in memory. Turn this off with `enigma guardrails disable ctx-memory-budget`.",
        severity: "block",
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
function globToRegExp(glob: string): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
    return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
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

/** Run every applicable rule against one file's content. `projectRoot` may be null (project rules then skip). */
export function checkFile(file: string, content: string, projectRoot: string | null): Finding[] {
    const norm = file.replace(/\\/g, "/");
    const out: Finding[] = [];
    for (const rule of loadRules()) {
        if (!rule.files.some((g) => globToRegExp(g).test(norm))) continue;
        if (rule.excludeFiles?.some((g) => globToRegExp(g).test(norm))) continue;
        const base = { ruleId: rule.id, severity: rule.severity, file: norm, message: rule.message, skill: rule.skill };
        if (rule.scope === "file" && rule.maxBytes) {
            const bytes = Buffer.byteLength(content, "utf8");
            if (bytes > rule.maxBytes) out.push({ ...base, message: `${rule.message} (${bytes} bytes, budget ${rule.maxBytes})` });
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
export function checkPath(file: string): Finding[] {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return []; }
    if (content.includes("\0")) return [];
    return checkFile(file, content, findProjectRoot(file));
}

/**
 * Post-edit hook entry. Given a Claude/opencode PostToolUse payload (`tool_input.file_path`)
 * - passed in, or read from stdin when omitted - scans that file and returns the process
 * exit code: 2 when any BLOCK violation is found (stderr fed back to the model), else 0.
 * WARN violations are printed to stdout (advisory) and never block.
 */
export function runGuardrailsHook(payload?: string): number {
    let file: string | undefined;
    try { file = JSON.parse(payload ?? readFileSync(0, "utf8"))?.tool_input?.file_path; } catch { /* no/invalid payload */ }
    if (!file || typeof file !== "string") return 0;
    const findings = checkPath(file);
    if (!findings.length) return 0;
    const warns = findings.filter((f) => f.severity === "warn");
    const blocks = findings.filter((f) => f.severity === "block");
    if (warns.length) process.stdout.write(`enigma guardrails (suggestions)\n${formatFindings(warns)}\n`);
    if (blocks.length) {
        process.stderr.write(`enigma guardrails\n${formatFindings(blocks)}\nFix the above before continuing.\n`);
        return 2;
    }
    return 0;
}

// --- standalone commit/CI backstop -------------------------------------------------

function gitFiles(all: boolean): string[] {
    const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" });
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
