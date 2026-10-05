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
 * it is never trivial either. The rule is deliberately one-sided: a false "trivial" skips a
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

export interface ChangeSize {
    files: number;
    /** Added + deleted lines across text files. */
    lines: number;
    /** Some file has no line count (binary). */
    binary: boolean;
    /** Changed paths that always warrant a review. */
    sensitive: string[];
}

/** Sizes a `git diff --numstat` listing. Renames (`a => b`, `{a => b}`) are judged by both names. */
export function parseNumstat(numstat: string): ChangeSize {
    const size: ChangeSize = { files: 0, lines: 0, binary: false, sensitive: [] };
    for (const line of numstat.split("\n")) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        size.files++;
        if (m[1] === "-" || m[2] === "-") size.binary = true;
        else size.lines += Number(m[1]) + Number(m[2]);
        const path = m[3]!.replace(/\\/g, "/");
        const names = path.includes("=>")
            ? [path.replace(/\{([^}]*?) => [^}]*\}/, "$1").replace(/^(.*) => .*$/, "$1"), path.replace(/\{[^}]*? => ([^}]*)\}/, "$1").replace(/^.* => (.*)$/, "$1")]
            : [path];
        if (names.some((n) => SENSITIVE_PATHS.some((re) => re.test(n)))) size.sensitive.push(path);
    }
    return size;
}

/** True when `size` is below the review threshold `maxLines` (0 disables the fast path). */
export function isTrivial(size: ChangeSize, maxLines: number): boolean {
    return maxLines > 0 && size.files > 0 && size.files <= MAX_TRIVIAL_FILES && !size.binary
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

/** One line for the user: why the change counts as trivial. */
export function describeTrivial(size: ChangeSize, maxLines: number): string {
    return `${size.lines} changed line(s) in ${size.files} file(s), no sensitive paths (threshold ${maxLines})`;
}
