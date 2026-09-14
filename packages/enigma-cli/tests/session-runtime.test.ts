/**
 * Warm session runtime (src/session-runtime.ts) against a stand-in `claude` binary.
 *
 * The real CLI is not needed to pin down the lifecycle: the runtime spawns whatever `spec.binary`
 * names, so a small stub that records its argv and speaks stream-json back makes every invariant
 * deterministic in CI - the launch flags, the resume decision, turn serialization, the turn
 * timeout, idle sweeping and the context binding. Only the model's own behavior needs the real
 * thing, and that is what the manual e2e in local-api-server.md covers.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { runSessionTurn, isSessionBusy, liveSessionCount, closeAllSessions, SessionError, type SessionSpec, type SessionRuntimeConfig } from "../src/session-runtime";

/**
 * The stand-in agent: appends its argv to one file and every stdin turn to another, then answers
 * each turn with an `assistant` + `result` pair and stays alive for the next one (a warm process).
 * `STUB_MODE=hang` reads turns and never answers; `die` exits before reading anything.
 */
const STUB = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.STUB_MODE || "reply";
if (process.env.STUB_ARGV_FILE) appendFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(args) + "\\n");
if (mode === "die") process.exit(7);
const at = args.indexOf("--session-id") !== -1 ? args.indexOf("--session-id") : args.indexOf("--resume");
const id = at !== -1 ? args[at + 1] : "";
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (process.env.STUB_STDIN_FILE) appendFileSync(process.env.STUB_STDIN_FILE, line + "\\n");
        if (mode === "hang") continue;
        process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: id, usage: { input_tokens: 11, output_tokens: 3 } }) + "\\n");
    }
});
process.stdin.resume();
`;

let dir = "";
let shim = "";
let argvLog = "";
let stdinLog = "";

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "enigma-session-"));
    const script = join(dir, "fake-claude.mjs");
    writeFileSync(script, STUB);
    // The runtime spawns one executable with the agent's own args, so the stub needs a launcher of
    // its own: a .cmd through the shell on Windows (what a non-.exe launcher gets there), else an
    // executable shell script.
    if (process.platform === "win32") {
        shim = join(dir, "fake-claude.cmd");
        writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
        shim = join(dir, "fake-claude.sh");
        writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
        chmodSync(shim, 0o755);
    }
    argvLog = join(dir, "argv.log");
    stdinLog = join(dir, "stdin.log");
});

afterEach(() => {
    closeAllSessions();
});

function spec(over: Partial<SessionSpec> = {}, mode = "reply"): SessionSpec {
    return {
        binary: shim,
        env: { ...process.env, STUB_MODE: mode, STUB_ARGV_FILE: argvLog, STUB_STDIN_FILE: stdinLog },
        model: null,
        system: null,
        enableTools: false,
        contextKey: "ctx-a",
        useShell: process.platform === "win32",
        ...over,
    };
}

function cfg(over: Partial<SessionRuntimeConfig> = {}): SessionRuntimeConfig {
    return { idleTtlMs: 15 * 60 * 1000, maxSessions: 8, turnTimeoutMs: 5000, ...over };
}

/** Every spawn's argv, in order. The log is per-test: it is truncated before each launch. */
function launches(): string[][] {
    if (!existsSync(argvLog)) return [];
    return readFileSync(argvLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[]);
}

function reset(): void {
    for (const f of [argvLog, stdinLog]) rmSync(f, { force: true });
}

/** The value a flag was given, or null when the flag is absent. */
function flag(args: string[], name: string): string | null {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] ?? "");
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a turn passes --permission-mode, so a session never stalls on a prompt nothing can answer", async () => {
    reset();
    const id = randomUUID();
    const result = await runSessionTurn(spec(), id, { prompt: "hello" }, undefined, cfg());
    expect(result.text).toBe("ok");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(3);

    const args = launches()[0]!;
    // Tools off is a permission posture, and MCP is skipped - exactly the stateless adapter's flags.
    expect(flag(args, "--permission-mode")).toBe("default");
    expect(args).toContain("--strict-mcp-config");
    // A brand-new id claims itself; it is not resumed.
    expect(flag(args, "--session-id")).toBe(id);
    expect(args).not.toContain("--resume");
});

test("tools on keeps the user's MCP servers and still pins a permission mode", async () => {
    reset();
    await runSessionTurn(spec({ enableTools: true }), randomUUID(), { prompt: "hello" }, undefined, cfg());
    const args = launches()[0]!;
    expect(["default", "bypassPermissions"]).toContain(flag(args, "--permission-mode"));
    expect(args).not.toContain("--strict-mcp-config");
});

test("a turn's images reach the agent instead of being dropped", async () => {
    reset();
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAAA" } };
    await runSessionTurn(spec(), randomUUID(), { prompt: "what is this", images: [image] }, undefined, cfg());
    const sent = JSON.parse(readFileSync(stdinLog, "utf8").split("\n")[0]!) as { message: { content: unknown[]; }; };
    expect(sent.message.content).toEqual([{ type: "text", text: "what is this" }, image]);
});

test("a session whose process is gone respawns with --resume, continuing the transcript", async () => {
    reset();
    const id = randomUUID();
    await runSessionTurn(spec(), id, { prompt: "one" }, undefined, cfg());
    // Eviction/shutdown kills the process and forgets the live entry; the transcript survives on disk.
    closeAllSessions();
    expect(liveSessionCount()).toBe(0);

    await runSessionTurn(spec(), id, { prompt: "two" }, undefined, cfg());
    const second = launches()[1]!;
    expect(flag(second, "--resume")).toBe(id);
    expect(second).not.toContain("--session-id");
});

test("a wedged turn times out, releases the session and lets the next turn recover it", async () => {
    reset();
    const id = randomUUID();
    const err = await runSessionTurn(spec({}, "hang"), id, { prompt: "hello" }, undefined, cfg({ turnTimeoutMs: 300 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe("timeout");
    // The session is not left pinned busy, and its process is not left resident.
    expect(isSessionBusy(id)).toBe(false);
    expect(liveSessionCount()).toBe(0);

    const recovered = await runSessionTurn(spec(), id, { prompt: "again" }, undefined, cfg());
    expect(recovered.text).toBe("ok");
    expect(flag(launches()[1]!, "--resume")).toBe(id);
});

test("a second concurrent turn on the same session is refused, not interleaved", async () => {
    reset();
    const id = randomUUID();
    // The wedged turn ends in a timeout; its handler is attached now so a failing assertion below
    // can never turn it into an unhandled rejection charged to whatever test runs next.
    const first = runSessionTurn(spec({}, "hang"), id, { prompt: "one" }, undefined, cfg({ turnTimeoutMs: 400 }));
    const firstSettled = first.then(() => "answered", () => "timed out");
    await wait(50);
    expect(isSessionBusy(id)).toBe(true);

    const err = await runSessionTurn(spec(), id, { prompt: "two" }, undefined, cfg()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe("busy");

    // Counted only once the first turn is over: the stub records its argv on startup, and a spawn
    // through the shell is not instant.
    expect(await firstSettled).toBe("timed out");
    expect(launches().length).toBe(1);
});

test("a session id is bound to one isolation context, so another account cannot resume it", async () => {
    reset();
    const id = randomUUID();
    await runSessionTurn(spec({ contextKey: "ctx-a" }), id, { prompt: "one" }, undefined, cfg());
    closeAllSessions();

    const err = await runSessionTurn(spec({ contextKey: "ctx-b" }), id, { prompt: "two" }, undefined, cfg()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe("context-mismatch");
    // Nothing was spawned under the wrong context.
    expect(launches().length).toBe(1);
});

test("an idle session is swept without another session having to be created", async () => {
    reset();
    await runSessionTurn(spec(), randomUUID(), { prompt: "hello" }, undefined, cfg({ idleTtlMs: 50 }));
    expect(liveSessionCount()).toBe(1);
    // No further turn and no new session: the sweep timer has to be what reaps it.
    await wait(1600);
    expect(liveSessionCount()).toBe(0);
}, 10_000);

test("a replaced session's late exit does not delete its successor", async () => {
    reset();
    const id = randomUUID();
    await runSessionTurn(spec(), id, { prompt: "one" }, undefined, cfg());
    // Kill and immediately respawn the same id: the dead child's close event lands afterwards, and
    // must not take the successor's entry (and its live process) with it.
    closeAllSessions();
    const second = runSessionTurn(spec(), id, { prompt: "two" }, undefined, cfg());
    expect(await second.then((r) => r.text)).toBe("ok");
    await wait(250);
    expect(liveSessionCount()).toBe(1);

    // The successor is still the warm process: a third turn reuses it rather than spawning again.
    await runSessionTurn(spec(), id, { prompt: "three" }, undefined, cfg());
    expect(launches().length).toBe(2);
});
