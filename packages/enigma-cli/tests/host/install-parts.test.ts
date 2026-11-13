/**
 * `enigma install --skip <part,...>`: the parts a host can leave out of one install run.
 * Run alone: bun test tests/host/install-parts.test.ts
 */
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { INSTALL_PARTS, mcpRegistrationWanted, parseSkipParts } from "../../src/install-parts";

const ENTRY = resolve(import.meta.dir, "..", "..", "src", "bin", "enigma.ts");

test("parseSkipParts resolves aliases to their part and accepts comma lists and repeats", () => {
    expect([...parseSkipParts(["stop-hook"])]).toEqual(["verify"]);
    expect([...parseSkipParts(["commit-hooks"])]).toEqual(["git-push-guard"]);
    expect([...parseSkipParts([" Gate , recall", "code-graph"])].sort()).toEqual(["code-graph", "gate", "recall"]);
    expect(parseSkipParts([]).size).toBe(0);
});

test("an unknown part is refused with every valid name in the message", () => {
    expect(() => parseSkipParts(["stop-hooks"])).toThrow(/Unknown install part 'stop-hooks'/);
    try { parseSkipParts(["nope"]); } catch (err) {
        for (const p of INSTALL_PARTS) expect((err as Error).message).toContain(p.name);
    }
});

test("every part named in the host request exists", () => {
    const names = INSTALL_PARTS.flatMap((p) => [p.name, ...(p.aliases ?? [])]);
    for (const wanted of ["stop-hook", "gate", "recall", "code-graph", "compress", "guardrails", "output-style", "commit-hooks"]) {
        expect(names).toContain(wanted);
    }
});

test("the MCP entry is written unless mcp is skipped or every feature that is on was skipped", () => {
    const on = { compress: true, recall: true, codeGraph: true };
    expect(mcpRegistrationWanted(new Set(), on)).toBe(true);
    expect(mcpRegistrationWanted(new Set(["mcp"]), on)).toBe(false);
    expect(mcpRegistrationWanted(new Set(["compress", "recall"]), on)).toBe(true);
    expect(mcpRegistrationWanted(new Set(["compress", "recall", "code-graph"]), on)).toBe(false);
    expect(mcpRegistrationWanted(new Set(["code-graph"]), { compress: false, recall: false, codeGraph: true })).toBe(false);
});

/** Run a real install into a scratch home and return its Claude settings and command dir. */
function install(extra: string[]): { settings: Record<string, unknown>; commands: string[]; status: number | null; stderr: string; } {
    const home = mkdtempSync(join(tmpdir(), "enigma-skip-"));
    try {
        const env = { ...process.env, HOME: home, USERPROFILE: home, ENIGMA_CONFIG_HOME: home, ENIGMA_OFFLINE: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
        const run = spawnSync("bun", [ENTRY, "install", "--all", "--yes", "-g", ...extra], { cwd: home, env, encoding: "utf8", shell: process.platform === "win32" });
        const file = join(home, ".claude", "settings.json");
        const dir = join(home, ".claude", "commands");
        return {
            settings: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {},
            commands: existsSync(dir) ? readdirSync(dir) : [],
            status: run.status,
            stderr: run.stderr,
        };
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

test("--skip stop-hook,statusline,gate leaves exactly those out of a real install", () => {
    const full = install([]);
    expect(full.status).toBe(0);
    expect(JSON.stringify((full.settings.hooks as Record<string, unknown>)?.Stop ?? [])).toContain("verify");
    expect(full.settings.statusLine).toBeDefined();
    expect(full.commands).toContain("gate.md");

    const skipped = install(["--skip", "stop-hook,statusline", "--skip", "gate"]);
    expect(skipped.status).toBe(0);
    expect(JSON.stringify((skipped.settings.hooks as Record<string, unknown>)?.Stop ?? [])).not.toContain("verify");
    expect(skipped.settings.statusLine).toBeUndefined();
    expect(skipped.commands).not.toContain("gate.md");
    // Everything not skipped is still installed.
    expect(skipped.commands).toContain("handoff.md");
}, 180_000);

test("--skip with an unknown part fails before installing anything, as JSON under --json", () => {
    const home = mkdtempSync(join(tmpdir(), "enigma-skip-bad-"));
    try {
        const env = { ...process.env, HOME: home, USERPROFILE: home, ENIGMA_CONFIG_HOME: home, ENIGMA_OFFLINE: "1" };
        const run = spawnSync("bun", [ENTRY, "install", "--all", "--yes", "--skip", "nope", "--json"], { cwd: home, env, encoding: "utf8", shell: process.platform === "win32" });
        expect(run.status).toBe(1);
        expect(JSON.parse(run.stdout).error.code).toBe("unknown_part");
        expect(existsSync(join(home, ".claude"))).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}, 60_000);
