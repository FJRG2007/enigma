/**
 * Managed-account deployment sync: syncAccount must seed a fresh account config
 * dir with skills + rendered memory and mirror the enigma-managed agent settings
 * (bypass, attribution) from the user's global config, then follow the same
 * never-overwrite rules as syncDeployed on refresh. Runs against a temp HOME
 * (set BEFORE importing the modules - they resolve some paths at import time).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-account-sync-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const { hasAccountDeployment, syncAccount } = await import("../src/skills");

const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

beforeAll(() => {
    // Global Claude posture enigma manages: bypass on, attribution disabled.
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    writeFileSync(join(HOME, ".claude", "settings.json"), JSON.stringify({
        permissions: { defaultMode: "bypassPermissions" },
        attribution: { commit: "", pr: "" },
        includeCoAuthoredBy: false,
        statusLine: { type: "command", command: "enigma statusline", padding: 0 },
    }, null, 2) + "\n");
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("syncAccount seeds a claude account dir and mirrors managed settings", async () => {
    const dir = join(HOME, ".enigma", "claude", "work");
    mkdirSync(dir, { recursive: true });
    expect(hasAccountDeployment("claude", dir)).toBe(false);

    const notices = syncAccount("claude", dir);
    expect(notices.length).toBe(1);

    // Skills deployed into the dir CLAUDE_CONFIG_DIR points the tool at.
    const deployed = readdirSync(join(dir, "skills"));
    expect(deployed).toContain("core-engineering-policy");
    expect(deployed).toContain("git-policy");
    // Memory seeded (rendered, not raw-copied).
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    // Managed settings mirrored from the global posture.
    const settings = readJson(join(dir, "settings.json"));
    expect((settings.permissions as Record<string, unknown>).defaultMode).toBe("bypassPermissions");
    expect((settings.attribution as Record<string, unknown>).commit).toBe("");
    expect(settings.includeCoAuthoredBy).toBe(false);
    // Statusline is mirrored so a managed account gets the same bar as the default one.
    expect((settings.statusLine as Record<string, unknown>).command).toBe("enigma statusline");
    expect(hasAccountDeployment("claude", dir)).toBe(true);

    // Idempotent: a second sync changes nothing.
    expect(syncAccount("claude", dir).length).toBe(0);

    // A user-edited account memory file is never overwritten.
    writeFileSync(join(dir, "CLAUDE.md"), "my own notes\n");
    syncAccount("claude", dir);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("my own notes\n");

    // Turning the global knob off propagates: bypass is removed on the next sync.
    writeFileSync(join(HOME, ".claude", "settings.json"), JSON.stringify({
        attribution: { commit: "", pr: "" },
        includeCoAuthoredBy: false,
    }, null, 2) + "\n");
    syncAccount("claude", dir);
    expect(readJson(join(dir, "settings.json")).permissions).toBeUndefined();
});

test("syncAccount honors discards on refresh", async () => {
    const dir = join(HOME, ".enigma", "claude", "discards");
    mkdirSync(dir, { recursive: true });
    syncAccount("claude", dir);
    expect(existsSync(join(dir, "skills", "frontend-policy"))).toBe(true);

    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ discardedSkills: ["frontend-policy"] }) + "\n");
    syncAccount("claude", dir);
    expect(existsSync(join(dir, "skills", "frontend-policy"))).toBe(false);
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
});

test("syncAccount deploys codex memory only and mirrors config.toml bypass", async () => {
    mkdirSync(join(HOME, ".codex"), { recursive: true });
    writeFileSync(join(HOME, ".codex", "config.toml"), "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n");

    const dir = join(HOME, ".enigma", "codex", "work");
    mkdirSync(dir, { recursive: true });
    syncAccount("codex", dir);

    // Codex reads skills from the shared ~/.agents/skills - no per-account copy.
    expect(existsSync(join(dir, "skills"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain("approval_policy = \"never\"");
});
