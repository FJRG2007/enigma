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
 */

import * as conf from "./config";
import { homedir } from "node:os";
import { Paths } from "./gate/paths";
import { dirname, join } from "node:path";
import * as gateConf from "./gate/config";
import { gateInitialized } from "./dashboard-projects";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** One pipeline step of a run, flattened for the browser. */
export interface GateStepView {
    name: string;
    status: string;
    durationMs: number | null;
    findings: number;
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
    intent: string | null;
    createdAt: number;
    updatedAt: number;
    steps: GateStepView[];
    findings: GateFindingView[];
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
    globalConfig: { path: string; text: string; };
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

/** Whether the gate daemon is alive, by probing the pid in its pidfile. */
function daemonAlive(pidFile: string): boolean {
    try {
        const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) return false;
        // Signal 0 tests for existence; EPERM means alive but owned by another user.
        try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
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
            const steps = stepMod.getStepsByRun(handle, run.id);
            const parked = steps.find((s) => s.status === "awaiting_approval" || s.status === "fix_review");
            return {
                id: run.id,
                branch: run.branch,
                status: run.status,
                headSha: (run.headSha || "").slice(0, 8),
                prUrl: run.prUrl,
                error: run.error,
                awaitingAgent: run.awaitingAgentSince !== null,
                intent: run.intent,
                createdAt: run.createdAt,
                updatedAt: run.updatedAt,
                steps: steps.map((s) => ({
                    name: s.stepName,
                    status: s.status,
                    durationMs: s.durationMs,
                    findings: parseFindings(s.findingsJson).length,
                })),
                findings: parked ? parseFindings(parked.findingsJson) : [],
            };
        });
    } catch { return null; } finally {
        try { (db as { close?: () => void; } | null)?.close?.(); } catch { /* already closed */ }
    }
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
        globalConfig: { path: globalPath, text: readText(globalPath) },
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
