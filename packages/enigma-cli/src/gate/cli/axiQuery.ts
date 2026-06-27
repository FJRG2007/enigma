/**
 * The agent-facing `axi status` and `axi logs` commands plus the run-resolution
 * and log helpers they share. Faithful port of upstream's
 * `internal/cli/axi_query.go`.
 */

import { join } from "node:path";
import { validStep } from "./steps";
import { readFileSync } from "node:fs";
import { currentBranch } from "../git";
import { field, toonHelp, toonTable } from "../toon";
import {
    type Finding,
    type StepName,
    ACTION_ASKUSER,
    ACTION_AUTOFIX
} from "../types";
import {
    type Run,
    getRun,
    getActiveRun,
    getStepsByRun,
    getRunsByRepo
} from "../db";
import {
    type AxiEnv,
    type AxiDeps,
    errMessage,
    openAxiEnv,
    repoInitHelp
} from "./axiEnv";
import {
    emitDoc,
    emitError,
    gateFields,
    awaitingStep,
    outcomeFor,
    runViewFromDB,
    terminalStatus,
    runObjectField
} from "./axiRender";

/** How many trailing log lines `axi logs` shows without --full. */
const logTailLines = 40;

/** The one-line "start a run" hint shown when there is no run to inspect. */
export function startRunHelp(): string {
    return "Run enigma gate axi run --intent \"the user's goal\" --yes to validate the current branch";
}

/** The hint shown when `axi logs` finds no run to read from. */
export function noRunLogsHelp(): string {
    return startRunHelp();
}

/** Resolves the current branch for run lookup, returning "" for detached HEAD. */
export async function currentBranchForRunResolve(signal?: AbortSignal): Promise<string> {
    try {
        const branch = await currentBranch(".", signal);
        return branch === "HEAD" ? "" : branch;
    } catch {
        return "";
    }
}

/**
 * Picks the run to inspect: an explicit ID, else the active run, else the most
 * recent run for the repo. Returns null when none exist.
 */
export function resolveRun(env: AxiEnv, runID: string, branch: string): Run | null {
    if (runID !== "") return getRun(env.d, runID);
    if (branch !== "") {
        const active = getActiveRun(env.d, env.repo.id, branch);
        if (active !== null) return active;
        const runs = getRunsByRepo(env.d, env.repo.id);
        for (const r of runs) {
            if (r.branch === branch) return r;
        }
    }
    const active = getActiveRun(env.d, env.repo.id, "");
    if (active !== null) return active;
    const runs = getRunsByRepo(env.d, env.repo.id);
    if (runs.length === 0) return null;
    return runs[0];
}

/** Shows the active (or most recent) run in detail. */
export async function runAxiStatus(deps: AxiDeps, runID: string): Promise<number> {
    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, false);
    } catch (err) {
        return emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let run: Run | null;
        try {
            run = resolveRun(env, runID, await currentBranchForRunResolve(deps.signal));
        } catch (err) {
            return emitError(deps.io, 1, errMessage(err));
        }
        if (run === null) {
            if (runID !== "") return emitError(deps.io, 1, `run "${runID}" not found`);
            emitDoc(deps.io, [
                field("runs", "0 runs yet in this repository"),
                toonHelp([startRunHelp()])
            ]);
            return 0;
        }
        let steps;
        try {
            steps = getStepsByRun(env.d, run.id);
        } catch (err) {
            return emitError(deps.io, 1, `load steps: ${errMessage(err)}`);
        }
        const rv = runViewFromDB(run, steps);
        const fields = [runObjectField(rv)];
        const gate = awaitingStep(rv);
        if (gate !== null) {
            fields.push(...gateFields(gate));
        } else if (terminalStatus(rv.status)) {
            fields.push(field("outcome", outcomeFor(rv.status)));
            if (run.error !== null && run.error !== "") fields.push(field("error", run.error));
        }
        emitDoc(deps.io, fields);
        return 0;
    } finally {
        env.close();
    }
}

/** Shows the log output of one pipeline step. */
export async function runAxiLogs(deps: AxiDeps, stepArg: string, runID: string, full: boolean): Promise<number> {
    const step = stepArg.trim();
    if (step === "") {
        return emitError(deps.io, 2, "--step is required",
            "Valid steps: intent, rebase, review, test, document, lint, push, pr, ci");
    }
    if (!validStep(step as StepName)) {
        return emitError(deps.io, 2, `unknown step "${step}"`,
            "Valid steps: intent, rebase, review, test, document, lint, push, pr, ci");
    }

    let env: AxiEnv;
    try {
        env = await openAxiEnv(deps, false);
    } catch (err) {
        return emitError(deps.io, 1, errMessage(err), ...repoInitHelp(err));
    }
    try {
        let run: Run | null;
        try {
            run = resolveRun(env, runID, await currentBranchForRunResolve(deps.signal));
        } catch (err) {
            return emitError(deps.io, 1, errMessage(err));
        }
        if (run === null) {
            return emitError(deps.io, 1, "no run found to read logs from", noRunLogsHelp());
        }

        const path = join(env.p.runLogDir(run.id), `${step}.log`);
        let data: string;
        try {
            data = readFileSync(path, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                emitDoc(deps.io, [
                    field("step", step),
                    field("run", run.id),
                    field("log", `no log recorded for step "${step}" in this run`)
                ]);
                return 0;
            }
            return emitError(deps.io, 1, `read log: ${errMessage(err)}`);
        }

        const lines = splitLogLines(data);
        if (!full && lines.length > logTailLines) {
            const shown = lines.slice(lines.length - logTailLines);
            emitDoc(deps.io, [
                field("step", step),
                field("run", run.id),
                field("lines", `${shown.length} of ${lines.length} total (tail)`),
                logRows(shown),
                toonHelp([`Run \`enigma gate axi logs --step ${step} --full\` to see the entire log`])
            ]);
            return 0;
        }
        emitDoc(deps.io, [
            field("step", step),
            field("run", run.id),
            field("lines", `${lines.length} total`),
            logRows(lines)
        ]);
        return 0;
    } finally {
        env.close();
    }
}

/**
 * Wraps log lines as a single-column block array so the encoder renders one line
 * per row rather than collapsing them onto a single inline row.
 */
function logRows(lines: string[]) {
    return toonTable("log", ["line"], lines.map(l => [l]));
}

/** Splits stored log text into lines, dropping trailing newlines. */
export function splitLogLines(s: string): string[] {
    const trimmed = s.replace(/\n+$/, "");
    if (trimmed === "") return [];
    return trimmed.split("\n");
}

/** Decodes a single finding object from the agent-authored JSON wire shape. */
function decodeFinding(raw: any): Finding {
    const f: Finding = {
        id: raw.id ?? "",
        severity: raw.severity ?? "",
        file: raw.file ?? "",
        line: raw.line ?? 0,
        description: raw.description ?? "",
        action: raw.action ?? "",
        source: raw.source ?? "",
        userInstructions: raw.user_instructions ?? ""
    };
    // Legacy: derive the action from requires_human_review when action is absent.
    if (f.action === "" && typeof raw.requires_human_review === "boolean") {
        f.action = raw.requires_human_review ? ACTION_ASKUSER : ACTION_AUTOFIX;
    }
    return f;
}

/** Decodes a user-authored finding from a JSON object string. */
export function parseAddFinding(raw: string): Finding {
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch (err) {
        throw new Error(errMessage(err));
    }
    const f = decodeFinding(obj);
    if ((f.description ?? "").trim() === "") throw new Error("description is required");
    return f;
}
