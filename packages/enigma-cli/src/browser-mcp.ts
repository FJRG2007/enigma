/**
 * `enigma __browser-mcp`: the launcher every agent's Chrome DevTools MCP entry points at, sitting
 * between the agent and `chrome-devtools-mcp` as a stdio proxy.
 *
 * The server alone left two things to the agent config and the agent's goodwill: whether Chrome
 * opens a window (a `--headless` flag in an entry some other writer can revert) and when Chrome
 * closes (only when the agent session ends, and on Windows not even then: the `cmd /c npx` chain
 * orphans the browser). The launcher owns both:
 *
 * - The server's flags come from enigma's config when the server starts, never from the entry,
 *   so a stale or reverted entry still launches the configured (headless) browser.
 * - After `BROWSER_IDLE_MS` without traffic the whole server tree, Chrome included, is killed.
 *   The next request starts a fresh server and replays the agent's `initialize` handshake to it
 *   first, so the agent sees no difference beyond the server's "reconnected" note.
 * - When the agent goes away (stdin closes, or a termination signal) the tree is killed with it.
 *
 * Messages are newline-delimited JSON-RPC, as the MCP stdio transport specifies.
 */

import { readConfig } from "./config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/** Pinned server package; bumping it is a deliberate, reviewed change. */
export const BROWSER_MCP_PACKAGE = "chrome-devtools-mcp@1.10.1";

/** How long the browser may sit unused before its process tree is closed. */
export const BROWSER_IDLE_MS = 5 * 60_000;

/** Request id of the replayed handshake; its response is the launcher's and never forwarded. */
const REINIT_ID = "enigma-browser-reinit";

/**
 * Arguments for `npx`. `--isolated` runs a throwaway profile, never the user's own cookies and
 * logins; usage statistics and the CrUX lookup (which sends trace URLs to Google) are off.
 * `--headless` keeps an agent's testing off the user's screen unless they turned it off to watch.
 */
export function browserServerArgs(headless: boolean): string[] {
    const args = ["-y", BROWSER_MCP_PACKAGE, "--isolated", "--no-usage-statistics", "--no-performance-crux"];
    return headless ? [...args, "--headless"] : args;
}

/** How the launcher starts the server: `npx` is a `.cmd` shim on Windows, which needs `cmd /c`. */
export function browserServerCommand(headless: boolean, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; } {
    const args = browserServerArgs(headless);
    return platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

/**
 * Kill a process and everything it started. On Windows `taskkill /T` walks the tree, Chrome
 * included. Elsewhere the server leads its own process group; Chrome is detached from it by
 * puppeteer, whose SIGTERM handler closes the browser, so the group gets SIGTERM, not SIGKILL.
 */
function killTree(child: ChildProcess): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
    }
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

/** Split a byte stream into lines, calling `onLine` for each complete, non-empty one. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
    let buffer = "";
    return (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            if (line.trim()) onLine(line);
            newline = buffer.indexOf("\n");
        }
    };
}

type Message = { id?: unknown; method?: unknown; result?: unknown; error?: unknown; };

function parse(line: string): Message | null {
    try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? value as Message : null;
    } catch {
        return null;
    }
}

export interface BrowserProxyOptions {
    command: string;
    args: string[];
    idleMs: number;
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    /** Called once the proxy has shut down (agent gone); the CLI exits the process here. */
    onClose?: () => void;
}

/**
 * Run the proxy until `input` ends. Returns a handle tests use to observe the current server;
 * the CLI ignores it.
 */
export function startBrowserProxy(opts: BrowserProxyOptions): { child: () => ChildProcess | null; close: () => void; } {
    let child: ChildProcess | null = null;
    let ready = false;
    let closed = false;
    let initialize: string | null = null;
    let initialized: string | null = null;
    let queue: string[] = [];
    // Requests the agent is waiting on, by JSON id. A server that dies with one outstanding
    // answers it here with an error, so the agent is never left hanging on a dead process.
    const pending = new Map<string, unknown>();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (line: string): void => { opts.output.write(`${line}\n`); };

    const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (!child) return;
            // A long call (a performance trace, a Lighthouse audit) is not idleness.
            if (pending.size > 0) return armIdle();
            const idle = child;
            child = null;
            ready = false;
            killTree(idle);
        }, opts.idleMs);
        idleTimer.unref?.();
    };

    const failPending = (): void => {
        for (const id of pending.values()) {
            send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "The browser server exited; retry the call." } }));
        }
        pending.clear();
    };

    const startServer = (replay: boolean): void => {
        const proc = spawn(opts.command, opts.args, {
            stdio: ["pipe", "pipe", "inherit"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        child = proc;
        ready = !replay || initialize === null;
        proc.stdout?.on("data", lineReader((line) => {
            const message = parse(line);
            if (!ready && message?.id === REINIT_ID) {
                if (initialized) proc.stdin?.write(`${initialized}\n`);
                ready = true;
                for (const queued of queue) proc.stdin?.write(`${queued}\n`);
                queue = [];
                return;
            }
            if (message && message.method === undefined && message.id !== undefined) pending.delete(JSON.stringify(message.id));
            armIdle();
            send(line);
        }));
        proc.on("error", () => { /* reported through exit */ });
        proc.on("exit", () => {
            if (child !== proc) return; // an idle kill already detached it
            child = null;
            ready = false;
            queue = [];
            failPending();
        });
        if (replay && initialize !== null) {
            const message = parse(initialize) ?? {};
            proc.stdin?.write(`${JSON.stringify({ ...message, id: REINIT_ID })}\n`);
        }
    };

    const close = (): void => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        const current = child;
        child = null;
        if (current) killTree(current);
        opts.onClose?.();
    };

    opts.input.on("data", lineReader((line) => {
        if (closed) return;
        const message = parse(line);
        if (message?.method === "initialize") initialize = line;
        else if (message?.method === "notifications/initialized") initialized = line;
        if (message && typeof message.method === "string" && message.id !== undefined) pending.set(JSON.stringify(message.id), message.id);
        armIdle();
        if (!child) startServer(true);
        if (ready) child?.stdin?.write(`${line}\n`);
        else queue.push(line);
    }));
    opts.input.on("end", close);
    opts.input.on("close", close);

    startServer(false);
    armIdle();
    return { child: () => child, close };
}

/** CLI entry: proxy the agent's stdio to a server launched with the configured flags. */
export function runBrowserMcp(): void {
    const { command, args } = browserServerCommand(readConfig().config.browserHeadless);
    const proxy = startBrowserProxy({
        command,
        args,
        idleMs: BROWSER_IDLE_MS,
        input: process.stdin,
        output: process.stdout,
        onClose: () => process.exit(0),
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, proxy.close);
}
