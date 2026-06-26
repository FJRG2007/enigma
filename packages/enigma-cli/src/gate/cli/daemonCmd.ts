/**
 * Daemon lifecycle commands (start/stop/restart/status/run) plus the hidden
 * `__gate-notify` push handler the post-receive hook invokes. Faithful port of
 * no-mistakes' `internal/cli/daemon_cmd.go`, together with the slice of the
 * `internal/daemon` control surface those commands need (Start/Stop/IsRunning/
 * EnsureDaemon/ReadPID).
 *
 * Managed-service plumbing (launchd/systemd/schtasks) is a separate phase, so
 * the control functions implement only Go's detached-daemon fallback path. That
 * matches Go behavior when the service manager is bypassed: `installManaged
 * Service` reports unmanaged, `Start` re-execs a detached daemon, and `Stop`
 * shuts it down over IPC with a PID-kill fallback.
 *
 * Daemon spawn (decision): Go re-execs the bare binary with `NM_DAEMON=1`; the
 * enigma equivalent re-execs `process.execPath` with `ENIGMA_GATE_DAEMON=1`
 * (and `ENIGMA_GATE_HOME`), the rebrand of that marker. The CLI entrypoint
 * detects the marker and calls `daemon.run()`, exactly as Go's `main` detects
 * `NM_DAEMON`. The spawn is injectable so the wiring layer (or tests) can supply
 * a precise re-exec without touching this module.
 */

import { allSteps } from "../types";
import { basename } from "node:path";
import type { Paths } from "../paths";
import { Client } from "../ipc/client";
import type { StepName } from "../types";
import { spawn } from "node:child_process";
import { out, sDim, sGreen, errMessage } from "./common";
import { openSync, closeSync, unlinkSync } from "node:fs";
import { processRunning, readDaemonPIDFile } from "../daemon/recover";

/** Spawns a detached daemon for `paths`; returns its PID (0 when unknown). */
export type SpawnDaemon = (paths: Paths) => number | undefined;

/** Default detached-daemon wait timeout (longer on Windows, as in Go). */
const DEFAULT_START_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;
/** Default poll cadence while waiting for the daemon to answer health checks. */
const DEFAULT_START_POLL_MS = 100;

// --- Daemon control surface (detached path of internal/daemon) ----------------

/** Sleeps for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Reads a positive-ms override from env, falling back to `fallbackMs`. */
function durationFromEnv(name: string, fallbackMs: number): number {
    const value = process.env[name];
    if (!value) return fallbackMs;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function startTimeout(): number {
    return durationFromEnv("ENIGMA_GATE_TEST_DAEMON_START_TIMEOUT", DEFAULT_START_TIMEOUT_MS);
}

function startPollInterval(): number {
    return durationFromEnv("ENIGMA_GATE_TEST_DAEMON_START_POLL_INTERVAL", DEFAULT_START_POLL_MS);
}

/** Force-terminates a process (SIGKILL on POSIX, TerminateProcess on Windows). */
function killPid(pid: number): void {
    process.kill(pid, "SIGKILL");
}

/** Best-effort removal of the daemon socket and PID file. */
function cleanupDaemonArtifacts(paths: Paths): void {
    for (const path of [paths.socket(), paths.pidFile()]) {
        try {
            unlinkSync(path);
        } catch {
            // best-effort
        }
    }
}

/**
 * Reports whether the daemon answers a health check on its IPC socket. A dial
 * or call failure is reported as "not running" (Go's callers ignore the error).
 */
export async function isDaemonRunning(paths: Paths): Promise<boolean> {
    let client: Client;
    try {
        client = await Client.dial(paths.socket());
    } catch {
        return false;
    }
    try {
        return (await client.health()) === "ok";
    } catch {
        return false;
    } finally {
        client.close();
    }
}

/** Reads the daemon PID from the PID file (throws ENOENT-coded when absent). */
export function readDaemonPid(paths: Paths): number {
    return readDaemonPIDFile(paths.pidFile()).pid;
}

/** Re-execs a detached daemon process; returns its PID (0 when unknown). */
function spawnDetachedDaemon(paths: Paths): number {
    const logFd = openSync(paths.daemonLog(), "a", 0o644);
    try {
        const child = spawn(process.execPath, gateDaemonArgv(), {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", logFd, logFd],
            env: { ...process.env, ENIGMA_GATE_HOME: paths.root(), ENIGMA_GATE_DAEMON: "1" }
        });
        child.unref();
        return child.pid ?? 0;
    } finally {
        closeSync(logFd);
    }
}

/**
 * Argv for the detached re-exec. The compiled binary needs no subcommand (the
 * entrypoint detects ENIGMA_GATE_DAEMON=1); a node/bun dev runtime re-runs the
 * current script so the same entrypoint is reached.
 */
function gateDaemonArgv(): string[] {
    const base = basename(process.execPath).toLowerCase();
    if (base.startsWith("node") || base.startsWith("bun")) {
        return process.argv.slice(1, 2);
    }
    return [];
}

/**
 * Waits for the daemon to answer health checks. On timeout, kills the spawned
 * child (when its PID is known) so it cannot race later rollback work.
 */
async function waitForDaemonStart(paths: Paths, pid?: number): Promise<void> {
    const timeout = startTimeout();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isDaemonRunning(paths)) return;
        await sleep(startPollInterval());
    }
    if (pid !== undefined && pid > 0 && processRunning(pid) !== false) {
        try {
            killPid(pid);
        } catch {
            // best-effort cleanup of an unresponsive child
        }
    }
    throw new Error(`daemon started but did not become responsive within ${timeout}ms`);
}

/**
 * Starts the daemon. Errors when one is already running (matching Go's
 * service-bypassed Start); otherwise clears stale artifacts, spawns a detached
 * daemon, and waits for it to become responsive.
 */
export async function startDaemon(paths: Paths, spawnFn: SpawnDaemon = spawnDetachedDaemon): Promise<void> {
    paths.ensureDirs();
    if (await isDaemonRunning(paths)) {
        throw new Error("daemon already running");
    }
    cleanupDaemonArtifacts(paths);
    const pid = spawnFn(paths);
    await waitForDaemonStart(paths, pid);
}

/** Starts the daemon when it is not already running. */
export async function ensureDaemon(paths: Paths, spawnFn: SpawnDaemon = spawnDetachedDaemon): Promise<void> {
    if (await isDaemonRunning(paths)) return;
    await startDaemon(paths, spawnFn);
}

/**
 * Stops the daemon over IPC and waits for it to exit, falling back to a PID
 * kill when the socket cannot be dialed.
 */
export async function stopDaemon(paths: Paths): Promise<void> {
    let client: Client;
    try {
        client = await Client.dial(paths.socket());
    } catch {
        await stopDaemonByPid(paths);
        return;
    }
    try {
        await client.shutdown();
    } catch (err) {
        throw new Error(`shutdown request: ${errMessage(err)}`);
    } finally {
        client.close();
    }
    await waitForDaemonStop(paths);
}

/** Polls until the daemon stops, killing it by PID as a last resort. */
async function waitForDaemonStop(paths: Paths): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (!(await isDaemonRunning(paths))) {
            cleanupDaemonArtifacts(paths);
            return;
        }
        await sleep(100);
    }
    let pid: number;
    try {
        pid = readDaemonPid(paths);
    } catch {
        throw new Error("daemon did not stop within timeout");
    }
    await killAndConfirm(paths, pid);
}

/** Stops the daemon by killing the PID recorded in the PID file. */
async function stopDaemonByPid(paths: Paths): Promise<void> {
    let pid: number;
    try {
        pid = readDaemonPid(paths);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            cleanupDaemonArtifacts(paths);
            return;
        }
        throw err;
    }
    if (pid <= 0) {
        throw new Error(`invalid daemon pid ${pid}`);
    }
    if (processRunning(pid) === false) {
        cleanupDaemonArtifacts(paths);
        return;
    }
    await killAndConfirm(paths, pid);
}

/** Kills `pid` and waits up to 2s for it to exit, then clears artifacts. */
async function killAndConfirm(paths: Paths, pid: number): Promise<void> {
    try {
        killPid(pid);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            throw new Error(`kill daemon pid ${pid}: ${errMessage(err)}`);
        }
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (processRunning(pid) === false) {
            cleanupDaemonArtifacts(paths);
            return;
        }
        await sleep(100);
    }
    throw new Error(`daemon pid ${pid} still running after kill`);
}

// --- Push-option parsing (verbatim from daemon_cmd.go) ------------------------

// enigma: these duplicate steps.ts's SKIP_PUSH_PREFIX/INTENT_PUSH_PREFIX (parallel
// ports). Kept in sync by value here; the final review pass folds both onto the
// steps.ts constants as the single source.
/** Carries an agent-supplied intent through a push, base64-encoded for transport. */
const INTENT_PUSH_OPTION_PREFIX = "enigma.intent=";
/** Prefix carrying the comma-separated list of pipeline steps to skip. */
const SKIP_PUSH_OPTION_PREFIX = "enigma.skip=";

/** Reports whether `step` is a known pipeline step. */
function validStep(step: StepName): boolean {
    return allSteps().includes(step);
}

/** Removes duplicate steps, preserving first-seen order. */
export function dedupeSteps(steps: StepName[]): StepName[] {
    const seen = new Set<StepName>();
    const out: StepName[] = [];
    for (const step of steps) {
        if (seen.has(step)) continue;
        seen.add(step);
        out.push(step);
    }
    return out;
}

/** Parses a comma-separated skip-steps value, rejecting unknown step names. */
export function parseSkipSteps(value: string): StepName[] {
    if (value.trim() === "") return [];
    const steps: StepName[] = [];
    for (const part of value.split(",")) {
        const step = part.trim() as StepName;
        if (!validStep(step)) {
            throw new Error(`unknown step "${step}"`);
        }
        steps.push(step);
    }
    return dedupeSteps(steps);
}

/** Collects skip steps from all `no-mistakes.skip=` push options. */
export function parseSkipPushOptions(options: string[]): StepName[] {
    const steps: StepName[] = [];
    for (const option of options) {
        if (!option.startsWith(SKIP_PUSH_OPTION_PREFIX)) continue;
        steps.push(...parseSkipSteps(option.slice(SKIP_PUSH_OPTION_PREFIX.length)));
    }
    return dedupeSteps(steps);
}

/** Encodes skip steps as a push option, or null when there is nothing to skip. */
export function formatSkipPushOptions(steps: StepName[]): string[] {
    if (steps.length === 0) return [];
    return [SKIP_PUSH_OPTION_PREFIX + dedupeSteps(steps).join(",")];
}

/** Encodes intent as a single push option, or "" when there is no intent. */
export function formatIntentPushOption(intent: string): string {
    if (intent.trim() === "") return "";
    return INTENT_PUSH_OPTION_PREFIX + Buffer.from(intent, "utf8").toString("base64");
}

/** Reports whether `value` is a well-formed standard base64 string. */
function isStdBase64(value: string): boolean {
    return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

/** Extracts and decodes the last `no-mistakes.intent=` push option, if any. */
export function parseIntentPushOptions(options: string[]): string {
    let intent = "";
    for (const option of options) {
        if (!option.startsWith(INTENT_PUSH_OPTION_PREFIX)) continue;
        const encoded = option.slice(INTENT_PUSH_OPTION_PREFIX.length);
        if (!isStdBase64(encoded)) {
            throw new Error("decode intent push option: invalid base64");
        }
        intent = Buffer.from(encoded, "base64").toString("utf8");
    }
    return intent;
}

// --- notify-push (`__gate-notify`) --------------------------------------------

interface NotifyArgs {
    gate: string;
    ref: string;
    old: string;
    new: string;
    pushOptions: string[];
}

/** Parses the `__gate-notify` flag argv (supports `--flag value` and `--flag=value`). */
function parseNotifyArgs(argv: string[]): NotifyArgs {
    const args: NotifyArgs = { gate: "", ref: "", old: "", new: "", pushOptions: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const eq = token.indexOf("=");
        let name: string;
        let value: string;
        if (eq > 0) {
            name = token.slice(0, eq);
            value = token.slice(eq + 1);
        } else {
            name = token;
            value = argv[i + 1] ?? "";
            i++;
        }
        switch (name) {
            case "--gate":
                args.gate = value;
                break;
            case "--ref":
                args.ref = value;
                break;
            case "--old":
                args.old = value;
                break;
            case "--new":
                args.new = value;
                break;
            case "--push-option":
                args.pushOptions.push(value);
                break;
        }
    }
    for (const [name, value] of [["gate", args.gate], ["ref", args.ref], ["old", args.old], ["new", args.new]] as const) {
        if (value === "") throw new Error(`required flag "--${name}" not set`);
    }
    return args;
}

/**
 * Handles the hidden `__gate-notify` command the post-receive hook invokes:
 * parses the push, ensures the daemon is running, and sends `push_received`.
 * Non-blocking by design - the hook ignores the exit code and never rejects the
 * push - so a failure here only surfaces in the hook's notify-push.log.
 */
export async function notifyPush(argv: string[], paths: Paths): Promise<void> {
    const args = parseNotifyArgs(argv);
    const skipSteps = parseSkipPushOptions(args.pushOptions);
    const intent = parseIntentPushOptions(args.pushOptions);

    // Best-effort: a start failure still lets the dial below report a clear error.
    try {
        await ensureDaemon(paths);
    } catch {
        // fall through to the dial, which surfaces the real connection error
    }

    let client: Client;
    try {
        client = await Client.dial(paths.socket());
    } catch (err) {
        throw new Error(`connect to daemon: ${errMessage(err)}`);
    }
    try {
        await client.pushReceived({
            gate: args.gate,
            ref: args.ref,
            old: args.old,
            new: args.new,
            skipSteps,
            intent
        });
    } finally {
        client.close();
    }
}

// --- Daemon subcommands -------------------------------------------------------

/** `gate daemon start`: install/refresh and start the daemon. */
export async function runDaemonStartCli(paths: Paths): Promise<void> {
    paths.ensureDirs();
    await startDaemon(paths);
    out(`  ${sGreen("✓")} daemon started\n`);
}

/** `gate daemon stop`: stop the running daemon. */
export async function runDaemonStopCli(paths: Paths): Promise<void> {
    await stopDaemon(paths);
    out(`  ${sGreen("✓")} daemon stopped\n`);
}

/** `gate daemon restart`: stop if running, then start. */
export async function runDaemonRestartCli(paths: Paths): Promise<void> {
    paths.ensureDirs();
    try {
        await stopDaemon(paths);
    } catch (err) {
        throw new Error(`stop daemon: ${errMessage(err)}`);
    }
    try {
        await startDaemon(paths);
    } catch (err) {
        throw new Error(`start daemon: ${errMessage(err)}`);
    }
    out(`  ${sGreen("✓")} daemon restarted\n`);
}

/** `gate daemon status`: report whether the daemon is running. */
export async function runDaemonStatusCli(paths: Paths): Promise<void> {
    const alive = await isDaemonRunning(paths);
    if (!alive) {
        out(`  ${sDim("○")} daemon not running\n`);
        return;
    }
    let pid = 0;
    try {
        pid = readDaemonPid(paths);
    } catch {
        // PID file may be absent; report running without a PID
    }
    if (pid > 0) {
        out(`  ${sGreen("●")} daemon running ${sDim(`(pid ${pid})`)}\n`);
    } else {
        out(`  ${sGreen("●")} daemon running\n`);
    }
}

/** Hidden `gate daemon run`: run the daemon in the foreground. */
export async function runDaemonRunCli(opts: { root?: string }, _paths: Paths): Promise<void> {
    if (opts.root !== undefined && opts.root !== "") {
        process.env.ENIGMA_GATE_HOME = opts.root;
    }
    const { run } = await import("../daemon/daemon");
    await run();
}

/** Dispatches a `gate daemon <sub>` subcommand. */
export async function runDaemonCli(argv: string[], paths: Paths): Promise<void> {
    const sub = argv[0] ?? "";
    switch (sub) {
        case "start":
            return runDaemonStartCli(paths);
        case "stop":
            return runDaemonStopCli(paths);
        case "restart":
            return runDaemonRestartCli(paths);
        case "status":
            return runDaemonStatusCli(paths);
        case "run":
            return runDaemonRunCli(parseRootFlag(argv.slice(1)), paths);
        default:
            throw new Error(`unknown daemon subcommand "${sub}"`);
    }
}

/** Extracts the `--root <dir>` / `--root=<dir>` flag for `daemon run`. */
function parseRootFlag(argv: string[]): { root?: string } {
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === "--root") return { root: argv[i + 1] ?? "" };
        if (token.startsWith("--root=")) return { root: token.slice("--root=".length) };
    }
    return {};
}
