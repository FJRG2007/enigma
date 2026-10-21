/**
 * System resource cleanup: list/kill processes, free ports, and the two Windows pain points
 * the user hits constantly - WSL's `vmmemwsl` lightweight VM (freed with `wsl --shutdown`)
 * and Docker Desktop not actually quitting. Everything here is DESTRUCTIVE, so every surface
 * (CLI, dashboard, TUI) confirms before calling the kill/shutdown helpers.
 *
 * Windows is first-class (the user's platform); POSIX has best-effort process/port support
 * via ps/lsof, and the WSL/Docker helpers report unavailable off Windows. The output PARSERS
 * and the kill-target grammar are pure and exported so they can be unit-tested without
 * spawning or killing anything.
 */

import { execFileSync } from "node:child_process";
import { totalmem, freemem, tmpdir } from "node:os";
import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

/** One process snapshot: tasklist on Windows, ps elsewhere. Best-effort; empty on failure. */
function snapshot(): ProcInfo[] {
    return isWin
        ? parseTasklist(run("tasklist", ["/fo", "csv", "/nh"]))
        : parsePs(run("ps", ["-axo", "pid=,rss=,comm="]));
}

/** Running processes, sorted by memory (desc). Best-effort; empty on failure. */
export function listProcesses(limit = 40): ProcInfo[] {
    return snapshot().sort((a, b) => b.memKB - a.memKB).slice(0, limit);
}

/**
 * Every listening TCP port with the owning process name, UNCAPPED. `listPorts`' limit is a
 * display cap applied after sorting by port, so anything that has to FIND a port (freePort)
 * reads this instead - otherwise a machine with many listeners loses the high ports and the
 * command reports nothing listening on a port that is very much in use.
 */
function allPorts(): PortInfo[] {
    let ports = isWin ? parseNetstat(run("netstat", ["-ano"])) : parseLsof(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]));
    if (isWin && ports.length) {
        // Fill names from a single tasklist snapshot (pid -> name).
        const byPid = new Map(parseTasklist(run("tasklist", ["/fo", "csv", "/nh"])).map((p) => [p.pid, p.name]));
        ports = ports.map((p) => ({ ...p, name: byPid.get(p.pid) || "" }));
    }
    return ports;
}

/** Listening TCP ports with the owning process name. Best-effort; empty on failure. */
export function listPorts(limit = 60): PortInfo[] {
    return allPorts().sort((a, b) => a.port - b.port).slice(0, limit);
}

/**
 * The listening ports enigma would actually agree to free - the system-owned ones (445, 135,
 * 3389 and the rest of the low range on Windows) are refused anyway, so offering them as
 * suggestions only wastes the reader's attention.
 */
export function listKillablePorts(limit = 20): PortInfo[] {
    return allPorts().filter((p) => !killRefusalReason(p.pid, p.name)).sort((a, b) => a.port - b.port).slice(0, limit);
}

/** True when a process whose name matches `re` is running (cheap snapshot). */
function processMatches(re: RegExp): boolean {
    return snapshot().some((p) => re.test(p.name));
}

/** A factual snapshot for the UIs (no side effects). */
export function resourceStatus(): ResourceStatus {
    const procs = snapshot();
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

/**
 * Kill one process by PID. Force-kills (Windows `taskkill /F`, POSIX SIGKILL). The refusal
 * lives HERE, in the single primitive every surface goes through (CLI, dashboard, TUI), so
 * no caller can reach a protected process by another route. Pass `knownName` when the caller
 * already has the name, to skip the snapshot.
 */
export function killPid(pid: number, knownName?: string): ActionResult {
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, message: "Invalid PID." };
    const name = knownName ?? (snapshot().find((p) => p.pid === pid)?.name || "");
    const refused = killRefusalReason(pid, name);
    if (refused) return { ok: false, message: `PID ${pid} is ${refused}; enigma will not kill it.` };
    try {
        if (isWin) execFileSync("taskkill", ["/F", "/PID", String(pid)], { timeout: 8000, windowsHide: true, stdio: "ignore" });
        else process.kill(pid, "SIGKILL");
        return { ok: true, message: `Killed process ${pid}.` };
    } catch (e) { return { ok: false, message: `Could not kill ${pid}: ${(e as Error).message}` }; }
}

/**
 * Kill every process listening on `port`. Protected owners are skipped and named rather than
 * killed: the low Windows ports belong to `System`, RPC and the other processes `PROTECTED`
 * exists for, and `enigma kill 135` must not take the machine down.
 */
export function freePort(port: number): ActionResult {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, message: "Invalid port." };
    const names = new Map<number, string>();
    for (const listener of allPorts().filter((p) => p.port === port)) if (!names.get(listener.pid)) names.set(listener.pid, listener.name);
    if (!names.size) return { ok: false, message: `Nothing is listening on port ${port}.` };
    // lsof/netstat do not always give a name; one snapshot fills whatever is still missing,
    // because a pid with no name would sail past the protection check.
    if ([...names.values()].some((name) => !name)) {
        const byPid = new Map(snapshot().map((p) => [p.pid, p.name]));
        for (const [pid, name] of names) if (!name) names.set(pid, byPid.get(pid) || "");
    }
    const targets: number[] = [], refused: string[] = [];
    for (const [pid, name] of names) {
        const reason = killRefusalReason(pid, name);
        if (reason) refused.push(`${pid} (${reason})`);
        else targets.push(pid);
    }
    const skipped = refused.length ? ` Skipped ${refused.join(", ")}.` : "";
    if (!targets.length) return { ok: false, message: `Refusing to free port ${port}: nothing there may be killed.${skipped}` };
    const killed: number[] = [], failed: number[] = [];
    for (const pid of targets) (killPid(pid, names.get(pid)).ok ? killed : failed).push(pid);
    if (!killed.length) return { ok: false, message: `Could not free port ${port} (pids ${failed.join(", ")}).${skipped}` };
    return { ok: true, message: `Freed port ${port}: killed ${killed.join(", ")}${failed.length ? ` (failed ${failed.join(", ")})` : ""}.${skipped}` };
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

/**
 * Processes that must never be force-killed: on Windows the kernel/session ones take the
 * machine down (or bluescreen it), on POSIX pid 1 and the kernel threads do. A kill BY NAME
 * can sweep many pids at once, so the list is checked there rather than left to the OS
 * refusing one call at a time.
 */
const PROTECTED = isWin
    ? /^(system|system idle process|secure system|registry|memory compression|smss|csrss|wininit|winlogon|services|lsass|lsaiso|fontdrvhost|dwm|svchost)(\.exe)?$/i
    : /^(init|systemd|systemd-\S+|launchd|kernel_task|kthreadd)$/i;

/** True when a process name is one enigma refuses to kill. */
export function isProtectedProcess(name: string): boolean {
    return PROTECTED.test(name.trim());
}

/**
 * Why enigma refuses to kill this process, or null when it is fair game. One rule for every
 * route to a kill (by pid, by name, by port), phrased so it can be read straight back to the
 * user. An unknown name is not treated as protected: it is the pid the OS itself will refuse.
 */
export function killRefusalReason(pid: number, name: string): string | null {
    if (pid === process.pid) return "enigma itself";
    if (pid === process.ppid) return "the shell enigma runs in";
    if (name && isProtectedProcess(name)) return `${name.trim()}, a system process`;
    return null;
}

// --- processes the agents leave behind -------------------------------------------

/**
 * A family of process an agent session starts and then abandons, and the age past which
 * one is provably garbage rather than busy.
 *
 * AGE IS THE WHOLE RULE, in every family, on purpose. The tempting second condition - "its
 * spawner is gone" - needs a parent PID, and Windows recycles those: a reused id reads as a
 * live parent and would make the sweep skip a real orphan, while a coincidence would make it
 * kill on bad evidence. The clock needs neither, and each family's threshold is set from how
 * long the work legitimately takes.
 */
export interface LeftoverKind {
    /** How a report names one of these. */
    label: string;
    /** Plural for the report. */
    plural: string;
    minAgeSec: number;
    matches(commandLine: string): boolean;
}

/** A leftover candidate and its age, as either platform's probe reports it. */
export interface LeftoverProc { pid: number; ageSec: number; command: string; kind: LeftoverKind; }

/**
 * A status-bar render prints one line and exits - it reads the piped session under a 2 s
 * ceiling - so two minutes is far past anything that is still working.
 */
export const STATUSLINE_ORPHAN_MIN_AGE_SEC = 120;

/**
 * A whole-machine search gets longer, because the ones a person starts deliberately are
 * slow rather than abandoned. Fifteen minutes of walking every file on the disk is past
 * both: an agent that started it has long since moved on, and nothing is reading the output.
 */
export const WHOLE_MACHINE_SEARCH_MIN_AGE_SEC = 900;

/**
 * Whether a command line is one of enigma's own status-bar processes: a render - the npm
 * shim (`enigma statusline`), the launcher it expands to on Windows (`node ...\bin\enigma.mjs
 * statusline`), or the binary called directly - or the janitor itself, which can get stuck the
 * same way its subjects do (`node ...\dist\leftovers.js`).
 *
 * `enigma` is anchored immediately before the subcommand because the Windows probe matches on
 * the WORD `statusline`, and the probe's own command line contains it.
 */
export function isStatuslineCommand(commandLine: string): boolean {
    if (/[\\/]leftovers\.js(?:["']|\s|$)/i.test(commandLine)) return true;
    return /(?:^|[\\/\s"'])enigma(?:-bin|-cli)?(?:\.mjs|\.cmd|\.exe|\.ps1)?["']?\s+statusline(?:\s|$)/i.test(commandLine);
}

/**
 * Whether a command line is a `find` walking the whole machine: its first path argument is
 * a filesystem root, a home directory, or a drive root in any of the spellings Windows makes
 * available (`C:\`, Git Bash's `/c/`, WSL's `/mnt/c/`).
 *
 * The root has to be the WHOLE argument - followed by whitespace or the end of the command -
 * which is what keeps `find /c/Users/me/project -name x` out of it. That search is scoped, and
 * a scoped search is not what this is for.
 *
 * What it does NOT try to be is a parser. A search rooted somewhere unusual, or spelled
 * through a variable this cannot resolve, is left alone: the sweep force-kills what it
 * matches, so a miss costs one abandoned process and a false match costs someone's work.
 */
export function isWholeMachineSearch(commandLine: string): boolean {
    const root = "\\/|~\\/?|\\$HOME\\/?|\\/c\\/?|\\/d\\/?|\\/e\\/?|\\/mnt\\/[a-z]\\/?|\\/home\\/?|\\/Users\\/?|[A-Za-z]:[\\\\\\/]?";
    return new RegExp(String.raw`(?:^|[\\/\s"'])find(?:\.exe)?["']?\s+(?:-\S+\s+)*(?:${root})(?:\s|$)`, "i").test(commandLine);
}

/**
 * An automation browser lives as long as the MCP server that launched it - the whole agent
 * session, hours after the last test. Half an hour is past any single check, and reaping one
 * costs nothing: the Chrome DevTools server relaunches its browser on the next tool call
 * (`BrowserManager.ensureBrowser` re-inits when `browser.connected` is false).
 */
export const AUTOMATION_BROWSER_MIN_AGE_SEC = 1800;

/** Throwaway profiles only automation creates: Puppeteer's `--isolated` profile and `enigma design`'s. */
const AUTOMATION_PROFILE = /--user-data-dir=["']?([^"'\s]*?[\\/](?:puppeteer_dev_chrome_profile-|enigma-design-)[\w-]+)/i;

/**
 * Whether a command line is the MAIN process of a browser an agent's tooling launched: a
 * Chromium-family executable (renderer/GPU children carry `--type=` and die with it) running
 * on one of the automation-only temp profiles. The user's own browser never runs on those
 * profiles, which is what makes this safe to force-kill.
 */
export function isAutomationBrowser(commandLine: string): boolean {
    if (/\s--type=/.test(commandLine)) return false;
    if (!/(?:chrome|chromium|msedge|brave)(?:\.exe)?["']?\s/i.test(commandLine)) return false;
    return AUTOMATION_PROFILE.test(commandLine);
}

/** The temp profile directory of an automation browser's command line, or null. */
export function automationProfileDir(commandLine: string): string | null {
    return commandLine.match(AUTOMATION_PROFILE)?.[1] ?? null;
}

/**
 * Delete a reaped browser's temp profile - only a directory directly under the OS temp dir
 * with an automation profile name, whatever the command line claimed.
 */
export function removeTempProfile(dir: string, tempRoot: string = tmpdir()): boolean {
    const full = resolve(dir);
    if (resolve(dirname(full)).toLowerCase() !== resolve(tempRoot).toLowerCase()) return false;
    if (!/^(?:puppeteer_dev_chrome_profile-|enigma-design-)[\w-]+$/.test(basename(full))) return false;
    try { rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; } catch { return false; }
}

/** Every family the sweep knows about. */
export const LEFTOVER_KINDS: readonly LeftoverKind[] = [
    { label: "status bar", plural: "status bars", minAgeSec: STATUSLINE_ORPHAN_MIN_AGE_SEC, matches: isStatuslineCommand },
    { label: "whole-machine search", plural: "whole-machine searches", minAgeSec: WHOLE_MACHINE_SEARCH_MIN_AGE_SEC, matches: isWholeMachineSearch },
    { label: "idle automation browser", plural: "idle automation browsers", minAgeSec: AUTOMATION_BROWSER_MIN_AGE_SEC, matches: isAutomationBrowser },
];

/** Parse the Windows probe's `pid|ageSeconds|commandLine` rows. */
export function parseWinProcs(out: string): Omit<LeftoverProc, "kind">[] {
    const procs: Omit<LeftoverProc, "kind">[] = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(\d+)\|(-?\d+)\|(.*)$/);
        if (!m) continue;
        procs.push({ pid: Number(m[1]), ageSec: Number(m[2]), command: m[3]! });
    }
    return procs;
}

/** Parse `ps -eo pid=,etime=,args=`: pid, `[[dd-]hh:]mm:ss` elapsed, full command line. */
export function parsePsProcs(out: string): Omit<LeftoverProc, "kind">[] {
    const procs: Omit<LeftoverProc, "kind">[] = [];
    for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;
        const ageSec = parseElapsed(m[2]!);
        if (ageSec < 0) continue;
        procs.push({ pid: Number(m[1]), ageSec, command: m[3]! });
    }
    return procs;
}

/** `ps` ELAPSED (`[[dd-]hh:]mm:ss`) in seconds, or -1 when it is not that shape. */
export function parseElapsed(text: string): number {
    const m = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!m) return -1;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** The processes worth reaping: matched by a family, past ITS age, and killable. */
export function selectLeftovers(
    procs: Omit<LeftoverProc, "kind">[],
    kinds: readonly LeftoverKind[] = LEFTOVER_KINDS,
): LeftoverProc[] {
    const found: LeftoverProc[] = [];
    for (const proc of procs) {
        if (killRefusalReason(proc.pid, "")) continue;
        const kind = kinds.find((k) => proc.ageSec >= k.minAgeSec && k.matches(proc.command));
        if (kind) found.push({ ...proc, kind });
    }
    return found;
}

/**
 * Every process on the machine that could be a leftover, with its age.
 *
 * Windows has no builtin left that prints a command line - `wmic` is gone from Windows 11
 * 24H2 on - so the probe is one PowerShell CIM query, filtered server-side on the two words
 * so it does not carry 800 processes back. The filter is deliberately loose and the matching
 * is done here: a false positive in the query costs nothing, a miss costs a process nobody
 * reaps. The script is written WITHOUT a single double quote, so nothing depends on how the
 * shell re-quotes it on the way in.
 */
function leftoverCandidates(): Omit<LeftoverProc, "kind">[] {
    if (!isWin) return parsePsProcs(run("ps", ["-eo", "pid=,etime=,args="]));
    // `%find%` and not `%find %`: the real command line is `...inind.exe" /c/ -name x`,
    // so the trailing space matched nothing. The pattern is meant to be loose - the regexes
    // above do the deciding, and a row the query drops is a process nobody reaps.
    const where = "CommandLine LIKE ''%statusline%'' OR CommandLine LIKE ''%find%'' OR CommandLine LIKE ''%puppeteer_dev_chrome_profile%'' OR CommandLine LIKE ''%enigma-design-%''";
    const emit = "ForEach-Object { [string]$_.ProcessId + '|' + [string][int]((Get-Date) - $_.CreationDate).TotalSeconds + '|' + $_.CommandLine }";
    const script = `Get-CimInstance Win32_Process -Filter '${where}' | ${emit}`;
    return parseWinProcs(run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]));
}

/**
 * Force-kill several pids at once, reporting which actually died.
 *
 * `killPid` is the primitive for a kill someone NAMED, and on Windows it spawns a `taskkill`
 * per pid; a sweep can carry dozens, and on the box this was measured on a spawn costs
 * seconds. `process.kill` is TerminateProcess on Windows and SIGKILL on POSIX - no spawn at
 * all, and it throws when the pid is already gone, which is how this knows what it killed
 * rather than parsing a localized `taskkill` transcript. The refusal rule is the same one.
 */
export function killPids(pids: number[]): { killed: number[]; refused: number[]; } {
    const killed: number[] = [], refused: number[] = [];
    for (const pid of pids) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (killRefusalReason(pid, "")) { refused.push(pid); continue; }
        try { process.kill(pid, "SIGKILL"); killed.push(pid); } catch { /* already gone, or not ours */ }
    }
    return { killed, refused };
}

/**
 * Sweep the processes an agent session started and walked away from. DESTRUCTIVE, over two
 * families only, each past its own age (see `LEFTOVER_KINDS`).
 *
 * THE STATUS BARS are the ones nothing else could ever clean up. The harness re-runs the bar
 * on a timer, and a tick that lands while the session tears down leaves a process that was
 * CREATED AND NEVER STARTED - measured on Windows 11 as 66 in a day, every one with a single
 * suspended thread, zero CPU over four hours, no module loaded and a dead parent. No timeout,
 * `unref` or signal handler can reach that: none of it runs in a thread that never ran.
 *
 * THE SEARCHES are the same shape from the other end. An agent starts a `find` across the
 * whole disk, the turn moves on, and nothing is left reading the output - so it keeps walking
 * millions of files for hours. `search-guard` refuses the ones it can see coming (claude.ts);
 * this is for the ones already running, and for the spellings a deny rule matched as written
 * cannot catch.
 *
 * Both survive until reboot, so the only cure is a sweep from a process that IS running.
 */
export function reapAgentLeftovers(kinds: readonly LeftoverKind[] = LEFTOVER_KINDS): ActionResult {
    const candidates = leftoverCandidates();
    const leftovers = selectLeftovers(candidates, kinds);
    const { killed } = killPids(leftovers.map((p) => p.pid));
    // A killed browser never runs its own profile cleanup; remove the temp profile it was on.
    for (const proc of leftovers) {
        const profile = killed.includes(proc.pid) ? automationProfileDir(proc.command) : null;
        if (profile) removeTempProfile(profile);
    }
    // Profiles of browsers that died some other way (a crash, a killed server) pile up in the
    // temp dir - 139 of them, 640 MB, on the machine this was written on.
    const live = candidates.filter((p) => !killed.includes(p.pid)).map((p) => p.command);
    const profiles = kinds.some((k) => k.matches === isAutomationBrowser) ? sweepStaleProfiles(live) : 0;
    const byKind = new Map<string, number>();
    for (const proc of leftovers) {
        if (!killed.includes(proc.pid)) continue;
        const label = proc.kind.plural;
        byKind.set(label, (byKind.get(label) ?? 0) + 1);
    }
    const profileNote = profiles ? ` Removed ${profiles} stale browser profile${profiles === 1 ? "" : "s"}.` : "";
    if (!leftovers.length) return { ok: true, message: `No leftover agent processes.${profileNote}` };
    if (!byKind.size) return { ok: false, message: `Found ${leftovers.length} leftover process(es); none of them could be killed.${profileNote}` };
    const parts = [...byKind].map(([label, n]) => `${n} ${n === 1 ? label.replace(/e?s$/, "") : label}`);
    return { ok: true, message: `Killed ${killed.length} leftover process${killed.length === 1 ? "" : "es"}: ${parts.join(", ")}.${profileNote}` };
}

/**
 * Remove automation profile directories in the temp dir that no running process references and
 * that have not been touched for the browser age limit. Returns how many were removed.
 */
export function sweepStaleProfiles(liveCommands: string[], tempRoot: string = tmpdir(), now: number = Date.now()): number {
    let removed = 0;
    let entries: string[];
    try { entries = readdirSync(tempRoot); } catch { return 0; }
    for (const name of entries) {
        if (!/^(?:puppeteer_dev_chrome_profile-|enigma-design-)[\w-]+$/.test(name)) continue;
        if (liveCommands.some((c) => c.includes(name))) continue;
        const dir = join(tempRoot, name);
        try {
            if (!statSync(dir).isDirectory() || now - statSync(dir).mtimeMs < AUTOMATION_BROWSER_MIN_AGE_SEC * 1000) continue;
        } catch { continue; }
        if (removeTempProfile(dir, tempRoot)) removed++;
    }
    return removed;
}

/** What `enigma kill <target>` was asked to kill. */
export type KillTarget =
    | { kind: "wsl"; }
    | { kind: "docker"; }
    /** The sweep. `family` narrows it to one of LEFTOVER_KINDS; absent means all of them. */
    | { kind: "leftovers"; family?: "statusline"; }
    /** `bare`: written as a plain number, so it may have been meant as a PID. */
    | { kind: "port"; port: number; bare: boolean; }
    | { kind: "pid"; pid: number; }
    | { kind: "name"; name: string; };

/**
 * Read one kill target. Pure (the unit-testable half of the command): `3000` is a port
 * because that is what people mean when they type it, `pid 1234` / `port 3000` / `:3000`
 * are the explicit forms, `wsl` and `docker` are the two Windows pain points, and anything
 * else is a process name. A bare number above 65535 cannot be a port, so it is a PID.
 */
export function parseKillTarget(raw: string): KillTarget | null {
    const text = raw.trim();
    if (!text) return null;
    const token = text.toLowerCase();
    if (/^(wsl|vmmem|vmmemwsl)$/.test(token)) return { kind: "wsl" };
    if (/^docker([ -]desktop)?$/.test(token)) return { kind: "docker" };
    if (/^left-?overs?$/.test(token)) return { kind: "leftovers" };
    if (/^status-?lines?$/.test(token)) return { kind: "leftovers", family: "statusline" };
    const pid = token.match(/^pid[:=\s]\s*(\d+)$/);
    if (pid) return { kind: "pid", pid: Number(pid[1]) };
    const port = token.match(/^(?::|port[:=\s]\s*)(\d+)$/);
    if (port) return { kind: "port", port: Number(port[1]), bare: false };
    if (/^\d+$/.test(token)) {
        const n = Number(token);
        return n <= 65535 ? { kind: "port", port: n, bare: true } : { kind: "pid", pid: n };
    }
    return { kind: "name", name: text };
}

/**
 * A name match above this count is a fleet, not "the process the user meant" - `enigma kill
 * node` on a dev machine can resolve to dozens of editor language servers and extension
 * hosts, none of which anyone typing four letters intended to take down at once. Past the
 * threshold, `killByName` refuses instead of killing, so one word cannot mass-kill unrelated
 * tooling; `opts.yes` is the explicit opt-in past that refusal.
 */
export const KILL_BY_NAME_BULK_LIMIT = 5;

/** True when a by-name kill of `count` processes needs the `--yes`/`-y` opt-in to proceed. */
export function isBulkKill(count: number, yes = false): boolean {
    return count > KILL_BY_NAME_BULK_LIMIT && !yes;
}

/**
 * Kill every process with this name (`enigma kill app.exe`). Exact name wins; a substring
 * only matches when it resolves to ONE name, because "node" hitting four different programs
 * has to be the user's decision and not a guess. `.exe` is optional either way. Past
 * `KILL_BY_NAME_BULK_LIMIT` killable matches, refuses unless `opts.yes` is set - see
 * `KILL_BY_NAME_BULK_LIMIT`.
 */
export function killByName(raw: string, opts: { yes?: boolean; } = {}): ActionResult {
    const wanted = raw.trim().toLowerCase().replace(/\.exe$/, "");
    if (!wanted) return { ok: false, message: "Missing process name." };
    if (isProtectedProcess(raw)) return { ok: false, message: `'${raw.trim()}' is a system process; enigma will not kill it.` };
    const base = (name: string): string => name.toLowerCase().replace(/\.exe$/, "");
    const procs = snapshot();
    let matches = procs.filter((p) => base(p.name) === wanted);
    if (!matches.length) {
        matches = procs.filter((p) => base(p.name).includes(wanted));
        const names = [...new Set(matches.map((p) => p.name))];
        if (names.length > 1) {
            const shown = names.slice(0, 8).join(", ");
            const rest = names.length - 8;
            return { ok: false, message: `'${raw.trim()}' matches ${names.length} programs: ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Name one exactly.` };
        }
    }
    if (!matches.length) return { ok: false, message: `No process named '${raw.trim()}' is running.` };
    const name = matches[0]!.name;
    // Never kill enigma itself or the shell it was launched from - that reads as a crash.
    const safe = matches.filter((p) => !killRefusalReason(p.pid, p.name));
    if (!safe.length) return { ok: false, message: `Refusing to kill '${name}': it is a system process, enigma itself, or its shell.` };
    if (isBulkKill(safe.length, opts.yes)) {
        return {
            ok: false,
            message: `'${name}' matches ${safe.length} processes; refusing to kill that many at once. Name one by pid ('enigma kill pid <n>') or repeat the command with --yes/-y.`,
        };
    }
    const killed: number[] = [], failed: number[] = [];
    for (const p of safe) (killPid(p.pid, p.name).ok ? killed : failed).push(p.pid);
    if (!killed.length) return { ok: false, message: `Could not kill ${name} (pids ${failed.join(", ")}).` };
    return { ok: true, message: `Killed ${name}: ${killed.length} process${killed.length === 1 ? "" : "es"} (${killed.join(", ")})${failed.length ? `, failed ${failed.join(", ")}` : ""}.` };
}

/** Run one parsed kill target. DESTRUCTIVE; the caller owns the confirmation. */
export function killTarget(target: KillTarget, opts: { yes?: boolean; } = {}): ActionResult {
    switch (target.kind) {
        case "wsl": return shutdownWsl();
        case "docker": return quitDocker();
        case "leftovers": return reapAgentLeftovers(target.family === "statusline"
            ? LEFTOVER_KINDS.filter((k) => k.matches === isStatuslineCommand)
            : LEFTOVER_KINDS);
        case "name": return killByName(target.name, opts);
        case "pid": {
            const proc = snapshot().find((p) => p.pid === target.pid);
            return killPid(target.pid, proc?.name ?? "");
        }
        case "port": {
            const result = freePort(target.port);
            // A plain number is read as a port; when nothing listens there, say so AND point
            // at the PID reading rather than killing a process the user never named.
            if (result.ok || !target.bare) return result;
            const proc = snapshot().find((p) => p.pid === target.port);
            if (!proc || killRefusalReason(proc.pid, proc.name)) return result; // never point at one that would be refused
            return { ok: false, message: `Nothing is listening on port ${target.port}. PID ${target.port} is ${proc.name} - kill it with 'enigma kill pid ${target.port}'.` };
        }
    }
}

/** Dispatch a named action (used by the dashboard/CLI/TUI). `value` is the PID or port. */
export function runResourceAction(op: string, value?: number): ActionResult {
    switch (op) {
        case "wsl-shutdown": return shutdownWsl();
        case "docker-quit": return quitDocker();
        case "leftovers": return reapAgentLeftovers();
        case "free-port": return value != null ? freePort(value) : { ok: false, message: "Missing port." };
        case "kill": return value != null ? killPid(value) : { ok: false, message: "Missing PID." };
        default: return { ok: false, message: `Unknown action: ${op}` };
    }
}
