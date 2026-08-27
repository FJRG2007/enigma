/**
 * CI failure notifier: tell the agent that the workflow its push triggered has failed,
 * with the reason attached, without the agent ever asking.
 *
 * The problem it solves is a round trip that costs a person's time: the agent pushes,
 * carries on, and the only way it learns the build broke is the user noticing and pasting
 * the red checks in by hand. Polling from the agent is the obvious fix and the wrong one -
 * every check burns model tokens on the overwhelmingly common answer, "still green".
 *
 * So nothing runs in the model's loop. Two halves, neither of which the agent pays for:
 *
 *  - a DETACHED poller (`enigma __ci-watch <repo> <sha>`), spawned once per push, which
 *    talks to `gh` on its own and writes what it finds to a state file. It is an ordinary
 *    background process: its waiting costs nothing but wall clock.
 *  - the hook (`enigma __ci-hook`), which fires at tool boundaries anyway. It reads the
 *    state file and prints a report ONLY when there is a failure that has not been
 *    delivered yet. On a green build it writes nothing at all, so the feature's cost in
 *    the passing case - which is most of them - is exactly zero tokens.
 *
 * Non-blocking by construction: the hook never denies anything and always exits 0. The
 * agent finds out at its next tool call, which is soon enough to fix the build and late
 * enough to not interrupt what it was doing.
 *
 * State lives in `~/.enigma/ci-watch/state.json`, one entry per repository, the same shape
 * `gate-ledger.ts` and the status-line snapshot use - a single global slot would let one
 * project's build report overwrite another's.
 */

import { enigmaHome } from "./util";
import { isCiWatchOn } from "./ci-watch-deploy";
import { basename, join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Schema version of the state file. */
const STATE_VERSION = 1;

/** Cap on remembered repositories, mirroring the run ledger and the status-line snapshot. */
const MAX_REPOS = 100;

/** How long the detached poller keeps asking before giving up on checks that never settle. */
const POLL_BUDGET_MS = 30 * 60_000;

/** Gap between polls. GitHub's API is rate limited and a workflow takes minutes, not seconds. */
const POLL_INTERVAL_MS = 30_000;

/** How recently the tracking ref must have been pushed for the build to still be ours to fix. */
const PUSH_RECENCY_MS = 10 * 60_000;

/** How long a push is given to register a workflow run before we conclude it triggered none. */
const RUN_REGISTER_GRACE_MS = 3 * 60_000;

/** Cap on the failing-log excerpt handed to the agent, in characters. */
const LOG_EXCERPT_LIMIT = 4000;

/** Trailing lines of the failed step's log to keep - the error is at the end, not the start. */
const LOG_EXCERPT_LINES = 60;

/** Conclusions that mean the build is broken. `cancelled` is deliberate and not reported. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** One failed workflow run, as the agent needs to read it. */
interface FailureReport {
    sha: string;
    workflow: string;
    job: string;
    url: string;
    log: string;
}

/** What is known about one repository's most recent pushed commit. */
interface RepoState {
    repoPath: string;
    /** The pushed commit currently being watched or already judged. */
    sha: string;
    /** Set once the poller reaches a verdict; absent while it is still waiting. */
    failure?: FailureReport;
    /** True once the hook has handed this failure to the agent, so it is reported once. */
    delivered?: boolean;
    at: number;
}

/** The serialized file: one entry per repository, keyed by its root. */
interface StateFile {
    version: number;
    repos: Record<string, RepoState>;
}

/** Path to the state file the poller writes and the hook reads. */
export function ciWatchStatePath(): string {
    return join(process.env.ENIGMA_CI_WATCH_DIR || join(enigmaHome(), "ci-watch"), "state.json");
}

/** Reads the state file, or an empty one when it is missing, corrupt or a version we do not write. */
function readState(path = ciWatchStatePath()): StateFile {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as StateFile;
        if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.repos !== "object" || parsed.repos === null) {
            return { version: STATE_VERSION, repos: {} };
        }
        return parsed;
    } catch { return { version: STATE_VERSION, repos: {} }; }
}

/**
 * Writes the state file atomically (temp file plus rename): the hook reads it at arbitrary
 * moments and must never parse half a write. Failures are swallowed - a notifier that can
 * break the agent's turn is worse than one that misses a report.
 */
function writeState(file: StateFile, path = ciWatchStatePath()): void {
    try {
        const entries = Object.entries(file.repos);
        if (entries.length > MAX_REPOS) {
            entries.sort((a, b) => b[1].at - a[1].at);
            file.repos = Object.fromEntries(entries.slice(0, MAX_REPOS));
        }
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(file)}\n`);
        renameSync(tmp, path);
    } catch { /* a derived cache; losing a write costs one missed report */ }
}

/** Runs a command and returns trimmed stdout, or null when it is unusable or fails. */
function run(bin: string, args: string[], cwd?: string, timeout = 20_000): string | null {
    try {
        const r = spawnSync(bin, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
        if (r.status !== 0) return null;
        return (r.stdout || "").trim();
    } catch { return null; }
}

/** The repository root containing `cwd`, or null when it is not a work tree. */
export function repoRootOf(cwd: string): string | null {
    const root = run("git", ["rev-parse", "--show-toplevel"], cwd, 10_000);
    return root === null || root === "" ? null : root.replace(/\\/g, "/");
}

/**
 * Whether the tracking ref moved because THIS repository pushed, moments ago.
 *
 * Git records why a remote-tracking ref moved, and the wording is the discriminator: a push
 * writes "update by push", while a fetch or a pull writes "<command>: fast-forward". Without
 * that test every way of acquiring commits arms a watch - `git pull` leaves the upstream an
 * ancestor of HEAD exactly like a push does - and the agent is handed a build it never
 * touched, which is worse than no notifier at all.
 *
 * The recency window is the second half of the same guard. A tracking ref keeps the last push
 * in its reflog forever, so `git checkout` of a branch pushed last week would otherwise look
 * identical to a push made now; a build that old has been dealt with by someone already.
 */
function recentlyPushed(repoRoot: string, ref: string): boolean {
    const entry = run("git", ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", "-1", ref], repoRoot, 10_000);
    if (entry === null || entry === "") return false;
    const [selector = "", subject = ""] = entry.split("\t");
    if (!subject.startsWith("update by push")) return false;
    const at = Number(/@\{(\d+)\}/.exec(selector)?.[1] ?? "");
    return Number.isFinite(at) && at > 0 && Date.now() - at * 1000 <= PUSH_RECENCY_MS;
}

/**
 * The commit the tracking branch points at, but only when it is one this repository
 * actually pushed, just now.
 *
 * The ancestor test keeps a ref that moved to something we do not have from arming a watch;
 * the reflog test above is what separates an actual push from every other way that ref moves.
 * One `rev-parse` answers both "where" and "which ref", so the added precision costs one
 * subprocess, not two.
 */
function pushedHead(repoRoot: string): string | null {
    const out = run("git", ["rev-parse", "@{u}", "--symbolic-full-name", "@{u}"], repoRoot, 10_000);
    if (out === null) return null;
    const [upstream = "", ref = ""] = out.split("\n").map(l => l.trim());
    if (upstream === "" || ref === "") return null;
    const r = spawnSync("git", ["merge-base", "--is-ancestor", upstream, "HEAD"], { cwd: repoRoot, windowsHide: true, timeout: 10_000 });
    if (r.status !== 0) return null;
    return recentlyPushed(repoRoot, ref) ? upstream : null;
}

/** Resolves the `gh` binary, honoring the same override the rest of enigma uses. */
function ghBin(): string {
    return process.env.ENIGMA_GH_BIN || "gh";
}

/** Raw `gh run list` row, narrowed to the fields the verdict needs. */
interface RunRow {
    databaseId: number;
    workflowName: string;
    status: string;
    conclusion: string;
}

/** The workflow runs GitHub has for `sha`, or null when gh cannot answer. */
function runsForSha(repoRoot: string, sha: string): RunRow[] | null {
    const out = run(ghBin(), ["run", "list", "--commit", sha, "--limit", "40", "--json", "databaseId,workflowName,status,conclusion"], repoRoot, 30_000);
    if (out === null) return null;
    try {
        const rows = JSON.parse(out) as RunRow[];
        return Array.isArray(rows) ? rows : null;
    } catch { return null; }
}

/**
 * The tail of a failed run's log, which is where the error is. Trimmed hard: this text is
 * spent from the agent's context window, and a workflow log is measured in megabytes.
 */
function failureLog(repoRoot: string, runId: number): { job: string; log: string; } {
    const raw = run(ghBin(), ["run", "view", String(runId), "--log-failed"], repoRoot, 60_000) || "";
    const lines = raw.split("\n").filter(l => l.trim() !== "");
    // `gh` prefixes every line with "<job>\t<step>\t<text>"; the job name is worth keeping
    // and the repeated prefix is not.
    const job = (lines[0] || "").split("\t")[0] || "";
    const stripped = lines.map(l => {
        const parts = l.split("\t");
        return parts.length >= 3 ? parts.slice(2).join("\t") : l;
    });
    let log = stripped.slice(-LOG_EXCERPT_LINES).join("\n");
    if (log.length > LOG_EXCERPT_LIMIT) log = `...\n${log.slice(-LOG_EXCERPT_LIMIT)}`;
    return { job, log };
}

/**
 * Records the verdict for `sha`, replacing this repository's entry and leaving others alone.
 *
 * A no-op once the entry has moved on to a newer commit. A poller lives up to half an hour, so
 * a second push overtakes the first routinely, and writing the older verdict back would undo
 * the newer push's claim on the slot: the hook would see a SHA it has not watched, arm a
 * duplicate poller for it, and - the entry having lost its `delivered` flag on the way - hand
 * the agent the same failure a second time.
 */
function recordVerdict(repoRoot: string, sha: string, failure: FailureReport | null): void {
    const state = readState();
    if (state.repos[repoRoot]?.sha !== sha) return;
    const entry: RepoState = { repoPath: repoRoot, sha, at: Date.now() };
    if (failure) entry.failure = failure;
    state.repos[repoRoot] = entry;
    writeState(state);
}

/**
 * The detached poller. Waits for every workflow on `sha` to settle, then records the first
 * failure with its log, or clears the entry when the build is green.
 *
 * Bounded rather than open-ended: a workflow queued behind a busy runner, or one waiting on
 * an environment approval, would otherwise leave this process alive indefinitely.
 *
 * A push that triggers no run at all stands down far sooner. GitHub registers a run within
 * seconds, so an empty answer that stays empty past the grace period means this repository has
 * no workflow for the commit - and spending the whole budget on it would cost sixty API calls
 * per push in every repository that has a GitHub remote and nothing to build.
 */
export async function runCiWatchPoll(repoRoot: string, sha: string): Promise<number> {
    const started = Date.now();
    const deadline = started + POLL_BUDGET_MS;
    for (;;) {
        const rows = runsForSha(repoRoot, sha);
        // gh unusable (absent, unauthenticated, not a GitHub remote) is a silent stand-down:
        // this feature is a convenience and must never announce its own plumbing.
        if (rows === null) return 0;
        if (rows.length === 0 && Date.now() - started >= RUN_REGISTER_GRACE_MS) return 0;
        const settled = rows.length > 0 && rows.every(r => r.status === "completed");
        if (settled) {
            const failed = rows.find(r => FAILED_CONCLUSIONS.has(r.conclusion));
            if (!failed) {
                recordVerdict(repoRoot, sha, null);
                return 0;
            }
            const { job, log } = failureLog(repoRoot, failed.databaseId);
            const url = run(ghBin(), ["run", "view", String(failed.databaseId), "--json", "url", "--jq", ".url"], repoRoot, 20_000) || "";
            recordVerdict(repoRoot, sha, { sha, workflow: failed.workflowName, job, url, log });
            return 0;
        }
        if (Date.now() >= deadline) return 0;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

/** Spawns the poller for `sha` and returns immediately; the child outlives this process. */
function startPoller(repoRoot: string, sha: string): void {
    try {
        // Same runtime dispatch as the lint-install/update-check children: a compiled binary
        // takes the hidden command directly (every arg goes to the embedded CLI); node/bun on
        // the source entry need the entry path (argv[1]) before it. Getting this wrong is
        // invisible - the SHA is claimed either way, and the child that never polls simply
        // exits, so the watch looks armed and no verdict ever arrives.
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = dev ? [process.argv[1]!, "__ci-watch", repoRoot, sha] : ["__ci-watch", repoRoot, sha];
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true
        });
        // A spawn failure surfaces as an async `error` event; with no listener the child
        // rethrows it as an uncaught exception, which this try/catch cannot intercept - and
        // here that would crash the hook the agent's tool call is waiting on.
        child.on("error", () => { /* the watch just did not arm */ });
        child.unref();
    } catch { /* the notifier is a convenience; failing to arm it changes nothing else */ }
}

/**
 * The block handed to the agent. Written as an instruction because it is one.
 *
 * The log section is dropped when there is no excerpt - `gh` cannot read the logs of an
 * expired run, and a heading followed by nothing reads as "fix this, reason withheld". The
 * run URL is what is left to go on, so it carries the report on its own.
 */
function reportText(failure: FailureReport): string {
    const where = failure.job === "" ? failure.workflow : `${failure.workflow} / ${failure.job}`;
    const log = String(failure.log ?? "").trim();
    return [
        `The GitHub Actions run for the commit you pushed (${String(failure.sha ?? "").slice(0, 8)}) FAILED: ${where}.`,
        String(failure.url ?? ""),
        "",
        ...log === "" ? [] : ["The tail of the failing step's log:", "", log, ""],
        "Fix it now rather than reporting the push as finished. Nothing is blocked - this arrived on its own, no one asked for it."
    ].join("\n");
}

/** Whether `dir` is `root` itself or a directory beneath it (case-insensitive, as Windows is). */
function isInside(dir: string, root: string): boolean {
    const a = String(dir || "").split("\\").join("/").replace(/[/]+$/, "").toLowerCase();
    const b = String(root || "").split("\\").join("/").replace(/[/]+$/, "").toLowerCase();
    return a === b || a.startsWith(`${b}/`);
}

/**
 * The recorded state for the repository containing `cwd`, deepest root first so a clone
 * nested inside another repository reads its own verdict.
 *
 * Matching on the recorded path rather than resolving the git root is deliberate: delivery
 * runs at every tool boundary, and it must not cost a subprocess to answer "nothing to say"
 * - which is the answer almost every time.
 */
function entryFor(file: StateFile, cwd: string): RepoState | null {
    let best: RepoState | null = null;
    for (const entry of Object.values(file.repos)) {
        if (!entry || typeof entry.repoPath !== "string") continue;
        if (!isInside(cwd, entry.repoPath)) continue;
        if (best === null || entry.repoPath.length > best.repoPath.length) best = entry;
    }
    return best;
}

/** Emits additional context for the agent, in the shape Claude Code's hooks expect. */
function emit(event: string, additionalContext: string): void {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

/**
 * The hook. Does two things per tool boundary, both cheap, and prints only when there is
 * something the agent did not already know:
 *
 *  1. Delivers a failure the poller has recorded and has not been handed over yet, then
 *     marks it delivered so a build breaks the agent's flow once rather than every tick.
 *  2. On PostToolUse only, notices that this repository has just pushed the tracking branch
 *     and arms a poller for that commit. Delivery happens on every event; arming does not,
 *     because it costs subprocesses and UserPromptSubmit cannot afford them.
 *
 * Always exits 0. A notifier that can deny a tool call would be a worse problem than the
 * one it was written to solve.
 */
export function runCiWatchHook(payload: string, event = "PostToolUse"): number {
    if (!isCiWatchOn()) return 0;
    let cwd = "";
    try {
        cwd = String((JSON.parse(payload) as { cwd?: string; }).cwd ?? "");
    } catch { /* an unreadable payload just means we fall back to the process cwd */ }
    if (cwd === "") cwd = process.cwd();
    const state = readState();
    const entry = entryFor(state, cwd);
    if (entry?.failure && !entry.delivered) {
        entry.delivered = true;
        writeState(state);
        emit(event, reportText(entry.failure));
        return 0;
    }

    // Arming is the expensive half - four git subprocesses to answer "did you push?" - and
    // UserPromptSubmit is the wrong place to spend them: that hook chain runs before the turn
    // starts, several tools share its budget, and it was already timing out on a loaded box
    // before this feature added to it. A push comes from Bash, so PostToolUse arms and
    // UserPromptSubmit only ever delivers, which costs one JSON read.
    if (event !== "PostToolUse") return 0;
    const repoRoot = repoRootOf(cwd);
    if (repoRoot === null) return 0;
    const head = pushedHead(repoRoot);
    if (head === null || head === state.repos[repoRoot]?.sha) return 0;
    // Claim the SHA before spawning: two tool calls landing together would otherwise arm
    // two pollers for the same commit and report the same failure twice.
    state.repos[repoRoot] = { repoPath: repoRoot, sha: head, at: Date.now() };
    writeState(state);
    startPoller(repoRoot, head);
    return 0;
}
