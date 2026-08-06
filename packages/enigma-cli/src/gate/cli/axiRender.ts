/**
 * Render-ready views of a pipeline run and the TOON field builders the axi
 * surface emits. Faithful port of upstream's `internal/cli/axi_render.go`,
 * decoupled from whether a run came from the daemon (ipc) or the local database.
 *
 * Output helpers (`emitDoc`/`emitError`) write through an `AxiIO` so the daemon
 * split is preserved: TOON documents go to stdout, progress to stderr.
 */

import type { FixPolicy } from "../config";
import type { Run, StepResult } from "../db";
import type { RunInfo } from "../ipc/protocol";
import {
    type Findings,
    ACTION_ASKUSER,
    ACTION_AUTOFIX,
    parseFindingsJSON
} from "../types";
import {
    field,
    axiDoc,
    toonHelp,
    toonTable,
    toonObject,
    type ToonField
} from "../toon";

/**
 * The injectable clock (unix seconds), so parked-duration rendering is
 * deterministic under test, mirroring the Go `nowUnix` package var.
 */
let nowUnixFn: () => number = () => Math.floor(Date.now() / 1000);

/** Returns the current time in unix seconds. */
export function nowUnix(): number {
    return nowUnixFn();
}

/** Overrides the render clock (test hook). */
export function setNowUnix(fn: () => number): void {
    nowUnixFn = fn;
}

/**
 * maxFindingDesc caps a finding description rendered inline. Findings are the
 * decision content at a gate, so the limit is generous; only pathological
 * descriptions get truncated, with the full length disclosed.
 */
const maxFindingDesc = 600;

/** Where a finished TOON document and live progress are written. */
export interface AxiIO {
    stdout(s: string): void;
    stderr(s: string): void;
}

/** The process stdout/stderr writer used outside tests. */
export function defaultIO(): AxiIO {
    return {
        stdout: s => process.stdout.write(s),
        stderr: s => process.stderr.write(s)
    };
}

/** Writes a finished TOON document to stdout. */
export function emitDoc(io: AxiIO, fields: ToonField[]): void {
    io.stdout(axiDoc(fields));
}

/**
 * Renders a structured TOON error to stdout and returns the exit code, so the
 * caller exits non-zero without printing a raw error.
 */
export function emitError(io: AxiIO, code: number, msg: string, ...help: string[]): number {
    const fields: ToonField[] = [field("error", msg)];
    if (help.length > 0) fields.push(toonHelp(help));
    emitDoc(io, fields);
    return code;
}

/** A render-ready view of a single pipeline step. */
export interface StepView {
    name: string;
    status: string;
    durationMS: number;
    findingsJSON: string;
    fixSummaries: string[];
}

/** A render-ready view of a pipeline run. */
export interface RunView {
    id: string;
    branch: string;
    status: string;
    headSHA: string;
    prURL: string;
    /**
     * Unix-seconds time the run parked at a gate awaiting the driving agent, or
     * null when not parked. Powers the top-level parked signal in the run object.
     */
    awaitingAgentSince: number | null;
    steps: StepView[];
}

/** Builds a render view from the daemon's IPC run representation. */
export function runViewFromIPC(r: RunInfo): RunView {
    return {
        id: r.id,
        branch: r.branch,
        status: r.status,
        headSHA: r.headSha,
        prURL: r.prUrl ?? "",
        awaitingAgentSince: r.awaitingAgentSince,
        steps: r.steps.map(s => ({
            name: s.stepName,
            status: s.status,
            durationMS: s.durationMs ?? 0,
            findingsJSON: s.findingsJson ?? "",
            fixSummaries: s.fixSummaries
        }))
    };
}

/** Builds a render view from a database run row plus its step results. */
export function runViewFromDB(r: Run, steps: StepResult[]): RunView {
    return {
        id: r.id,
        branch: r.branch,
        status: r.status,
        headSHA: r.headSha,
        prURL: r.prUrl ?? "",
        awaitingAgentSince: r.awaitingAgentSince,
        steps: steps.map(s => ({
            name: s.stepName,
            status: s.status,
            durationMS: s.durationMs ?? 0,
            findingsJSON: s.findingsJson ?? "",
            fixSummaries: []
        }))
    };
}

/**
 * Returns the step currently blocking on a human decision, or null. At most one
 * step awaits at a time, so the first match is the active gate.
 */
export function awaitingStep(rv: RunView): StepView | null {
    for (const s of rv.steps) {
        if (s.status === "awaiting_approval" || s.status === "fix_review") return s;
    }
    return null;
}

/** Reports whether a run has reached a final state. */
export function terminalStatus(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

/** Maps a terminal run status onto an agent-facing outcome word. */
export function outcomeFor(status: string): string {
    switch (status) {
        case "completed":
            return "passed";
        case "failed":
            return "failed";
        case "cancelled":
            return "cancelled";
        default:
            return status;
    }
}

/**
 * Renders how long a run has been parked awaiting the agent, given the unix
 * seconds it parked, so a supervisor tells a fresh park ("parked 4s") from a
 * stalled one ("parked 18m20s") in a single `axi status` read.
 */
export function formatParkedFor(sinceUnix: number): string {
    let secs = nowUnix() - sinceUnix;
    if (secs < 0) secs = 0;
    if (secs < 60) return `parked ${secs}s`;
    if (secs < 3600) return `parked ${Math.floor(secs / 60)}m${secs % 60}s`;
    if (secs < 86400) return `parked ${Math.floor(secs / 3600)}h${Math.floor(secs / 60) % 60}m`;
    const totalHours = Math.floor(secs / 3600);
    return `parked ${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
}

/** Trims a commit SHA for display. */
export function shortSHA(sha: string): string {
    return sha.length > 8 ? sha.slice(0, 8) : sha;
}

/** Parses findings JSON, returning null on any decode error. */
function tryParseFindings(json: string): Findings | null {
    try {
        return parseFindingsJSON(json);
    } catch {
        return null;
    }
}

/** Returns the number of findings recorded for a step. */
function findingCount(s: StepView): number {
    if (s.findingsJSON === "") return 0;
    const parsed = tryParseFindings(s.findingsJSON);
    return parsed ? parsed.items.length : 0;
}

/** Joins parts with ", ", matching the Go helper. */
function joinComma(parts: string[]): string {
    return parts.join(", ");
}

/**
 * Summarizes a run's findings across all steps by action, so an agent sees the
 * shape of outstanding work without a follow-up call.
 */
export function findingsTally(rv: RunView): string {
    let awaiting = 0;
    let autofix = 0;
    let info = 0;
    for (const s of rv.steps) {
        if (s.findingsJSON === "") continue;
        const parsed = tryParseFindings(s.findingsJSON);
        if (!parsed) continue;
        for (const f of parsed.items) {
            switch (f.action) {
                case ACTION_ASKUSER:
                    awaiting++;
                    break;
                case ACTION_AUTOFIX:
                    autofix++;
                    break;
                default:
                    info++;
            }
        }
    }
    const parts: string[] = [];
    if (awaiting > 0) parts.push(`${awaiting} awaiting`);
    if (autofix > 0) parts.push(`${autofix} auto-fix`);
    if (info > 0) parts.push(`${info} info`);
    if (parts.length === 0) return "none";
    return joinComma(parts);
}

/**
 * Flattens the fixes the pipeline applied across all steps into renderable rows,
 * in step then round order. A fix round that recorded no summary still produced
 * a fix commit, so it gets an explicit placeholder rather than being dropped.
 */
export function fixRows(rv: RunView): string[][] {
    const rows: string[][] = [];
    for (const s of rv.steps) {
        for (const raw of s.fixSummaries) {
            const summary = raw === "" ? "fix applied (no summary recorded)" : raw;
            rows.push([s.name, summary]);
        }
    }
    return rows;
}

/** Renders a run as a TOON `run:` object with a steps table. */
export function runObjectField(rv: RunView): ToonField {
    return runObjectFieldWithKey("run", rv);
}

/** Renders a run as a TOON object under an arbitrary key. */
export function runObjectFieldWithKey(key: string, rv: RunView): ToonField {
    const fields: ToonField[] = [
        field("id", rv.id),
        field("branch", rv.branch),
        field("status", rv.status)
    ];
    // Surface the parked-awaiting-agent signal right after status so one read
    // distinguishes a run waiting for the agent to drive a gate from one that is
    // actively running/fixing/ci. Present only while genuinely parked (non-null
    // marker on a non-terminal run).
    if (rv.awaitingAgentSince !== null && !terminalStatus(rv.status)) {
        fields.push(field("awaiting_agent", formatParkedFor(rv.awaitingAgentSince)));
    }
    fields.push(field("head", shortSHA(rv.headSHA)));
    if (rv.prURL !== "") fields.push(field("pr", rv.prURL));
    fields.push(field("findings", findingsTally(rv)));

    const rows = rv.steps.map(s => [s.name, s.status, findingCount(s), s.durationMS] as (string | number)[]);
    fields.push(toonTable("steps", ["step", "status", "findings", "duration_ms"], rows));
    return field(key, toonObject(fields));
}

/**
 * What the configured `fix_policy` means for the agent standing at this gate.
 * The drive loop already enforces the policy by deciding which gates it hands
 * back at all; this line only tells the agent why it is holding one, so it does
 * not escalate a finding the user asked it to settle (or settle one the user
 * asked to be consulted about).
 */
const FIX_POLICY_HELP: Record<FixPolicy, string> = {
    auto: "fix_policy is `auto`: the user asked you to settle every finding yourself. This gate came back because the run needs a response, not a decision - respond without checking back.",
    assisted: "fix_policy is `assisted`: findings the review could settle mechanically are already handled, so this gate carries a judgment call. Escalate an ask-user finding only when the answer is not already yes - fixing it would contradict what the user asked for, undo a deliberate decision, or take a very large change. Otherwise authorize the fix yourself: `should I fix this?` is not a question to hand back.",
    ask: "fix_policy is `ask`: the user wants every finding put to them before anything is fixed. Relay this gate's findings and let them choose, rather than deciding yourself."
};

/**
 * Renders the active approval gate: the awaiting step, its findings table, and
 * the next-step commands an agent can run to clear it. `policy` adds the line
 * telling the agent how much of the decision is its own; pass null when the
 * caller has no config in hand.
 */
export function gateFields(gate: StepView, policy: FixPolicy | null = null): ToonField[] {
    const parsed = tryParseFindings(gate.findingsJSON);
    const gfields: ToonField[] = [
        field("step", gate.name),
        field("status", gate.status)
    ];
    if (parsed && parsed.summary !== "") gfields.push(field("summary", parsed.summary));
    if (parsed && parsed.riskLevel !== "") gfields.push(field("risk", parsed.riskLevel));
    const rows = (parsed?.items ?? []).map(f => [
        f.id ?? "",
        f.severity,
        f.file ?? "",
        f.action,
        truncate(f.description, maxFindingDesc)
    ]);
    gfields.push(toonTable("findings", ["id", "severity", "file", "action", "description"], rows));

    if (policy !== null) gfields.push(field("fix_policy", policy));

    return [
        field("gate", toonObject(gfields)),
        toonHelp([
            ...(policy === null ? [] : [FIX_POLICY_HELP[policy]]),
            "Run `enigma gate axi respond --action approve` to accept this step and continue",
            "Run `enigma gate axi respond --action fix --findings <ids>` to have the pipeline fix the selected findings (do not edit files yourself)",
            "Run `enigma gate axi respond --action skip` to skip this step",
            `Run \`enigma gate axi logs --step ${gate.name} --full\` to read the full step log`
        ])
    ];
}

/**
 * Shortens s to limit code points, appending a disclosure of the full size when
 * it actually trims, per the axi content-truncation convention.
 */
export function truncate(s: string, limit: number): string {
    const runes = [...s];
    if (runes.length <= limit) return s;
    return `${runes.slice(0, limit).join("")}… (truncated, ${runes.length} chars total)`;
}
