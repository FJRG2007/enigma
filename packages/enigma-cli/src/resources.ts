/**
 * System resource cleanup: list/kill processes, free ports, and the two Windows pain points
 * the user hits constantly - WSL's `vmmemwsl` lightweight VM (freed with `wsl --shutdown`)
 * and Docker Desktop not actually quitting. Everything here is DESTRUCTIVE, so every surface
 * (CLI, dashboard, TUI) confirms before calling the kill/shutdown helpers.
 *
 * Windows is first-class (the user's platform); POSIX has best-effort process/port support
 * via ps/lsof, and the WSL/Docker helpers report unavailable off Windows. The output PARSERS
 * are pure and exported so they can be unit-tested without spawning or killing anything.
 */

import { execFileSync } from "node:child_process";
import { totalmem, freemem } from "node:os";

const isWin = process.platform === "win32";

export interface ProcInfo { pid: number; name: string; memKB: number; }
export interface PortInfo { port: number; pid: number; name: string; proto: string; }
export interface ActionResult { ok: boolean; message: string; }

export interface ResourceStatus {
    platform: NodeJS.Platform;
    totalMem: number;
    freeMem: number;
    /** `wsl` is present (Windows + WSL installed). */
    wslAvailable: boolean;
    /** The vmmem/vmmemWSL VM process is currently running (the RAM hog). */
    vmmemRunning: boolean;
    /** Docker Desktop is currently running. */
    dockerRunning: boolean;
    /** Top processes by memory (capped). */
    topProcesses: ProcInfo[];
    /** Listening TCP ports with their owning process (capped). */
    ports: PortInfo[];
}

/** Run a command, returning stdout, or "" on any error/timeout (best-effort, never throws). */
function run(cmd: string, args: string[]): string {
    try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); }
    catch (e) { const out = (e as { stdout?: string; }).stdout; return typeof out === "string" ? out : ""; }
}

// --- parsers (pure, exported for tests) -----------------------------------------

/** Parse `tasklist /fo csv /nh`: "name","pid","session","#","mem K" rows. */
export function parseTasklist(out: string): ProcInfo[] {
    const procs: ProcInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
        if (!m) continue;
        const memKB = Number(m[3]!.replace(/[^\d]/g, "")) || 0; // "12,345 K" -> 12345
        procs.push({ name: m[1]!, pid: Number(m[2]), memKB });
    }
    return procs;
}

/** Parse `ps -axo pid=,rss=,comm=`: pid, RSS in KB, command. */
export function parsePs(out: string): ProcInfo[] {
    const procs: ProcInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        procs.push({ pid: Number(m[1]), memKB: Number(m[2]) || 0, name: m[3]!.split(/[\\/]/).pop() || m[3]! });
    }
    return procs;
}

/** Parse `netstat -ano` LISTENING rows -> {proto, port, pid}. Names are filled in by the caller. */
export function parseNetstat(out: string): PortInfo[] {
    const seen = new Set<string>();
    const ports: PortInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim().split(/\s+/);
        // TCP  0.0.0.0:3000   0.0.0.0:0   LISTENING   1234
        if (t[0] !== "TCP" || !/LISTEN/i.test(t[3] || "")) continue;
        const port = Number((t[1] || "").split(":").pop());
        const pid = Number(t[4]);
        if (!port || !pid) continue;
        const key = `${port}:${pid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ports.push({ proto: "tcp", port, pid, name: "" });
    }
    return ports;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN`: COMMAND PID USER ... NAME(host:port). */
export function parseLsof(out: string): PortInfo[] {
    const seen = new Set<string>();
    const ports: PortInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim().split(/\s+/);
        if (t.length < 9 || t[1] === "PID") continue;
        const port = Number((t[8] || "").split(":").pop());
        const pid = Number(t[1]);
        if (!port || !pid) continue;
        const key = `${port}:${pid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ports.push({ proto: "tcp", port, pid, name: t[0]! });
    }
    return ports;
}

// --- queries --------------------------------------------------------------------

/** Running processes, sorted by memory (desc). Best-effort; empty on failure. */
export function listProcesses(limit = 40): ProcInfo[] {
    const procs = isWin
        ? parseTasklist(run("tasklist", ["/fo", "csv", "/nh"]))
        : parsePs(run("ps", ["-axo", "pid=,rss=,comm="]));
    return procs.sort((a, b) => b.memKB - a.memKB).slice(0, limit);
}

/** Listening TCP ports with the owning process name. Best-effort; empty on failure. */
export function listPorts(limit = 60): PortInfo[] {
    let ports = isWin ? parseNetstat(run("netstat", ["-ano"])) : parseLsof(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]));
    if (isWin && ports.length) {
        // Fill names from a single tasklist snapshot (pid -> name).
        const byPid = new Map(parseTasklist(run("tasklist", ["/fo", "csv", "/nh"])).map((p) => [p.pid, p.name]));
        ports = ports.map((p) => ({ ...p, name: byPid.get(p.pid) || "" }));
    }
    return ports.sort((a, b) => a.port - b.port).slice(0, limit);
}

/** True when a process whose name matches `re` is running (cheap snapshot). */
function processMatches(re: RegExp): boolean {
    const procs = isWin ? parseTasklist(run("tasklist", ["/fo", "csv", "/nh"])) : parsePs(run("ps", ["-axo", "pid=,rss=,comm="]));
    return procs.some((p) => re.test(p.name));
}

/** A factual snapshot for the UIs (no side effects). */
export function resourceStatus(): ResourceStatus {
    const procs = isWin ? parseTasklist(run("tasklist", ["/fo", "csv", "/nh"])) : parsePs(run("ps", ["-axo", "pid=,rss=,comm="]));
    const top = [...procs].sort((a, b) => b.memKB - a.memKB).slice(0, 40);
    return {
        platform: process.platform,
        totalMem: totalmem(),
        freeMem: freemem(),
        wslAvailable: isWin && run("where", ["wsl"]).trim().length > 0,
        vmmemRunning: procs.some((p) => /^vmmem/i.test(p.name)),
        dockerRunning: procs.some((p) => /docker desktop/i.test(p.name)),
        topProcesses: top,
        ports: listPorts(),
    };
}

// --- actions (DESTRUCTIVE) ------------------------------------------------------

/** Kill one process by PID. Force-kills (Windows `taskkill /F`, POSIX SIGKILL). */
export function killPid(pid: number): ActionResult {
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: "Invalid PID." };
    try {
        if (isWin) execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 8000, windowsHide: true, stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
        return { ok: true, message: `Killed process ${pid}.` };
    } catch (e) { return { ok: false, message: `Could not kill ${pid}: ${(e as Error).message}` }; }
}

/** Kill every process listening on `port`. */
export function freePort(port: number): ActionResult {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, message: "Invalid port." };
    const pids = [...new Set(listPorts(200).filter((p) => p.port === port).map((p) => p.pid))];
    if (!pids.length) return { ok: false, message: `Nothing is listening on port ${port}.` };
    const killed: number[] = [], failed: number[] = [];
    for (const pid of pids) (killPid(pid).ok ? killed : failed).push(pid);
    if (!killed.length) return { ok: false, message: `Could not free port ${port} (pids ${failed.join(", ")}).` };
    return { ok: true, message: `Freed port ${port}: killed ${killed.join(", ")}${failed.length ? ` (failed ${failed.join(", ")})` : ""}.` };
}

/**
 * `wsl --shutdown`: stop every WSL distro and the lightweight VM, so `vmmemWSL` releases its
 * RAM. The documented fix for vmmem eating memory. Windows only.
 */
export function shutdownWsl(): ActionResult {
    if (!isWin) return { ok: false, message: "WSL is Windows-only." };
    try {
        execFileSync("wsl", ["--shutdown"], { timeout: 20000, windowsHide: true, stdio: "ignore" });
        return { ok: true, message: "WSL shut down. vmmemWSL releases its memory within a few seconds." };
    } catch (e) { return { ok: false, message: `wsl --shutdown failed: ${(e as Error).message}` }; }
}

/**
 * Quit Docker Desktop AND its WSL backend, the safe order (Docker first, then WSL): Docker
 * Desktop often does not actually exit, so this force-kills its processes. Windows only.
 */
export function quitDocker(): ActionResult {
    if (!isWin) return { ok: false, message: "Docker Desktop quit is Windows-only here." };
    if (!processMatches(/docker desktop/i)) return { ok: false, message: "Docker Desktop is not running." };
    const targets = ["Docker Desktop.exe", "com.docker.backend.exe", "com.docker.build.exe", "com.docker.dev-envs.exe"];
    let any = false;
    for (const name of targets) {
        try { execFileSync("taskkill", ["/F", "/IM", name], { timeout: 8000, windowsHide: true, stdio: "ignore" }); any = true; }
        catch { /* not running */ }
    }
    // Docker's engine runs in WSL2, so shut WSL down too (frees vmmem fully).
    const wsl = shutdownWsl();
    return any
        ? { ok: true, message: `Docker Desktop closed.${wsl.ok ? " WSL backend shut down too." : ""}` }
        : { ok: false, message: "Could not close Docker Desktop." };
}

/** Dispatch a named action (used by the dashboard/CLI/TUI). `value` is the PID or port. */
export function runResourceAction(op: string, value?: number): ActionResult {
    switch (op) {
        case "wsl-shutdown": return shutdownWsl();
        case "docker-quit": return quitDocker();
        case "free-port": return value != null ? freePort(value) : { ok: false, message: "Missing port." };
        case "kill": return value != null ? killPid(value) : { ok: false, message: "Missing PID." };
        default: return { ok: false, message: `Unknown action: ${op}` };
    }
}
