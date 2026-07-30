/**
 * enigma EOF trimmer: removes the blank line agents leave at the end of a file.
 *
 * Every coding agent's write tool tends to end a file with an extra empty line, so a repo
 * slowly fills with files whose last line is blank. This module takes it back out, and it is
 * deliberately conservative: a file is only changed when it has REAL CONTENT followed by one
 * or more blank lines at the very end. A file that is empty, or is nothing but blank lines,
 * or whose last line has content but no closing newline, is left exactly as it is - so a
 * fixture that must look like that never breaks.
 *
 * It runs in three places, all the same core:
 *   - after an agent edit (the hidden `enigma __trim-hook`), on that one file;
 *   - as a pre-commit step, on the staged files, re-staging what it fixed;
 *   - as `enigma trim --all`, over every tracked file (the retroactive sweep).
 *
 * COST. The check never reads a whole file. It stats the file, reads only the LAST few KB,
 * and when there is something to remove it TRUNCATES - no read of the body, no rewrite, no
 * temp file, so a 200 MB file costs the same as a 200 byte one. Files are processed with
 * bounded concurrency, which keeps a huge commit fast without a thread pool: the work is
 * filesystem I/O, and Node already runs that off the main thread.
 *
 * Self-contained (Node builtins only, no enigma imports) exactly like guard.ts and
 * guardrails.ts: it is bundled into the CLI AND built to dist/trim.js, which is copied into a
 * repo's .githooks/trim.mjs and run by that repo's own Node.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { open, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";

/** How much of the file's end to read first. Long blank runs re-read, doubling up to MAX_TAIL. */
const TAIL_BYTES = 4096;
const MAX_TAIL = 1024 * 1024;

/** How many files to process at once. I/O-bound, so this is a queue depth, not a core count. */
const CONCURRENCY = 32;

/**
 * Extensions never touched. The NUL sniff below already rejects most binaries; this list is
 * for TEXT formats where a trailing blank line is data rather than an accident - a patch's
 * final context line, a recorded snapshot that must stay byte-exact.
 */
const SKIP_EXT = new Set([
    ".patch", ".diff", ".snap",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".node", ".class", ".pyc",
    ".db", ".sqlite", ".sqlite3", ".lock",
]);

/**
 * Directory segments never touched: recorded fixtures and snapshots (which must stay
 * byte-exact), build output (regenerated anyway), and vendored third-party code, which is
 * somebody else's file - rewriting it diverges the copy from upstream for no gain, and where
 * the copy is integrity-checked it invalidates the recorded hash outright.
 */
const SKIP_DIR = /(^|\/)(__snapshots__|fixtures|testdata|golden|node_modules|\.git|vendor|third_party|third-party|dist|build|coverage|\.next|\.venv)(\/|$)/;

/**
 * Repo-relative globs to leave alone, from an optional `.githooks/enigma-trim.json`
 * (`{ "ignore": ["assets/vendored/**"] }`) - the same shape and location as the commit
 * guard's `enigma-guard.json`. This is how a repo marks a tree whose trailing blank lines
 * are deliberate or load-bearing: mirrored upstream content, files whose checksum is
 * recorded elsewhere, a fixture directory that does not match the names above.
 */
export function readIgnoreGlobs(root: string): string[] {
    try {
        const raw = JSON.parse(readFileSync(join(root, ".githooks", "enigma-trim.json"), "utf8"));
        return Array.isArray(raw.ignore) ? raw.ignore.filter((g: unknown) => typeof g === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Translate a simple glob to an anchored RegExp (`**` crosses separators, `*` within a
 * segment, `?` one non-separator char; a no-slash glob matches the basename anywhere).
 * enigma: duplicated from guard.ts:globToRegExp on purpose - this engine must stay
 * import-free so dist/trim.js runs standalone in any repo. Keep the two in sync.
 */
function globToRegExp(glob: string): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
    return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}

/** A line with nothing on it but horizontal whitespace or a carriage return. */
const BLANK_LINE = /^[ \t\r]*$/;

/** True when the path is one this trimmer must never rewrite. */
export function isSkipped(file: string): boolean {
    const norm = file.replace(/\\/g, "/");
    return SKIP_DIR.test(norm) || SKIP_EXT.has(extname(norm).toLowerCase());
}

/**
 * Byte length of the trailing blank lines in `tail`, where `atStart` says whether `tail`
 * reaches the beginning of the file. Returns 0 for "nothing to remove", and -1 for "the
 * answer is further back than this tail" so the caller can read more.
 *
 * The rule, exactly as it is meant to be conservative: the file must end with a newline
 * (otherwise its last line is unterminated content, not a blank line), and there must be at
 * least one line of REAL content before the blank ones (otherwise the file is entirely blank
 * and may be that way on purpose). Whitespace on a CONTENT line is never touched - trailing
 * whitespace is a different convention, and removing it here would rewrite a line the user
 * may have meant.
 */
export function trailingBlankBytes(tail: string, atStart: boolean): number {
    const lines = tail.split("\n");
    // Anything after the final "\n" is an unterminated last line: content, so nothing to do.
    if (lines.pop() !== "") return 0;
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!BLANK_LINE.test(line)) return bytes;   // reached content: everything after it goes
        bytes += line.length + 1;                   // the blank line plus its own "\n"
    }
    // Every line in the window was blank. At the start of the file that means the whole file
    // is blank (leave it alone); otherwise the content is further back than this tail.
    return atStart ? 0 : -1;
}

/**
 * Remove the trailing blank lines of one file. Returns true when the file was changed.
 * Never throws for an ordinary cause (missing file, no permission, a directory, a binary):
 * this runs inside a commit and an editor hook, where failing loudly on an unreadable path
 * would be worse than skipping it.
 */
export async function trimFile(file: string): Promise<boolean> {
    if (isSkipped(file)) return false;
    let handle;
    try {
        const info = await stat(file);
        if (!info.isFile() || info.size === 0) return false;
        handle = await open(file, "r+");
        let want = TAIL_BYTES;
        for (;;) {
            const length = Math.min(want, info.size);
            const position = info.size - length;
            const buf = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buf, 0, length, position);
            const tail = buf.subarray(0, bytesRead);
            if (tail.includes(0)) return false;                 // binary: not ours to rewrite
            // latin1 keeps one char per byte, so string offsets ARE byte offsets. Decoding as
            // utf8 would collapse multi-byte characters and compute the wrong truncation point.
            const cut = trailingBlankBytes(tail.toString("latin1"), position === 0);
            if (cut === 0) return false;
            if (cut > 0) {
                await handle.truncate(info.size - cut);
                return true;
            }
            if (position === 0 || want >= MAX_TAIL) return false;
            want *= 2;
        }
    } catch {
        return false;
    } finally {
        await handle?.close().catch(() => { /* already gone */ });
    }
}

/** Run `task` over every file with a bounded number in flight; returns the ones that changed. */
async function trimAll(files: string[], task: (f: string) => Promise<boolean> = trimFile): Promise<string[]> {
    const changed: string[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let i = next++; i < files.length; i = next++) {
            if (await task(files[i]!)) changed.push(files[i]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    return changed;
}

// --- git plumbing (staged / tracked file lists) -------------------------------------

/** Run git with NUL-separated output, returning [] when git is absent or this is not a repo. */
function gitLines(args: string[]): string[] {
    try {
        const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
        return out.split("\0").map((s) => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

/** The repository root, or null when this is not a git repo. */
function repoRoot(): string | null {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || null;
    } catch {
        return null;
    }
}

/** Re-stage the files that were fixed, in chunks so a huge commit never overruns the arg limit. */
function stage(files: string[]): void {
    for (let i = 0; i < files.length; i += 500) {
        try {
            execFileSync("git", ["add", "--", ...files.slice(i, i + 500)], { stdio: "ignore", windowsHide: true });
        } catch { /* the file is reported as fixed either way */ }
    }
}

export interface TrimResult {
    /** Files whose trailing blank lines were removed. */
    changed: string[];
    /** Fixed but NOT re-staged, because they also hold unstaged edits (see runTrimScanCli). */
    unstaged: string[];
    /** How many files were considered. */
    count: number;
    notRepo?: boolean;
}

/**
 * Trim the staged files (pre-commit) or every tracked file (`--all`), re-staging what changed
 * so the fix lands in the commit being made.
 *
 * A file that is staged AND has further unstaged edits is deliberately fixed but NOT re-staged:
 * `git add` would pull those unrelated edits into the commit, which is a much worse surprise
 * than one blank line surviving. It is reported instead, and the next commit picks it up.
 */
export async function runTrimScan(all: boolean): Promise<TrimResult> {
    const root = repoRoot();
    if (root === null) return { changed: [], unstaged: [], count: 0, notRepo: true };
    const listed = all
        ? gitLines(["ls-files", "-z"])
        : gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]);
    const ignore = readIgnoreGlobs(root).map(globToRegExp);
    const files = ignore.length ? listed.filter((f) => !ignore.some((re) => re.test(f))) : listed;
    if (files.length === 0) return { changed: [], unstaged: [], count: 0 };
    const dirty = all ? new Set<string>() : new Set(gitLines(["diff", "--name-only", "-z"]));
    const changed = await trimAll(files);
    const unstaged = changed.filter((f) => dirty.has(f));
    const restage = changed.filter((f) => !dirty.has(f));
    if (!all && restage.length) stage(restage);
    return { changed, unstaged, count: files.length };
}

// --- entry points -------------------------------------------------------------------

/**
 * The post-edit hook: trim the file the agent just wrote. Always exits 0 - this is a silent
 * tidy, not a gate, and a failure here must never interrupt the turn.
 */
export async function runTrimHook(payload?: string): Promise<number> {
    try {
        const file = JSON.parse(payload || "{}")?.tool_input?.file_path;
        if (typeof file === "string" && file) await trimFile(file);
    } catch { /* no payload, or nothing to do */ }
    return 0;
}

/** `enigma trim [--all]` / the .githooks/trim.mjs pre-commit step. Always exits 0. */
export async function runTrimScanCli(all: boolean): Promise<number> {
    const r = await runTrimScan(all);
    if (r.notRepo) {
        console.error("enigma-trim: not a git repository; nothing to do.");
        return 0;
    }
    if (r.changed.length === 0) {
        console.log(`enigma-trim: ${r.count} ${all ? "tracked" : "staged"} file(s) checked, no trailing blank lines.`);
        return 0;
    }
    const staged = r.changed.length - r.unstaged.length;
    console.log(`enigma-trim: removed a trailing blank line from ${r.changed.length} file(s)${all ? "" : `, ${staged} re-staged`}.`);
    for (const f of r.changed.slice(0, 20)) console.log(`  - ${f}`);
    if (r.changed.length > 20) console.log(`  ... and ${r.changed.length - 20} more`);
    if (r.unstaged.length) {
        console.log(`\nenigma-trim: ${r.unstaged.length} file(s) were fixed on disk but NOT re-staged, because they also`);
        console.log("hold unstaged edits and `git add` would have pulled those into this commit:");
        for (const f of r.unstaged) console.log(`  ! ${f}`);
    }
    return 0;
}

// Run standalone only when this file is itself the program entry (the built dist/trim.js, the
// copied .githooks/trim.mjs, or src/trim.ts via tsx). The basename guard is required because
// this module is also bundled into the CLI, where argv[1] resolves to enigma.js instead.
const trimEntry = process.argv[1] ?? "";
const isTrimEntry = /(^|[\\/])trim\.[mc]?[jt]s$/.test(trimEntry);
if (isTrimEntry && fileURLToPath(import.meta.url) === trimEntry) {
    void runTrimScanCli(process.argv.includes("--all")).then((code) => process.exit(code));
}
