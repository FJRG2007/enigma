/**
 * JSON-RPC 2.0 wire protocol for the gate daemon's IPC endpoint. Faithful port of
 * upstream's `internal/ipc/protocol.go`.
 *
 * Transport contract: newline-delimited JSON, one message per line, matching
 * `mcp.ts`. TypeScript fields are camelCase; the JSON wire keys stay snake_case
 * exactly as the Go json tags, so a Go `ipc` client can talk to this server
 * unchanged. The explicit encode/decode helpers own that translation, honoring
 * Go's `omitempty` (empty string, zero number, false, null, and empty slice are
 * dropped from the wire).
 */

import type { Run, StepResult } from "../db";
import { ACTION_ASKUSER, ACTION_AUTOFIX } from "../types";
import type { Finding, StepName, RunStatus, StepStatus, ApprovalAction } from "../types";

/** JSON-RPC 2.0 method names. */
export const MethodHealth = "health";
export const MethodRerun = "rerun";
export const MethodGetRun = "get_run";
export const MethodGetRuns = "get_runs";
export const MethodRespond = "respond";
export const MethodShutdown = "shutdown";
export const MethodSubscribe = "subscribe";
export const MethodCancelRun = "cancel_run";
export const MethodGetActiveRun = "get_active_run";
export const MethodPushReceived = "push_received";

/** JSON-RPC 2.0 error codes. */
export const ErrParseError = -32700;
export const ErrInvalidRequest = -32600;
export const ErrMethodNotFound = -32601;
export const ErrInvalidParams = -32602;
export const ErrInternal = -32603;

/** A JSON-RPC 2.0 request. `params` carries the already wire-encoded payload. */
export interface Request {
    jsonrpc: string;
    method: string;
    params?: unknown;
    id: number;
}

/** A JSON-RPC 2.0 error object as it appears on the wire. */
export interface RPCErrorObject {
    code: number;
    message: string;
}

/** A JSON-RPC 2.0 response. `result` carries the wire-encoded payload. */
export interface Response {
    jsonrpc: string;
    result?: unknown;
    error?: RPCErrorObject;
    id: number;
}

/** A JSON-RPC error surfaced to the client as a throwable, mirroring Go's RPCError. */
export class RPCError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.code = code;
        this.name = "RPCError";
    }
}

// --- Method parameters ---

/**
 * Sent by the post-receive hook when a push arrives. `intent`, when set, is an
 * agent-supplied description stamped onto the run so the intent step uses it
 * verbatim instead of inferring intent from local transcripts.
 */
export interface PushReceivedParams {
    gate: string;
    ref: string;
    old: string;
    new: string;
    skipSteps?: StepName[];
    intent?: string;
}

/** Requests a single run by ID. */
export interface GetRunParams {
    runId: string;
}

/** Requests all runs for a repo. */
export interface GetRunsParams {
    repoId: string;
}

/** Requests the active run for a repo; `branch`, when set, is preferred. */
export interface GetActiveRunParams {
    repoId: string;
    branch?: string;
}

/** Requests a new run for the latest gate head on a branch. */
export interface RerunParams {
    repoId: string;
    branch: string;
    skipSteps?: StepName[];
    intent?: string;
}

/** Starts an event stream for a run. */
export interface SubscribeParams {
    runId: string;
}

/**
 * Sends a user action for a step awaiting approval. `instructions` carries
 * optional per-finding notes keyed by finding ID; `addedFindings` carries
 * user-authored findings merged into the round. Both apply only when `action`
 * triggers a fix round.
 */
export interface RespondParams {
    runId: string;
    step: StepName;
    action: ApprovalAction;
    findingIds?: string[];
    instructions?: Record<string, string>;
    addedFindings?: Finding[];
}

/** Cancels an active pipeline run. */
export interface CancelRunParams {
    runId: string;
}

// --- Method results ---

/** Confirms the push was accepted. */
export interface PushReceivedResult {
    runId: string;
}

/** Wraps a single run (null when absent). */
export interface GetRunResult {
    run: RunInfo | null;
}

/** Wraps a list of runs. */
export interface GetRunsResult {
    runs: RunInfo[];
}

/** Wraps the active run (null when none). */
export interface GetActiveRunResult {
    run: RunInfo | null;
}

/** Confirms a rerun was created. */
export interface RerunResult {
    runId: string;
}

/** Confirms the action was accepted. */
export interface RespondResult {
    ok: boolean;
}

/** Confirms the run cancellation request was accepted. */
export interface CancelRunResult {
    ok: boolean;
}

/** Confirms the daemon is alive. */
export interface HealthResult {
    status: string;
}

/** Confirms shutdown was initiated. */
export interface ShutdownResult {
    ok: boolean;
}

// --- Wire types ---

/** The IPC representation of a pipeline run. */
export interface RunInfo {
    id: string;
    repoId: string;
    branch: string;
    headSha: string;
    baseSha: string;
    status: RunStatus;
    prUrl: string | null;
    error: string | null;
    /**
     * True while the run is parked at a gate awaiting the driving agent's
     * response. `awaitingAgentSince` is the unix-seconds time it parked. Both are
     * observability only and clear the moment the agent responds.
     */
    awaitingAgent: boolean;
    awaitingAgentSince: number | null;
    steps: StepResultInfo[];
    createdAt: number;
    updatedAt: number;
}

/** The IPC representation of a step result. */
export interface StepResultInfo {
    id: string;
    runId: string;
    stepName: StepName;
    stepOrder: number;
    status: StepStatus;
    exitCode: number | null;
    durationMs: number | null;
    findingsJson: string | null;
    reportedFindings: number;
    fixedFindings: number;
    /**
     * One entry per fix round the pipeline ran for this step, in round order: the
     * agent's one-line fix summary, or "" when the round recorded none.
     */
    fixSummaries: string[];
    error: string | null;
    startedAt: number | null;
    completedAt: number | null;
}

// --- Events (for the subscribe stream) ---

/** Identifies the kind of streamed event. */
export type EventType =
    | "run_created"
    | "run_updated"
    | "run_completed"
    | "step_started"
    | "step_completed"
    | "log_chunk";

export const EventRunCreated: EventType = "run_created";
export const EventRunUpdated: EventType = "run_updated";
export const EventRunCompleted: EventType = "run_completed";
export const EventStepStarted: EventType = "step_started";
export const EventStepCompleted: EventType = "step_completed";
export const EventLogChunk: EventType = "log_chunk";

/** A real-time update sent to subscribers. */
export interface Event {
    type: EventType;
    runId: string;
    repoId: string;
    stepName?: StepName;
    status?: string;
    error?: string;
    stream?: string;
    content?: string;
    branch?: string;
    /** JSON-encoded findings for step_completed events. */
    findings?: string;
    /** Unified diff for fix_review events. */
    diff?: string;
    reportedFindings?: number;
    fixedFindings?: number;
    /** Execution-only duration for step events. */
    durationMs?: number;
    /** PR URL for run_updated/run_completed events. */
    prUrl?: string;
}

// --- Finding (de)serialization ---
//
// Inlined from the (private) helpers in `../types` since that module is frozen.
// Mirrors its `encodeFinding`/`decodeFinding` wire shape exactly.

function encodeFinding(f: Finding): Record<string, unknown> {
    const w: Record<string, unknown> = { severity: f.severity, description: f.description, action: f.action };
    if (f.id) w.id = f.id;
    if (f.file) w.file = f.file;
    if (f.line) w.line = f.line;
    if (f.source) w.source = f.source;
    if (f.userInstructions) w.user_instructions = f.userInstructions;
    return w;
}

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

// --- Param (de)serialization ---

/** Encodes push-received params to the snake_case wire shape. */
export function encodePushReceivedParams(p: PushReceivedParams): Record<string, unknown> {
    const w: Record<string, unknown> = { gate: p.gate, ref: p.ref, old: p.old, new: p.new };
    if (p.skipSteps && p.skipSteps.length > 0) w.skip_steps = p.skipSteps;
    if (p.intent) w.intent = p.intent;
    return w;
}

/** Decodes push-received params from the wire. */
export function decodePushReceivedParams(raw: any): PushReceivedParams {
    return {
        gate: raw.gate ?? "",
        ref: raw.ref ?? "",
        old: raw.old ?? "",
        new: raw.new ?? "",
        skipSteps: Array.isArray(raw.skip_steps) ? (raw.skip_steps as StepName[]) : undefined,
        intent: raw.intent ?? undefined
    };
}

/** Encodes get-run params to the wire. */
export function encodeGetRunParams(p: GetRunParams): Record<string, unknown> {
    return { run_id: p.runId };
}

/** Decodes get-run params from the wire. */
export function decodeGetRunParams(raw: any): GetRunParams {
    return { runId: raw.run_id ?? "" };
}

/** Encodes get-runs params to the wire. */
export function encodeGetRunsParams(p: GetRunsParams): Record<string, unknown> {
    return { repo_id: p.repoId };
}

/** Decodes get-runs params from the wire. */
export function decodeGetRunsParams(raw: any): GetRunsParams {
    return { repoId: raw.repo_id ?? "" };
}

/** Encodes get-active-run params to the wire. */
export function encodeGetActiveRunParams(p: GetActiveRunParams): Record<string, unknown> {
    const w: Record<string, unknown> = { repo_id: p.repoId };
    if (p.branch) w.branch = p.branch;
    return w;
}

/** Decodes get-active-run params from the wire. */
export function decodeGetActiveRunParams(raw: any): GetActiveRunParams {
    return { repoId: raw.repo_id ?? "", branch: raw.branch ?? undefined };
}

/** Encodes rerun params to the wire. */
export function encodeRerunParams(p: RerunParams): Record<string, unknown> {
    const w: Record<string, unknown> = { repo_id: p.repoId, branch: p.branch };
    if (p.skipSteps && p.skipSteps.length > 0) w.skip_steps = p.skipSteps;
    if (p.intent) w.intent = p.intent;
    return w;
}

/** Decodes rerun params from the wire. */
export function decodeRerunParams(raw: any): RerunParams {
    return {
        repoId: raw.repo_id ?? "",
        branch: raw.branch ?? "",
        skipSteps: Array.isArray(raw.skip_steps) ? (raw.skip_steps as StepName[]) : undefined,
        intent: raw.intent ?? undefined
    };
}

/** Encodes subscribe params to the wire. */
export function encodeSubscribeParams(p: SubscribeParams): Record<string, unknown> {
    return { run_id: p.runId };
}

/** Decodes subscribe params from the wire. */
export function decodeSubscribeParams(raw: any): SubscribeParams {
    return { runId: raw.run_id ?? "" };
}

/** Encodes respond params to the wire. */
export function encodeRespondParams(p: RespondParams): Record<string, unknown> {
    const w: Record<string, unknown> = { run_id: p.runId, step: p.step, action: p.action };
    if (p.findingIds && p.findingIds.length > 0) w.finding_ids = p.findingIds;
    if (p.instructions && Object.keys(p.instructions).length > 0) w.instructions = p.instructions;
    if (p.addedFindings && p.addedFindings.length > 0) w.added_findings = p.addedFindings.map(encodeFinding);
    return w;
}

/** Decodes respond params from the wire. */
export function decodeRespondParams(raw: any): RespondParams {
    return {
        runId: raw.run_id ?? "",
        step: raw.step as StepName,
        action: raw.action as ApprovalAction,
        findingIds: Array.isArray(raw.finding_ids) ? (raw.finding_ids as string[]) : undefined,
        instructions: raw.instructions ?? undefined,
        addedFindings: Array.isArray(raw.added_findings) ? raw.added_findings.map(decodeFinding) : undefined
    };
}

/** Encodes cancel-run params to the wire. */
export function encodeCancelRunParams(p: CancelRunParams): Record<string, unknown> {
    return { run_id: p.runId };
}

/** Decodes cancel-run params from the wire. */
export function decodeCancelRunParams(raw: any): CancelRunParams {
    return { runId: raw.run_id ?? "" };
}

// --- Result (de)serialization ---

/** Encodes a push-received result to the wire. */
export function encodePushReceivedResult(r: PushReceivedResult): Record<string, unknown> {
    return { run_id: r.runId };
}

/** Decodes a push-received result from the wire. */
export function decodePushReceivedResult(raw: any): PushReceivedResult {
    return { runId: raw.run_id ?? "" };
}

/** Encodes a get-run result to the wire (run is always present, null when absent). */
export function encodeGetRunResult(r: GetRunResult): Record<string, unknown> {
    return { run: r.run ? encodeRunInfo(r.run) : null };
}

/** Decodes a get-run result from the wire. */
export function decodeGetRunResult(raw: any): GetRunResult {
    return { run: raw?.run ? decodeRunInfo(raw.run) : null };
}

/** Encodes a get-runs result to the wire. */
export function encodeGetRunsResult(r: GetRunsResult): Record<string, unknown> {
    return { runs: r.runs.map(encodeRunInfo) };
}

/** Decodes a get-runs result from the wire. */
export function decodeGetRunsResult(raw: any): GetRunsResult {
    return { runs: Array.isArray(raw?.runs) ? raw.runs.map(decodeRunInfo) : [] };
}

/** Encodes a get-active-run result to the wire (run omitted when null). */
export function encodeGetActiveRunResult(r: GetActiveRunResult): Record<string, unknown> {
    const w: Record<string, unknown> = {};
    if (r.run) w.run = encodeRunInfo(r.run);
    return w;
}

/** Decodes a get-active-run result from the wire. */
export function decodeGetActiveRunResult(raw: any): GetActiveRunResult {
    return { run: raw?.run ? decodeRunInfo(raw.run) : null };
}

/** Encodes a rerun result to the wire. */
export function encodeRerunResult(r: RerunResult): Record<string, unknown> {
    return { run_id: r.runId };
}

/** Decodes a rerun result from the wire. */
export function decodeRerunResult(raw: any): RerunResult {
    return { runId: raw.run_id ?? "" };
}

/** Decodes an ok result ({ ok }) shared by respond/cancel/shutdown. */
function decodeOK(raw: any): boolean {
    return raw?.ok === true;
}

/** Decodes a respond result from the wire. */
export function decodeRespondResult(raw: any): RespondResult {
    return { ok: decodeOK(raw) };
}

/** Decodes a cancel-run result from the wire. */
export function decodeCancelRunResult(raw: any): CancelRunResult {
    return { ok: decodeOK(raw) };
}

/** Decodes a health result from the wire. */
export function decodeHealthResult(raw: any): HealthResult {
    return { status: raw?.status ?? "" };
}

/** Decodes a shutdown result from the wire. */
export function decodeShutdownResult(raw: any): ShutdownResult {
    return { ok: decodeOK(raw) };
}

// --- RunInfo / StepResultInfo (de)serialization ---

/** Encodes a RunInfo to the snake_case wire shape, honoring omitempty. */
export function encodeRunInfo(r: RunInfo): Record<string, unknown> {
    const w: Record<string, unknown> = {
        id: r.id,
        repo_id: r.repoId,
        branch: r.branch,
        head_sha: r.headSha,
        base_sha: r.baseSha,
        status: r.status
    };
    if (r.prUrl != null) w.pr_url = r.prUrl;
    if (r.error != null) w.error = r.error;
    if (r.awaitingAgent) w.awaiting_agent = true;
    if (r.awaitingAgentSince != null) w.awaiting_agent_since = r.awaitingAgentSince;
    if (r.steps && r.steps.length > 0) w.steps = r.steps.map(encodeStepResultInfo);
    w.created_at = r.createdAt;
    w.updated_at = r.updatedAt;
    return w;
}

/** Decodes a RunInfo from the wire. */
export function decodeRunInfo(raw: any): RunInfo {
    return {
        id: raw.id ?? "",
        repoId: raw.repo_id ?? "",
        branch: raw.branch ?? "",
        headSha: raw.head_sha ?? "",
        baseSha: raw.base_sha ?? "",
        status: raw.status as RunStatus,
        prUrl: raw.pr_url ?? null,
        error: raw.error ?? null,
        awaitingAgent: raw.awaiting_agent ?? false,
        awaitingAgentSince: raw.awaiting_agent_since ?? null,
        steps: Array.isArray(raw.steps) ? raw.steps.map(decodeStepResultInfo) : [],
        createdAt: raw.created_at ?? 0,
        updatedAt: raw.updated_at ?? 0
    };
}

/** Encodes a StepResultInfo to the snake_case wire shape, honoring omitempty. */
export function encodeStepResultInfo(s: StepResultInfo): Record<string, unknown> {
    const w: Record<string, unknown> = {
        id: s.id,
        run_id: s.runId,
        step_name: s.stepName,
        step_order: s.stepOrder,
        status: s.status
    };
    if (s.exitCode != null) w.exit_code = s.exitCode;
    if (s.durationMs != null) w.duration_ms = s.durationMs;
    if (s.findingsJson != null) w.findings_json = s.findingsJson;
    if (s.reportedFindings) w.reported_findings = s.reportedFindings;
    if (s.fixedFindings) w.fixed_findings = s.fixedFindings;
    if (s.fixSummaries && s.fixSummaries.length > 0) w.fix_summaries = s.fixSummaries;
    if (s.error != null) w.error = s.error;
    if (s.startedAt != null) w.started_at = s.startedAt;
    if (s.completedAt != null) w.completed_at = s.completedAt;
    return w;
}

/** Decodes a StepResultInfo from the wire. */
export function decodeStepResultInfo(raw: any): StepResultInfo {
    return {
        id: raw.id ?? "",
        runId: raw.run_id ?? "",
        stepName: raw.step_name as StepName,
        stepOrder: raw.step_order ?? 0,
        status: raw.status as StepStatus,
        exitCode: raw.exit_code ?? null,
        durationMs: raw.duration_ms ?? null,
        findingsJson: raw.findings_json ?? null,
        reportedFindings: raw.reported_findings ?? 0,
        fixedFindings: raw.fixed_findings ?? 0,
        fixSummaries: Array.isArray(raw.fix_summaries) ? (raw.fix_summaries as string[]) : [],
        error: raw.error ?? null,
        startedAt: raw.started_at ?? null,
        completedAt: raw.completed_at ?? null
    };
}

// --- Event (de)serialization ---

/** Encodes an Event to the snake_case wire shape, honoring omitempty. */
export function encodeEvent(e: Event): Record<string, unknown> {
    const w: Record<string, unknown> = { type: e.type, run_id: e.runId, repo_id: e.repoId };
    if (e.stepName != null) w.step_name = e.stepName;
    if (e.status != null) w.status = e.status;
    if (e.error != null) w.error = e.error;
    if (e.stream != null) w.stream = e.stream;
    if (e.content != null) w.content = e.content;
    if (e.branch != null) w.branch = e.branch;
    if (e.findings != null) w.findings = e.findings;
    if (e.diff != null) w.diff = e.diff;
    if (e.reportedFindings != null) w.reported_findings = e.reportedFindings;
    if (e.fixedFindings != null) w.fixed_findings = e.fixedFindings;
    if (e.durationMs != null) w.duration_ms = e.durationMs;
    if (e.prUrl != null) w.pr_url = e.prUrl;
    return w;
}

/** Decodes an Event from the wire. */
export function decodeEvent(raw: any): Event {
    return {
        type: raw.type as EventType,
        runId: raw.run_id ?? "",
        repoId: raw.repo_id ?? "",
        stepName: raw.step_name ?? undefined,
        status: raw.status ?? undefined,
        error: raw.error ?? undefined,
        stream: raw.stream ?? undefined,
        content: raw.content ?? undefined,
        branch: raw.branch ?? undefined,
        findings: raw.findings ?? undefined,
        diff: raw.diff ?? undefined,
        reportedFindings: raw.reported_findings ?? undefined,
        fixedFindings: raw.fixed_findings ?? undefined,
        durationMs: raw.duration_ms ?? undefined,
        prUrl: raw.pr_url ?? undefined
    };
}

// --- DB-row mappers ---

/**
 * Maps a DB run row plus its already-mapped step results to the IPC RunInfo.
 * `awaitingAgent` is derived from `awaitingAgentSince` (the upstream
 * `runToInfo` convention).
 */
export function runToInfo(r: Run, steps: StepResultInfo[] = []): RunInfo {
    return {
        id: r.id,
        repoId: r.repoId,
        branch: r.branch,
        headSha: r.headSha,
        baseSha: r.baseSha,
        status: r.status,
        prUrl: r.prUrl,
        error: r.error,
        awaitingAgent: r.awaitingAgentSince != null,
        awaitingAgentSince: r.awaitingAgentSince,
        steps,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
    };
}

/** Extra per-step fields derived from the step's rounds (not stored on the row). */
export interface StepInfoExtras {
    reportedFindings?: number;
    fixedFindings?: number;
    fixSummaries?: string[];
}

/** Maps a DB step-result row (plus round-derived extras) to the IPC StepResultInfo. */
export function stepToInfo(s: StepResult, extras: StepInfoExtras = {}): StepResultInfo {
    return {
        id: s.id,
        runId: s.runId,
        stepName: s.stepName,
        stepOrder: s.stepOrder,
        status: s.status,
        exitCode: s.exitCode,
        durationMs: s.durationMs,
        findingsJson: s.findingsJson,
        reportedFindings: extras.reportedFindings ?? 0,
        fixedFindings: extras.fixedFindings ?? 0,
        fixSummaries: extras.fixSummaries ?? [],
        error: s.error,
        startedAt: s.startedAt,
        completedAt: s.completedAt
    };
}

// --- Request/response constructors ---

let reqId = 0;

/** Creates a JSON-RPC 2.0 request with an auto-incremented ID (starts at 1). */
export function newRequest(method: string, params: unknown): Request {
    return { jsonrpc: "2.0", method, params, id: ++reqId };
}

/** Creates a successful JSON-RPC 2.0 response. */
export function newResponse(id: number, result: unknown): Response {
    return { jsonrpc: "2.0", result, id };
}

/** Creates an error JSON-RPC 2.0 response. */
export function newErrorResponse(id: number, code: number, message: string): Response {
    return { jsonrpc: "2.0", error: { code, message }, id };
}
