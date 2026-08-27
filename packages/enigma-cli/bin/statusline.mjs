#!/usr/bin/env node
/**
 * Status bar renderer for agent status lines (Claude Code's `statusLine`).
 *
 * Lives on the launcher's fast path (bin/enigma.mjs), so it stays dependency-free
 * and never resolves the Bun binary: a status bar re-runs on every refresh, and
 * cold-starting a ~260 MB binary each time is not an option. That constraint is
 * also why gate progress arrives through a small snapshot file the daemon writes
 * instead of the gate's SQLite database, which only the Bun runtime can open.
 *
 * Both inputs are optional: the session JSON the agent pipes on stdin, and the
 * gate snapshot. Output is one line at rest, two while a gate run is active.
 *
 * Nothing here may throw. A status bar that errors displays the error until the
 * next refresh, so every reader is guarded and every field is treated as absent
 * until proven otherwise.
 */

import os from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Snapshot schema this renderer understands; a newer file is ignored, not guessed at. */
const SNAPSHOT_VERSION = 2;

/** The pre-map file: a single flat snapshot. Still read during an upgrade, never written. */
const LEGACY_SNAPSHOT_VERSION = 1;

/** Schema version of the code graph's snapshot; a pre-map file carried no version at all. */
const CODEGRAPH_SNAPSHOT_VERSION = 2;

/** Spinner frames, advanced once per second (the status bar's fastest refresh). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";

/**
 * 256-color SGR codes. The status/state colors use the low indices so they follow
 * the terminal's own palette, but greys are pinned to the greyscale ramp: index 8
 * ("bright black") is rendered near-black by many terminals, which makes secondary
 * text vanish on a dark background. 245 matches the weight of the harness's own
 * hint text; `track` is a step quieter, since an empty meter cell is a background
 * rail rather than something to read.
 */
const COLORS = { red: 1, green: 2, yellow: 3, blue: 4, cyan: 6, dim: 245, track: 240, amber: 172 };

/** Built at runtime so no raw control byte ever lives in this source file. */
const ESC = String.fromCharCode(27);

/** Matches any SGR sequence, so styled text can be measured by visible width. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/**
 * How a step status paints its cell in the pipeline bar. `pulse` marks the
 * states that animate, so a parked or working run is visibly alive.
 */
const STEP_STYLES = {
    completed: { color: "green", glyph: BAR_FILLED },
    running: { color: "blue", glyph: BAR_FILLED },
    fixing: { color: "cyan", glyph: BAR_FILLED },
    fix_review: { color: "yellow", glyph: BAR_FILLED, pulse: true },
    awaiting_approval: { color: "yellow", glyph: BAR_FILLED, pulse: true },
    failed: { color: "red", glyph: BAR_FILLED },
    skipped: { color: "dim", glyph: BAR_FILLED },
    pending: { color: "track", glyph: BAR_EMPTY }
};

/** Step statuses that mean the pipeline is working or parked rather than settled. */
const ACTIVE_STEP_STATUSES = new Set(["running", "fixing", "fix_review", "awaiting_approval"]);

/** Run statuses worth showing; a settled run leaves the status bar alone. */
const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);

/**
 * Parses JSON, tolerating a leading UTF-8 BOM. Windows tooling emits one freely,
 * and every reader here fails silently by design, so a BOM would otherwise show
 * up as an inexplicably blank status bar.
 */
function parseJson(text) {
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

/** Wraps text in a 256-color SGR sequence, or returns it unchanged without color. */
function paint(text, color, color256) {
    if (!color256) return text;
    return `${ESC}[38;5;${COLORS[color] ?? COLORS.dim}m${text}${ESC}[0m`;
}

/** Dims a string to the secondary palette entry. */
function dim(text, color256) {
    return paint(text, "dim", color256);
}

/** Visible width of a string, ignoring SGR sequences. */
function width(text) {
    return text.replace(SGR, "").length;
}

/**
 * Joins parts with a separator, dropping the lowest-priority parts (those latest
 * in the list with `optional: true`) until the line fits `max` columns. Required
 * parts are never dropped; an over-long line is truncated as a last resort.
 */
function fit(parts, sep, max) {
    const kept = parts.filter((p) => p && p.text);
    while (kept.length > 1) {
        const line = kept.map((p) => p.text).join(sep);
        if (width(line) <= max) return line;
        const victim = kept.map((p, i) => (p.optional ? i : -1)).filter((i) => i !== -1).pop();
        if (victim === undefined) break;
        kept.splice(victim, 1);
    }
    const line = kept.map((p) => p.text).join(sep);
    return width(line) <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

/** Renders an n-cell meter, e.g. context window usage. */
function meter(fraction, cells, color, color256) {
    const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
    return paint(BAR_FILLED.repeat(filled), color, color256)
        + paint(BAR_EMPTY.repeat(cells - filled), "track", color256);
}

/** Colors a context percentage by pressure: green under 70, yellow under 90, red beyond. */
function pressureColor(pct) {
    if (pct >= 90) return "red";
    if (pct >= 70) return "yellow";
    return "green";
}

/** Compact elapsed time: "42s", "7m12s", "2h05m". */
function formatElapsed(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Reads the token-efficient output level from .enigma.json, mirroring config.ts
 * precedence: global (~/.enigma.json) then local (cwd), nearest wins.
 */
function readOutputStyle() {
    let style = "off";
    for (const dir of [os.homedir(), process.cwd()]) {
        try {
            const raw = parseJson(readFileSync(join(dir, ".enigma.json"), "utf8"));
            if (raw && typeof raw.outputStyle === "string") style = raw.outputStyle;
        } catch { /* missing/invalid .enigma.json - ignore */ }
    }
    return style;
}

/** The [ENIGMA] badge, carrying the active token-efficient level when one is set. */
function badge(color256) {
    const style = readOutputStyle();
    const label = (!style || style === "off") ? "ENIGMA" : `ENIGMA:${style.toUpperCase()}`;
    return paint(`[${label}]`, "amber", color256);
}

/**
 * The code graph's own snapshot, written by its session hooks.
 *
 * Same reason the gate has one: this is a Node script and the engine is compiled into the Bun
 * binary, so the statusline can never call it. A hook that already ran the engine leaves the two
 * numbers worth showing behind in a small file, and this only reads them.
 *
 * Keyed per repository for the same reason the gate snapshot is, and more urgently: the writer
 * is a session hook, so with several projects open every prompt in one of them used to blank
 * this segment in the others. The deepest matching root wins, so a clone nested inside another
 * repository reads its own counters.
 */
export function readCodeGraphStatus(cwd) {
    if (typeof cwd !== "string" || !cwd) return null;
    try {
        const root = process.env.ENIGMA_CODEGRAPH_DIR || join(os.homedir(), ".enigma", "codegraph");
        const file = parseJson(readFileSync(join(root, "statusline.json"), "utf8"));
        if (!file) return null;
        let entries;
        if (file.version === CODEGRAPH_SNAPSHOT_VERSION && file.repos && typeof file.repos === "object") entries = Object.values(file.repos);
        else if (file.version === undefined && typeof file.root === "string") entries = [file];
        else return null;
        // Only speak for the repo this session is actually in - another project's counters
        // on this status line would be worse than none.
        const best = deepestEntryFor(entries, cwd, "root");
        return best === null ? null : { symbols: Number(best.symbols) || 0, stale: Number(best.stale) || 0 };
    } catch { return null; }
}

/** Path to the snapshot the gate daemon writes, mirroring gate/paths.ts. */
export function snapshotPath() {
    const root = process.env.ENIGMA_GATE_HOME || join(os.homedir(), ".enigma", "gate");
    return join(root, "statusline.json");
}

/** Reports whether a process is alive, used to discard a snapshot from a dead daemon. */
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but belongs to another user.
        return err && err.code === "EPERM";
    }
}

/**
 * Loads the gate snapshot for `cwd`, or null when there is nothing to show.
 *
 * The file carries one entry per repository, so a run in another project can no longer
 * take this repository's slot and blank its bar. Where several entries contain `cwd` -
 * a repository checked out inside another one, a worktree, a vendored clone - the
 * deepest root wins, matching how the run ledger resolves the same ambiguity.
 *
 * Rejects an entry that is for another repository, already settled, carries no steps,
 * or was left behind by a daemon that is no longer running. A version-1 file (one flat
 * snapshot, no map) is still read: during an upgrade the renderer is new while the
 * daemon is still the old long-running process, and a dark bar there would look like
 * this very bug.
 */
export function readSnapshot(cwd, path = snapshotPath()) {
    let file;
    try {
        file = parseJson(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
    if (!file) return null;
    let entries;
    if (file.version === SNAPSHOT_VERSION && file.repos && typeof file.repos === "object") entries = Object.values(file.repos);
    else if (file.version === LEGACY_SNAPSHOT_VERSION) entries = [file];
    else return null;
    return deepestEntryFor(entries, cwd, "repoPath", (snap) =>
        ACTIVE_RUN_STATUSES.has(snap.status) && Array.isArray(snap.steps) && snap.steps.length > 0 && pidAlive(snap.pid));
}

/**
 * The entry of a per-repository snapshot file that owns `cwd`, or null when none does.
 *
 * Both files enigma keeps for this bar - the gate snapshot and the code graph's counters - are
 * maps from a repository root to one entry, and both resolve a cwd the same way: skip an entry
 * whose root does not contain it, then let the DEEPEST root win, so a repository checked out
 * inside another one (a worktree, a vendored clone) reads its own entry rather than its
 * parent's. `accept` carries whatever else that file rejects on.
 */
function deepestEntryFor(entries, cwd, key, accept) {
    let best = null;
    for (const entry of entries) {
        if (!entry || typeof entry[key] !== "string") continue;
        if (!isInside(cwd, entry[key])) continue;
        if (accept && !accept(entry)) continue;
        if (best === null || entry[key].length > best[key].length) best = entry;
    }
    return best;
}

/** Reports whether `cwd` is the repo root or a directory beneath it. */
function isInside(cwd, root) {
    const a = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const b = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return a === b || a.startsWith(`${b}/`);
}

/**
 * Renders the base line: the enigma badge, model, project, context meter and
 * session cost. Everything after the badge is optional and drops away on a
 * narrow terminal, in reverse order of usefulness.
 */
function renderBase(session, columns, color256) {
    const model = session?.model?.display_name;
    const dir = session?.workspace?.current_dir || session?.cwd;
    const project = typeof dir === "string" ? dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() : null;
    const pct = session?.context_window?.used_percentage;
    const cost = session?.cost?.total_cost_usd;

    const parts = [{ text: badge(color256) }];
    if (model) parts.push({ text: paint(model, "cyan", color256), optional: true });
    if (project) parts.push({ text: dim(project, color256), optional: true });
    if (typeof pct === "number") {
        const rounded = Math.round(pct);
        parts.push({
            text: `${meter(rounded / 100, 8, pressureColor(rounded), color256)} ${dim(`${rounded}%`, color256)}`,
            optional: true
        });
    }
    if (typeof cost === "number" && cost > 0) {
        parts.push({ text: dim(`$${cost.toFixed(2)}`, color256), optional: true });
    }
    const graph = readCodeGraphStatus(dir);
    if (graph && graph.symbols > 0) {
        // Stale is the only part worth a colour: a graph that has fallen behind the code answers
        // confidently and wrongly, and nothing else on the line would show it.
        const label = graph.stale > 0
            ? `${dim(`graph ${graph.symbols}`, color256)} ${paint(`${graph.stale} stale`, "yellow", color256)}`
            : dim(`graph ${graph.symbols}`, color256);
        parts.push({ text: label, optional: true });
    }
    return fit(parts, "  ", columns);
}

/**
 * Renders the gate line: a spinner, one bar cell per pipeline step, the step
 * count, the active step with its elapsed time, and the PR once one exists.
 *
 * The bar doubles as the legend - cell N is step N - so the whole pipeline fits
 * one line. The active cell alternates glyph each frame, which is what makes a
 * long step visibly still working rather than hung.
 */
function renderGate(snap, columns, frame, nowSec, color256) {
    const steps = snap.steps.filter((s) => s && typeof s.name === "string");
    const done = steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    const active = steps.find((s) => ACTIVE_STEP_STATUSES.has(s.status));
    const failed = steps.find((s) => s.status === "failed");
    const current = active ?? failed;

    const cells = steps.map((s) => {
        const style = STEP_STYLES[s.status] ?? STEP_STYLES.pending;
        const glyph = style.pulse && frame % 2 === 1 ? BAR_EMPTY : style.glyph;
        return paint(glyph, style.color, color256);
    }).join("");

    // The spinner turns only while a step is actually working; a failed run holds
    // a red marker instead, so a stalled pipeline never looks like a busy one.
    const spinner = active
        ? paint(SPINNER[frame % SPINNER.length], snap.awaiting ? "yellow" : "blue", color256)
        : paint(BAR_FILLED, failed ? "red" : "dim", color256);

    let labelColor = "blue";
    if (snap.awaiting) labelColor = "yellow";
    else if (!active && failed) labelColor = "red";
    const label = snap.awaiting ? "needs you" : (current ? current.name : snap.status);
    // A negative age means the snapshot and this process disagree about the clock.
    // Dropping the segment is honest; a confident "0s" is not.
    const started = current?.startedAt ?? snap.startedAt;
    const age = typeof started === "number" ? nowSec - started : -1;
    const elapsed = age >= 0 ? formatElapsed(age) : null;

    const parts = [
        { text: `${spinner} ${dim("gate", color256)}` },
        { text: cells },
        { text: dim(`${done}/${steps.length}`, color256) },
        { text: paint(label, labelColor, color256) }
    ];
    if (elapsed) parts.push({ text: dim(elapsed, color256), optional: true });
    if (typeof snap.branch === "string" && snap.branch) {
        parts.push({ text: dim(snap.branch, color256), optional: true });
    }
    if (typeof snap.prUrl === "string") {
        const num = snap.prUrl.match(/\/(\d+)(?:\/)?$/);
        if (num) parts.push({ text: dim(`PR #${num[1]}`, color256), optional: true });
    }
    return fit(parts, "  ", columns);
}

/**
 * Builds the full status bar. `frame` drives the animation and is derived from
 * wall-clock seconds by the caller, so consecutive refreshes advance it without
 * this module holding any state.
 */
export function render({ session, snapshot, columns = 80, frame = 0, nowSec = 0, color256 = true }) {
    const lines = [renderBase(session, columns, color256)];
    if (snapshot) lines.push(renderGate(snapshot, columns, frame, nowSec, color256));
    return lines.join("\n");
}

/**
 * How long to wait for the harness to pipe in the session JSON before rendering
 * without it. Only reached when nothing parseable ever arrives; a complete write
 * resolves the read immediately, whether or not the pipe is then closed.
 */
const STDIN_TIMEOUT_MS = 2000;

/** Hard bound on the drain that follows the write, so the caller always gets to exit. */
const DRAIN_TIMEOUT_MS = 1000;

/** Ceiling on the piped session, past which the stream is garbage rather than a slow writer. */
const MAX_SESSION_BYTES = 1_000_000;

/**
 * Reads the piped session JSON, or null when nothing usable is piped in.
 *
 * Deliberately a streaming read rather than `readFileSync(0)`: that call blocks
 * until EOF, so a harness that writes the session and leaves the pipe open leaves
 * this process hung forever. It was observed leaking one orphaned renderer per
 * session on Windows - each holding ~38 MB and a pipe handle until reboot - which
 * is exactly the machine-wide pressure a status bar must never create.
 *
 * Ways out, in the order they fire in practice: the buffer parses as JSON (the
 * harness has written everything, close or no close), the pipe reaches EOF, or the
 * bar renders in its degraded form because the timeout expired or the writer ran
 * past the point where it is still plausibly a session.
 */
export function readSession(stream = process.stdin, timeoutMs = STDIN_TIMEOUT_MS) {
    return new Promise((resolve) => {
        if (stream.isTTY) return resolve(null);
        let buffer = "";
        let settled = false;
        const timer = setTimeout(() => finish(null), timeoutMs);
        const parsed = () => {
            try {
                return parseJson(buffer);
            } catch {
                // A partial write is not valid JSON, so this only settles once the
                // harness has finished writing the object.
                return undefined;
            }
        };
        const onData = (chunk) => {
            buffer += chunk;
            if (buffer.length > MAX_SESSION_BYTES) return finish(null);
            // Only a complete object can parse, so the scan is worth one closing
            // brace to skip re-parsing a buffer that is still mid-write.
            if (!buffer.trimEnd().endsWith("}")) return;
            const value = parsed();
            if (value !== undefined) finish(value);
        };
        const onEnd = () => finish(parsed() ?? null);
        const onError = () => finish(null);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            buffer = "";
            // Every exit has to stop the flow as well as answer the caller: a stream
            // left attached goes on appending to a buffer nobody will read, which is
            // the cap failing to cap, and on a stream this process does not own the
            // listeners would outlive the read entirely.
            try {
                stream.removeListener("data", onData);
                stream.removeListener("end", onEnd);
                stream.removeListener("error", onError);
                stream.pause();
            } catch { /* a stream that cannot be detached is one already gone */ }
            resolve(value);
        };
        try {
            stream.setEncoding("utf8");
            stream.on("data", onData);
            stream.on("end", onEnd);
            stream.on("error", onError);
        } catch {
            finish(null);
        }
    });
}

/** Streams whose asynchronous write failures are already swallowed. */
const silenced = new WeakSet();

/**
 * Swallows a stream's asynchronous write failures, once per stream.
 *
 * A reader that is already gone answers the write with EPIPE an event-loop turn
 * later, and Node escalates an unhandled `error` event to an uncaught exception:
 * a stack trace on stderr and a nonzero exit, from a bar whose whole contract is
 * to stay quiet. The listener has to outlive the drain it protects, because the
 * event arrives after the failed write has already reported back.
 */
function silenceWriteErrors(stream) {
    if (silenced.has(stream)) return;
    silenced.add(stream);
    stream.on("error", () => {});
}

/**
 * Writes the bar and resolves once it has drained, so the caller can exit.
 *
 * Destroying stdin is what releases the process: the harness may leave its end of
 * the pipe open, and an open stdin keeps the event loop - and this process - alive
 * for as long as it lasts. The timer covers the other half of the same problem, a
 * stdout whose reader is already gone and whose drain callback never fires.
 */
function drain(text) {
    return new Promise((resolve) => {
        try {
            process.stdin.destroy();
        } catch { /* nothing was piped in */ }
        const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
        const done = () => { clearTimeout(timer); resolve(); };
        try {
            silenceWriteErrors(process.stdout);
            process.stdout.write(text, done);
        } catch {
            done();
        }
    });
}

/** Entry point for `enigma statusline`. Prints the bar and never throws. Await it: it resolves when the write has drained and the process is free to exit. */
export async function printStatusline() {
    let text = "";
    try {
        const session = await readSession();
        const cwd = session?.workspace?.current_dir || session?.cwd || process.cwd();
        const columns = Number(process.env.COLUMNS) || 80;
        const nowSec = Math.floor(Date.now() / 1000);
        text = render({
            session,
            snapshot: readSnapshot(cwd),
            columns,
            frame: nowSec,
            nowSec,
            color256: !process.env.NO_COLOR
        });
    } catch {
        // A status bar must never error or emit noise.
    }
    await drain(text);
}
