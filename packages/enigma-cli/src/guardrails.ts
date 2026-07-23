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
        message: "Native browser dialog (alert/confirm/prompt) - use a dialog/modal component that matches the page design instead of the browser's built-in (frontend-policy).",
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
        // A whole-component loading guard that returns null or a bare spinner (blank screen until
        // the fetch resolves) - the "page doesn't render until it has data" tell. The return group
        // matches ONLY null / a *Spinner|*Loader|*Loading|CircularProgress element, so
        // `return <Skeleton/>` is NOT matched (that is the correct pattern). `absent` skips the file
        // when any skeleton signal is present - the component already renders a placeholder. Kept to
        // the terse one-line guard for precision (a multi-line block is not matched: precision > recall).
        pattern: "\\bif\\s*\\(\\s*(isLoading|isPending|isFetching|loading|pending)\\s*\\)\\s*return\\s+(null\\b|<\\s*\\w*(Spinner|Loader|Loading|CircularProgress)\\b)",
        absent: "skeleton|animate-pulse|shimmer|Suspense",
        message: "Component returns nothing (or only a spinner) while data loads, so the page stays blank until the fetch resolves. Render the shell/layout on first paint and show skeleton placeholders shaped like the final content (reserve their space to avoid layout shift) while data loads async via the API (frontend-policy).",
        severity: "warn",
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
        if (rule.scope === "file" && rule.pattern) {
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
