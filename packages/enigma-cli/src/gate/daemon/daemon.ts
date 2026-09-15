/**
 * Daemon bootstrap and IPC wiring: prepares the process environment, recovers
 * state from a previous crash, starts the JSON-RPC server, registers handlers,
 * writes the PID file, and shuts down cleanly on a signal or the shutdown RPC.
 * Faithful port of the Go `internal/daemon/daemon.go` (minus the OS service-
 * manager paths, which live in a separate phase).
 *
 * Concurrency mapping: Go's `context.Context` cancellation + signal goroutine ->
 * a once-guarded `doShutdown` that aborts active runs (via `RunManager.shutdown`)
 * and closes the server, which resolves the `serve` promise so `run` returns.
 */

import { log } from "../log";
import * as gateDb from "../db";
import { join } from "node:path";
import { Paths } from "../paths";
import { Server } from "../ipc/server";
import * as proto from "../ipc/protocol";
import { applyToProcess } from "../shellenv";
import { setAgentTmpPaths } from "../agent/env";
import { StepFactory, RunManager } from "./manager";
import { worktreeRemove, worktreePrune, run as gitRun } from "../git";
import { isolateHooksPath, refreshManagedPostReceiveHook } from "../hook";
import { setServerPIDsDir, currentProcessStartedAt } from "../agent/serverpid";
import {
    loadGlobal,
    parseLogLevel,
    ensureDefaultGlobalConfig
} from "../config";
import {
    type DaemonPIDFile,
    processStartTime,
    reapOrphanedServers,
    readDaemonPIDFileData
} from "./recover";
import {
    rmSync,
    statSync,
    renameSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    existsSync,
    unlinkSync
} from "node:fs";

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Starts the daemon process. Blocks until a shutdown signal is received or the
 * shutdown IPC method is called. Entry point for the managed/standalone daemon.
 */
export async function run(): Promise<void> {
    const p = Paths.resolve();
    p.ensureDirs();
    prepareDaemonEnvironment();

    ensureDefaultGlobalConfig(p.configFile());
    const globalCfg = loadGlobal(p.configFile());
    initLogger(globalCfg.logLevel);

    const d = new gateDb.Database(p.db());
    try {
        await runWithResources(p, d);
    } finally {
        d.close();
    }
}

/**
 * Scrubs the inherited Claude Code session env, applies the login shell
 * environment (so agent binaries resolve like an interactive shell), and
 * restores ENIGMA_GATE_HOME if the shell env clobbered it.
 */
function prepareDaemonEnvironment(): void {
    const gateHome = process.env.ENIGMA_GATE_HOME;
    for (const key of [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_ENTRY_POINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ACCESS_TOKEN"
    ]) {
        delete process.env[key];
    }
    applyToProcess();
    if (gateHome !== undefined) process.env.ENIGMA_GATE_HOME = gateHome;
    logDaemonPathSummary();
}

/** Logs the effective PATH at startup so "agent not in PATH" failures are diagnosable. */
function logDaemonPathSummary(): void {
    const path = process.env.PATH ?? "";
    const delimiter = process.platform === "win32" ? ";" : ":";
    const entries = path === "" ? 0 : path.split(delimiter).length;
    log.info("daemon environment ready", "path_entries", entries, "path", path);
}

/** Sets the log threshold from the configured level (read by the gate logger). */
function initLogger(level: string): void {
    process.env.ENIGMA_GATE_LOG_LEVEL = parseLogLevel(level);
}

/** Starts the daemon with pre-initialized paths and DB (default steps). */
export function runWithResources(p: Paths, d: gateDb.Database): Promise<void> {
    return runWithOptions(p, d);
}

/** Starts the daemon with optional step-factory override (for testing). */
export async function runWithOptions(p: Paths, d: gateDb.Database, stepFactory?: StepFactory): Promise<void> {
    await recoverOnStartup(d, p);

    // Point the agent package at our PID dir so managed servers we spawn leave
    // crash-recovery breadcrumbs, and at our layout so the temp directory an agent
    // is handed is the one this daemon provisions and reclaims; clear both on exit.
    setServerPIDsDir(p.serverPIDsDir());
    setAgentTmpPaths(p);
    try {
        const srv = new Server();
        const mgr = new RunManager(d, p, stepFactory);

        let shutdownStarted = false;
        const doShutdown = (reason: string): void => {
            if (shutdownStarted) return;
            shutdownStarted = true;
            log.info("shutting down", "reason", reason);
            void mgr.shutdown().finally(() => srv.close());
        };

        registerHandlers(srv, mgr, d, () => doShutdown("ipc request"));

        const pidPath = p.pidFile();
        const pidRecord = currentDaemonPIDRecord();
        writeDaemonPIDFile(pidPath, pidRecord);

        const onSignal = (sig: NodeJS.Signals): void => doShutdown(sig);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        const socketPath = p.socket();
        log.info("daemon starting", "socket", socketPath, "pid", process.pid);

        try {
            await srv.serve(socketPath);
        } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
        }
        doShutdown("listener closed");

        // Clean up the socket + PID file only if we still own the PID file (a new
        // daemon may have replaced it).
        if (stillOwnsPIDFile(pidPath, pidRecord)) {
            removeQuietly(pidPath);
            removeQuietly(socketPath);
        }
        log.info("daemon stopped");
    } finally {
        setServerPIDsDir("");
        setAgentTmpPaths(null);
    }
}

/** Builds the daemon PID record (pid + best-effort process start time). */
function currentDaemonPIDRecord(): DaemonPIDFile {
    const pid = process.pid;
    let startedAt = processStartTime(pid);
    if (startedAt === null) startedAt = currentProcessStartedAt();
    return { pid, startedAt };
}

/** Atomically writes the daemon PID file (temp file + rename). */
function writeDaemonPIDFile(path: string, record: DaemonPIDFile): void {
    const payload: Record<string, unknown> = { pid: record.pid };
    if (record.startedAt) payload.started_at = record.startedAt.toISOString();
    const data = JSON.stringify(payload);
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    try {
        writeFileSync(tmpPath, data, { mode: 0o644 });
        renameSync(tmpPath, path);
    } catch (err) {
        removeQuietly(tmpPath);
        throw new Error(`write pid file: ${errMessage(err)}`);
    }
}

/** Reports whether the on-disk PID file still matches our written record. */
function stillOwnsPIDFile(pidPath: string, record: DaemonPIDFile): boolean {
    try {
        const current = readDaemonPIDFileData(readFileSync(pidPath, "utf8"));
        if (current.pid !== record.pid) return false;
        const a = current.startedAt ? current.startedAt.getTime() : null;
        const b = record.startedAt ? record.startedAt.getTime() : null;
        return a === b;
    } catch {
        return false;
    }
}

function removeQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // best-effort
    }
}

/**
 * Cleans up after a previous daemon crash: reaps orphaned managed servers,
 * migrates gate bare repos in place, marks stale runs/steps failed, and removes
 * orphaned worktree directories.
 */
async function recoverOnStartup(d: gateDb.Database, p: Paths): Promise<void> {
    // Bracketed by logs because this runs BEFORE the socket exists: everything it spends is
    // time the CLI's health check is failing, and until these lines the log went quiet between
    // "environment ready" and "daemon starting" with no way to tell slow from hung.
    const startedAt = Date.now();
    log.info("startup recovery beginning");
    reapOrphanedServers(p);
    await migrateGateConfigs(p);

    let count: number;
    try {
        count = gateDb.recoverStaleRuns(d, "daemon crashed during execution");
    } catch (err) {
        log.error("failed to recover stale runs", "error", errMessage(err));
        return;
    }
    if (count > 0) log.info("recovered stale runs from previous crash", "count", count);

    await removeOrphanedWorktrees(p);
    log.info("startup recovery complete", "ms", Date.now() - startedAt);
}

/**
 * Version that last migrated a bare repo, recorded inside it. The migration is idempotent, so
 * it was simply re-run on every start - three git invocations per repo, every time. That is
 * free where a process costs a millisecond and it is not free everywhere: fifteen repos on a
 * Windows machine with an antivirus in the path measured around ninety seconds, spent before
 * the daemon opens its socket, so `enigma gate axi run` gave up on the health check and every
 * gate run on that machine was blocked. Stamping the version keeps the work happening exactly
 * when it can matter - a new enigma may ship a new hook - and never again after that.
 */
function migrationStamp(bareDir: string): string {
    return join(bareDir, "enigma-migrated");
}

/** The enigma version this daemon is, as the launcher reports it. */
function currentVersion(): string {
    return process.env.ENIGMA_VERSION || "dev";
}

/**
 * Refreshes the managed post-receive hook, enables push options, and pins the
 * per-worktree hookspath on every gate bare repo. Idempotent and best-effort.
 */
async function migrateGateConfigs(p: Paths): Promise<void> {
    let entries: string[];
    try {
        entries = readdirSync(p.reposDir());
    } catch {
        return; // repos dir may not exist on a fresh install
    }
    const version = currentVersion();
    let migrated = 0;
    const startedAt = Date.now();
    for (const name of entries) {
        const bareDir = join(p.reposDir(), name);
        try {
            if (!statSync(bareDir).isDirectory()) continue;
        } catch {
            continue;
        }
        // An unreadable or mismatched stamp means migrate; only an exact match skips, so a
        // corrupted stamp costs one extra migration rather than skipping a needed one.
        try {
            if (readFileSync(migrationStamp(bareDir), "utf8").trim() === version) continue;
        } catch { /* not migrated by this version yet */ }
        migrated++;
        try {
            refreshManagedPostReceiveHook(bareDir);
        } catch (err) {
            log.warn("refresh gate post-receive hook failed", "bare", bareDir, "error", errMessage(err));
        }
        try {
            await gitRun(bareDir, ["config", "receive.advertisePushOptions", "true"]);
        } catch (err) {
            log.warn("enable gate push options failed", "bare", bareDir, "error", errMessage(err));
        }
        try {
            await isolateHooksPath(bareDir);
        } catch (err) {
            log.warn("isolate gate hooks path failed", "bare", bareDir, "error", errMessage(err));
        }
        // Stamped after the three steps, and best-effort: a stamp that cannot be written just
        // means this repo is migrated again next time, which is what used to happen anyway.
        try {
            writeFileSync(migrationStamp(bareDir), `${version}\n`, { mode: 0o644 });
        } catch { /* the migration still ran; it will simply run again */ }
    }
    if (migrated > 0) {
        log.info("migrated gate repos", "count", migrated, "of", entries.length, "ms", Date.now() - startedAt);
    }
}

/**
 * Removes everything a previous daemon's runs left on disk: the worktree
 * directories, the per-repository directory holding them, the administrative
 * entries of worktrees whose directory is already gone, and the private temp
 * directories handed to their agents. Exported for the regression test that
 * keeps the per-repository directory from surviving again.
 *
 * Safe to run wholesale because startup recovery has already terminated every
 * run inherited from the dead daemon, so nothing here is in use.
 */
export async function removeOrphanedWorktrees(p: Paths): Promise<void> {
    const wtRoot = p.worktreesDir();
    let repoEntries: string[];
    try {
        repoEntries = readdirSync(wtRoot);
    } catch {
        return; // directory may not exist yet
    }
    for (const repoName of repoEntries) {
        const repoPath = join(wtRoot, repoName);
        try {
            if (!statSync(repoPath).isDirectory()) continue;
        } catch {
            continue;
        }
        const gateDir = p.repoDir(repoName);
        let runEntries: string[];
        try {
            runEntries = readdirSync(repoPath);
        } catch {
            continue;
        }
        for (const runName of runEntries) {
            const wtPath = join(repoPath, runName);
            try {
                if (!statSync(wtPath).isDirectory()) continue;
            } catch {
                continue;
            }
            try {
                await worktreeRemove(gateDir, wtPath);
                log.info("removed orphaned worktree", "path", wtPath);
            } catch (err) {
                log.warn("git worktree remove failed, falling back to recursive delete", "path", wtPath, "error", errMessage(err));
                try {
                    rmSync(wtPath, { recursive: true, force: true });
                } catch (rmErr) {
                    log.warn("failed to remove orphaned worktree", "path", wtPath, "error", errMessage(rmErr));
                }
            }
        }
        // The recursive-delete fallback above removes the directory but leaves the bare
        // repo's administrative entry for it, and so does a crash between the two; prune
        // is what stops those from accumulating as permanently `prunable` entries.
        try {
            await worktreePrune(gateDir);
        } catch (err) {
            log.warn("failed to prune worktree metadata", "repo", repoName, "error", errMessage(err));
        }
        // This used to call removeQuietly, which is unlink and cannot remove a directory:
        // it failed silently and left one empty directory per repository behind forever.
        removeDirQuietly(repoPath);
    }
    // Each of these belongs to a run that startup recovery has already terminated.
    removeDirQuietly(p.agentTmpRoot());
}

/** Best-effort recursive directory removal; a directory already gone counts as removed. */
function removeDirQuietly(path: string): void {
    if (!existsSync(path)) return;
    try {
        rmSync(path, { recursive: true, force: true });
    } catch (err) {
        log.warn("failed to remove directory", "path", path, "error", errMessage(err));
    }
}

/** Registers all IPC handlers (unary + the subscribe stream) on the server. */
function registerHandlers(srv: Server, mgr: RunManager, d: gateDb.Database, shutdown: () => void): void {
    srv.handle(proto.MethodHealth, () => ({ status: "ok" }));

    srv.handle(proto.MethodShutdown, () => {
        shutdown();
        return { ok: true };
    });

    srv.handle(proto.MethodGetRun, params => {
        const { runId } = proto.decodeGetRunParams(params ?? {});
        const r = gateDb.getRun(d, runId);
        if (r === null) throw new Error(`run not found: ${runId}`);
        return proto.encodeGetRunResult({ run: runInfoFor(d, r) });
    });

    srv.handle(proto.MethodGetRuns, params => {
        const { repoId } = proto.decodeGetRunsParams(params ?? {});
        const runs = gateDb.getRunsByRepo(d, repoId);
        return proto.encodeGetRunsResult({ runs: runs.map(r => runInfoFor(d, r)) });
    });

    srv.handle(proto.MethodGetActiveRun, params => {
        const { repoId, branch } = proto.decodeGetActiveRunParams(params ?? {});
        const r = gateDb.getActiveRun(d, repoId, branch ?? "");
        if (r === null) return proto.encodeGetActiveRunResult({ run: null });
        return proto.encodeGetActiveRunResult({ run: runInfoFor(d, r) });
    });

    srv.handle(proto.MethodRerun, async params => {
        const p = proto.decodeRerunParams(params ?? {});
        const runId = await mgr.handleRerun(p.repoId, p.branch, p.skipSteps ?? [], p.intent ?? "");
        return proto.encodeRerunResult({ runId });
    });

    srv.handle(proto.MethodPushReceived, async params => {
        const p = proto.decodePushReceivedParams(params ?? {});
        log.info("push received", "ref", p.ref, "old", p.old, "new", p.new, "gate", p.gate);
        const runId = await mgr.handlePushReceived(p);
        return proto.encodePushReceivedResult({ runId });
    });

    srv.handle(proto.MethodRespond, params => {
        const p = proto.decodeRespondParams(params ?? {});
        mgr.handleRespondWithOverrides(p.runId, p.step, p.action, p.findingIds ?? [], p.instructions ?? null, p.addedFindings ?? null);
        return { ok: true };
    });

    srv.handle(proto.MethodCancelRun, params => {
        const { runId } = proto.decodeCancelRunParams(params ?? {});
        mgr.handleCancel(runId);
        return { ok: true };
    });

    srv.handleStream(proto.MethodSubscribe, async (params, send) => {
        const { runId } = proto.decodeSubscribeParams(params ?? {});
        const sub = mgr.subscribe(runId);
        try {
            for await (const event of sub.events) send(event);
        } finally {
            sub.unsubscribe();
        }
    });
}

/** Builds an IPC RunInfo for a run, including per-step finding stats + summaries. */
function runInfoFor(d: gateDb.Database, run: gateDb.Run): proto.RunInfo {
    const steps = gateDb.getStepsByRun(d, run.id);
    const stepInfos = steps.map(s => {
        const extras: { reportedFindings?: number; fixedFindings?: number; fixSummaries?: string[]; } = {};
        try {
            const stats = gateDb.stepFindingStats(d, s);
            extras.reportedFindings = stats.reportedFindings;
            extras.fixedFindings = stats.fixedFindings;
        } catch {
            // Stats are best-effort, matching the Go handler.
        }
        try {
            extras.fixSummaries = gateDb.stepFixSummaries(d, s.id);
        } catch {
            // Summaries are best-effort.
        }
        return proto.stepToInfo(s, extras);
    });
    return proto.runToInfo(run, stepInfos);
}
