/**
 * Pipeline step contracts: the shared execution context handed to each step, the
 * outcome a step returns, and the Step interface itself. Faithful port of the Go
 * `internal/pipeline/pipeline.go`. The Go `context.Context` maps to an
 * `AbortSignal` threaded through step work.
 */

import type { Config } from "../config";
import type { Agent } from "../agent/agent";
import type { Database, Run, Repo } from "../db";

/** Shared resources provided to a pipeline step during execution. */
export interface StepContext {
    signal: AbortSignal;
    run: Run;
    repo: Repo;
    workDir: string;
    agent: Agent;
    config: Config;
    db: Database;
    /** Discrete log line (newline-terminated, user-visible + file). */
    log: (text: string) => void;
    /** Raw streaming chunk (user-visible + file). */
    logChunk: (text: string) => void;
    /** File-only log line (not shown to the user). */
    logFile: (text: string) => void;
    /** True when re-executing after a "fix" action. */
    fixing: boolean;
    /** JSON findings from the previous execution (set during the fix loop). */
    previousFindings: string;
    /** DB row ID of the current step's step_results record. */
    stepResultID: string;
    /** Extra environment variables for subprocesses (used in tests). */
    env: string[];
    /**
     * Short, possibly-empty summary of what the change author was trying to
     * accomplish, surfaced in step prompts so agents have context beyond the diff.
     */
    userIntent: string;
}

/** Result of executing a pipeline step. */
export interface StepOutcome {
    /** Whether the step pauses for user action. */
    needsApproval: boolean;
    autoFixable: boolean;
    /** JSON findings for display (optional). */
    findings: string;
    /** Process exit code (0 = success). */
    exitCode: number;
    /** PR/MR URL if this step created or found one. */
    prUrl: string;
    /** Mark the step skipped without failing the run. */
    skipped: boolean;
    /** Skip all subsequent steps (e.g. empty diff after rebase). */
    skipRemaining: boolean;
    /** The agent's one-line commit summary for a fix attempt (fix mode only). */
    fixSummary: string;
    /** When positive, replaces the reported wall-clock duration (demo mode). */
    durationOverrideMS: number;
}

/** Returns a zero-value StepOutcome with the given overrides applied. */
export function newStepOutcome(partial: Partial<StepOutcome> = {}): StepOutcome {
    return {
        needsApproval: false,
        autoFixable: false,
        findings: "",
        exitCode: 0,
        prUrl: "",
        skipped: false,
        skipRemaining: false,
        fixSummary: "",
        durationOverrideMS: 0,
        ...partial
    };
}

/** A pipeline step in the fixed execution sequence. */
export interface Step {
    /** The step's identity in the fixed pipeline sequence. */
    name(): import("../types").StepName;
    /** Runs the step logic. Returning needsApproval=true pauses the pipeline. */
    execute(sctx: StepContext): Promise<StepOutcome>;
}
