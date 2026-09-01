/**
 * The agent-facing `axi` command tree: a token-efficient TOON interface to the
 * gate, driven entirely by flags (no interactive prompts). Faithful port of
 * upstream's `internal/cli/axi.go` plus the `executablePath`/`collapseHome`
 * helpers from `root.go` and the surface telemetry from `telemetry.go`.
 *
 * `runAxiHome` renders the content-first home view from the local database, so it
 * works whether or not the daemon is running. `runAxi` parses an argv slice and
 * dispatches to the per-subcommand functions; each is also exported for direct,
 * parsed-args invocation by the wiring layer.
 */

import { sep } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { type StepName } from "../types";
import { isMergeMethod } from "../scm/types";
import { track, type Fields } from "../telemetry";
import { parseRunSkips, validStep } from "./steps";
import { runAxiMerge, type MergeArgs } from "./axiMerge";
import { field, toonHelp, toonTable, type ToonField } from "../toon";
import {
    type Run,
    getActiveRun,
    getStepsByRun,
    getRunsByRepo
} from "../db";
import {
    runAxiLogs,
    runAxiStatus,
    currentBranchForRunResolve
} from "./axiQuery";
import {
    runAxiRun,
    runAxiAbort,
    runAxiRespond,
    type RespondArgs
} from "./axiDrive";
import {
    type AxiEnv,
    type AxiDeps,
    type AxiDaemon,
    errMessage,
    openAxiEnv,
    repoInitHelp,
    readFixPolicy
} from "./axiEnv";
import {
    type AxiIO,
    emitDoc,
    emitError,
    shortSHA,
    defaultIO,
    gateFields,
    awaitingStep,
    runViewFromDB,
    runObjectFieldWithKey
} from "./axiRender";

export type { AxiDeps, AxiDaemon } from "./axiEnv";
export type { AxiIO } from "./axiRender";
export { defaultIO, setNowUnix } from "./axiRender";
export { runAxiRun, runAxiRespond, runAxiAbort } from "./axiDrive";
export { runAxiMerge } from "./axiMerge";
export { runAxiStatus, runAxiLogs } from "./axiQuery";

/**
 * The /enigma skill description surfaced on the home view. Faithful rebrand of
 * upstream's `internal/skill` description.
 */
export const SKILL_DESCRIPTION =
    "Validate your code changes through the enigma gate pipeline - automated code review, tests, lint, docs, push, PR, and CI - before they reach the configured push target. Use when the user asks to run enigma gate, gate or ship or validate their changes, push safely, asks you to do a task and then validate it, or invokes /enigma.";

/** Caps the recent-runs table on the home view. */
const recentRunsHomeLimit = 10;

/** Returns the absolute path of the running binary, resolving symlinks. */
function executablePath(): string {
    const exe = process.execPath;
    try {
        return realpathSync(exe);
    } catch {
        return exe;
    }
}

/** Rewrites a leading home directory to ~ for compact display. */
function collapseHome(path: string): string {
    let home: string;
    try {
        home = homedir();
    } catch {
        return path;
    }
    if (home === "") return path;
    if (path === home) return "~";
    if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
    return path;
}

/**
 * Renders a recent-runs table with an aggregate count, showing at most limit rows
 * newest-first.
 */
export function runsFields(runs: Run[], limit: number): ToonField[] {
    if (runs.length === 0) {
        return [field("runs", "0 runs yet in this repository")];
    }
    let shown = runs;
    if (limit > 0 && shown.length > limit) shown = shown.slice(0, limit);
    const rows = shown.map(r => [r.id, r.branch, r.status, shortSHA(r.headSha), r.prUrl ?? ""]);
    return [
        field("count", `${shown.length} of ${runs.length} total`),
        toonTable("runs", ["id", "branch", "status", "head", "pr"], rows)
    ];
}

/**
 * Renders the content-first home view: tool identity, repo, daemon state, the
 * active run (if any) with its gate, and recent runs - all from the local
 * database so it works whether or not the daemon is running.
 */
export async function runAxiHome(deps: AxiDeps): Promise<number> {
    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, false);
    } catch (err) {
        return emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let daemonState = "stopped";
        try {
            if (await deps.daemon.isDaemonRunning(env.p)) daemonState = "running";
        } catch {
            // Liveness is best-effort; absence is reported as stopped.
        }
        const branch = await currentBranchForRunResolve(deps.signal);
        const branchDisplay = branch === "" ? "unknown" : branch;

        const fields: ToonField[] = [
            field("bin", collapseHome(executablePath())),
            field("description", SKILL_DESCRIPTION),
            field("repo", env.repo.workingPath),
            field("current_branch", branchDisplay),
            field("daemon", daemonState)
        ];

        let currentActive: Run | null = null;
        if (branch !== "") {
            try {
                currentActive = getActiveRun(env.d, env.repo.id, branch);
            } catch (err) {
                return emitError(deps.io, 1, `check current-branch active run: ${errMessage(err)}`);
            }
        }

        let otherActive: Run | null = null;
        if (currentActive === null) {
            try {
                otherActive = getActiveRun(env.d, env.repo.id, "");
            } catch (err) {
                return emitError(deps.io, 1, `check repo active run: ${errMessage(err)}`);
            }
            if (otherActive !== null && otherActive.branch === branch) otherActive = null;
        }

        let gated = false;
        if (currentActive !== null) {
            const steps = getStepsByRun(env.d, currentActive.id);
            const rv = runViewFromDB(currentActive, steps);
            fields.push(runObjectFieldWithKey("active_run", rv));
            const gate = awaitingStep(rv);
            if (gate !== null) {
                gated = true;
                fields.push(...gateFields(gate, readFixPolicy(env.p)));
            }
        } else if (otherActive !== null) {
            const steps = getStepsByRun(env.d, otherActive.id);
            const rv = runViewFromDB(otherActive, steps);
            fields.push(runObjectFieldWithKey("other_branch_active_run", rv));
        }

        let runs: Run[];
        try {
            runs = getRunsByRepo(env.d, env.repo.id);
        } catch (err) {
            return emitError(deps.io, 1, `list runs: ${errMessage(err)}`);
        }
        fields.push(...runsFields(runs, recentRunsHomeLimit));

        const help: string[] = [];
        if (currentActive === null) {
            help.push("Run `enigma gate axi run --intent \"<what the user set out to accomplish>\"` to validate your changes");
            if (otherActive !== null) {
                help.push(`Another active run is on ${otherActive.branch}; leave it alone unless you are working on that branch`);
            }
        } else if (gated) {
            help.push("Run `enigma gate axi respond --action approve` to clear the current gate");
        } else {
            help.push("Run `enigma gate axi status` to inspect the active run");
        }
        fields.push(toonHelp(help));

        emitDoc(deps.io, fields);
        return 0;
    } finally {
        env.close();
    }
}

// --- Surface telemetry (faithful port of internal/cli/telemetry.go) ---

/** Reports the step for telemetry, masking an unknown step as "invalid". */
function sanitizeAxiTelemetryStep(step: string): string {
    const s = step.trim();
    return validStep(s as StepName) ? s : "invalid";
}

/** Reports the action for telemetry, masking an unknown action as "invalid". */
function sanitizeAxiTelemetryAction(action: string): string {
    const a = action.trim();
    return a === "approve" || a === "fix" || a === "skip" ? a : "invalid";
}

/** Reports the merge method for telemetry, masking an unknown one as "invalid". */
function sanitizeAxiTelemetryMergeMethod(method: string): string {
    const m = method.trim();
    if (m === "") return "default";
    return isMergeMethod(m) ? m : "invalid";
}

/**
 * Records an axi command as a pageview and a command event (with status and
 * duration), then runs it. The surface is recorded even when the command fails.
 */
async function trackAxiSurface(
    command: string,
    path: string,
    fields: Fields,
    fn: () => Promise<number>
): Promise<number> {
    track("pageview", { path, ...fields });
    const start = Date.now();
    let code = 0;
    try {
        code = await fn();
        return code;
    } finally {
        track("command", { command, status: code === 0 ? "success" : "error", duration_ms: Date.now() - start });
    }
}

// --- argv dispatch ---

interface ParsedFlags {
    values: Map<string, string>;
    bools: Set<string>;
}

/** Parses a flag list, rejecting unknown flags and missing values. */
function parseFlags(
    args: string[],
    boolNames: Set<string>,
    valueNames: Set<string>,
    alias: Record<string, string>
): ParsedFlags | { error: string; } {
    const values = new Map<string, string>();
    const bools = new Set<string>();
    let i = 0;
    while (i < args.length) {
        const tok = args[i];
        if (!tok.startsWith("-")) return { error: `unexpected argument "${tok}"` };
        let name = tok.replace(/^--?/, "");
        let inline: string | null = null;
        const eq = name.indexOf("=");
        if (eq >= 0) {
            inline = name.slice(eq + 1);
            name = name.slice(0, eq);
        }
        name = alias[name] ?? name;
        if (boolNames.has(name)) {
            bools.add(name);
            i++;
            continue;
        }
        if (!valueNames.has(name)) return { error: `unknown flag --${name}` };
        let val: string;
        if (inline !== null) {
            val = inline;
        } else {
            const next = args[i + 1];
            if (next === undefined) return { error: `flag --${name} needs a value` };
            val = next;
            i++;
        }
        values.set(name, val);
        i++;
    }
    return { values, bools };
}

/** Usage for one axi subcommand: the flags it takes, with no side effect. */
export function axiSubcommandHelp(sub: string): string {
    const usage: Record<string, string> = {
        run: [
            "usage: enigma gate axi run --intent \"<what the user set out to accomplish>\" [flags]",
            "  --intent <text>   required; the goal behind the work, in the user's terms",
            "  --skip <steps>    comma-separated: intent, rebase, review, test, document, lint, push, pr, ci",
            "  --quick, -q       skip test and document: the change is small or already tested",
            "  --yes, -y         treat every actionable finding as consent to fix (drives unattended)",
            "  --merge, -m       ONLY when the user asked for the merge: merge the PR once CI is green"
        ].join("\n"),
        respond: [
            "usage: enigma gate axi respond --action <approve|fix|skip> [flags]",
            "  --action <a>          approve, fix or skip the awaiting step",
            "  --findings <id,...>   with --action fix: which findings to fix",
            "  --instructions <text> guidance for the fix; @<file> reads it from a file",
            "  --add-finding <json>  add your own finding, e.g. {\"description\":\"...\"}",
            "  --step <name>         target a specific step instead of the awaiting one",
            "  --yes, -y             accept the resulting fix review without a second prompt"
        ].join("\n"),
        merge: [
            "usage: enigma gate axi merge [flags]",
            "Merges the run's PR. Only ever when the user asked you to merge it.",
            "  --method <m>   squash (default), merge or rebase",
            "  --force        merge even with checks failing or still running",
            "  --run <id>     target a specific run instead of the current branch's"
        ].join("\n"),
        status: "usage: enigma gate axi status\nFull detail of the resolved run.",
        logs: "usage: enigma gate axi logs --step <name> [--full]\nPrints a step's log.",
        abort: "usage: enigma gate axi abort [--run <id>]\nCancels the current-branch run, or the run with that id."
    };
    return `${usage[sub] ?? "usage: enigma gate axi [run|respond|merge|status|logs|abort]\nAdd --help to a subcommand for its flags."}\n`;
}

/**
 * Parses an axi argv slice (the args after `axi`) and dispatches to the matching
 * subcommand, returning the process exit code (0 success/no-op/decision-gate, 1
 * failed/cancelled, 2 bad usage).
 */
export async function runAxi(argv: string[], deps: Pick<AxiDeps, "daemon"> & Partial<AxiDeps>): Promise<number> {
    const resolved: AxiDeps = {
        io: deps.io ?? defaultIO(),
        daemon: deps.daemon,
        signal: deps.signal,
        paths: deps.paths
    };

    const sub = argv[0];
    if (sub === undefined) {
        return trackAxiSurface("axi-home", "/axi", {}, () => runAxiHome(resolved));
    }
    const rest = argv.slice(1);
    // Asking for the flags used to answer `error: unknown flag --help`, which is what the /gate
    // command tells an agent to run. Answer it, before parseFlags rejects it and before any run
    // starts.
    if (rest.includes("--help") || rest.includes("-h")) {
        resolved.io.stdout(axiSubcommandHelp(sub));
        return 0;
    }

    switch (sub) {
        case "run": {
            const f = parseFlags(rest, new Set(["yes", "quick", "merge"]), new Set(["skip", "intent"]),
                { y: "yes", q: "quick", m: "merge" });
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const autoYes = f.bools.has("yes");
            const quick = f.bools.has("quick");
            const merge = f.bools.has("merge");
            const skipValue = f.values.get("skip") ?? "";
            const intent = f.values.get("intent") ?? "";
            return trackAxiSurface("axi-run", "/axi/run", {
                auto_yes: autoYes,
                merge,
                quick,
                has_intent: intent.trim() !== "",
                has_skip: skipValue.trim() !== ""
            }, () => {
                let skipSteps: StepName[];
                try {
                    skipSteps = parseRunSkips(skipValue, quick);
                } catch (err) {
                    return Promise.resolve(emitError(resolved.io, 2, errMessage(err),
                        "Valid steps: intent, rebase, review, test, document, lint, push, pr, ci"));
                }
                return runAxiRun(resolved, autoYes, skipSteps, intent, merge);
            });
        }
        case "respond": {
            const f = parseFlags(rest, new Set(["yes"]),
                new Set(["action", "step", "findings", "instructions", "add-finding"]), { y: "yes" });
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const action = f.values.get("action") ?? "";
            const ra: RespondArgs = {
                action,
                step: f.values.get("step") ?? "",
                findings: f.values.get("findings") ?? "",
                instructions: f.values.get("instructions") ?? "",
                addFinding: f.values.get("add-finding") ?? "",
                autoYes: f.bools.has("yes")
            };
            return trackAxiSurface("axi-respond", "/axi/respond", {
                action: sanitizeAxiTelemetryAction(action),
                auto_yes: ra.autoYes
            }, () => runAxiRespond(resolved, ra));
        }
        case "merge": {
            const f = parseFlags(rest, new Set(["force"]), new Set(["run", "method"]), {});
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const ma: MergeArgs = {
                run: f.values.get("run") ?? "",
                method: f.values.get("method") ?? "",
                force: f.bools.has("force")
            };
            return trackAxiSurface("axi-merge", "/axi/merge", {
                method: sanitizeAxiTelemetryMergeMethod(ma.method),
                force: ma.force
            }, () => runAxiMerge(resolved, ma));
        }
        case "status": {
            const f = parseFlags(rest, new Set(), new Set(["run"]), {});
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const runID = f.values.get("run") ?? "";
            return trackAxiSurface("axi-status", "/axi/status", {
                explicit_run_id: runID.trim() !== ""
            }, () => runAxiStatus(resolved, runID));
        }
        case "logs": {
            const f = parseFlags(rest, new Set(["full"]), new Set(["step", "run"]), {});
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const step = f.values.get("step") ?? "";
            const runID = f.values.get("run") ?? "";
            const full = f.bools.has("full");
            return trackAxiSurface("axi-logs", "/axi/logs", {
                step: sanitizeAxiTelemetryStep(step),
                full,
                explicit_run_id: runID.trim() !== ""
            }, () => runAxiLogs(resolved, step, runID, full));
        }
        case "abort": {
            const f = parseFlags(rest, new Set(), new Set(["run"]), {});
            if ("error" in f) return emitError(resolved.io, 2, f.error);
            const runID = (f.values.get("run") ?? "").trim();
            return trackAxiSurface("axi-abort", "/axi/abort", {}, () => runAxiAbort(resolved, runID));
        }
        default:
            return emitError(resolved.io, 2, `unknown axi command "${sub}"`,
                "Valid commands: run, respond, merge, status, logs, abort");
    }
}
