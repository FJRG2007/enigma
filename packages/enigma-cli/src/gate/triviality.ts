/**
 * Is a change small and harmless enough that the full gate pipeline (review agents, fix
 * rounds, a PR) costs more than it can catch?
 *
 * The gate's value scales with the change: on a one-line CSS fix the review finds nothing a
 * typecheck and the pre-commit hooks did not already, and the run still takes minutes and
 * opens a PR for the user to wade through. So below a size threshold the gate is not
 * expected (the turn-end check stands down) and `axi run` declines unless forced.
 *
 * Size alone is not enough: a two-line change to an auth check, a migration, a dependency
 * manifest or a CI workflow is exactly where a review earns its time, so any SENSITIVE path
 * makes a change non-trivial whatever its size. A binary file has no line count to judge, so
 * it is never trivial either - except an image or font asset: swapping a logo, a favicon or an
 * icon set is the most common tiny change there is, a review reads nothing in it, and counting
 * it as "binary" (or each file toward the breadth limit) sent every logo swap through the full
 * pipeline and a PR. The rule is otherwise deliberately one-sided: a false "trivial" skips a
 * review that mattered, a false "not trivial" only costs a run - when in doubt, not trivial.
 */

import { spawnSync } from "node:child_process";

/** Changed lines (added + deleted) at or under which a change is trivial; 0 turns the fast path off. */
export const DEFAULT_TRIVIAL_LINES = 20;
/** More files than this is a change with breadth, whatever its line count. */
export const MAX_TRIVIAL_FILES = 3;

/** Paths where any change deserves the full pipeline. Matched against the repo-relative path. */
const SENSITIVE_PATHS: RegExp[] = [
    /(^|\/)\.github\/workflows\//, /(^|\/)\.gitlab-ci\.yml$/, /(^|\/)(azure-pipelines|bitbucket-pipelines)\.ya?ml$/,
    /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/i, /(^|\/)\.env(\.|$)/, /\.(tf|tfvars)$/, /(^|\/)(infra|terraform|k8s|helm)\//i,
    /(^|\/)migrations?\//i, /\.sql$/i, /(^|\/)prisma\/schema\.prisma$/,
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Gemfile(\.lock)?|composer\.(json|lock)|Pipfile(\.lock)?)$/,
    /(auth|oauth|login|session|secret|credential|password|passwd|token|crypto|permission|rbac|acl|security|csrf|cors|sanitiz)/i,
    /(^|\/)\.enigma\.json$/, /(^|\/)\.githooks\//,
];

/** Whether a repo-relative path is one where any change deserves a review. */
export function isSensitivePath(path: string): boolean {
    const p = path.replace(/\\/g, "/");
    return SENSITIVE_PATHS.some((re) => re.test(p));
}

/** Image and font assets: no line count and nothing a review reads, so they add no size. */
const ASSET_PATH = /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot)$/i;

export interface ChangeSize {
    /** Changed files other than assets. */
    files: number;
    /** Changed image/font assets, which count toward neither `files` nor `lines`. */
    assets: number;
    /** Added + deleted lines across text files. */
    lines: number;
    /** Some file has no line count (binary). */
    binary: boolean;
    /** Changed paths that always warrant a review. */
    sensitive: string[];
}

/** Sizes a `git diff --numstat` listing. Renames (`a => b`, `{a => b}`) are judged by both names. */
export function parseNumstat(numstat: string): ChangeSize {
    const size: ChangeSize = { files: 0, assets: 0, lines: 0, binary: false, sensitive: [] };
    for (const line of numstat.split("\n")) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        const path = m[3]!.replace(/\\/g, "/");
        const names = path.includes("=>")
            ? [path.replace(/\{([^}]*?) => [^}]*\}/, "$1").replace(/^(.*) => .*$/, "$1"), path.replace(/\{[^}]*? => ([^}]*)\}/, "$1").replace(/^.* => (.*)$/, "$1")]
            : [path];
        if (names.some((n) => SENSITIVE_PATHS.some((re) => re.test(n)))) size.sensitive.push(path);
        if (names.every((n) => ASSET_PATH.test(n))) { size.assets++; continue; }
        size.files++;
        if (m[1] === "-" || m[2] === "-") size.binary = true;
        else size.lines += Number(m[1]) + Number(m[2]);
    }
    return size;
}

/** True when `size` is below the review threshold `maxLines` (0 disables the fast path). */
export function isTrivial(size: ChangeSize, maxLines: number): boolean {
    return maxLines > 0 && size.files + size.assets > 0 && size.files <= MAX_TRIVIAL_FILES && !size.binary
        && size.sensitive.length === 0 && size.lines <= maxLines;
}

/** The size of what `HEAD` adds on top of `base` in `cwd`, or null when git cannot say. */
export function measureChange(cwd: string, base: string): ChangeSize | null {
    const res = spawnSync("git", ["diff", "--numstat", "-M", base, "HEAD", "--"], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return parseNumstat(res.stdout);
}

/** Largest accepted threshold: past it the "trivial" label stops meaning anything. */
export const MAX_TRIVIAL_LINES = 1000;

/** Parses a threshold typed into `enigma config gate-trivial-lines`; throws on anything but 0..MAX. */
export function parseTrivialLines(value: string): number {
    const text = value.trim();
    const n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isInteger(n) || n > MAX_TRIVIAL_LINES) {
        throw new Error(`expected a whole number of lines from 0 to ${MAX_TRIVIAL_LINES}, got "${value}"`);
    }
    return n;
}

/** Past this many changed lines even a copy-only change is a rewrite worth a look. */
export const MAX_COPY_LINES = 400;

/** Prose and translation files: every line in them is copy. */
const COPY_FILE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(locales?|i18n|lang|langs|translations|messages)\/[^/]+\.(json|ya?ml|po|properties|strings|xliff?)$/i;

/** String literals (", ', `) and the text between JSX/HTML tags, which is what copy is in code. */
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const TAG_TEXT = />[^<>{}]*</g;

/** A code line with its copy blanked: two lines equal after this differ only in copy. */
function withoutCopy(line: string): string {
    return line.replace(LITERAL, "\"\"").replace(TAG_TEXT, "><").trim();
}

/**
 * Whether every hunk of `diff` (a `git diff -U0`) only changes copy: whole prose or translation
 * files, or code lines whose removed and added versions differ only inside string literals and
 * tag text. A hunk that adds or removes a line of code, or changes anything outside the copy,
 * makes the change not copy-only - one-sided like the rest of this module.
 */
export function copyOnlyDiff(diff: string): boolean {
    let file = "";
    let removed: string[] = [];
    let added: string[] = [];
    let sawHunk = false;
    const settle = (): boolean => {
        if (!removed.length && !added.length) return true;
        if (COPY_FILE.test(file)) return true;
        if (removed.length !== added.length) return false;
        return removed.every((r, i) => withoutCopy(r) === withoutCopy(added[i]!));
    };
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            if (!settle()) return false;
            removed = []; added = [];
            file = /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? "";
            if (isSensitivePath(file)) return false;
        } else if (line.startsWith("@@")) {
            if (!settle()) return false;
            removed = []; added = [];
            sawHunk = true;
        } else if (line.startsWith("Binary files ")) return false;
        else if (line.startsWith("-") && !line.startsWith("---")) removed.push(line.slice(1));
        else if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    }
    return settle() && sawHunk;
}

/**
 * Trivial by size (`isTrivial`), or a copy-only change of any breadth up to MAX_COPY_LINES: fixing
 * text across a dozen components is the "change a couple of texts" case the size rule sent through
 * the full pipeline - an hour of review for what a typecheck already covers.
 */
export function isTrivialChange(cwd: string, base: string, maxLines: number): { trivial: boolean; size: ChangeSize | null; copyOnly: boolean; } {
    const size = measureChange(cwd, base);
    if (size === null) return { trivial: false, size, copyOnly: false };
    if (isTrivial(size, maxLines)) return { trivial: true, size, copyOnly: false };
    if (maxLines <= 0 || size.binary || size.sensitive.length || size.lines > MAX_COPY_LINES) return { trivial: false, size, copyOnly: false };
    const res = spawnSync("git", ["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", base, "HEAD", "--"], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const copyOnly = res.status === 0 && typeof res.stdout === "string" && copyOnlyDiff(res.stdout);
    return { trivial: copyOnly, size, copyOnly };
}

/** One line for the user: why the change counts as trivial. */
export function describeTrivial(size: ChangeSize, maxLines: number): string {
    const assets = size.assets ? ` plus ${size.assets} image/font asset(s)` : "";
    return `${size.lines} changed line(s) in ${size.files} file(s)${assets}, no sensitive paths (threshold ${maxLines})`;
}
