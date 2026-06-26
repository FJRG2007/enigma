/**
 * Shared gate types: run/step lifecycle states, the fixed pipeline step order,
 * approval actions, agent backends, and the structured findings payload that
 * crosses the pipeline / IPC / TUI boundaries.
 *
 * Faithful port of the Go `internal/types` package. Findings JSON keeps the same
 * wire shape (current + legacy keys) so recorded runs and agent output decode
 * identically to no-mistakes.
 */

/** Lifecycle state of a pipeline run. */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const RUN_CANCEL_REASON_ABORTED_BY_USER = "cancelled: aborted by user";
export const RUN_CANCEL_REASON_SUPERSEDED = "cancelled: superseded by new push";

/** Identifies a pipeline step. */
export type StepName =
    | "intent"
    | "rebase"
    | "review"
    | "test"
    | "document"
    | "lint"
    | "push"
    | "pr"
    | "ci";

export const STEP_INTENT: StepName = "intent";
export const STEP_REBASE: StepName = "rebase";
export const STEP_REVIEW: StepName = "review";
export const STEP_TEST: StepName = "test";
export const STEP_DOCUMENT: StepName = "document";
export const STEP_LINT: StepName = "lint";
export const STEP_PUSH: StepName = "push";
export const STEP_PR: StepName = "pr";
export const STEP_CI: StepName = "ci";

const STEP_ORDER: Record<StepName, number> = {
    intent: 1,
    rebase: 2,
    review: 3,
    test: 4,
    document: 5,
    lint: 6,
    push: 7,
    pr: 8,
    ci: 9
};

/** Normalizes a raw step name, mapping the legacy `babysit` alias to `ci`. */
export function normalizeStepName(raw: string): StepName {
    return (raw === "babysit" ? "ci" : raw) as StepName;
}

/** Fixed execution order for a step (1-indexed); 0 for an unknown step. */
export function stepOrder(step: StepName): number {
    return STEP_ORDER[step] ?? 0;
}

/** All pipeline steps in execution order. */
export function allSteps(): StepName[] {
    return ["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"];
}

/** Lifecycle state of a pipeline step. */
export type StepStatus =
    | "pending"
    | "running"
    | "awaiting_approval"
    | "fixing"
    | "fix_review"
    | "completed"
    | "skipped"
    | "failed";

/** User responses at an approval gate. */
export type ApprovalAction = "approve" | "fix" | "skip" | "abort";

/**
 * Supported agent backends. ACP agents use dynamic `acp:<target>` values rather
 * than a constant, so `AgentName` stays a string.
 */
export type AgentName = string;
export const AGENT_AUTO = "auto";
export const AGENT_CLAUDE = "claude";
export const AGENT_CODEX = "codex";
export const AGENT_ROVODEV = "rovodev";
export const AGENT_OPENCODE = "opencode";
export const AGENT_PI = "pi";

/** Finding action: informational, mechanically fixable, or a user judgment call. */
export const ACTION_NOOP = "no-op";
export const ACTION_AUTOFIX = "auto-fix";
export const ACTION_ASKUSER = "ask-user";

/** Finding source. An empty source is treated as agent-produced. */
export const FINDING_SOURCE_AGENT = "agent";
export const FINDING_SOURCE_USER = "user";

/** A single review, test, lint, or PR-comment finding. */
export interface Finding {
    id?: string;
    severity: string;
    file?: string;
    line?: number;
    description: string;
    action: string;
    source?: string;
    userInstructions?: string;
}

/** Evidence produced by the test step for human review. */
export interface TestArtifact {
    kind?: string;
    label: string;
    path?: string;
    url?: string;
    content?: string;
}

/** Structured findings payload exchanged across pipeline, IPC, and TUI. */
export interface Findings {
    items: Finding[];
    summary: string;
    tested?: string[];
    testingSummary?: string;
    artifacts?: TestArtifact[];
    riskLevel: string;
    riskRationale: string;
}

/** Returns the effective action, defaulting an empty action to auto-fix. */
function actionOrDefault(f: Finding): string {
    return f.action === "" || f.action === undefined ? ACTION_AUTOFIX : f.action;
}

function emptyFindings(): Findings {
    return { items: [], summary: "", riskLevel: "", riskRationale: "" };
}

/** Shallow clone of a Findings carrying everything except the items list. */
function withoutItems(f: Findings): Findings {
    return {
        items: [],
        summary: f.summary,
        tested: f.tested,
        testingSummary: f.testingSummary,
        artifacts: f.artifacts,
        riskLevel: f.riskLevel,
        riskRationale: f.riskRationale
    };
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
    // Legacy compatibility: derive the action from requires_human_review when
    // the explicit action field is absent.
    if (f.action === "" && typeof raw.requires_human_review === "boolean") {
        f.action = raw.requires_human_review ? ACTION_ASKUSER : ACTION_AUTOFIX;
    }
    return f;
}

/**
 * Decodes findings JSON, accepting current (`findings`) and legacy (`items`)
 * item keys plus legacy `requires_human_review` fields.
 */
export function parseFindingsJSON(raw: string): Findings {
    const wire = JSON.parse(raw) as any;
    let rawItems: any[] = Array.isArray(wire.findings) ? wire.findings : [];
    if (rawItems.length === 0 && Array.isArray(wire.items)) rawItems = wire.items;
    return {
        items: rawItems.map(decodeFinding),
        summary: wire.summary ?? "",
        tested: wire.tested ?? undefined,
        testingSummary: wire.testing_summary ?? undefined,
        artifacts: wire.artifacts ?? undefined,
        riskLevel: wire.risk_level ?? "",
        riskRationale: wire.risk_rationale ?? ""
    };
}

/** Encodes findings using the current wire shape (risk fields always present). */
export function marshalFindingsJSON(f: Findings): string {
    const wire: any = {
        findings: f.items.map(encodeFinding),
        summary: f.summary,
        risk_level: f.riskLevel,
        risk_rationale: f.riskRationale
    };
    if (f.tested !== undefined) wire.tested = f.tested;
    if (f.testingSummary !== undefined) wire.testing_summary = f.testingSummary;
    if (f.artifacts !== undefined) wire.artifacts = f.artifacts;
    return JSON.stringify(wire);
}

function encodeFinding(f: Finding): any {
    const wire: any = { severity: f.severity, description: f.description, action: f.action };
    if (f.id) wire.id = f.id;
    if (f.file) wire.file = f.file;
    if (f.line) wire.line = f.line;
    if (f.source) wire.source = f.source;
    if (f.userInstructions) wire.user_instructions = f.userInstructions;
    return wire;
}

/** Assigns deterministic `<prefix>-N` IDs to findings that lack one. */
export function normalizeFindings(findings: Findings, prefix: string): Findings {
    findings.items.forEach((item, i) => {
        if (!item.id) item.id = `${prefix}-${i + 1}`;
    });
    return findings;
}

function summarizeSelectedFindings(count: number): string {
    if (count === 0) return "0 selected findings";
    if (count === 1) return "1 selected finding";
    return `${count} selected findings`;
}

function isSelectedFindingsSummary(summary: string): boolean {
    if (summary === "0 selected findings" || summary === "1 selected finding") return true;
    if (!summary.endsWith(" selected findings")) return false;
    const count = summary.slice(0, -" selected findings".length);
    return count.length > 0 && /^[0-9]+$/.test(count);
}

/** Keeps only findings whose IDs are in `ids` (empty ids keeps everything). */
export function filterFindings(findings: Findings, ids: string[]): Findings {
    if (ids.length === 0) return findings;
    const selected = new Set(ids);
    const filtered = withoutItems(findings);
    filtered.items = findings.items.filter(item => selected.has(item.id ?? ""));
    if (filtered.items.length !== findings.items.length) {
        filtered.summary = summarizeSelectedFindings(filtered.items.length);
    }
    return filtered;
}

/** Keeps only findings whose IDs are NOT in `ids`. */
export function excludeFindings(findings: Findings, ids: string[]): Findings {
    if (ids.length === 0) return findings;
    const excluded = new Set(ids);
    const result = withoutItems(findings);
    result.items = findings.items.filter(item => !excluded.has(item.id ?? ""));
    return result;
}

/** Returns only findings whose effective action is `auto-fix`. */
export function autoFixableFindings(findings: Findings): Findings {
    const result = withoutItems(findings);
    result.items = findings.items.filter(item => actionOrDefault(item) === ACTION_AUTOFIX);
    return result;
}

function nextUserFindingID(used: Set<string>, counter: number): [string, number] {
    for (;;) {
        counter++;
        const candidate = `user-${counter}`;
        if (used.has(candidate)) continue;
        used.add(candidate);
        return [candidate, counter];
    }
}

/**
 * Applies per-finding user instructions to existing agent findings and appends
 * user-added findings at the end. Added findings get `source: user`, a default
 * `auto-fix` action, and a deterministic `user-N` ID on collision. The original
 * Findings is not mutated.
 */
export function mergeUserOverrides(
    findings: Findings,
    instructions: Record<string, string> | null | undefined,
    added: Finding[] | null | undefined
): Findings {
    const result = withoutItems(findings);
    result.items = findings.items.map(item => ({ ...item }));
    if (instructions) {
        for (const item of result.items) {
            const note = instructions[item.id ?? ""];
            if (note !== undefined) item.userInstructions = note;
        }
    }
    const used = new Set<string>();
    for (const item of result.items) {
        if (item.id) used.add(item.id);
    }
    let counter = 0;
    let appended = false;
    for (const raw of added ?? []) {
        const item: Finding = { ...raw, source: FINDING_SOURCE_USER };
        if (item.action === "" || item.action === undefined) item.action = ACTION_AUTOFIX;
        if (!item.id || used.has(item.id)) {
            [item.id, counter] = nextUserFindingID(used, counter);
        } else {
            used.add(item.id);
        }
        result.items.push(item);
        appended = true;
    }
    if (appended && isSelectedFindingsSummary(result.summary)) {
        result.summary = summarizeSelectedFindings(result.items.length);
    }
    return result;
}

/** Reports whether any finding has action `ask-user`. */
export function hasAskUserFindings(findings: Findings): boolean {
    return findings.items.some(item => item.action === ACTION_ASKUSER);
}

/**
 * Reports whether any finding warrants a fix - any finding whose effective
 * action is not `no-op`. A step with only no-op (or no) findings returns false.
 */
export function hasActionableFindings(findings: Findings): boolean {
    return findings.items.some(item => actionOrDefault(item) !== ACTION_NOOP);
}

export { emptyFindings };
