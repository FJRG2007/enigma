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
 * Windows: the launcher puts ITSELF in a job object before it spawns the agent. Job membership is
 * inherited and survives the parent's exit, so every process the session creates is in it - also
 * one started through `start`, `Start-Process` or ShellExecute, whose parent is gone by the time
 * anyone looks. The job reports each new process on an I/O completion port, which is drained
 * every 15 ms; a browser main process without a headless flag is terminated on sight, before it
 * has drawn a window and, measured, before a console child printed its first line. When the
 * agent exits, every browser still in the job is closed, headless ones included.
 *
 * Linux and macOS: the launcher polls `ps` for its own descendants (on Linux it also becomes the
 * subreaper, so an orphaned browser is re-parented to it instead of to init). macOS `open` starts
 * an app through launchd, outside the tree: the command guard is the only stop for that one.
 *
 * What this cannot stop: a URL handed to a browser the user already has open. The new process
 * only passes the URL to the running one and exits; it is killed if it is caught in time, and
 * otherwise the tab opens in the user's window. The command guard and BROWSER=none (which Vite
 * and Create React App honor) are what cover that case.
 *
 * A sign-in page an agent opens for its own login (Claude's /login, `codex login`) is let through:
 * it is the user's action, and its URL names the vendor's authorize endpoint.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { readConfig } from "./config";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { BROWSER_EXE, hasHeadless, programName } from "./browser-guard";

/** A running jail; `close` stops watching and closes every browser the session left behind. */
export interface BrowserJail {
    close(): void;
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

/** Whether every URL in a command line is a vendor sign-in page (and there is at least one). */
export function opensOnlyLogin(commandLine: string): boolean {
    const urls = commandLine.match(/https?:\/\/[^\s"']+/gi) ?? [];
    if (!urls.length) return false;
    return urls.every((raw) => {
        try {
            const url = new URL(raw);
            return LOGIN_HOST.test(url.hostname) && LOGIN_PATH.test(url.pathname);
        } catch {
            return false;
        }
    });
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
const TH32CS_SNAPPROCESS = 0x2;
/** sizeof(PROCESSENTRY32W) on 64-bit Windows, and where its fields sit. */
const PROCESS_ENTRY_SIZE = 568;
const ENTRY_PID = 8;
const ENTRY_PARENT = 32;
const ENTRY_EXE = 44;
/** How long an exited member still vouches for a process it started: a detached child is often seen after its parent is gone. */
const EXITED_MEMBER_GRACE_MS = 10_000;

/** The Windows jail: a job object around `root` and everything it starts. */
function windowsJail(ffi: typeof import("bun:ffi"), root: number): BrowserJail | null {
    const { dlopen, FFIType: T, ptr } = ffi;
    let k32: Record<string, (...args: any[]) => any>;
    let ntdll: Record<string, (...args: any[]) => any>;
    let snapshotClose: (handle: bigint | number) => number;
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
            Process32FirstW: { args: [T.i64, T.ptr], returns: T.i32 },
            Process32NextW: { args: [T.i64, T.ptr], returns: T.i32 },
        }).symbols;
        snapshotClose = dlopen("kernel32.dll", { CloseHandle: { args: [T.i64], returns: T.i32 } }).symbols.CloseHandle;
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
    const target = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, root);
    // The port first, so the job reports every process from the very first one.
    const ready = port && k32.SetInformationJobObject(job, JOB_ASSOCIATE_COMPLETION_PORT, ptr(association), 16)
        && k32.SetInformationJobObject(job, JOB_EXTENDED_LIMIT_INFORMATION, ptr(limits), limits.byteLength)
        && target && k32.AssignProcessToJobObject(job, target);
    if (target) k32.CloseHandle(target);
    if (!ready) {
        if (port) k32.CloseHandle(port);
        k32.CloseHandle(job);
        // Said in the log: a jail that silently does not start looks exactly like one that found nothing.
        record("jail-unavailable", root, "the job object could not be set up");
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
    const members = new Map<number, number>([[root, Infinity]]);
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

    return {
        close(): void {
            clearInterval(timer);
            drain();
            sweepEscaped();
            const list = new BigUint64Array(1 + 4096);
            if (k32.QueryInformationJobObject(job, JOB_BASIC_PROCESS_ID_LIST, ptr(list), list.byteLength, null)) {
                const count = new Uint32Array(list.buffer, 0, 2)[1]!;
                for (const pid of list.subarray(1, 1 + count)) inspect(Number(pid), () => true, "closed-at-exit");
            }
            for (const pid of escaped) inspect(pid, () => true, "closed-at-exit");
            k32.CloseHandle(port);
            k32.CloseHandle(job);
        },
    };
}

/** One `ps` row: pid, parent pid, full command line. */
export function parsePsTree(out: string): Array<{ pid: number; ppid: number; args: string; }> {
    const rows: Array<{ pid: number; ppid: number; args: string; }> = [];
    for (const line of out.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]!.trim() });
    }
    return rows;
}

/** The descendants of `root` in a process listing. */
export function descendantsOf(root: number, rows: Array<{ pid: number; ppid: number; args: string; }>): Array<{ pid: number; ppid: number; args: string; }> {
    const children = new Map<number, Array<{ pid: number; ppid: number; args: string; }>>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const found: Array<{ pid: number; ppid: number; args: string; }> = [];
    const queue = [root];
    while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
            if (child.pid === root || found.includes(child)) continue;
            found.push(child);
            queue.push(child.pid);
        }
    }
    return found;
}

/** The Linux/macOS jail: poll the descendants of `root`. */
function posixJail(ffi: typeof import("bun:ffi") | null, root: number): BrowserJail {
    if (process.platform === "linux" && ffi && root === process.pid) {
        // PR_SET_CHILD_SUBREAPER: an orphaned descendant is re-parented here, so it stays in the tree.
        try { ffi.dlopen("libc.so.6", { prctl: { args: [ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.u64, ffi.FFIType.u64], returns: ffi.FFIType.i32 } }).symbols.prctl(36, 1, 0, 0, 0); } catch { /* polling still sees direct descendants */ }
    }
    const sweep = (judge: (image: string, commandLine: string) => boolean, action: string): void => {
        const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", windowsHide: true });
        if (ps.status !== 0) return;
        for (const row of descendantsOf(root, parsePsTree(ps.stdout))) {
            const image = commandImage(row.args);
            if (!isBrowserImage(image) || !judge(image, row.args)) continue;
            try { process.kill(row.pid, "SIGTERM"); record(action, row.pid, row.args); } catch { /* already gone */ }
        }
    };
    const timer = setInterval(() => sweep((image, commandLine) => isVisibleBrowser(image, commandLine) && headlessWanted(), "closed-visible"), 300);
    timer.unref?.();
    return {
        close(): void {
            clearInterval(timer);
            sweep((image, commandLine) => !HELPER_PROCESS.test(` ${commandLine}`), "closed-at-exit");
        },
    };
}

/**
 * Start the jail around `root`: this process, before it spawns the agent (so nothing the agent
 * starts escapes it), or a child that is already running (the gate's agents, whose daemon cannot
 * jail itself). Null when headless is off or the platform gives no hold on the process tree (a
 * Node dev run on Windows).
 */
export async function startBrowserJail(root: number = process.pid): Promise<BrowserJail | null> {
    if (!headlessWanted()) return null;
    const ffi = await loadFfi();
    if (process.platform === "win32") return ffi ? windowsJail(ffi, root) : null;
    return posixJail(ffi, root);
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
