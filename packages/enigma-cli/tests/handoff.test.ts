/**
 * Handoffs: the per-project store, delivery to a fresh session on each host, the wiring enigma
 * writes for Claude Code (hook + relay mod), Codex, Kimi and OpenCode, and the headless relay loop
 * driven against a fake agent. HOME is a temp dir, set BEFORE the imports.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-handoff-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const handoff = await import("../src/handoff");
const { runHandoffHook } = await import("../src/handoff-cli");
const deploy = await import("../src/handoff-deploy");
const relay = await import("../src/relay");

const PROJ = mkdtempSync(join(tmpdir(), "enigma-handoff-proj-"));
mkdirSync(join(PROJ, ".git"));
mkdirSync(join(PROJ, "src", "deep"), { recursive: true });

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJ, { recursive: true, force: true });
    delete process.env.ENIGMA_CONFIG_HOME;
});

/** Run the hook for `host` and capture what it wrote to stdout. */
function hook(host: string, payload: Record<string, unknown>): string {
    let out = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try { expect(runHandoffHook(host, JSON.stringify(payload))).toBe(0); } finally { process.stdout.write = write; }
    return out;
}

test("one handoff per project, found from any subdirectory, delivered once", () => {
    handoff.saveHandoff(join(PROJ, "src"), "# Ship the parser\n\n## Next\n1. wire the CLI");
    expect(handoff.readHandoff(join(PROJ, "src", "deep"))?.text).toContain("Ship the parser");
    expect(handoff.pendingHandoff(PROJ)).not.toBeNull();
    // A resumed or compacted session keeps its history: nothing to deliver there.
    expect(hook("claude", { cwd: PROJ, source: "resume" })).toBe("");
    const out = JSON.parse(hook("claude", { cwd: join(PROJ, "src"), source: "clear" }));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("Continue the work it describes now");
    expect(out.hookSpecificOutput.additionalContext).toContain("wire the CLI");
    // Delivered: the next fresh session in the project is not handed it again.
    expect(hook("claude", { cwd: PROJ, source: "startup" })).toBe("");
});

test("Kimi gets plain text, finished and stale handoffs are never delivered, empty and huge are refused", () => {
    handoff.saveHandoff(PROJ, "# Task\n\nnext: test it");
    expect(hook("kimi", { cwd: PROJ, source: "startup" })).toContain("next: test it");
    handoff.saveHandoff(PROJ, "# Task\n\nSTATUS: done");
    expect(handoff.pendingHandoff(PROJ)).toBeNull();
    handoff.saveHandoff(PROJ, "# Old", Date.now() - handoff.MAX_AGE_MS - 1000);
    expect(handoff.pendingHandoff(PROJ)).toBeNull();
    expect(() => handoff.saveHandoff(PROJ, "   ")).toThrow();
    expect(() => handoff.saveHandoff(PROJ, "x".repeat(handoff.MAX_HANDOFF_BYTES + 1))).toThrow();
    // The pointer the Claude Code mod reads names this project.
    const latest = JSON.parse(readFileSync(handoff.latestFile(), "utf8"));
    expect(latest.root).toBe(handoff.projectRoot(PROJ));
});

test("Claude Code gets the session-start hook, the relay mod and its plugin folder; off removes them", () => {
    const settings = join(HOME, "claude-settings.json");
    writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: "/other/mod" } }));
    deploy.applyClaudeHandoffWiring(settings);
    let s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.hooks.SessionStart[0].matcher).toBe("startup|clear");
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("enigma __handoff-hook claude");
    const sep = process.platform === "win32" ? ";" : ":";
    expect(s.env.CLAUDE_CODE_PLUGIN_DIRS.split(sep)).toEqual(["/other/mod", deploy.relayModDir()]);
    const mod = readFileSync(join(deploy.relayModDir(), "hooks", "register.ts"), "utf8");
    expect(mod).toContain("const RELAY_AT = 300000;");
    expect(mod).toContain(handoff.latestFile().split("\\").join("/"));
    expect(existsSync(join(deploy.relayModDir(), ".claude-plugin", "plugin.json"))).toBe(true);
    // Idempotent.
    expect(deploy.applyClaudeHandoffWiring(settings)).toBe(false);
    // relay off: hook and folder go, the user's other plugin folder stays.
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ relay: false }));
    deploy.applyClaudeHandoffWiring(settings);
    s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.hooks).toBeUndefined();
    expect(s.env.CLAUDE_CODE_PLUGIN_DIRS).toBe("/other/mod");
    rmSync(join(HOME, ".enigma.json"), { force: true });
});

test("Codex is wired only where it is installed; Kimi and OpenCode get their own entries", () => {
    const codex = join(HOME, ".codex");
    expect(deploy.applyCodexHandoffHook(codex, true)).toBe(false);
    expect(existsSync(codex)).toBe(false);
    mkdirSync(codex);
    expect(deploy.applyCodexHandoffHook(codex, true)).toBe(true);
    expect(JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0].command).toBe("enigma __handoff-hook codex");
    const kimi = join(HOME, "kimi.toml");
    deploy.applyKimiHandoffHook(kimi, true);
    expect(readFileSync(kimi, "utf8")).toContain("enigma __handoff-hook kimi");
    const opencode = join(HOME, "opencode");
    deploy.applyOpencodeHandoffPlugin(opencode, true);
    expect(readFileSync(join(opencode, "plugins", "enigma-handoff.js"), "utf8")).toContain("session.created");
    deploy.applyOpencodeHandoffPlugin(opencode, false);
    expect(existsSync(join(opencode, "plugins", "enigma-handoff.js"))).toBe(false);
});

test("relay-at parses tokens and off", () => {
    expect(deploy.parseRelayAt("300k")).toBe(300_000);
    expect(deploy.parseRelayAt("off")).toBe(0);
    expect(() => deploy.parseRelayAt("10k")).toThrow();
});

test("the relay chains fresh sessions through handoffs and stops on STATUS: done", () => {
    // A fake `claude` that saves a handoff the way an agent would: step 1 continues, step 2 finishes.
    const bin = join(HOME, "bin");
    mkdirSync(bin, { recursive: true });
    const counter = join(HOME, "steps.txt");
    const script = join(bin, "fake-agent.mjs");
    const enigmaEntry = join(import.meta.dir, "..", "src", "handoff.ts").split("\\").join("/");
    const hookEntry = join(import.meta.dir, "..", "src", "handoff-cli.ts").split("\\").join("/");
    writeFileSync(script, `import { readFileSync, writeFileSync, existsSync } from "node:fs";
const n = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1 : 1;
writeFileSync(${JSON.stringify(counter)}, String(n));
if (process.env.ENIGMA_RELAY_STEP !== "1") throw new Error("not marked as a relay step");
const { runHandoffHook } = await import(${JSON.stringify(hookEntry)});
let said = "";
process.stdout.write = (c) => { said += c; return true; };
runHandoffHook("claude", JSON.stringify({ cwd: process.cwd(), source: "startup" }));
if (said) throw new Error("a relay step was handed the old handoff");
const { saveHandoff } = await import(${JSON.stringify(enigmaEntry)});
saveHandoff(process.cwd(), n === 1 ? "# Task\\n\\n## Next\\n1. step two" : "# Task\\n\\nSTATUS: done");
`);
    // An unrelated handoff already waiting in the project: no step is handed it.
    handoff.saveHandoff(PROJ, "# Old task\n\n## Next\n1. something else");
    expect(handoff.pendingHandoff(PROJ)).not.toBeNull();
    if (process.platform === "win32") writeFileSync(join(bin, "claude.cmd"), `@bun "${script}"\r\n`);
    else { writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec bun "${script}"\n`); chmodSync(join(bin, "claude"), 0o755); }
    const sep = process.platform === "win32" ? ";" : ":";
    const path = process.env.PATH;
    process.env.PATH = `${bin}${sep}${path}`;
    try {
        const lines: string[] = [];
        const opts = relay.parseRelayArgs(["--max", "5", "ship", "it"], PROJ);
        if (typeof opts === "string") throw new Error(opts);
        const code = relay.runRelay(opts, (l) => lines.push(l));
        expect(lines.join(" | ")).toContain("done after 2 step(s)");
        expect(code).toBe(0);
        expect(readFileSync(counter, "utf8")).toBe("2");
        expect(lines.join("\n")).toContain("done after 2 step(s)");
        // Delivered by the relay itself, so no later session is handed it again.
        expect(handoff.pendingHandoff(PROJ)).toBeNull();
    } finally {
        process.env.PATH = path;
    }
});

test("relay arguments are validated", () => {
    expect(relay.parseRelayArgs([])).toContain("name the task");
    expect(relay.parseRelayArgs(["--agent", "vim", "x"])).toContain("--agent takes one of");
    expect(relay.parseRelayArgs(["--max", "0", "x"])).toContain("--max takes");
    // The handoff store sits outside the workspace, so Codex's sandbox is told it may write there.
    expect(relay.stepArgv("codex", "/store/p.md")).toEqual(["codex", "exec", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.writable_roots=['/store']", "Read /store/p.md and do what it says."]);
    expect(() => relay.stepArgv("codex", "/it's/p.md")).toThrow();
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ permissionBypass: false }));
    try {
        expect(relay.stepArgv("claude", "/p.md")).toEqual(["claude", "-p", "Read /p.md and do what it says.", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(enigma handoff save:*)"]);
    } finally { rmSync(join(HOME, ".enigma.json"), { force: true }); }
    expect(relay.stepArgv("kimi", "/p.md")).toEqual(["kimi", "-p", "Read /p.md and do what it says."]);
});
