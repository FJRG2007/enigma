/**
 * Keeps every browser an agent starts headless, whatever started it, and closes them all when
 * the agent exits.
 *
 * The PreToolUse guard (browser-guard.ts) reads a command before it runs, so it only sees what
 * the command says: `node test.js` with `headless: false` inside, a `playwright.config.ts` that
 * asks for a headed browser, `npm run dev` with `server.open: true`, Python's `webbrowser`, and
 * every agent without a PreToolUse hook all get past it. What they have in common is the process
 * they end up creating, so this watches processes instead of commands.
 *
 * Windows: the launcher creates the agent itself, suspended, puts it in a job object and only then
 * lets it run. Job membership is inherited and survives the parent's exit, so every process the
 * session creates is in it - also one started through `start`, `Start-Process` or ShellExecute,
 * whose parent is gone by the time anyone looks. The agent is created outside the job libuv keeps
 * the launcher in: that job kills everything in it when the npm launcher exits, and a job nested
 * under it would take every daemon the session started down with it. The job reports each new process on an I/O completion port, which is drained
 * every 15 ms; a browser main process without a headless flag is terminated on sight, before it
 * has drawn a window and, measured, before a console child printed its first line. When the
 * agent exits, every browser still in the job is closed, headless ones included.
 *
 * Linux and macOS: the launcher polls `ps` for its own descendants, and keeps following one it
 * has seen after its parent exits (on Linux it also becomes the subreaper, so an orphaned browser
 * is re-parented to it instead of to init, and it reaps the ones it adopted). macOS `open` starts
 * an app through launchd, outside the tree: the command guard is the only stop for that one.
 *
 * What this cannot stop: a URL handed to a browser the user already has open. The new process
 * only passes the URL to the running one and exits; it is killed if it is caught in time, and
 * otherwise the tab opens in the user's window. The command guard and BROWSER=none (which Vite
 * and Create React App honor) are what cover that case.
 *
 * A sign-in page is let through, and left open when the session ends: an agent's own login
 * (Claude's /login, `codex login`), whose URL names the vendor's authorize endpoint, or an MCP
 * server's OAuth sign-in, whose URL is an authorization request (`client_id` and `response_type`).
 * Both are the user's action, and the browser they start may become the user's own.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { readConfig } from "./config";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { BROWSER_EXE, hasHeadless, programName } from "./browser-guard";

/** A running jail; `close` stops watching and closes every browser the session left behind. */
export interface BrowserJail {
    close(): Promise<void>;
    /**
     * Windows, a jail started for an agent: run `commandLine` inside it, inheriting this process's
     * stdio and console, resolving with its exit code. Null when the process could not be created
     * that way; the jail then holds this process instead, and the caller spawns as usual.
     */
    spawn?(commandLine: string, env: NodeJS.ProcessEnv): Promise<number> | null;
}

/** Browsers BROWSER_EXE does not name. */
const EXTRA_BROWSER_IMAGE = /^(?:opera|vivaldi)$/i;

/** Playwright's WebKit build on Windows. Only the .exe: elsewhere `playwright` is the test runner's own CLI. */
const PLAYWRIGHT_WEBKIT = /(?:^|[\\/])playwright\.exe$/i;

/** A browser's helper processes (renderer, GPU, crash handler, Firefox content): they die with the main one. */
const HELPER_PROCESS = /\s--type=|\s-contentproc\b/i;

/** Vendor domains an agent signs in through. */
const LOGIN_HOST = /(?:^|\.)(?:claude\.ai|claude\.com|anthropic\.com|openai\.com|chatgpt\.com|github\.com)$/i;

/** A whole path segment that makes a URL a sign-in page (`/oauth/authorize`, `/login/device`). */
const LOGIN_PATH = /\/(?:oauth|authorize|login|device)(?:\/|$)/i;

/** Whether an executable path or name is a browser's. */
export function isBrowserImage(image: string): boolean {
    const name = programName(image);
    return BROWSER_EXE.test(name) || EXTRA_BROWSER_IMAGE.test(name) || PLAYWRIGHT_WEBKIT.test(image);
}

/** An OAuth 2.0 authorization request (RFC 6749 4.1.1) over https: how any provider's sign-in page opens. */
function isAuthorizationRequest(url: URL): boolean {
    return url.protocol === "https:" && url.searchParams.has("client_id") && url.searchParams.has("response_type");
}

/** Whether every URL in a command line is a sign-in page (and there is at least one). */
export function opensOnlyLogin(commandLine: string): boolean {
    const urls = commandLine.match(/https?:\/\/[^\s"']+/gi) ?? [];
    if (!urls.length) return false;
    return urls.every((raw) => {
        try {
            const url = new URL(raw);
            return (LOGIN_HOST.test(url.hostname) && LOGIN_PATH.test(url.pathname)) || isAuthorizationRequest(url);
        } catch {
            return false;
        }
    });
}

/** Whether a browser still running when the session ends is closed: not a helper (it dies with its main process) nor a sign-in. */
export function closedAtExit(commandLine: string): boolean {
    return !HELPER_PROCESS.test(` ${commandLine}`) && !opensOnlyLogin(commandLine);
}

/** Whether a process is a browser's main process that will put a window on screen. */
export function isVisibleBrowser(image: string, commandLine: string): boolean {
    if (!isBrowserImage(image) || HELPER_PROCESS.test(` ${commandLine}`)) return false;
    return !hasHeadless(commandLine) && !opensOnlyLogin(commandLine);
}

/** The macOS app binary in a command line (`.../Google Chrome.app/Contents/MacOS/Google Chrome --x`), or its first word. */
export function commandImage(commandLine: string): string {
    const app = commandLine.match(/\.app\/Contents\/MacOS\/(.+?)(?=\s+-|$)/);
    if (app) return app[1]!;
    return commandLine.trim().split(/\s+/)[0] ?? "";
}

/** Whether the user still wants browsers headless; read at each decision so a toggle applies mid-session. */
function headlessWanted(): boolean {
    try { return readConfig().config.browserHeadless; } catch { return true; }
}

/** One line per closed browser, so a killed run can be traced afterwards. */
function record(action: string, pid: number, commandLine: string): void {
    try {
        const dir = join(enigmaHome(), ".enigma");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "browser-jail.log"), `${new Date().toISOString()} ${action} pid=${pid} ${commandLine.slice(0, 300)}\n`);
    } catch { /* the log is a convenience; the kill already happened */ }
}

/** `bun:ffi`, or null under Node (a dev run through tsx), where there is no jail. */
async function loadFfi(): Promise<typeof import("bun:ffi") | null> {
    // A variable specifier so a Node bundler never tries to resolve the Bun builtin.
    const specifier = "bun:ffi";
    try { return await import(specifier) as typeof import("bun:ffi"); } catch { return null; }
}

const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const JOB_OBJECT_MSG_NEW_PROCESS = 6;
const JOB_OBJECT_MSG_EXIT_PROCESS = 7;
const JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;
const JOB_BASIC_PROCESS_ID_LIST = 3;
const JOB_ASSOCIATE_COMPLETION_PORT = 7;
/** BREAKAWAY_OK is only accepted through the extended structure (144 bytes on 64-bit), LimitFlags at offset 16. */
const JOB_EXTENDED_LIMIT_INFORMATION = 9;
const EXTENDED_LIMIT_SIZE = 144;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
const PROCESS_COMMAND_LINE_INFORMATION = 60;
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
const STARTF_USESTDHANDLES = 0x100;
const DUPLICATE_SAME_ACCESS = 0x2;
const WAIT_OBJECT_0 = 0;
/** STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE as the unsigned values GetStdHandle takes. */
const STD_HANDLES = [0xfffffff6, 0xfffffff5, 0xfffffff4];
/** sizeof(STARTUPINFOW) on 64-bit Windows, and where its fields sit. */
const STARTUP_INFO_SIZE = 104;
const STARTUP_FLAGS = 60;
const STARTUP_STDIO = 80;
const TH32CS_SNAPPROCESS = 0x2;
/** sizeof(PROCESSENTRY32W) on 64-bit Windows, and where its fields sit. */
const PROCESS_ENTRY_SIZE = 568;
const ENTRY_PID = 8;
const ENTRY_PARENT = 32;
const ENTRY_EXE = 44;
/** How long an exited member still vouches for a process it started: a detached child is often seen after its parent is gone. */
const EXITED_MEMBER_GRACE_MS = 10_000;

/** A Windows environment block: `KEY=value\0` pairs sorted by key, ending in an empty one. */
export function environmentBlock(env: NodeJS.ProcessEnv): string {
    const pairs = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== "" && !entry[0].includes("="));
    pairs.sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
    return `${pairs.map(([k, v]) => `${k}=${v}\0`).join("")}\0`;
}

/** Quote one argument the way the C runtime splits a command line back into argv. */
export function quoteWindowsArg(arg: string): string {
    if (arg && !/[\s"]/.test(arg)) return arg;
    let quoted = "\"";
    let slashes = 0;
    for (const ch of arg) {
        if (ch === "\\") { slashes++; continue; }
        quoted += "\\".repeat(ch === "\"" ? slashes * 2 + 1 : slashes) + ch;
        slashes = 0;
    }
    return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

/** UTF-16LE, NUL-terminated, in a buffer the callee may write to (CreateProcessW edits its command line). */
function wide(text: string): Uint16Array {
    const buf = new Uint16Array(text.length + 1);
    for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i);
    return buf;
}

/**
 * The Windows jail: a job object around `root` and everything it starts, or, with no root, around
 * the agent that `spawn` creates.
 */
function windowsJail(ffi: typeof import("bun:ffi"), initialRoot: number | null): BrowserJail | null {
    let root = initialRoot ?? 0;
    const { dlopen, FFIType: T, ptr } = ffi;
    let k32: Record<string, (...args: any[]) => any>;
    let ntdll: Record<string, (...args: any[]) => any>;
    let snapshotClose: (handle: bigint | number) => number;
    let raw: Record<string, (...args: any[]) => any>;
    try {
        k32 = dlopen("kernel32.dll", {
            CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.ptr },
            CreateIoCompletionPort: { args: [T.i64, T.ptr, T.u64, T.u32], returns: T.ptr },
            SetInformationJobObject: { args: [T.ptr, T.i32, T.ptr, T.u32], returns: T.i32 },
            AssignProcessToJobObject: { args: [T.ptr, T.ptr], returns: T.i32 },
            QueryInformationJobObject: { args: [T.ptr, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
            GetQueuedCompletionStatus: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.u32], returns: T.i32 },
            OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.ptr },
            QueryFullProcessImageNameW: { args: [T.ptr, T.u32, T.ptr, T.ptr], returns: T.i32 },
            TerminateProcess: { args: [T.ptr, T.u32], returns: T.i32 },
            CloseHandle: { args: [T.ptr], returns: T.i32 },
            // The snapshot handle is INVALID_HANDLE_VALUE (-1) on failure, which a pointer type cannot carry.
            CreateToolhelp32Snapshot: { args: [T.u32, T.u32], returns: T.i64 },
            CreateProcessW: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
            ResumeThread: { args: [T.ptr], returns: T.u32 },
            WaitForSingleObject: { args: [T.ptr, T.u32], returns: T.u32 },
            GetExitCodeProcess: { args: [T.ptr, T.ptr], returns: T.i32 },
            GetLastError: { args: [], returns: T.u32 },
            Process32FirstW: { args: [T.i64, T.ptr], returns: T.i32 },
            Process32NextW: { args: [T.i64, T.ptr], returns: T.i32 },
        }).symbols;
        // Pseudo and invalid handles are -1, which a pointer type cannot carry.
        raw = dlopen("kernel32.dll", {
            CloseHandle: { args: [T.i64], returns: T.i32 },
            GetStdHandle: { args: [T.u32], returns: T.i64 },
            DuplicateHandle: { args: [T.i64, T.i64, T.i64, T.ptr, T.u32, T.i32, T.u32], returns: T.i32 },
        }).symbols;
        snapshotClose = raw.CloseHandle!;
        ntdll = dlopen("ntdll.dll", {
            NtQueryInformationProcess: { args: [T.ptr, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
        }).symbols;
    } catch {
        return null;
    }

    const job = k32.CreateJobObjectW(null, null);
    if (!job) return null;
    const port = k32.CreateIoCompletionPort(-1, null, 0n, 1);
    const association = new BigUint64Array([1n, BigInt(port ?? 0)]);
    // A process spawned `detached` asks to leave the job (libuv sets CREATE_BREAKAWAY_FROM_JOB), and a job
    // that refuses fails the spawn itself with EPERM - enigma's own background tasks and any agent tool
    // that daemonizes would break. So breakaway is allowed, and a process that left is followed by its
    // parent instead (see sweepEscaped).
    const limits = new BigUint64Array(EXTENDED_LIMIT_SIZE / 8);
    new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_BREAKAWAY_OK, true);
    /** Put a running process in the job. */
    const assign = (pid: number): boolean => {
        const target = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if (!target) return false;
        try { return !!k32.AssignProcessToJobObject(job, target); } finally { k32.CloseHandle(target); }
    };
    // The port first, so the job reports every process from the very first one.
    const ready = port && k32.SetInformationJobObject(job, JOB_ASSOCIATE_COMPLETION_PORT, ptr(association), 16)
        && k32.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.byteLength)
        && (initialRoot === null || assign(initialRoot));
    if (!ready) {
        if (port) k32.CloseHandle(port);
        k32.CloseHandle(job);
        // Said in the log: a jail that silently does not start looks exactly like one that found nothing.
        record("jail-unavailable", initialRoot ?? process.pid, "the job object could not be set up");
        return null;
    }

    const imageOf = (handle: number): string => {
        const name = new Uint16Array(1024);
        const size = new Uint32Array([name.length]);
        return k32.QueryFullProcessImageNameW(handle, 0, ptr(name), ptr(size)) ? String.fromCharCode(...name.subarray(0, size[0])) : "";
    };
    const commandLineOf = (handle: number): string => {
        const buf = new Uint8Array(65536);
        if (ntdll.NtQueryInformationProcess(handle, PROCESS_COMMAND_LINE_INFORMATION, ptr(buf), buf.byteLength, null) !== 0) return "";
        // A UNICODE_STRING (length, max length, pointer) whose text the call wrote into the same buffer.
        const view = new DataView(buf.buffer);
        const length = view.getUint16(0, true);
        const offset = Number(view.getBigUint64(8, true)) - ptr(buf);
        if (offset < 16 || offset + length > buf.byteLength) return "";
        return new TextDecoder("utf-16le").decode(buf.subarray(offset, offset + length));
    };
    /** Look at one process; terminate it when `judge` says so. */
    const inspect = (pid: number, judge: (image: string, commandLine: string) => boolean, action: string): void => {
        if (pid === process.pid || pid === root) return;
        const handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE, 0, pid);
        if (!handle) return;
        try {
            const image = imageOf(handle);
            if (!isBrowserImage(image)) return;
            const commandLine = commandLineOf(handle) || image;
            if (!judge(image, commandLine)) return;
            if (k32.TerminateProcess(handle, 1)) record(action, pid, commandLine);
        } finally {
            k32.CloseHandle(handle);
        }
    };

    const visible = (image: string, commandLine: string): boolean => isVisibleBrowser(image, commandLine) && headlessWanted();
    /** Every process of the session, in the job or escaped from it: pid -> when it stops vouching for its children. */
    const members = new Map<number, number>(initialRoot === null ? [] : [[initialRoot, Infinity]]);
    const escaped = new Set<number>();

    const message = new Uint32Array(1);
    const key = new BigUint64Array(1);
    const overlapped = new BigUint64Array(1);
    const drain = (): void => {
        while (k32.GetQueuedCompletionStatus(port, ptr(message), ptr(key), ptr(overlapped), 0)) {
            const pid = Number(overlapped[0]);
            if (message[0] === JOB_OBJECT_MSG_EXIT_PROCESS || message[0] === JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS) members.set(pid, Date.now() + EXITED_MEMBER_GRACE_MS);
            if (message[0] !== JOB_OBJECT_MSG_NEW_PROCESS) continue;
            members.set(pid, Infinity);
            inspect(pid, visible, "closed-visible");
        }
    };
    /** Processes that broke away from the job: found by a parent that belongs to the session. */
    const sweepEscaped = (): void => {
        const snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot === -1n || snapshot === -1) return;
        try {
            const entry = new Uint8Array(PROCESS_ENTRY_SIZE);
            const view = new DataView(entry.buffer);
            view.setUint32(0, PROCESS_ENTRY_SIZE, true);
            const now = Date.now();
            const seen = new Set<number>();
            for (let ok = k32.Process32FirstW(snapshot, ptr(entry)); ok; ok = k32.Process32NextW(snapshot, ptr(entry))) {
                const pid = view.getUint32(ENTRY_PID, true);
                const parent = view.getUint32(ENTRY_PARENT, true);
                seen.add(pid);
                if (members.has(pid) || (members.get(parent) ?? 0) < now) continue;
                members.set(pid, Infinity);
                escaped.add(pid);
                const name = new Uint16Array(entry.buffer, ENTRY_EXE, 260);
                const exe = String.fromCharCode(...name.subarray(0, Math.max(0, name.indexOf(0))));
                if (isBrowserImage(exe)) inspect(pid, visible, "closed-visible");
            }
            for (const [pid, until] of members) if (pid !== root && (until < now || (escaped.has(pid) && !seen.has(pid)))) { members.delete(pid); escaped.delete(pid); }
        } finally {
            snapshotClose(snapshot);
        }
    };
    let ticks = 0;
    // Unref: the watch never keeps a process alive on its own. The job's port every 15 ms (a new
    // process is caught before it draws), the escaped ones every ~120 ms (a snapshot costs more).
    const timer = setInterval(() => {
        drain();
        if (++ticks % 8 === 0) sweepEscaped();
    }, 15);
    timer.unref?.();

    /** Duplicate one of this process's standard handles as inheritable, or 0 when it has none. */
    const inheritable = (which: number): bigint => {
        const handle = raw.GetStdHandle!(which) as bigint;
        if (!handle || handle === -1n) return 0n;
        const copy = new BigUint64Array(1);
        return raw.DuplicateHandle!(-1n, handle, -1n, ptr(copy), 0, 1, DUPLICATE_SAME_ACCESS) ? copy[0]! : 0n;
    };
    /** Create the agent suspended, outside any job that lets it leave, put it in this one, then let it run. */
    const spawnInJob = (commandLine: string, env: NodeJS.ProcessEnv): Promise<number> | null => {
        const stdio = STD_HANDLES.map(inheritable);
        const startup = new Uint8Array(STARTUP_INFO_SIZE);
        const view = new DataView(startup.buffer);
        view.setUint32(0, STARTUP_INFO_SIZE, true);
        view.setUint32(STARTUP_FLAGS, STARTF_USESTDHANDLES, true);
        stdio.forEach((handle, i) => view.setBigUint64(STARTUP_STDIO + i * 8, handle, true));
        const info = new BigUint64Array(3);
        const block = wide(environmentBlock(env));
        const create = (flags: number): boolean => !!k32.CreateProcessW(null, ptr(wide(commandLine)), null, null, 1, flags, ptr(block), null, ptr(startup), ptr(info));
        const flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        // Breakaway leaves a job this process is in when that job allows it; one that does not
        // refuses the flag, and the agent is then created inside it, this job nested under that one.
        const created = create(flags | CREATE_BREAKAWAY_FROM_JOB) || create(flags);
        const error = created ? 0 : k32.GetLastError();
        for (const handle of stdio) if (handle) raw.CloseHandle!(handle);
        if (!created) {
            record("jail-spawn-failed", process.pid, `CreateProcessW error ${error}`);
            // The jail still holds the session through this process; the caller spawns as usual.
            if (assign(process.pid)) members.set(process.pid, Infinity);
            return null;
        }
        const handle = Number(info[0]);
        const thread = Number(info[1]);
        root = new Uint32Array(info.buffer, 16, 1)[0]!;
        members.set(root, Infinity);
        if (!k32.AssignProcessToJobObject(job, handle)) record("jail-unavailable", root, "the agent could not be put in the job");
        k32.ResumeThread(thread);
        k32.CloseHandle(thread);

        // As spawnInherit: a termination signal to the launcher ends the agent.
        const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
        const forward = (): void => { k32.TerminateProcess(handle, 1); };
        for (const sig of signals) process.on(sig, forward);
        return new Promise<number>((resolve) => {
            const wait = setInterval(() => {
                if (k32.WaitForSingleObject(handle, 0) !== WAIT_OBJECT_0) return;
                clearInterval(wait);
                for (const sig of signals) process.off(sig, forward);
                const code = new Uint32Array(1);
                k32.GetExitCodeProcess(handle, ptr(code));
                k32.CloseHandle(handle);
                resolve(code[0]! | 0);
            }, 50);
        });
    };

    return {
        ...(initialRoot === null ? { spawn: spawnInJob } : {}),
        async close(): Promise<void> {
            clearInterval(timer);
            drain();
            sweepEscaped();
            const leftBehind = (_: string, commandLine: string): boolean => closedAtExit(commandLine);
            const list = new BigUint64Array(1 + 4096);
            if (k32.QueryInformationJobObject(job, JOB_BASIC_PROCESS_ID_LIST, ptr(list), list.byteLength, null)) {
                const count = new Uint32Array(list.buffer, 0, 2)[1]!;
                for (const pid of list.subarray(1, 1 + count)) inspect(Number(pid), leftBehind, "closed-at-exit");
            }
            for (const pid of escaped) inspect(pid, leftBehind, "closed-at-exit");
            k32.CloseHandle(port);
            k32.CloseHandle(job);
        },
    };
}

/** One `ps` row: pid, parent pid, state (`Z...` for a zombie), full command line. */
export interface PsRow {
    pid: number;
    ppid: number;
    stat: string;
    args: string;
}

/** Parse `ps -o pid=,ppid=,stat=,args=`. */
export function parsePsTree(out: string): PsRow[] {
    const rows: PsRow[] = [];
    for (const line of out.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3]!, args: match[4]!.trim() });
    }
    return rows;
}

/** The descendants of `roots` in a process listing, the roots themselves left out. */
export function descendantsOf(roots: number | Iterable<number>, rows: PsRow[]): PsRow[] {
    const children = new Map<number, PsRow[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const seen = new Set<number>(typeof roots === "number" ? [roots] : roots);
    const queue = [...seen];
    const found: PsRow[] = [];
    while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
            if (seen.has(child.pid)) continue;
            seen.add(child.pid);
            found.push(child);
            queue.push(child.pid);
        }
    }
    return found;
}

/** Every process on the machine, or null when `ps` fails. Asynchronous: the gate daemon runs a jail per child it spawns. */
function listProcesses(): Promise<PsRow[] | null> {
    return new Promise((resolve) => {
        execFile("ps", ["-A", "-o", "pid=,ppid=,stat=,args="], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? null : parsePsTree(stdout));
        });
    });
}

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;

/**
 * The Linux/macOS jail: poll the descendants of `root`. A process once seen in the tree is
 * followed after its parent exits, so the gate's jail (rooted at a child, not at this process)
 * still finds what the agent left behind once the agent itself is gone.
 */
function posixJail(ffi: typeof import("bun:ffi") | null, root: number): BrowserJail {
    let reap: ((pid: number) => void) | null = null;
    if (process.platform === "linux" && ffi && root === process.pid) {
        // An orphaned descendant is re-parented here, so it stays in the tree. The runtime waits only
        // for what it spawned, so an adopted process that exits would stay a zombie unless reaped here.
        try {
            const { FFIType: T } = ffi;
            const libc = ffi.dlopen("libc.so.6", {
                prctl: { args: [T.i32, T.u64, T.u64, T.u64, T.u64], returns: T.i32 },
                waitpid: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
            }).symbols;
            if (libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) === 0) reap = (pid) => { libc.waitpid(pid, null, WNOHANG); };
        } catch { /* polling still sees direct descendants */ }
    }
    /** Every process of the session seen so far: its command line, and its parent when first seen. */
    const known = new Map<number, { args: string; parent: number; }>();
    const sweep = async (judge: (image: string, commandLine: string) => boolean, action: string): Promise<void> => {
        const rows = await listProcesses();
        if (!rows) return;
        const byPid = new Map(rows.map((row) => [row.pid, row]));
        for (const [pid, seen] of known) {
            const row = byPid.get(pid);
            // Gone, or the pid now belongs to another program.
            if (!row || (!row.stat.startsWith("Z") && row.args !== seen.args)) known.delete(pid);
        }
        const tree = descendantsOf([root, ...known.keys()], rows);
        for (const pid of known.keys()) tree.push(byPid.get(pid)!);
        for (const row of tree) {
            if (!known.has(row.pid)) known.set(row.pid, { args: row.args, parent: row.ppid });
            if (row.stat.startsWith("Z")) {
                // Only one adopted after its parent exited: what this process spawned is the runtime's to wait for.
                if (reap && row.ppid === process.pid && known.get(row.pid)!.parent !== process.pid) {
                    reap(row.pid);
                    known.delete(row.pid);
                }
                continue;
            }
            const image = commandImage(row.args);
            if (!isBrowserImage(image) || !judge(image, row.args)) continue;
            try { process.kill(row.pid, "SIGTERM"); record(action, row.pid, row.args); } catch { /* already gone */ }
        }
    };
    let running: Promise<void> | null = null;
    const timer = setInterval(() => {
        if (running) return;
        running = sweep((image, commandLine) => isVisibleBrowser(image, commandLine) && headlessWanted(), "closed-visible").finally(() => { running = null; });
    }, 300);
    timer.unref?.();
    return {
        async close(): Promise<void> {
            clearInterval(timer);
            await running;
            await sweep((_, commandLine) => closedAtExit(commandLine), "closed-at-exit");
        },
    };
}

/**
 * Start the jail around `root`: this process, before it spawns the agent (so nothing the agent
 * starts escapes it), or a child that is already running (the gate's agents, whose daemon cannot
 * jail itself). Null when headless is off or the platform gives no hold on the process tree (a
 * Node dev run on Windows). An interactive agent launch uses startAgentBrowserJail instead.
 */
export async function startBrowserJail(root: number = process.pid): Promise<BrowserJail | null> {
    if (!headlessWanted()) return null;
    const ffi = await loadFfi();
    if (process.platform === "win32") return ffi ? windowsJail(ffi, root) : null;
    return posixJail(ffi, root);
}

/**
 * Start the jail for an agent this process is about to launch. On Windows the agent is created by
 * the jail's `spawn`, so the job is not nested under the one libuv keeps this process in: that one
 * kills its members when the npm launcher exits, which would end every daemon the session started.
 */
export async function startAgentBrowserJail(): Promise<BrowserJail | null> {
    if (!headlessWanted()) return null;
    const ffi = await loadFfi();
    if (process.platform === "win32") return ffi ? windowsJail(ffi, null) : null;
    return posixJail(ffi, process.pid);
}

/**
 * What a dev server or a test reporter reads before opening a browser by itself: BROWSER=none
 * for Vite and Create React App, PLAYWRIGHT_HTML_OPEN=never for Playwright's HTML report (it
 * overrides the config's `open`). Set on the agent's environment when browsers are headless.
 */
export function applyAgentBrowserEnv(env: NodeJS.ProcessEnv): void {
    if (!headlessWanted()) return;
    env.BROWSER = "none";
    env.PLAYWRIGHT_HTML_OPEN = "never";
}
