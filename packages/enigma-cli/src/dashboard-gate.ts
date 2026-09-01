/**
 * Bridge that exposes the AI quality gate to the loopback dashboard: its two YAML
 * config files, the daemon's liveness, and the runs recorded for a project.
 *
 * SPLIT BY RUNTIME. The config half is plain filesystem work and always available.
 * The run half lives in the gate's SQLite database, which is opened through
 * `bun:sqlite` and therefore only exists when enigma runs on its own Bun binary -
 * the same wall that makes the status line read a JSON snapshot instead of the
 * database. Every import of that layer is dynamic and guarded, so under a Node dev
 * runtime the view degrades to the config half rather than failing the request.
 *
 * Writes are validated before they land: a config is parsed by the gate's OWN
 * loader from a temporary file and only renamed into place once it parses, so a
 * typo in the browser can never leave the daemon with a config it cannot read.
 * The form controls take the same route: each one edits ONE key in place (the
 * surrounding comments and layout survive) and then goes through that validator,
 * so the structured editor and the raw YAML editor can never disagree.
 */

import * as conf from "./config";
import { homedir } from "node:os";
import { Paths } from "./gate/paths";
import { dirname, join } from "node:path";
import * as gateConf from "./gate/config";
import { lookPath } from "./gate/agent/factory";
import { gateInitialized } from "./dashboard-projects";
import { processRunning, readDaemonPIDFile } from "./gate/daemon/recover";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** One pipeline step of a run, flattened for the browser. */
export interface GateStepView {
    name: string;
    status: string;
    durationMs: number | null;
    findings: number;
    /** Unix seconds the step started, so a running step can tick live in the browser. */
    startedAt: number | null;
    completedAt: number | null;
}

/** The step a run is currently working on, with the tail of what it is writing. */
export interface GateActivityView {
    step: string;
    status: string;
    startedAt: number | null;
    /** Last lines of that step's log, oldest first, so the view shows live progress. */
    tail: string[];
}

/** A finding the pipeline is parked on, flattened for the browser. */
export interface GateFindingView {
    id: string;
    severity: string;
    action: string;
    file: string;
    description: string;
}

/** One run, newest first in `GateOverview.runs`. */
export interface GateRunView {
    id: string;
    branch: string;
    status: string;
    headSha: string;
    prUrl: string | null;
    error: string | null;
    awaitingAgent: boolean;
    /**
     * The human action the run is waiting on, or null. Separate from awaitingAgent:
     * that one is a gate the driving agent answers, this one only the user can clear
     * (merging the PR once CI is green), and the run reads as `running` throughout.
     */
    blockedReason: string | null;
    intent: string | null;
    createdAt: number;
    updatedAt: number;
    /** True while the run can still be stopped, which is what gates the Stop action. */
    live: boolean;
    /** Null once the run is terminal: there is nothing in progress to report. */
    activity: GateActivityView | null;
    steps: GateStepView[];
    findings: GateFindingView[];
}

/**
 * The global config as form controls rather than YAML text. `model` is the value
 * of the model flag inside `agent_args_override.<agent>` - the single setting that
 * decides how long a run takes and what it costs, which is why it gets a field of
 * its own instead of living only in the raw editor.
 */
export interface GateSettingsView {
    agent: string;
    /** `agent` with `auto` resolved against PATH, so the model row names a real agent. */
    agentResolved: string;
    model: string;
    /** False when the resolved agent takes no model flag enigma knows about. */
    modelSupported: boolean;
    ciTimeout: string;
    logLevel: string;
    /** Who settles a finding the pipeline parks on: `auto`, `assisted` or `ask`. */
    fixPolicy: string;
    autoFix: Record<string, number>;
    intentEnabled: boolean;
    /**
     * What each control above falls back to when the config leaves it out. The view shows it
     * in every hint and drives the per-row reset, so a number nobody remembers changing can
     * be read and undone in place instead of hunting for it in the YAML.
     */
    defaults: GateSettingsDefaults;
}

/** The default value of every gate setting the form exposes as its own control. */
export interface GateSettingsDefaults {
    agent: string;
    ciTimeout: string;
    logLevel: string;
    fixPolicy: string;
    autoFix: Record<string, number>;
    intentEnabled: boolean;
}

/** Everything the gate view renders in one payload. */
export interface GateOverview {
    /** The `gate` toggle: whether agents are told to drive the pipeline on their own. */
    on: boolean;
    /** False when this runtime cannot parse a gate config, so the editors are read-only. */
    canWrite: boolean;
    writeNote: string;
    /** False when this runtime cannot open the gate database; `runs` is then empty. */
    runsAvailable: boolean;
    runsNote: string;
    daemon: boolean;
    root: string;
    /** Unix seconds on the server, so the browser can tick a running step without clock drift. */
    serverNow: number;
    /**
     * Only the path: the view has a control for every global setting and no raw editor, and
     * the file itself would otherwise ride along on every 3s poll of a live run.
     */
    globalConfig: { path: string; };
    /** Null when this runtime cannot parse the config, in which case only the raw editor shows. */
    settings: GateSettingsView | null;
    /** Present only under a project scope. */
    repo: { path: string; initialized: boolean; configPath: string; text: string; exists: boolean; } | null;
    runs: GateRunView[];
}

/**
 * Whether this process can VALIDATE a gate config. The gate's YAML loader is built on
 * `Bun.YAML`, so under a Node dev runtime a config could only be written blind - and a
 * config the daemon cannot read is worse than an unsaved edit, so the editor goes
 * read-only there instead.
 */
function canValidateConfig(): boolean {
    return typeof (globalThis as { Bun?: unknown; }).Bun !== "undefined";
}

/** The one message explaining why a config cannot be written in this runtime. */
const NO_WRITE_NOTE = "This runtime cannot parse a gate config (its YAML loader needs enigma's own binary), so the editors are read-only here.";

/**
 * Whether the gate daemon is alive, by probing the pid in its pidfile. Both the
 * file format and the liveness probe come from the daemon's own module: the file
 * is JSON (`{"pid":...}`), so a hand-rolled integer parse silently reported every
 * running daemon as stopped.
 */
function daemonAlive(pidFile: string): boolean {
    try {
        return processRunning(readDaemonPIDFile(pidFile).pid) === true;
    } catch { return false; }
}

/** Read a text file, or "" when it does not exist (an absent config is a valid state). */
function readText(path: string): string {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** Findings recorded on a step, tolerating an absent or malformed blob. */
function parseFindings(json: string | null): GateFindingView[] {
    if (!json) return [];
    try {
        const parsed: unknown = JSON.parse(json);
        const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown[]; })?.items;
        if (!Array.isArray(items)) return [];
        return items.map((raw, i) => {
            const f = (raw || {}) as Record<string, unknown>;
            return {
                id: typeof f.id === "string" && f.id ? f.id : `finding-${i + 1}`,
                severity: String(f.severity ?? "info"),
                action: String(f.action ?? ""),
                file: String(f.file ?? ""),
                description: String(f.description ?? ""),
            };
        });
    } catch { return []; }
}

/** Step statuses that mean the pipeline is still working on (or parked at) that step. */
const ACTIVE_STEP_STATUS = new Set(["running", "fixing", "awaiting_approval", "fix_review"]);

/** Run statuses that can still be stopped. Anything else has already ended. */
const LIVE_RUN_STATUS = new Set(["pending", "running", "awaiting_approval"]);

/** How many log lines the activity tail carries, and how wide each one may be. */
const TAIL_LINES = 8;
const TAIL_LINE_CHARS = 300;

/**
 * The tail of a step's log, oldest line first.
 *
 * Read whole and sliced rather than seeked: a step log is the transcript of one
 * agent pass, and the ones that matter here are the ones being written right now,
 * so they are small. The read is capped anyway - only the last TAIL_LINES survive,
 * and a run that is not live never gets read at all.
 */
function logTail(dir: string, step: string): string[] {
    let text: string;
    try { text = readFileSync(join(dir, `${step}.log`), "utf8"); } catch { return []; }
    return text.split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .slice(-TAIL_LINES)
        .map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}...` : line));
}

/**
 * What a live run is doing right now: the step in flight and the tail of its log.
 * The pipeline runs one step at a time, so the last active step in pipeline order
 * is the current one.
 */
function runActivity(runId: string, steps: GateStepView[], live: boolean): GateActivityView | null {
    if (!live) return null;
    let current: GateStepView | null = null;
    for (const step of steps) if (ACTIVE_STEP_STATUS.has(step.status)) current = step;
    if (current === null) return null;
    return {
        step: current.name,
        status: current.status,
        startedAt: current.startedAt,
        tail: logTail(Paths.resolve().runLogDir(runId), current.name)
    };
}

/**
 * Read the runs for one repo path (or every active run when no project is given).
 * Returns null when this runtime has no `bun:sqlite`, which the caller reports as
 * an unavailable half rather than an error.
 */
async function readRuns(dbPath: string, projectPath: string | null, limit: number): Promise<GateRunView[] | null> {
    if (!existsSync(dbPath)) return [];
    let db: { close?: () => void; } | null = null;
    try {
        const [{ Database }, runMod, stepMod, repoMod] = await Promise.all([
            import("./gate/db/index"),
            import("./gate/db/run"),
            import("./gate/db/step"),
            import("./gate/db/repo"),
        ]);
        const handle = new Database(dbPath);
        db = handle as unknown as { close?: () => void; };
        let runs = [];
        if (projectPath) {
            const repo = repoMod.getRepoByPath(handle, projectPath);
            runs = repo ? runMod.getRunsByRepo(handle, repo.id) : [];
        } else {
            runs = runMod.getActiveRuns(handle);
        }
        return runs.slice(0, limit).map((run) => {
            const rows = stepMod.getStepsByRun(handle, run.id);
            const parked = rows.find((s) => s.status === "awaiting_approval" || s.status === "fix_review");
            const live = LIVE_RUN_STATUS.has(run.status);
            const steps: GateStepView[] = rows.map((s) => ({
                name: s.stepName,
                status: s.status,
                durationMs: s.durationMs,
                findings: parseFindings(s.findingsJson).length,
                startedAt: s.startedAt,
                completedAt: s.completedAt,
            }));
            return {
                id: run.id,
                branch: run.branch,
                status: run.status,
                headSha: (run.headSha || "").slice(0, 8),
                prUrl: run.prUrl,
                error: run.error,
                awaitingAgent: run.awaitingAgentSince !== null,
                blockedReason: run.blockedReason,
                intent: run.intent,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                live,
                activity: runActivity(run.id, steps, live),
                steps,
                findings: parked ? parseFindings(parked.findingsJson) : [],
            };
        });
    } catch { return null; } finally {
        try { (db as { close?: () => void; } | null)?.close?.(); } catch { /* already closed */ }
    }
}

/** Per-agent model flag. An agent absent here gets no model row rather than a guessed flag. */
const MODEL_FLAG: Record<string, string> = {
    claude: "--model",
    codex: "-m",
    opencode: "--model"
};

/** The auto-fix limits the form renders, in pipeline order. */
const AUTO_FIX_STEPS = ["rebase", "review", "test", "document", "lint", "ci"] as const;

/** Renders a resolved CI timeout back to the duration text the config accepts. */
function ciTimeoutText(ms: number): string {
    if (ms === gateConf.CI_TIMEOUT_UNLIMITED) return "unlimited";
    if (ms % 3600000 === 0) return `${ms / 3600000}h`;
    if (ms % 60000 === 0) return `${ms / 60000}m`;
    return `${Math.round(ms / 1000)}s`;
}

/** Reads the model out of an agent's extra args, for either flag spelling. */
function modelFromArgs(args: string[], flag: string): string {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flag) return args[i + 1] ?? "";
        if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
    return "";
}

/**
 * The global config as form values, or null when this runtime cannot parse it.
 * Reads through the gate's own loader so the form shows what the daemon will see,
 * including the defaults for keys the file leaves out.
 */
async function readGateSettings(globalPath: string): Promise<GateSettingsView | null> {
    if (!canValidateConfig()) return null;
    try {
        const merged = gateConf.merge(gateConf.loadGlobal(globalPath), gateConf.loadRepoFromBytes(""));
        const declared = merged.agent;
        // `auto` only names a real agent after probing PATH; a probe failure is not fatal here.
        try { await gateConf.resolveAgent(merged, lookPath); } catch { /* left as declared */ }
        const flag = MODEL_FLAG[merged.agent];
        const autoFix: Record<string, number> = {};
        for (const step of AUTO_FIX_STEPS) autoFix[step] = merged.autoFix[step];
        // The defaults come from the gate's own loader rather than a second copy of the
        // numbers: loadGlobal returns them verbatim when the file is missing, so pointing it
        // at a path that cannot exist yields exactly what an empty config would resolve to.
        // Any future change to a default reaches this form for free.
        const base = gateConf.merge(gateConf.loadGlobal(join(dirname(globalPath), ".enigma-gate.defaults-probe")), gateConf.loadRepoFromBytes(""));
        const autoFixDefaults: Record<string, number> = {};
        for (const step of AUTO_FIX_STEPS) autoFixDefaults[step] = base.autoFix[step];
        return {
            defaults: {
                agent: base.agent,
                ciTimeout: ciTimeoutText(base.ciTimeout),
                logLevel: base.logLevel,
                fixPolicy: base.fixPolicy,
                autoFix: autoFixDefaults,
                intentEnabled: base.intent.enabled
            },
            agent: declared,
            agentResolved: merged.agent,
            model: flag ? modelFromArgs(merged.agentArgsOverride?.[merged.agent] ?? [], flag) : "",
            modelSupported: flag !== undefined,
            ciTimeout: ciTimeoutText(merged.ciTimeout),
            logLevel: merged.logLevel,
            fixPolicy: merged.fixPolicy,
            autoFix,
            intentEnabled: merged.intent.enabled
        };
    } catch { return null; }
}

/** The whole gate view payload for the given scope ("global" or a project path). */
export async function gateOverview(projectPath: string | null): Promise<GateOverview> {
    const paths = Paths.resolve();
    const globalPath = paths.configFile();
    const runs = await readRuns(paths.db(), projectPath, 12);
    return {
        on: conf.readConfig().config.gate,
        canWrite: canValidateConfig(),
        writeNote: canValidateConfig() ? "" : NO_WRITE_NOTE,
        runsAvailable: runs !== null,
        runsNote: runs === null
            ? "Run history needs enigma's own binary (the gate database is Bun-only); the config below still applies."
            : "",
        daemon: daemonAlive(paths.pidFile()),
        root: paths.root(),
        serverNow: Math.floor(Date.now() / 1000),
        globalConfig: { path: globalPath },
        settings: await readGateSettings(globalPath),
        repo: projectPath
            ? {
                path: projectPath,
                initialized: gateInitialized(projectPath),
                configPath: join(projectPath, gateConf.REPO_CONFIG_FILE),
                text: readText(join(projectPath, gateConf.REPO_CONFIG_FILE)),
                exists: existsSync(join(projectPath, gateConf.REPO_CONFIG_FILE)),
            }
            : null,
        runs: runs || [],
    };
}

/** Result of a config write, mirroring the other dashboard bridges. */
export interface GateApplyResult {
    ok: boolean;
    message: string;
}

/** The largest config text the browser may submit (a gate config is a few KB at most). */
const MAX_CONFIG_BYTES = 64 * 1024;

/**
 * Write one of the two gate configs after validating it with the gate's own
 * parser. The text is staged in a sibling temp file, parsed from there, and only
 * renamed over the real file once it loads - so a rejected edit changes nothing.
 */
export function saveGateConfig(scope: "global" | "repo", text: string, projectPath: string | null): GateApplyResult {
    if (typeof text !== "string") return { ok: false, message: "Nothing to save." };
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return { ok: false, message: "That config is too large." };
    // Refuse before touching disk rather than writing something nothing here can check.
    if (!canValidateConfig()) return { ok: false, message: NO_WRITE_NOTE };

    const target = scope === "global"
        ? Paths.resolve().configFile()
        : (projectPath ? join(projectPath, gateConf.REPO_CONFIG_FILE) : "");
    if (!target) return { ok: false, message: "Pick a project first." };

    const temp = `${target}.dashboard-tmp`;
    try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(temp, text);
        // Parse with the loader the daemon itself uses, so what passes here runs there.
        if (scope === "global") gateConf.loadGlobal(temp);
        else gateConf.loadRepoFromBytes(text);
        renameSync(temp, target);
        return { ok: true, message: "Saved. A run already in flight keeps the config it started with." };
    } catch (err) {
        try { rmSync(temp, { force: true }); } catch { /* nothing staged */ }
        return { ok: false, message: `Not saved: ${err instanceof Error ? err.message : "the config did not parse"}` };
    }
}

/** Absolute path of the gate root, for the "where does this live" line in the UI. */
export function gateRoot(): string {
    return process.env.ENIGMA_GATE_HOME || join(homedir(), ".enigma", "gate");
}

// --- structured editing of the global config ------------------------------------
// The form edits ONE key per request, in place. Regenerating the file from parsed
// values would be shorter but would erase the explanatory comments the config ships
// with - and those comments are the only documentation most people ever read. So
// each setter finds the key's own line and rewrites just that line, then hands the
// whole text to saveGateConfig, which validates it with the daemon's own loader.

/** Dotted keys the form may write, and the shape each one accepts. */
const SETTABLE_KEYS: Record<string, "string" | "number" | "boolean"> = {
    agent: "string",
    ci_timeout: "string",
    log_level: "string",
    fix_policy: "string",
    "intent.enabled": "boolean",
    ...Object.fromEntries(AUTO_FIX_STEPS.map((s) => [`auto_fix.${s}`, "number" as const]))
};

/**
 * Values the gate's own loader accepts without complaint but the daemon then fails
 * on (it never enumerates agent names or log levels), so the form checks them here.
 * Without this, a bad pick would save cleanly and only surface on the next push.
 */
const ENUM_KEYS: Record<string, (value: string) => boolean> = {
    agent: (v) => ["auto", "claude", "codex", "rovodev", "opencode", "pi"].includes(v) || v.startsWith("acp:"),
    log_level: (v) => ["debug", "info", "warn", "error"].includes(v),
    // fix_policy is range-checked by the loader too, so this only buys a better message.
    fix_policy: (v) => gateConf.asFixPolicy(v) !== null
};

/** Escapes a config key for use inside a line-matching regex. */
function keyPattern(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `<indent><key>:` on an uncommented line. */
function keyLineRe(key: string, indent: string): RegExp {
    return new RegExp(`^${indent}${keyPattern(key)}\\s*:`);
}

/** Renders a value as a YAML scalar, quoting only when a bare word would not parse. */
function yamlScalar(value: string | number | boolean): string {
    if (typeof value !== "string") return String(value);
    return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Replaces the value on a `key: value` line, keeping any trailing comment. */
function rewriteValueLine(line: string, key: string, indent: string, scalar: string): string {
    const comment = /(\s+#.*)$/.exec(line);
    return `${indent}${key}: ${scalar}${comment ? comment[1] : ""}`;
}

/**
 * The half-open line range of the block opened at `open`: every following line that
 * is blank or indented. A line starting at column 0 (including a comment) closes it,
 * which is exactly how the shipped config separates its sections.
 */
function blockRange(lines: string[], open: number): number {
    let end = open + 1;
    while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
    return end;
}

/** Sets a top-level `key: value`, appending the key when the file does not have it. */
function setRootKey(lines: string[], key: string, scalar: string): void {
    const re = keyLineRe(key, "");
    const i = lines.findIndex((line) => re.test(line));
    if (i >= 0) { lines[i] = rewriteValueLine(lines[i], key, "", scalar); return; }
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`${key}: ${scalar}`);
}

/** Sets `parent.child`, creating the child line or the whole block as needed. */
function setNestedKey(lines: string[], parent: string, child: string, scalar: string): void {
    const parentRe = keyLineRe(parent, "");
    const p = lines.findIndex((line) => parentRe.test(line));
    if (p < 0) {
        if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
        lines.push(`${parent}:`, `  ${child}: ${scalar}`);
        return;
    }
    const end = blockRange(lines, p);
    // Indent from the first real entry in the block, so a 4-space config stays 4-space.
    let indent = "  ";
    for (let i = p + 1; i < end; i++) {
        const m = /^(\s+)[^\s#]/.exec(lines[i]);
        if (m) { indent = m[1]; break; }
    }
    const childRe = keyLineRe(child, indent);
    for (let i = p + 1; i < end; i++) {
        if (childRe.test(lines[i])) { lines[i] = rewriteValueLine(lines[i], child, indent, scalar); return; }
    }
    // No such child: insert after the block's last entry rather than after its trailing blanks.
    let at = p + 1;
    for (let i = p + 1; i < end; i++) if (lines[i].trim() !== "") at = i + 1;
    lines.splice(at, 0, `${indent}${child}: ${scalar}`);
}

/** Drops the top-level block opened by `key`, if the file has one. */
function removeRootBlock(lines: string[], key: string): void {
    const re = keyLineRe(key, "");
    const i = lines.findIndex((line) => re.test(line));
    if (i < 0) return;
    lines.splice(i, blockRange(lines, i) - i);
}

/**
 * Rewrites `agent_args_override` so `agent` carries `<flag> <model>` (or no model
 * flag when `model` is empty), preserving every other flag and every other agent.
 * This one block IS regenerated rather than line-edited: it is a nested list, and a
 * machine-managed one, so there are no hand-written comments inside it to lose.
 */
function setAgentModel(lines: string[], existing: Record<string, string[]>, agent: string, flag: string, model: string): void {
    const kept: string[] = [];
    const args = existing[agent] ?? [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === flag) { i++; continue; }
        if (args[i].startsWith(`${flag}=`)) continue;
        kept.push(args[i]);
    }
    const next: Record<string, string[]> = { ...existing };
    if (model) next[agent] = [flag, model, ...kept];
    else if (kept.length > 0) next[agent] = kept;
    else delete next[agent];

    removeRootBlock(lines, "agent_args_override");
    const names = Object.keys(next);
    if (names.length === 0) return;
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("agent_args_override:");
    for (const name of names) {
        lines.push(`  ${name}: [${next[name].map((a) => JSON.stringify(a)).join(", ")}]`);
    }
}

/** Joins edited lines back into a document that ends with exactly one newline. */
function joinConfig(lines: string[]): string {
    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * Applies one form control to the global config. Every write goes back through
 * saveGateConfig, so a change the daemon's loader rejects leaves the file untouched.
 */
export async function applyGateSetting(key: string, value: unknown): Promise<GateApplyResult> {
    if (!canValidateConfig()) return { ok: false, message: NO_WRITE_NOTE };
    const path = Paths.resolve().configFile();
    gateConf.ensureDefaultGlobalConfig(path);
    const lines = readText(path).split("\n");

    if (key === "model") {
        const model = typeof value === "string" ? value.trim() : "";
        let current: gateConf.GlobalConfig;
        try { current = gateConf.loadGlobal(path); } catch (err) {
            return { ok: false, message: `Not saved: ${err instanceof Error ? err.message : "the config did not parse"}` };
        }
        const merged = gateConf.merge(current, gateConf.loadRepoFromBytes(""));
        try { await gateConf.resolveAgent(merged, lookPath); } catch { /* left as declared */ }
        const flag = MODEL_FLAG[merged.agent];
        if (!flag) return { ok: false, message: `enigma does not know a model flag for the ${merged.agent} agent.` };
        setAgentModel(lines, current.agentArgsOverride ?? {}, merged.agent, flag, model);
        return saveGateConfig("global", joinConfig(lines), null);
    }

    const kind = SETTABLE_KEYS[key];
    if (!kind) return { ok: false, message: "That setting is not editable here." };
    let scalar: string;
    if (kind === "boolean") scalar = yamlScalar(value === true || value === "true");
    else if (kind === "number") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 20) return { ok: false, message: "Use a whole number between 0 and 20." };
        scalar = yamlScalar(n);
    } else {
        const s = String(value ?? "").trim();
        if (s === "") return { ok: false, message: "That setting cannot be empty." };
        if (ENUM_KEYS[key] && !ENUM_KEYS[key](s)) return { ok: false, message: `"${s}" is not a valid ${key}.` };
        scalar = yamlScalar(s);
    }

    const dot = key.indexOf(".");
    if (dot < 0) setRootKey(lines, key, scalar);
    else setNestedKey(lines, key.slice(0, dot), key.slice(dot + 1), scalar);
    return saveGateConfig("global", joinConfig(lines), null);
}

/**
 * Cancels an in-flight run, the same way `enigma gate axi abort --run <id>` does:
 * a run lives in the daemon's memory, so the cancellation is an IPC call and there
 * is nothing to stop when the daemon is down.
 *
 * Idempotent by design - a run that already ended is reported as a no-op rather
 * than an error, because by the time a click arrives the run may well have finished
 * on its own.
 */
export async function abortGateRun(runId: string): Promise<GateApplyResult> {
    const id = String(runId ?? "").trim();
    if (id === "") return { ok: false, message: "No run to stop." };
    try {
        const paths = Paths.resolve();
        if (!daemonAlive(paths.pidFile())) return { ok: true, message: "The daemon is not running, so no run is in flight." };
        const { Client } = await import("./gate/ipc/client");
        const client = await Client.dial(paths.socket());
        try {
            await client.cancelRun(id);
            return { ok: true, message: "Run stopped." };
        } finally {
            client.close();
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        // The daemon words an unknown or already-finished run this way; it is not a failure.
        if (message.includes("no active run")) return { ok: true, message: "That run had already finished." };
        return { ok: false, message: `Could not stop the run: ${message}` };
    }
}

/**
 * Starts or stops the gate daemon. The daemon module reaches into the gate's
 * Bun-only layers, so it is imported dynamically and an unavailable runtime is
 * reported rather than thrown.
 */
export async function setGateDaemon(on: boolean): Promise<GateApplyResult> {
    try {
        const paths = Paths.resolve();
        const { startDaemon, stopDaemon } = await import("./gate/cli/daemonCmd");
        if (on) { await startDaemon(paths); return { ok: true, message: "Daemon started." }; }
        await stopDaemon(paths);
        return { ok: true, message: "Daemon stopped. It starts again on the next gated push." };
    } catch (err) {
        return { ok: false, message: `Could not ${on ? "start" : "stop"} the daemon: ${err instanceof Error ? err.message : "unknown error"}` };
    }
}
