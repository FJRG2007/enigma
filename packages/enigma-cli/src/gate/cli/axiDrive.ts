/**
 * The agent-facing `axi run`, `axi respond`, and `axi abort` commands and the
 * blocking drive loop they share. Faithful port of upstream's
 * `internal/cli/axi_drive.go`.
 *
 * Drive semantics: poll a run until it reaches an approval gate, a terminal
 * state, or CI-ready. Without --yes the loop returns at the first gate for a
 * human/agent decision; with --yes it resolves each gate ("agree to fix every
 * finding", then accept) until a decision point or outcome. Each step is fixed at
 * most once so a finding the fix cannot clear converges to an approval. Once CI
 * checks pass the loop hands control back (the PR awaits a human merge).
 *
 * The CI "checks passed" detection is the relevant subset of upstream's
 * `cimonitor` package, reading the exact log strings the CI step emits.
 */

import { Paths } from "../paths";
import { join } from "node:path";
import { REMOTE_NAME } from "../init";
import { readConfig } from "@/config";
import * as render from "./axiRender";
import { readFileSync } from "node:fs";
import type { FixPolicy } from "../config";
import type { RunInfo } from "../ipc/protocol";
import { parseAddFinding, splitLogLines } from "./axiQuery";
import { field, toonHelp, toonTable, type ToonField } from "../toon";
import { formatSkipPushOptions, formatIntentPushOption } from "./steps";
import { currentBranch, run as gitRun, pushWithOptions, hasUncommittedChanges } from "../git";
import {
    type AxiEnv,
    type AxiDeps,
    errMessage,
    openAxiEnv,
    repoInitHelp,
    readFixPolicy
} from "./axiEnv";
import {
    type Finding,
    type StepName,
    STEP_CI,
    type ApprovalAction,
    parseFindingsJSON,
    hasAskUserFindings,
    hasActionableFindings
} from "../types";

/** How often the drive loop re-reads run state. */
const drivePollInterval = 250;

/** How long to wait for the daemon to register a run after a triggering push. */
const triggerWaitTimeout = 5_000;

/** CI monitor log lines matched exactly to derive the "checks passed" state. */
const CHECKS_PASSED_MSG = "all CI checks passed - still monitoring until merged or closed";
const NO_CHECKS_PASSED_MSG = "no CI checks reported - still monitoring until merged or closed";

/** Returns the error a signal aborts with, mirroring Go's ctx.Err(). */
function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("context canceled");
}

/** Throws the abort error when the signal is already aborted. */
function checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError(signal);
}

/** Resolves after ms, or rejects with the abort error if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortError(signal as AbortSignal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Reports whether the CI monitor's latest state is "checks passed, PR ready".
 * Ports the Ready derivation from cimonitor.ParseActivity: it is true only when
 * the most recent relevant log line announced passed (or no) checks.
 */
function checksPassed(logs: string[]): boolean {
    let ready = false;
    for (const line of logs) {
        if (line.includes("running agent to fix CI")) ready = false;
        else if (line.includes("committed and pushed fixes")) ready = false;
        else if (line.includes("CI failures detected")) ready = false;
        else if (line === CHECKS_PASSED_MSG || line === NO_CHECKS_PASSED_MSG) ready = true;
        else if (
            line.includes("issues detected") ||
            line.includes("CI checks running") ||
            line.includes("mergeable state still pending") ||
            line.includes("warning: could not check CI") ||
            line.includes("warning: could not check mergeable state") ||
            line.includes("warning: could not check PR state")
        ) ready = false;
        else if (line.includes("monitoring CI for PR")) ready = false;
        else if (line.includes("PR has been merged")) ready = false;
        else if (line.includes("PR has been closed")) ready = false;
        else if (line.includes("CI timeout")) ready = false;
    }
    return ready;
}

/** Emits step and run status transitions to stderr so watchers see liveness. */
class ProgressPrinter {
    private runStatus = "";
    private readonly seen = new Map<string, string>();

    constructor(private readonly write: (s: string) => void) {}

    update(run: RunInfo): void {
        if (run.status !== this.runStatus) {
            this.runStatus = run.status;
            this.write(`run: ${this.runStatus}\n`);
        }
        for (const s of run.steps) {
            const status = s.status;
            if (status === "pending") continue;
            if (this.seen.get(s.stepName) !== status) {
                this.seen.set(s.stepName, status);
                this.write(`  ${s.stepName}: ${status}\n`);
            }
        }
    }
}

/** Returns a run by ID through the daemon, or null when absent. */
async function getRunInfo(client: AxiEnv["client"], runID: string): Promise<RunInfo | null> {
    return client!.getRun(runID);
}

/** Parses findings JSON, returning null on any decode error. */
function tryParseFindings(json: string) {
    try {
        return parseFindingsJSON(json);
    } catch {
        return null;
    }
}

/**
 * Decides how --yes answers a gate. A gate with actionable findings is fixed with
 * every finding selected, unless the step was already fixed once (then approved
 * so the run converges). Gates with only non-actionable findings, no findings, or
 * actionable findings carrying no IDs are approved.
 */
function gateResolution(gate: render.StepView, alreadyFixed: boolean): [ApprovalAction, string[]] {
    if (alreadyFixed || gate.status === "fix_review") return ["approve", []];
    const parsed = tryParseFindings(gate.findingsJSON);
    if (parsed === null || !hasActionableFindings(parsed)) return ["approve", []];
    const ids = parsed.items.filter(f => (f.id ?? "") !== "").map(f => f.id as string);
    if (ids.length === 0) return ["approve", []];
    return ["fix", ids];
}

/**
 * Reports whether the drive loop may answer this gate itself under `policy`.
 *
 * `assisted` is the interesting one: it settles everything the review could act on
 * mechanically and hands back a gate carrying an `ask-user` finding. That is the
 * coarse half of the policy - handing it back does not make it the user's call.
 * The agent applies the bar the gate's help line states (escalate only what would
 * contradict the request, undo a deliberate decision, change agreed behavior, or take
 * a very large change) and fixes the rest itself. A gate whose findings cannot be
 * parsed is treated as having none - the same fallback gateResolution already takes.
 */
export function canAutoResolve(policy: FixPolicy, gate: render.StepView): boolean {
    if (policy === "auto") return true;
    if (policy === "ask") return false;
    const parsed = tryParseFindings(gate.findingsJSON);
    return parsed === null || !hasAskUserFindings(parsed);
}

/** Issues an approval action to the daemon for a step. */
async function sendRespond(
    client: AxiEnv["client"],
    runID: string,
    step: StepName,
    action: ApprovalAction,
    findingIDs: string[],
    instructions: Record<string, string> | null,
    added: Finding[] | null
): Promise<void> {
    const ok = await client!.respond({
        runId: runID,
        step,
        action,
        findingIds: findingIDs,
        instructions: instructions ?? undefined,
        addedFindings: added ?? undefined
    });
    if (!ok) throw new Error("daemon rejected the response");
}

/**
 * Blocks until the named step's status changes away from the gate status we just
 * answered, or the run terminates. Prevents a double-approve race.
 */
async function waitStepLeavesGate(
    client: AxiEnv["client"],
    runID: string,
    step: string,
    gateStatus: string,
    signal?: AbortSignal
): Promise<void> {
    for (;;) {
        checkAborted(signal);
        const run = await getRunInfo(client, runID);
        if (run === null || render.terminalStatus(run.status)) return;
        for (const s of run.steps) {
            if (s.stepName === step) {
                if (s.status !== gateStatus) return;
                break;
            }
        }
        await sleep(drivePollInterval, signal);
    }
}

/**
 * Reports whether the CI step is actively monitoring and its logs show all checks
 * passed, meaning the PR is ready for a human to merge.
 */
function ciReadyToMerge(rv: render.RunView, ciLogs: string[]): boolean {
    for (const s of rv.steps) {
        if (s.name === STEP_CI) return s.status === "running" && checksPassed(ciLogs);
    }
    return false;
}

/** Returns a reader of the CI step's log lines for a run. */
function ciLogReader(p: Paths): (runID: string) => string[] {
    return (runID: string) => {
        try {
            return splitLogLines(readFileSync(join(p.runLogDir(runID), `${STEP_CI}.log`), "utf8"));
        } catch {
            return [];
        }
    };
}

/** The result of driving a run to a decision point or outcome. */
interface DriveResult {
    run: RunInfo;
    ciReady: boolean;
}

/**
 * Polls a run until it reaches an approval gate the policy hands back, a terminal
 * state, or CI-ready, streaming step transitions to progress (stderr). Throws on
 * error or abort.
 */
async function driveRun(
    io: render.AxiIO,
    client: AxiEnv["client"],
    runID: string,
    policy: FixPolicy,
    readCILog: ((runID: string) => string[]) | null,
    signal?: AbortSignal
): Promise<DriveResult> {
    const pp = new ProgressPrinter(s => io.stderr(s));
    const fixedSteps = new Set<string>();
    for (;;) {
        checkAborted(signal);
        const run = await getRunInfo(client, runID);
        if (run === null) throw new Error(`run ${runID} not found`);
        pp.update(run);

        const rv = render.runViewFromIPC(run);
        if (render.terminalStatus(rv.status)) return { run, ciReady: false };

        const gate = render.awaitingStep(rv);
        if (gate !== null) {
            if (!canAutoResolve(policy, gate)) return { run, ciReady: false };
            const [action, findingIDs] = gateResolution(gate, fixedSteps.has(gate.name));
            if (action === "fix") fixedSteps.add(gate.name);
            try {
                await sendRespond(client, runID, gate.name as StepName, action, findingIDs, null, null);
            } catch (err) {
                throw new Error(`auto-resolve ${gate.name}: ${errMessage(err)}`);
            }
            await waitStepLeavesGate(client, runID, gate.name, gate.status, signal);
            continue;
        }
        // CI is green but the PR is unmerged: hand control back rather than waiting
        // on a human merge. This holds even under autoApprove.
        if (readCILog !== null && ciReadyToMerge(rv, readCILog(runID))) {
            return { run, ciReady: true };
        }
        await sleep(drivePollInterval, signal);
    }
}

/** Returns the ID of a non-terminal run for branch and head, or "" if none. */
async function activeRunID(env: AxiEnv, branch: string, headSHA: string): Promise<string> {
    let active: RunInfo | null;
    try {
        active = await env.client!.getActiveRun({ repoId: env.repo.id, branch });
    } catch {
        return "";
    }
    const run = activeRunInfoForHead(active, headSHA);
    return run === null ? "" : run.id;
}

/** Returns the run only when it is non-terminal and matches headSHA. */
function activeRunInfoForHead(run: RunInfo | null, headSHA: string): RunInfo | null {
    if (run === null || render.terminalStatus(run.status) || run.headSha !== headSHA) return null;
    return run;
}

/** Polls for an active run matching headSHA until the timeout. */
async function waitForActiveRunForHead(
    env: AxiEnv,
    branch: string,
    headSHA: string,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<RunInfo | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        checkAborted(signal);
        const result = await env.client!.getActiveRun({ repoId: env.repo.id, branch });
        const run = activeRunInfoForHead(result, headSHA);
        if (run !== null) return run;
        if (Date.now() >= deadline) return null;
        await sleep(150, signal);
    }
}

/**
 * Starts a fresh run for branch: pushes the current HEAD through the gate to
 * trigger a pipeline, falling back to a rerun when the push was a no-op.
 */
async function triggerRun(
    env: AxiEnv,
    branch: string,
    headSHA: string,
    skipSteps: StepName[],
    intent: string,
    signal?: AbortSignal
): Promise<string> {
    const pushOptions = formatSkipPushOptions(skipSteps);
    const opt = formatIntentPushOption(intent);
    if (opt !== "") pushOptions.push(opt);

    let pushErr: unknown = null;
    try {
        await pushWithOptions(".", REMOTE_NAME, `refs/heads/${branch}`, "", false, pushOptions, signal);
    } catch (err) {
        pushErr = err;
    }

    const run = await waitForActiveRunForHead(env, branch, headSHA, triggerWaitTimeout, signal);
    if (run !== null) return run.id;
    if (pushErr !== null) {
        throw new Error(`push "${branch}" to gate: ${errMessage(pushErr)}`);
    }

    // No run appeared: the push was likely up-to-date. Rerun the latest gate head.
    try {
        return await env.client!.rerun({ repoId: env.repo.id, branch, skipSteps, intent });
    } catch (err) {
        throw new Error(`no run started for "${branch}": ${errMessage(err)}`);
    }
}

/**
 * Reports whether the branch is one the user asked the gate to leave alone
 * (`gate-protected-branches`). Names are compared exactly, after trimming: a
 * branch is a concrete ref, and pattern matching would let a typo silently widen
 * the rule to branches the user never meant to protect.
 */
export function isProtectedBranch(branch: string, protectedBranches: string[]): boolean {
    const name = branch.trim();
    if (name === "") return false;
    return protectedBranches.some(entry => entry.trim() === name);
}

/**
 * Returns the first unmet pre-flight emitter (already emitted, returning its exit
 * code) when starting a new run, or null when the branch is ready to validate.
 *
 * Any branch validates, the default branch included - the pipeline already handles
 * it (rebase skips the branch targets, and the PR step opens nothing, since there is
 * no base to open a PR against). Only a branch the user listed in
 * `gate-protected-branches` is refused.
 */
async function preflightGuard(deps: AxiDeps, branch: string): Promise<number | null> {
    if (isProtectedBranch(branch, readConfig().config.gateProtectedBranches)) {
        return render.emitError(deps.io, 1, `refusing to validate "${branch}": it is a protected branch`,
            "Put your changes on another branch: `git switch -c <branch>`, then re-run",
            `Or stop protecting it: \`enigma config gate-protected-branches remove ${branch}\``);
    }
    let dirty: boolean;
    try {
        dirty = await hasUncommittedChanges(".", deps.signal);
    } catch (err) {
        return render.emitError(deps.io, 1, `inspect working tree: ${errMessage(err)}`,
            "Run `git status` to check the repository state, then re-run");
    }
    if (dirty) {
        return render.emitError(deps.io, 1, "uncommitted changes in the working tree",
            "Commit your work before validating: `git add -A && git commit -m \"...\"`, then re-run",
            "Run `git status` to see what is uncommitted");
    }
    return null;
}

/** Adds a fixes table when the pipeline applied any fixes. */
function appendFixesField(fields: ToonField[], fixes: string[][]): void {
    if (fixes.length === 0) return;
    fields.push(toonTable("fixes", ["step", "summary"], fixes));
}

/** The reporting instructions for a successful outcome. */
function successReportHelp(fixes: string[][]): string[] {
    const help = ["Summarize this pipeline run for the user in a concise, easily readable format: what was validated and what was found."];
    if (fixes.length > 0) {
        help.push("The pipeline fixed findings the original change missed (see `fixes`) - acknowledge the misses and list each fix so the user can review them.");
    }
    return help;
}

/**
 * Prints the run snapshot plus the active gate (exit 0), a checks-passed outcome
 * (exit 0), or the terminal outcome (exit 0 passed, exit 1 blocked/failed/
 * cancelled). Successful outcomes carry applied fixes and reporting instructions.
 */
function renderDriveResult(io: render.AxiIO, run: RunInfo, ciReady: boolean, policy: FixPolicy): number {
    const rv = render.runViewFromIPC(run);
    const fields: ToonField[] = [render.runObjectField(rv)];

    if (ciReady) {
        fields.push(field("outcome", "checks-passed"));
        let merge = "CI checks passed - the PR is ready. Ask the user to review and merge it.";
        if (rv.prURL !== "") {
            merge = `CI checks passed - the PR is ready. Ask the user to review and merge it: ${rv.prURL}`;
        }
        const fixes = render.fixRows(rv);
        appendFixesField(fields, fixes);
        fields.push(toonHelp([merge, ...successReportHelp(fixes)]));
        render.emitDoc(io, fields);
        return 0;
    }

    const gate = render.awaitingStep(rv);
    if (gate !== null) {
        fields.push(...render.gateFields(gate, policy));
        render.emitDoc(io, fields);
        return 0;
    }

    fields.push(field("outcome", render.outcomeFor(rv.status)));
    if (run.error !== null && run.error !== "") fields.push(field("error", run.error));

    if (rv.status === "completed") {
        const fixes = render.fixRows(rv);
        appendFixesField(fields, fixes);
        const help: string[] = [];
        if (rv.prURL !== "") help.push(`Open the PR: ${rv.prURL}`);
        help.push(...successReportHelp(fixes));
        fields.push(toonHelp(help));
        render.emitDoc(io, fields);
        return 0;
    }

    if (rv.prURL !== "") fields.push(toonHelp([`Open the PR: ${rv.prURL}`]));
    render.emitDoc(io, fields);
    return 1;
}

/** Validates code changes, blocking until a decision point or the outcome. */
export async function runAxiRun(deps: AxiDeps, autoYes: boolean, skipSteps: StepName[], intent: string): Promise<number> {
    const signal = deps.signal;
    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, true);
    } catch (err) {
        return render.emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let branch: string;
        try {
            branch = await currentBranch(".", signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `get current branch: ${errMessage(err)}`);
        }
        if (branch === "HEAD") {
            return render.emitError(deps.io, 1, "detached HEAD: check out a branch before validating",
                "Run `git switch -c <branch>` to put your commits on a branch");
        }

        let headSHA: string;
        try {
            headSHA = await gitRun(".", ["rev-parse", "HEAD"], signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `get current HEAD: ${errMessage(err)}`);
        }

        let runID = await activeRunID(env, branch, headSHA);
        if (runID === "") {
            // Intent is mandatory when starting a run: the driving agent knows the
            // change's intent, so we take it directly instead of inferring it.
            if (intent.trim() === "") {
                return render.emitError(deps.io, 2, "--intent is required to start a run",
                    "Pass what the user set out to accomplish: enigma gate axi run --intent \"the user's goal\"");
            }
            const guard = await preflightGuard(deps, branch);
            if (guard !== null) return guard;
            try {
                runID = await triggerRun(env, branch, headSHA, skipSteps, intent, signal);
            } catch (err) {
                return render.emitError(deps.io, 1, errMessage(err));
            }
        }

        // An explicit --yes is standing consent for this run, so it outranks the setting.
        const policy: FixPolicy = autoYes ? "auto" : readFixPolicy(env.p);
        let result: DriveResult;
        try {
            result = await driveRun(deps.io, env.client, runID, policy, ciLogReader(env.p), signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `drive run: ${errMessage(err)}`);
        }
        return renderDriveResult(deps.io, result.run, result.ciReady, policy);
    } finally {
        env.close();
    }
}

/** Parsed arguments for `axi respond`. */
/**
 * Resolves `--instructions`: the text itself, or the contents of `@<path>`.
 *
 * The file form exists because the text has to survive a command line. Long guidance ran into two
 * walls: the OS argv limit (see gate/agent/argv) and shell quoting, which differs between
 * PowerShell and sh and mangles quotes and newlines. A path has neither problem. `@` is the same
 * convention curl and gh use; a literal value starting with `@` can be passed from a file.
 */
export function readInstructions(raw: string): string {
    const value = raw.trim();
    if (!value.startsWith("@")) return value;
    const path = value.slice(1);
    if (path === "") throw new Error("--instructions @ needs a file path");
    try {
        return readFileSync(path, "utf8").trim();
    } catch (err) {
        throw new Error(`--instructions ${value}: ${errMessage(err)}`);
    }
}

export interface RespondArgs {
    action: string;
    step: string;
    findings: string;
    instructions: string;
    addFinding: string;
    autoYes: boolean;
}

/** Answers the current approval gate and continues the run. */
export async function runAxiRespond(deps: AxiDeps, ra: RespondArgs): Promise<number> {
    const signal = deps.signal;

    const actStr = ra.action.trim();
    if (actStr === "") {
        return render.emitError(deps.io, 2, "--action is required",
            "Run `enigma gate axi respond --action approve|fix|skip`");
    }
    if (actStr !== "approve" && actStr !== "fix" && actStr !== "skip") {
        return render.emitError(deps.io, 2, `unknown action "${ra.action}"`, "Valid actions: approve, fix, skip");
    }
    const act = actStr as ApprovalAction;

    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, true);
    } catch (err) {
        return render.emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let branch: string;
        try {
            branch = await currentBranch(".", signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `get current branch: ${errMessage(err)}`);
        }

        let active: RunInfo | null;
        try {
            active = await env.client!.getActiveRun({ repoId: env.repo.id, branch });
        } catch (err) {
            return render.emitError(deps.io, 1, `get active run: ${errMessage(err)}`);
        }
        if (active === null) {
            return render.emitError(deps.io, 1, "no active run to respond to", "Run `enigma gate axi run` to start one");
        }
        const runID = active.id;

        let run: RunInfo | null = null;
        let loadErr: unknown = null;
        try {
            run = await getRunInfo(env.client, runID);
        } catch (err) {
            loadErr = err;
        }
        if (run === null) {
            return render.emitError(deps.io, 1, `load run: ${loadErr === null ? "" : errMessage(loadErr)}`);
        }
        const rv = render.runViewFromIPC(run);

        let stepNameStr = ra.step.trim();
        if (stepNameStr === "") {
            const gate = render.awaitingStep(rv);
            if (gate === null) {
                return render.emitError(deps.io, 1, "no step is awaiting approval",
                    "Run `enigma gate axi status` to see the run state");
            }
            stepNameStr = gate.name;
        }
        const stepName = stepNameStr as StepName;

        const findingIDs = splitCSV(ra.findings);
        let instructions: Record<string, string> | null = null;
        let added: Finding[] | null = null;

        if (act === "fix") {
            if (findingIDs.length === 0 && ra.addFinding === "") {
                return render.emitError(deps.io, 2, "--action fix requires --findings <id,...> or --add-finding <json>",
                    "Run `enigma gate axi status` to list finding IDs");
            }
            let note: string;
            try {
                note = readInstructions(ra.instructions);
            } catch (err) {
                return render.emitError(deps.io, 2, errMessage(err),
                    "Pass the text directly, or @<path> to read it from a file");
            }
            if (note !== "" && findingIDs.length > 0) {
                instructions = {};
                for (const id of findingIDs) instructions[id] = note;
            }
            if (ra.addFinding !== "") {
                let f: Finding;
                try {
                    f = parseAddFinding(ra.addFinding);
                } catch (err) {
                    return render.emitError(deps.io, 2, `invalid --add-finding: ${errMessage(err)}`,
                        "Expected a JSON object, e.g. {\"description\":\"...\",\"action\":\"auto-fix\"}");
                }
                added = [f];
            }
        }

        try {
            await sendRespond(env.client, runID, stepName, act, findingIDs, instructions, added);
        } catch (err) {
            return render.emitError(deps.io, 1, `respond to ${stepName}: ${errMessage(err)}`);
        }

        // Let the executor consume the response before we re-read state, so we do
        // not immediately observe the same gate we just answered.
        try {
            await waitStepLeavesGate(env.client, runID, stepName, gateStatusFor(rv, stepName), signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `wait for ${stepName}: ${errMessage(err)}`);
        }

        const policy: FixPolicy = ra.autoYes ? "auto" : readFixPolicy(env.p);
        let result: DriveResult;
        try {
            result = await driveRun(deps.io, env.client, runID, policy, ciLogReader(env.p), signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `drive run: ${errMessage(err)}`);
        }
        return renderDriveResult(deps.io, result.run, result.ciReady, policy);
    } finally {
        env.close();
    }
}

/**
 * Returns the current status of step in rv, defaulting to the awaiting-approval
 * status so the post-respond wait still functions if the step was not found.
 */
function gateStatusFor(rv: render.RunView, step: string): string {
    for (const s of rv.steps) {
        if (s.name === step) return s.status;
    }
    return "awaiting_approval";
}

/** Cancels the active pipeline run (or a specific run id with --run). */
export async function runAxiAbort(deps: AxiDeps, runID: string): Promise<number> {
    if (runID !== "") return runAxiAbortByRunID(deps, runID);

    const signal = deps.signal;
    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, true);
    } catch (err) {
        return render.emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let branch: string;
        try {
            branch = await currentBranch(".", signal);
        } catch (err) {
            return render.emitError(deps.io, 1, `get current branch: ${errMessage(err)}`);
        }

        let active: RunInfo | null;
        try {
            active = await env.client!.getActiveRun({ repoId: env.repo.id, branch });
        } catch (err) {
            return render.emitError(deps.io, 1, `get active run: ${errMessage(err)}`);
        }

        if (active === null) {
            // Idempotent: nothing to abort is a successful no-op.
            render.emitDoc(deps.io, [field("aborted", false), field("detail", "no active run (no-op)")]);
            return 0;
        }

        try {
            await env.client!.cancelRun(active.id);
        } catch (err) {
            return render.emitError(deps.io, 1, `abort run: ${errMessage(err)}`);
        }
        render.emitDoc(deps.io, [field("aborted", true), field("run", active.id), field("branch", active.branch)]);
        return 0;
    } finally {
        env.close();
    }
}

/**
 * Cancels a run by its id directly via the daemon, without resolving a repo,
 * branch, or worktree. A run lives only in the running daemon's memory, so a
 * stopped daemon or an unknown/inactive id is a successful no-op.
 */
async function runAxiAbortByRunID(deps: AxiDeps, runID: string): Promise<number> {
    let p: Paths;
    try {
        p = deps.paths ?? Paths.resolve();
    } catch (err) {
        return render.emitError(deps.io, 1, `resolve paths: ${errMessage(err)}`);
    }
    try {
        p.ensureDirs();
    } catch (err) {
        return render.emitError(deps.io, 1, `create directories: ${errMessage(err)}`);
    }

    let alive: boolean;
    try {
        alive = await deps.daemon.isDaemonRunning(p);
    } catch {
        alive = false;
    }
    if (!alive) {
        render.emitDoc(deps.io, [
            field("aborted", false),
            field("run", runID),
            field("detail", "daemon not running, so no active run to cancel (no-op)")
        ]);
        return 0;
    }

    let client;
    try {
        const { Client } = await import("../ipc/client");
        client = await Client.dial(p.socket());
    } catch (err) {
        return render.emitError(deps.io, 1, `connect to daemon: ${errMessage(err)}`);
    }
    try {
        try {
            await client.cancelRun(runID);
        } catch (err) {
            // The daemon reports an unknown/inactive run id as "no active run <id>".
            if (errMessage(err).includes("no active run")) {
                render.emitDoc(deps.io, [
                    field("aborted", false),
                    field("run", runID),
                    field("detail", "no active run with that id (no-op)")
                ]);
                return 0;
            }
            return render.emitError(deps.io, 1, `abort run: ${errMessage(err)}`);
        }
        render.emitDoc(deps.io, [field("aborted", true), field("run", runID)]);
        return 0;
    } finally {
        client.close();
    }
}

/** Splits a comma-separated value, trimming and dropping empty entries. */
function splitCSV(s: string): string[] {
    const trimmed = s.trim();
    if (trimmed === "") return [];
    return trimmed.split(",").map(p => p.trim()).filter(p => p !== "");
}
