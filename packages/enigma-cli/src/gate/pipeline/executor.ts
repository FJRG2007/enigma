/**
 * The pipeline executor: runs steps sequentially in a disposable worktree,
 * coordinates approval gates and fix rounds, persists per-round history, and
 * streams events to subscribers. Faithful port of the Go
 * `internal/pipeline/executor.go`.
 *
 * Go coordinates approval over a buffered channel + mutex; this port uses a
 * single-slot buffered response plus a promise resolver, and threads an
 * AbortSignal where Go threads a cancellable context (the abort reason carries
 * the cancel cause, like context.WithCancelCause).
 */

import { log } from "../log";
import * as gateDb from "../db";
import { diffHead } from "../git";
import { type Agent } from "../agent/agent";
import { track, type Fields } from "../telemetry";
import { type Config, autoFixLimit } from "../config";
import { type Step, type StepContext } from "./types";
import {
    type Event,
    type EventType,
    EventRunUpdated,
    EventLogChunk,
    EventStepStarted,
    EventRunCompleted,
    EventStepCompleted
} from "../ipc/protocol";
import {
    type StepName,
    type Finding,
    type StepStatus,
    type ApprovalAction,
    parseFindingsJSON,
    RUN_CANCEL_REASON_SUPERSEDED,
    RUN_CANCEL_REASON_ABORTED_BY_USER
} from "../types";
import {
    findingIDsJSON,
    marshalFindingIDs,
    filterFindingsJSON,
    normalizeFindingsJSON,
    hasAskUserFindingsJSON,
    mergeUserOverridesJSON,
    autoFixableFindingsJSON,
    combineSelectedFindingIDs
} from "./findings";

/** Called when a pipeline event occurs, for streaming to subscribers. */
export type EventFunc = (event: Event) => void;

interface ApprovalResponse {
    action: ApprovalAction;
    findingIDs: string[];
    instructions: Record<string, string> | null;
    addedFindings: Finding[] | null;
}

/** Returns the cancel cause carried by an aborted signal, or "" when generic. */
function causeMessage(signal: AbortSignal): string {
    if (!signal.aborted) return "";
    const reason = signal.reason;
    if (reason instanceof Error) {
        if (reason.name === "AbortError") return "";
        return reason.message;
    }
    if (typeof reason === "string") return reason;
    return "";
}

function causeError(signal: AbortSignal): Error {
    const msg = causeMessage(signal);
    return new Error(msg || "context canceled");
}

/** Runs pipeline steps sequentially and coordinates approval interactions. */
export class Executor {
    private skips: Set<StepName> = new Set();
    private readonly onEvent: EventFunc;

    private waiting = false;
    private waitingStep: StepName | "" = "";
    private approvalResolver: ((r: ApprovalResponse) => void) | null = null;
    private bufferedResponse: ApprovalResponse | null = null;

    constructor(
        private readonly db: gateDb.Database,
        private readonly paths: { runLogDir(runId: string): string; },
        private readonly config: Config | null,
        private readonly agent: Agent,
        private readonly steps: Step[],
        onEvent?: EventFunc,
        private readonly stepAgent?: (step: StepName) => Agent
    ) {
        this.onEvent = onEvent ?? (() => {});
    }

    /**
     * Agent backend for one step. Without a per-step resolver every step shares
     * the single run agent, which is the unconfigured behavior.
     */
    private agentForStep(step: StepName): Agent {
        return this.stepAgent?.(step) ?? this.agent;
    }

    /** Configures steps to mark skipped without running. */
    setSkippedSteps(steps: StepName[]): void {
        this.skips = new Set(steps);
    }

    /** Sends a user approval action to the currently waiting step. */
    respond(step: StepName, action: ApprovalAction, findingIDs: string[]): void {
        this.respondWithOverrides(step, action, findingIDs, null, null);
    }

    /**
     * Like respond but also carries per-finding user instructions and
     * user-authored findings, merged into the round on a fix action.
     */
    respondWithOverrides(
        step: StepName,
        action: ApprovalAction,
        findingIDs: string[],
        instructions: Record<string, string> | null,
        addedFindings: Finding[] | null
    ): void {
        if (!this.waiting) throw new Error("no step awaiting approval");
        if (step !== this.waitingStep) {
            throw new Error(`step mismatch: responding to "${step}" but "${this.waitingStep}" is awaiting approval`);
        }
        this.waiting = false;
        const resp: ApprovalResponse = { action, findingIDs, instructions, addedFindings };
        if (this.approvalResolver) {
            const resolve = this.approvalResolver;
            this.approvalResolver = null;
            resolve(resp);
        } else {
            this.bufferedResponse = resp;
        }
    }

    /**
     * Runs the pipeline steps sequentially for a run. workDir is the directory
     * where steps execute (typically a git worktree). Throws the run error on
     * failure (the run status is persisted before throwing).
     */
    async execute(signal: AbortSignal, run: gateDb.Run, repo: gateDb.Repo, workDir: string): Promise<void> {
        gateDb.updateRunStatus(this.db, run.id, "running");
        run.status = "running";
        this.emitRunEvent(EventRunUpdated, run, repo);

        const logDir = this.paths.runLogDir(run.id);
        const { mkdirSync } = await import("node:fs");
        mkdirSync(logDir, { recursive: true });

        // Create step result records.
        const stepRecords = new Map<StepName, gateDb.StepResult>();
        for (const step of this.steps) {
            stepRecords.set(step.name(), gateDb.insertStepResult(this.db, run.id, step.name()));
        }

        for (let i = 0; i < this.steps.length; i++) {
            const step = this.steps[i];
            if (signal.aborted) return this.failRun(run, repo, causeError(signal), signal);

            const sr = stepRecords.get(step.name())!;
            if (this.skips.has(step.name())) {
                gateDb.completeStepWithStatus(this.db, sr.id, "skipped", 0, 0, "");
                this.emitStepEvent2(EventStepCompleted, run, repo, step.name(), "skipped", "", "", "", undefined);
                continue;
            }
            let skipRemaining: boolean;
            try {
                skipRemaining = await this.executeStep(signal, step, sr, run, repo, workDir, logDir);
            } catch (err) {
                return this.failRun(run, repo, err as Error, signal);
            }
            if (skipRemaining) {
                for (const remaining of this.steps.slice(i + 1)) {
                    const rsr = stepRecords.get(remaining.name())!;
                    try {
                        gateDb.completeStepWithStatus(this.db, rsr.id, "skipped", 0, 0, "");
                    } catch (dbErr) {
                        log.warn("failed to finalize skipped step", "step", remaining.name(), "error", String(dbErr));
                    }
                    this.emitStepEvent2(EventStepCompleted, run, repo, remaining.name(), "skipped", "", "", "", undefined);
                }
                break;
            }
        }

        gateDb.updateRunStatus(this.db, run.id, "completed");
        run.status = "completed";
        this.emitRunEvent(EventRunCompleted, run, repo);
    }

    /** Runs a single step with approval coordination. Returns skipRemaining. */
    private async executeStep(
        signal: AbortSignal,
        step: Step,
        sr: gateDb.StepResult,
        run: gateDb.Run,
        repo: gateDb.Repo,
        workDir: string,
        logDir: string
    ): Promise<boolean> {
        const { join } = await import("node:path");
        const { openSync, writeSync, closeSync } = await import("node:fs");
        const stepName = step.name();
        const logPath = join(logDir, `${stepName}.log`);
        let finalExitCode = 0;

        gateDb.startStep(this.db, sr.id);
        this.emitStepEvent(EventStepStarted, run, repo, stepName, "running");

        let phaseStart = Date.now();
        let executionMS = 0;
        let durationOverrideMS = 0;

        const logFd = openSync(logPath, "a");
        const writeLog = (text: string) => writeSync(logFd, text);
        try {
            let lastChunkNewline = true;
            const userIntent = run.intent ?? "";
            const sctx: StepContext = {
                signal,
                run,
                repo,
                workDir,
                agent: this.agentForStep(step.name()),
                config: this.config as Config,
                db: this.db,
                stepResultID: sr.id,
                userIntent,
                fixing: false,
                previousFindings: "",
                env: [],
                log: (text: string) => {
                    if (text !== "") {
                        const prefix = lastChunkNewline ? "" : "\n";
                        text = `${prefix}${text.replace(/\n+$/, "")}\n\n`;
                        lastChunkNewline = true;
                    }
                    this.emitLogChunk(run, repo, stepName, text);
                    writeLog(text);
                },
                logChunk: (text: string) => {
                    if (text !== "") lastChunkNewline = text.endsWith("\n");
                    this.emitLogChunk(run, repo, stepName, text);
                    writeLog(text);
                },
                logFile: (text: string) => writeLog(`${text}\n`)
            };

            let autoFixLimitVal = 0;
            if (this.config) autoFixLimitVal = autoFixLimit(this.config, stepName);
            let autoFixAttempts = 0;
            let roundNum = 0;
            let nextTrigger = "initial";
            let skipRemaining = false;
            let stepSkipped = false;
            let currentRoundID = "";

            // Execute with possible fix loop.
            for (;;) {
                let outcome;
                try {
                    outcome = await step.execute(sctx);
                } catch (err) {
                    roundNum++;
                    const durationMS = executionMS + (Date.now() - phaseStart);
                    const msg = String((err as Error)?.message ?? err);
                    writeLog(`\nerror: ${msg}\n`);
                    try {
                        gateDb.failStep(this.db, sr.id, msg, durationMS);
                    } catch (dbErr) {
                        log.warn("failed to mark step as failed in db", "step", stepName, "error", String(dbErr));
                    }
                    this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "failed", "", "", msg, durationMS);
                    throw new Error(`step ${stepName} failed: ${msg}`);
                }
                roundNum++;
                const roundDuration = Date.now() - phaseStart;

                outcome.findings = normalizeFindingsJSON(outcome.findings, stepName);
                finalExitCode = outcome.exitCode;
                durationOverrideMS += outcome.durationOverrideMS;

                if (outcome.findings !== "") gateDb.setStepFindings(this.db, sr.id, outcome.findings);
                else gateDb.clearStepFindings(this.db, sr.id);

                // Persist this execution round.
                const findingsPtr = outcome.findings !== "" ? outcome.findings : null;
                const fixSummaryPtr = outcome.fixSummary !== "" ? outcome.fixSummary : null;
                try {
                    const inserted = gateDb.insertStepRound(this.db, sr.id, roundNum, nextTrigger, findingsPtr, fixSummaryPtr, roundDuration);
                    currentRoundID = inserted.id;
                } catch (dbErr) {
                    currentRoundID = "";
                    log.warn("failed to insert step round", "step", stepName, "round", roundNum, "error", String(dbErr));
                }

                if (outcome.prUrl !== "") {
                    run.prUrl = outcome.prUrl;
                    this.emitRunEvent(EventRunUpdated, run, repo);
                }

                // Auto-fix before the NeedsApproval check, so all severities get a
                // chance at automatic fixing. Only "auto-fix" findings qualify.
                if (outcome.autoFixable && autoFixLimitVal > 0 && autoFixAttempts < autoFixLimitVal) {
                    const fixableFindings = autoFixableFindingsJSON(outcome.findings);
                    if (fixableFindings !== "") {
                        autoFixAttempts++;
                        track("fix", this.fixTelemetryFields("auto", stepName, findingsCount(fixableFindings), autoFixAttempts));
                        log.info("auto-fixing step", "step", stepName, "attempt", autoFixAttempts, "max", autoFixLimitVal);
                        executionMS += Date.now() - phaseStart;
                        gateDb.updateStepStatus(this.db, sr.id, "fixing");
                        if (currentRoundID !== "") {
                            const idsJSON = findingIDsJSON(fixableFindings);
                            if (idsJSON !== "") gateDb.setStepRoundSelection(this.db, currentRoundID, idsJSON, gateDb.RoundSelectionSourceAutoFix);
                        }
                        this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "fixing", "", "", "", undefined);
                        phaseStart = Date.now();
                        sctx.fixing = true;
                        sctx.previousFindings = fixableFindings;
                        nextTrigger = "auto_fix";
                        continue;
                    }
                }

                if (!outcome.needsApproval && !hasAskUserFindingsJSON(outcome.findings)) {
                    skipRemaining = outcome.skipRemaining;
                    stepSkipped = outcome.skipped;
                    break;
                }

                // Freeze execution timer before entering the approval wait.
                executionMS += Date.now() - phaseStart;

                let approvalStatus: StepStatus = "awaiting_approval";
                let diffText = "";
                if (sctx.fixing) {
                    approvalStatus = "fix_review";
                    try {
                        const d = await diffHead(workDir, signal);
                        if (d !== "") diffText = d;
                    } catch (err) {
                        log.warn("failed to compute diff for fix review", "error", String(err));
                    }
                }

                // Mark ready to receive approval before the DB/event writes so a
                // poller that sees the gate status can immediately call respond.
                this.waiting = true;
                this.waitingStep = stepName;

                // Surface the park as a pollable run-level signal (observability only).
                gateDb.setRunAwaitingAgent(this.db, run.id);

                gateDb.updateStepStatusWithDuration(this.db, sr.id, approvalStatus, executionMS);
                this.emitStepEvent2(EventStepCompleted, run, repo, stepName, approvalStatus, outcome.findings, diffText, "", executionMS);

                let response: ApprovalResponse;
                try {
                    response = await this.waitForApproval(signal);
                } catch (err) {
                    gateDb.clearRunAwaitingAgent(this.db, run.id);
                    gateDb.failStep(this.db, sr.id, (err as Error).message, executionMS);
                    this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "failed", "", "", (err as Error).message, executionMS);
                    throw new Error(`step ${stepName}: waiting for approval: ${(err as Error).message}`);
                }
                gateDb.clearRunAwaitingAgent(this.db, run.id);

                const approvalFields: Fields = {
                    step: stepName,
                    action: response.action,
                    fix_review: sctx.fixing
                };
                const agentName = this.telemetryAgentName();
                if (agentName !== "") approvalFields.agent = agentName;
                const selCount = selectedFindingCount(outcome.findings, response.findingIDs);
                if (selCount > 0) approvalFields.selected_findings_count = selCount;
                track("approval", approvalFields);

                if (response.action === "approve") {
                    phaseStart = Date.now();
                    break;
                } else if (response.action === "skip") {
                    gateDb.completeStepWithStatus(this.db, sr.id, "skipped", finalExitCode, executionMS, logPath);
                    this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "skipped", "", "", "", executionMS);
                    return false;
                } else if (response.action === "abort") {
                    gateDb.failStep(this.db, sr.id, "aborted by user", executionMS);
                    this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "failed", "", "", "aborted by user", executionMS);
                    throw new Error(`step ${stepName}: aborted by user`);
                } else if (response.action === "fix") {
                    track("fix", this.fixTelemetryFields("user", stepName, selectedFindingCount(outcome.findings, response.findingIDs), 0));
                    phaseStart = Date.now();
                    gateDb.updateStepStatus(this.db, sr.id, "fixing");
                    sctx.fixing = true;
                    const selectedFindings = filterFindingsJSON(outcome.findings, response.findingIDs);
                    const mergedFindings = mergeUserOverridesJSON(selectedFindings, response.instructions, response.addedFindings);
                    sctx.previousFindings = mergedFindings;
                    nextTrigger = "auto_fix";
                    if (currentRoundID !== "") {
                        const allSelectedIDs = combineSelectedFindingIDs(response.findingIDs, mergedFindings);
                        const idsJSON = marshalFindingIDs(allSelectedIDs);
                        if (idsJSON !== "") gateDb.setStepRoundSelection(this.db, currentRoundID, idsJSON, gateDb.RoundSelectionSourceUser);
                        if (mergedFindings !== "" && mergedFindings !== selectedFindings) {
                            gateDb.setStepRoundUserFindings(this.db, currentRoundID, mergedFindings);
                        }
                    }
                    this.emitStepEvent2(EventStepCompleted, run, repo, stepName, "fixing", "", "", "", undefined);
                    log.info("step fix requested, re-executing", "step", stepName);
                    continue;
                }
            }

            // done:
            let durationMS = executionMS + (Date.now() - phaseStart);
            if (durationOverrideMS > 0) durationMS = durationOverrideMS;
            const status: StepStatus = stepSkipped ? "skipped" : "completed";
            gateDb.completeStepWithStatus(this.db, sr.id, status, finalExitCode, durationMS, logPath);
            this.emitStepEvent2(EventStepCompleted, run, repo, stepName, status, "", "", "", durationMS);
            return skipRemaining;
        } finally {
            closeSync(logFd);
        }
    }

    /** Blocks until a user action arrives or the signal is aborted. */
    private waitForApproval(signal: AbortSignal): Promise<ApprovalResponse> {
        if (this.bufferedResponse) {
            const r = this.bufferedResponse;
            this.bufferedResponse = null;
            this.clearWaiting();
            return Promise.resolve(r);
        }
        return new Promise<ApprovalResponse>((resolve, reject) => {
            const onAbort = () => {
                this.approvalResolver = null;
                this.clearWaiting();
                reject(causeError(signal));
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            this.approvalResolver = (r: ApprovalResponse) => {
                signal.removeEventListener("abort", onAbort);
                this.clearWaiting();
                resolve(r);
            };
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    private clearWaiting(): void {
        this.waiting = false;
        this.waitingStep = "";
        this.bufferedResponse = null;
    }

    /** Marks a run failed (using the abort cause when present) and returns it. */
    private failRun(run: gateDb.Run, repo: gateDb.Repo, err: Error, signal?: AbortSignal): never {
        let errMsg = err.message;
        if (signal) {
            const cause = causeMessage(signal);
            if (cause !== "") errMsg = cause;
        }
        let runStatus: gateDb.Run["status"] = "failed";
        if (errMsg === RUN_CANCEL_REASON_ABORTED_BY_USER || errMsg === RUN_CANCEL_REASON_SUPERSEDED) {
            runStatus = "cancelled";
        }
        try {
            gateDb.updateRunErrorStatus(this.db, run.id, errMsg, runStatus);
        } catch (dbErr) {
            log.error("failed to update run error status", "run", run.id, "error", String(dbErr));
        }
        run.status = runStatus;
        run.error = errMsg;
        this.emitRunEvent(EventRunCompleted, run, repo);
        throw err;
    }

    // --- event helpers ---

    private emitRunEvent(eventType: EventType, run: gateDb.Run, repo: gateDb.Repo): void {
        this.onEvent({
            type: eventType,
            runId: run.id,
            repoId: repo.id,
            status: run.status,
            branch: run.branch,
            error: run.error ?? undefined,
            prUrl: run.prUrl ?? undefined
        });
    }

    private emitStepEvent(eventType: EventType, run: gateDb.Run, repo: gateDb.Repo, stepName: StepName, status: string): void {
        this.emitStepEvent2(eventType, run, repo, stepName, status, "", "", "", undefined);
    }

    private emitStepEvent2(
        eventType: EventType,
        run: gateDb.Run,
        repo: gateDb.Repo,
        stepName: StepName,
        status: string,
        findings: string,
        diff: string,
        errMsg: string,
        durationMS: number | undefined
    ): void {
        const event: Event = {
            type: eventType,
            runId: run.id,
            repoId: repo.id,
            stepName,
            status,
            durationMs: durationMS
        };
        const stats = this.findingStatsForStep(run.id, stepName);
        if (stats.reportedFindings > 0 || stats.fixedFindings > 0) {
            event.reportedFindings = stats.reportedFindings;
            event.fixedFindings = stats.fixedFindings;
        }
        if (errMsg !== "") event.error = errMsg;
        if (findings !== "") event.findings = findings;
        if (diff !== "") event.diff = diff;
        this.onEvent(event);

        if (!shouldTrackStepTelemetry(eventType, status)) return;
        const fields: Fields = { event: eventType, step: stepName, status };
        const agentName = this.telemetryAgentName();
        if (agentName !== "") fields.agent = agentName;
        if (durationMS !== undefined) fields.duration_ms = durationMS;
        if (findings !== "") fields.findings_count = findingsCount(findings);
        track("step", fields);
    }

    private findingStatsForStep(runID: string, stepName: StepName): { stepName: StepName; reportedFindings: number; fixedFindings: number; } {
        let steps: gateDb.StepResult[];
        try {
            steps = gateDb.getStepsByRun(this.db, runID);
        } catch {
            return { stepName, reportedFindings: 0, fixedFindings: 0 };
        }
        for (const step of steps) {
            if (step.stepName !== stepName) continue;
            try {
                return gateDb.stepFindingStats(this.db, step);
            } catch {
                return { stepName, reportedFindings: 0, fixedFindings: 0 };
            }
        }
        return { stepName, reportedFindings: 0, fixedFindings: 0 };
    }

    private emitLogChunk(run: gateDb.Run, repo: gateDb.Repo, stepName: StepName, content: string): void {
        this.onEvent({ type: EventLogChunk, runId: run.id, repoId: repo.id, stepName, content });
    }

    private telemetryAgentName(): string {
        if (!this.config || this.config.agent === "") return "";
        return this.config.agent;
    }

    private fixTelemetryFields(source: string, stepName: StepName, selectedCount: number, attempt: number): Fields {
        const fields: Fields = { source, step: stepName, selected_findings_count: selectedCount };
        const agentName = this.telemetryAgentName();
        if (agentName !== "") fields.agent = agentName;
        if (attempt > 0) fields.attempt = attempt;
        return fields;
    }
}

function shouldTrackStepTelemetry(eventType: EventType, status: string): boolean {
    if (eventType !== EventStepCompleted) return false;
    return status === "awaiting_approval" || status === "fix_review" || status === "failed";
}

function findingsCount(raw: string): number {
    try {
        return parseFindingsJSON(raw).items.length;
    } catch {
        return 0;
    }
}

function selectedFindingCount(raw: string, ids: string[]): number {
    if (ids.length > 0) return ids.length;
    return findingsCount(raw);
}
