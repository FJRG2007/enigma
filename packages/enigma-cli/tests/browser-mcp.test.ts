import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { browserServerCommand, startBrowserProxy } from "../src/browser-mcp";

// A stand-in for chrome-devtools-mcp: answers every request with the method it saw, and logs
// each message it receives so a test can check what a restarted server was sent.
const FAKE_SERVER = `
const fs = require("node:fs");
const log = process.argv[2];
let buf = "";
process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        fs.appendFileSync(log, line + "\\n");
        const m = JSON.parse(line);
        if (m.method === "hang") continue;
        if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { method: m.method, pid: process.pid } }) + "\\n");
    }
});
`;

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(idleMs: number) {
    const dir = mkdtempSync(join(tmpdir(), "browser-mcp-"));
    dirs.push(dir);
    const script = join(dir, "server.cjs");
    const log = join(dir, "log.jsonl");
    writeFileSync(script, FAKE_SERVER);
    writeFileSync(log, "");
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
            replies.push(JSON.parse(buffer.slice(0, i)));
            buffer = buffer.slice(i + 1);
        }
    });
    let closed = false;
    const proxy = startBrowserProxy({ command: process.execPath, args: [script, log], idleMs, input, output, onClose: () => { closed = true; } });
    closers.push(proxy.close);
    const sent = (): Record<string, unknown>[] => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const write = (message: Record<string, unknown>): void => { input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
    return { proxy, input, replies, sent, write, isClosed: () => closed };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
    }
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test("the server always gets the configured flags, never the entry's", () => {
    expect(browserServerCommand(true, "linux")).toEqual({ command: "npx", args: ["-y", "chrome-devtools-mcp@1.10.1", "--isolated", "--no-usage-statistics", "--no-performance-crux", "--headless"] });
    expect(browserServerCommand(false, "linux").args).not.toContain("--headless");
    expect(browserServerCommand(true, "win32")).toEqual({ command: "cmd", args: ["/c", "npx", ...browserServerCommand(true, "linux").args] });
});

// An idle browser is closed, and the next call reaches a fresh server that was handed the
// agent's handshake first - the agent itself sees only the answer to its own call.
test("an idle server is killed and transparently restarted with the handshake replayed", async () => {
    const t = setup(300);
    t.write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    t.write({ method: "notifications/initialized" });
    t.write({ id: 2, method: "tools/list" });
    await until(() => t.replies.length === 2);
    const firstPid = (t.replies[1]!.result as { pid: number; }).pid;

    await until(() => t.proxy.child() === null && !alive(firstPid));

    t.write({ id: 3, method: "tools/call", params: { name: "take_screenshot" } });
    await until(() => t.replies.length === 3);
    expect(t.replies[2]).toMatchObject({ id: 3, result: { method: "tools/call" } });
    expect((t.replies[2]!.result as { pid: number; }).pid).not.toBe(firstPid);
    expect(t.replies.some((r) => r.id === "enigma-browser-reinit")).toBe(false);

    const methods = t.sent().map((m) => m.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "initialize", "notifications/initialized", "tools/call"]);
    expect(t.sent()[3]).toMatchObject({ id: "enigma-browser-reinit", params: { protocolVersion: "2025-06-18" } });
});

// A call still running is not idleness: the timer waits for it.
test("an outstanding call keeps the server alive past the idle limit", async () => {
    const t = setup(200);
    t.write({ id: 1, method: "initialize" });
    await until(() => t.replies.length === 1);
    const pid = (t.replies[0]!.result as { pid: number; }).pid;
    t.write({ id: 2, method: "hang" });
    await new Promise((r) => setTimeout(r, 700));
    expect(alive(pid)).toBe(true);
    expect(t.proxy.child()).not.toBeNull();
});

// The agent going away takes the server (and so Chrome) with it.
test("closing the agent's stdin kills the server", async () => {
    const t = setup(60_000);
    t.write({ id: 1, method: "initialize" });
    await until(() => t.replies.length === 1);
    const pid = (t.replies[0]!.result as { pid: number; }).pid;
    t.input.end();
    await until(() => t.isClosed() && !alive(pid));
});

// A server that dies under a call answers it with an error instead of leaving the agent waiting.
test("a call outstanding when the server dies gets an error reply", async () => {
    const t = setup(60_000);
    t.write({ id: 1, method: "initialize" });
    await until(() => t.replies.length === 1);
    t.write({ id: 7, method: "hang" });
    await until(() => t.sent().some((m) => m.id === 7));
    t.proxy.child()!.kill("SIGKILL");
    await until(() => t.replies.length === 2);
    expect(t.replies[1]).toMatchObject({ id: 7, error: { code: -32603 } });
});
