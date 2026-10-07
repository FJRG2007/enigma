/**
 * Account rotation through the real HTTP server, against a stand-in `claude`.
 *
 * The stub answers in stream-json like `claude -p` and reports a usage limit when the account
 * directory it was launched with (CLAUDE_CONFIG_DIR) holds a `limited` marker, so the whole path
 * is exercised without a real login: rotation pick, failover to the next account, the
 * `x-enigma-account` header, a streamed answer that never leaks the limit notice, the 429 once
 * every account is cooling down, and the 403 when callers may not choose. A temp
 * ENIGMA_CONFIG_HOME (set before any import) keeps the real account registry untouched.
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-rotation-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const accounts = await import("../src/accounts");
const { startApiServer } = await import("../src/api-server");

const RESET = Math.floor(Date.now() / 1000) + 3600;
const STUB = `
import { appendFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
const dir = process.env.CLAUDE_CONFIG_DIR || "";
appendFileSync(process.env.STUB_LOG, basename(dir) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    if (existsSync(join(dir, "limited"))) {
        const notice = "Claude AI usage limit reached|${RESET}";
        out({ type: "assistant", message: { content: [{ type: "text", text: notice }] } });
        out({ type: "result", subtype: "success", is_error: true, result: notice, usage: { input_tokens: 0, output_tokens: 0 } });
        return;
    }
    if (existsSync(join(dir, "max-turns"))) {
        const answer = "Retry the request when the API answers 429 rate limit.";
        out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
        out({ type: "result", subtype: "error_max_turns", is_error: true, result: answer, usage: { input_tokens: 5, output_tokens: 3 } });
        return;
    }
    const text = "answer from " + basename(dir);
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 5, output_tokens: 3 } });
});
`;

let log = "";
let dirs: Record<string, string> = {};

beforeAll(() => {
    const script = join(HOME, "fake-claude.mjs");
    writeFileSync(script, STUB);
    let shim: string;
    if (process.platform === "win32") {
        shim = join(HOME, "fake-claude.cmd");
        writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
        shim = join(HOME, "fake-claude.sh");
        writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
        chmodSync(shim, 0o755);
    }
    process.env.ENIGMA_CLAUDE_BIN = shim;
    log = join(HOME, "launches.log");
    process.env.STUB_LOG = log;
    dirs = { work: accounts.addAccount("claude", "work").dir, personal: accounts.addAccount("claude", "personal").dir };
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Which accounts the stub ran under since the last call, in order. */
function launches(): string[] {
    if (!existsSync(log)) return [];
    const byDir = Object.fromEntries(Object.entries(dirs).map(([name, d]) => [basename(d), name]));
    const seen = readFileSync(log, "utf8").split("\n").filter(Boolean).map((b) => byDir[b] ?? b);
    writeFileSync(log, "");
    return seen;
}

function limit(name: string, on: boolean): void {
    const marker = join(dirs[name]!, "limited");
    if (on) writeFileSync(marker, "");
    else rmSync(marker, { force: true });
}

async function chat(url: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }) });
}

test("round-robin alternates accounts and names the one that answered", async () => {
    const server = await startApiServer({ port: 0, rotation: "round-robin", pool: ["work", "personal"] });
    try {
        launches();
        const a = await chat(server.url, {});
        const b = await chat(server.url, {});
        expect(a.headers.get("x-enigma-account")).toBe("work");
        expect(b.headers.get("x-enigma-account")).toBe("personal");
        expect((await b.json() as { choices: Array<{ message: { content: string; }; }>; }).choices[0]!.message.content).toBe(`answer from ${basename(dirs.personal!)}`);
        expect(launches()).toEqual(["work", "personal"]);
    } finally { server.close(); }
});

test("a usage limit fails over to the next account and cools the limited one down", async () => {
    const server = await startApiServer({ port: 0, rotation: "fill-first", pool: ["work", "personal"] });
    try {
        limit("work", true);
        launches();
        const res = await chat(server.url, {});
        expect(res.status).toBe(200);
        expect(res.headers.get("x-enigma-account")).toBe("personal");
        expect(launches()).toEqual(["work", "personal"]);
        // Cooling down: the next request goes straight to the second account.
        await chat(server.url, {});
        expect(launches()).toEqual(["personal"]);
        const health = await (await fetch(`${server.url}/health`)).json() as { rotation: { cooldowns: Array<{ account: string; until: number; }>; }; };
        expect(health.rotation.cooldowns).toEqual([{ tool: "claude", account: "work", reason: "limit", until: RESET * 1000 }] as never);
    } finally { server.close(); limit("work", false); }
});

test("a streamed request fails over without leaking the limit notice", async () => {
    const server = await startApiServer({ port: 0, rotation: "fill-first", pool: ["work", "personal"] });
    try {
        limit("work", true);
        launches();
        const res = await chat(server.url, { stream: true });
        const text = await res.text();
        expect(text).toContain("answer from");
        expect(text).not.toContain("usage limit");
        expect(launches()).toEqual(["work", "personal"]);
    } finally { server.close(); limit("work", false); }
});

test("once every account is cooling down the server answers 429", async () => {
    const server = await startApiServer({ port: 0, rotation: "round-robin", pool: ["work", "personal"] });
    try {
        limit("work", true);
        limit("personal", true);
        const first = await chat(server.url, {});
        expect(first.status).toBe(502);
        const second = await chat(server.url, {});
        expect(second.status).toBe(429);
        expect(((await second.json()) as { error: { type: string; }; }).error.type).toBe("rate_limit_error");
    } finally { server.close(); limit("work", false); limit("personal", false); }
});

test("a caller's own account wins over the rotation, unless callers may not choose", async () => {
    const open = await startApiServer({ port: 0, rotation: "round-robin", pool: ["work", "personal"] });
    try {
        launches();
        const res = await chat(open.url, { account: "personal" });
        expect(res.status).toBe(200);
        expect(launches()).toEqual(["personal"]);
    } finally { open.close(); }
    const closed = await startApiServer({ port: 0, rotation: "round-robin", pool: ["work", "personal"], clientContext: false });
    try {
        const res = await chat(closed.url, { account: "personal" });
        expect(res.status).toBe(403);
    } finally { closed.close(); }
});

test("rotation off keeps the fixed default account", async () => {
    const server = await startApiServer({ port: 0, account: "work" });
    try {
        launches();
        const res = await chat(server.url, {});
        expect(res.headers.get("x-enigma-account")).toBeNull();
        expect(launches()).toEqual(["work"]);
    } finally { server.close(); }
});

test("an error run whose answer mentions a rate limit stays on its account", async () => {
    const server = await startApiServer({ port: 0, rotation: "round-robin", pool: ["work", "personal"] });
    const marker = join(dirs.work!, "max-turns");
    try {
        writeFileSync(marker, "");
        launches();
        const res = await chat(server.url, {});
        expect(res.status).toBe(502);
        expect(launches()).toEqual(["work"]);
        const health = await (await fetch(`${server.url}/health`)).json() as { rotation: { cooldowns: unknown[]; }; };
        expect(health.rotation.cooldowns).toEqual([]);
    } finally { server.close(); rmSync(marker, { force: true }); }
});
