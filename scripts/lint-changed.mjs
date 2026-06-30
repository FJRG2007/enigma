/**
 * Changed-lines Ciphera-style gate. Runs @enigmax/linter over the files in a git diff but
 * fails ONLY on violations that land on added/modified lines - so editing a file that has a
 * pre-existing-warning backlog never forces unrelated fixes. This is the true "gate only on
 * changes" ratchet, shared by the pre-commit hook (staged) and CI (push / PR diff).
 *
 *   node --import tsx scripts/lint-changed.mjs --staged
 *   node --import tsx scripts/lint-changed.mjs --range origin/main...HEAD
 *
 * Run via tsx (it imports the linter's TypeScript source), with the repo root as cwd so the
 * git-relative paths resolve. Exits non-zero when any changed line carries a violation.
 */

import { execFileSync } from "node:child_process";
import { lintFiles } from "../packages/linter/src/index.ts";

/** Source extensions the Ciphera gate covers (mirrors the hook/CI glob list). */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".vue", ".svelte", ".py", ".rs", ".prisma"];

function git(args) {
    return execFileSync("git", args, { encoding: "utf8" });
}

/** Parse `--staged` / `--range <range>` from argv. */
function parseArgs(argv) {
    const staged = argv.includes("--staged");
    const rangeFlag = argv.indexOf("--range");
    const range = rangeFlag !== -1 ? argv[rangeFlag + 1] : null;
    return { staged, range };
}

/**
 * Path prefixes excluded from the style gate: vendored third-party content that
 * enigma commits verbatim and does not own the style of (the autoskills registry).
 */
const IGNORE_PREFIXES = ["assets/skills-registry/", "packages/helio/assets/"];

/** The changed source files (added/copied/modified) for the selected diff. */
function changedFiles({ staged, range }) {
    const base = staged ? ["diff", "--cached"] : ["diff", ...(range ? [range] : [])];
    const out = git([...base, "--name-only", "--diff-filter=ACM"]);
    return out.split("\n").map((f) => f.trim()).filter(Boolean)
        .filter((f) => !IGNORE_PREFIXES.some((p) => f.startsWith(p)))
        .filter((f) => EXTENSIONS.some((e) => f.toLowerCase().endsWith(e)));
}

/** The set of new-side line numbers added/modified in one file, from `git diff -U0`. */
function changedLines(file, { staged, range }) {
    const base = staged ? ["diff", "--cached"] : ["diff", ...(range ? [range] : [])];
    let out;
    try { out = git([...base, "-U0", "--", file]); } catch { return new Set(); }
    const lines = new Set();
    for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        for (let i = 0; i < count; i++) lines.add(start + i);
    }
    return lines;
}

function main(argv) {
    const opts = parseArgs(argv);
    const files = changedFiles(opts);
    if (!files.length) { console.log("Ciphera gate: no changed source files."); return 0; }

    const lineSets = new Map(files.map((f) => [f, changedLines(f, opts)]));
    const violations = lintFiles(files).filter((v) => lineSets.get(v.file)?.has(v.line));
    if (!violations.length) { console.log(`Ciphera gate: ${files.length} changed file(s) clean.`); return 0; }

    violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    console.error("Ciphera-style findings on changed lines:\n");
    for (const v of violations) console.error(`  ${v.file}:${v.line}:${v.column}  ${v.severity}  ${v.message}  ${v.rule}`);
    console.error(`\n${violations.length} finding(s). Fix them, or bypass once with: git commit --no-verify`);
    return 1;
}

process.exit(main(process.argv.slice(2)));
