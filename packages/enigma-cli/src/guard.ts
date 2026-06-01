/**
 * enigma commit guard: a self-contained, dependency-free pre-commit guard.
 *
 * It is BOTH (a) the engine enigma copies into a target repo's `.githooks/` to
 * run as a pre-commit hook, and (b) this repo's own CI/commit scanner. It must
 * stay self-contained (only Node builtins, no imports from other modules) so the
 * built dist/guard.js runs in any repo without enigma installed.
 *
 * Checks (OS-agnostic), each toggleable via an optional config file:
 *   - secrets        high-signal credential patterns          -> BLOCK
 *   - envFiles       .env / .env.local / .env.<anything>      -> BLOCK
 *                    (allowed: names with example/sample/template)
 *   - depDirs        node_modules, caches, virtualenvs         -> BLOCK
 *   - generatedDirs  dist, build, .next, coverage, ...         -> WARN
 *   - junkFiles      *.log, .DS_Store, Thumbs.db               -> WARN
 *   - largeFiles     files larger than 5 MB                    -> WARN
 *
 * Config: an optional `enigma-guard.json` next to this file. Missing keys = on.
 * Modes: default = STAGED files (pre-commit); `--all` = every tracked file (CI).
 * Bypass once (use sparingly): git commit --no-verify
 */

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

const ENV_ALLOWED = /(example|sample|template)/i;
const isForbiddenEnv = (base: string): boolean => /^\.env(\..+)?$/.test(base) && !ENV_ALLOWED.test(base);

const BLOCK_DIRS = [
    /(^|\/)node_modules\//, /(^|\/)bower_components\//, /(^|\/)\.pnp(\/|$)/,
    /(^|\/)__pycache__\//, /(^|\/)\.venv\//, /(^|\/)venv\//,
    /(^|\/)\.mypy_cache\//, /(^|\/)\.pytest_cache\//, /(^|\/)\.gradle\//,
];
const WARN_DIRS = [
    /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)out\//, /(^|\/)\.next\//,
    /(^|\/)\.nuxt\//, /(^|\/)\.svelte-kit\//, /(^|\/)\.turbo\//, /(^|\/)coverage\//,
];
const WARN_FILES = [/\.log$/i, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i];

const SECRET_SKIP_EXT = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".lock",
]);
const SECRET_PATTERNS: Array<[string, RegExp]> = [
    ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ["Stripe secret key", /\bsk_live_[0-9A-Za-z]{24,}\b/],
    ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
    ["Generic bearer secret", /\b(?:secret|token|api[_-]?key|passwd|password)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i],
];
const SECRET_SKIP_PATH = [/(^|\/)node_modules\//, /(^|\/)\.git\//, /package-lock\.json$/, /guard\.[mc]?js$/];

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

interface GuardConfig {
    secrets: boolean;
    envFiles: boolean;
    depDirs: boolean;
    generatedDirs: boolean;
    junkFiles: boolean;
    largeFiles: boolean;
}

/** Load the optional toggle config from next to this file; missing keys = on. */
function loadConfig(): GuardConfig {
    const defaults: GuardConfig = { secrets: true, envFiles: true, depDirs: true, generatedDirs: true, junkFiles: true, largeFiles: true };
    try {
        const raw = JSON.parse(readFileSync(join(SELF_DIR, "enigma-guard.json"), "utf8"));
        return { ...defaults, ...raw };
    } catch {
        return defaults;
    }
}

function gitFiles(all: boolean): string[] {
    const out = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function scanSecrets(file: string, blocks: string[]): void {
    if (SECRET_SKIP_PATH.some((re) => re.test(file))) return;
    if (SECRET_SKIP_EXT.has(extname(file).toLowerCase())) return;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    if (text.includes("\0")) return; // binary
    text.split("\n").forEach((line, i) => {
        for (const [label, re] of SECRET_PATTERNS) {
            if (re.test(line)) blocks.push(`${file}:${i + 1}  [secret: ${label}]`);
        }
    });
}

export interface GuardResult {
    ok: boolean;
    blocks: string[];
    warns: string[];
    count?: number;
    all?: boolean;
    notRepo?: boolean;
}

/** Run the guard. Returns the result; does not exit. */
export function runGuard({ all = false }: { all?: boolean } = {}): GuardResult {
    const cfg = loadConfig();
    let files: string[];
    try { files = gitFiles(all); }
    catch { return { ok: true, blocks: [], warns: [], notRepo: true }; }

    const blocks: string[] = [];
    const warns: string[] = [];
    for (const file of files) {
        const base = basename(file);
        if (cfg.envFiles && isForbiddenEnv(base)) {
            blocks.push(`${file}  [env file with secrets - commit .env.example/.template instead]`);
        }
        if (cfg.depDirs && BLOCK_DIRS.some((re) => re.test(file))) {
            blocks.push(`${file}  [dependency/cache dir - must not be committed]`);
        } else if (cfg.generatedDirs && WARN_DIRS.some((re) => re.test(file))) {
            warns.push(`${file}  [looks generated - confirm you really want it tracked]`);
        }
        if (cfg.junkFiles && WARN_FILES.some((re) => re.test(file))) warns.push(`${file}  [log / OS junk file]`);
        if (cfg.largeFiles) { try { if (statSync(file).size > LARGE_FILE_BYTES) warns.push(`${file}  [larger than 5 MB]`); } catch { /* gone */ } }
        if (cfg.secrets) scanSecrets(file, blocks);
    }
    return { ok: blocks.length === 0, blocks, warns, count: files.length, all };
}

/** CLI entry: print results and return the exit code. */
export function runGuardCli(all: boolean): number {
    const r = runGuard({ all });
    if (r.notRepo) { console.error("enigma-guard: not a git repository; nothing to check."); return 0; }
    if (r.warns.length) {
        console.error(`enigma-guard: ${r.warns.length} warning(s):`);
        for (const w of r.warns) console.error(`  ! ${w}`);
    }
    if (r.blocks.length) {
        console.error(`\nenigma-guard: BLOCKED - ${r.blocks.length} problem(s) must be fixed before committing:`);
        for (const b of r.blocks) console.error(`  x ${b}`);
        console.error("\nFix the above (move secrets to env/secret manager, gitignore generated paths).");
        console.error("To bypass intentionally for one commit: git commit --no-verify");
        return 1;
    }
    console.log(`enigma-guard: ${r.count} ${r.all ? "tracked" : "staged"} file(s) checked, no blocking problems.`);
    return 0;
}

// Run standalone only when this file is itself the program entry: the built
// dist/guard.js, the copied .githooks/guard.mjs, or src/guard.ts via tsx. The
// basename guard is required because this module is also bundled into the CLI
// (cli.ts imports runGuardCli); there import.meta.url and argv[1] both resolve
// to enigma.js, so a bare equality check would mis-fire the guard on every
// command. Matching only a "guard.*" entry keeps the bundled copy inert.
const guardEntry = process.argv[1] ?? "";
const isGuardEntry = /(^|[\\/])guard\.[mc]?[jt]s$/.test(guardEntry);
if (isGuardEntry && fileURLToPath(import.meta.url) === guardEntry) {
    process.exit(runGuardCli(process.argv.includes("--all")));
}
