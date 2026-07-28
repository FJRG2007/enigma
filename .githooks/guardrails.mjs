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
function readPkgDeps(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  } catch {
    return null;
  }
}
function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
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
    if (!rule.files.some((g) => globToRegExp(g).test(norm))) continue;
    if (rule.excludeFiles?.some((g) => globToRegExp(g).test(norm))) continue;
    const base = { ruleId: rule.id, severity: rule.severity, file: norm, message: rule.message, skill: rule.skill };
    if (rule.scope === "file" && rule.pattern) {
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
  const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" });
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
  PROJECT_CHECKS,
  checkFile,
  checkPath,
  findProjectRoot,
  formatFindings,
  loadRules,
  runGuardrailsHook,
  runGuardrailsScan,
  runGuardrailsScanCli
};
