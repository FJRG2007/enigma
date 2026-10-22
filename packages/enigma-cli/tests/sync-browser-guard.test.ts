/**
 * The browser guard on the SYNC path. `enigma update` reaches an existing install only through
 * syncDeployed, and a managed account is only re-synced at launch when autoSync is on, so the
 * update sync has to put the guard into every Claude account's settings.json as well as the
 * global one. Runs against a temp HOME with a fabricated global Claude deployment.
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-sync-browser-guard-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { syncDeployed } = await import("../src/skills");
const { addAccount } = await import("../src/accounts");
const { AGENTS } = await import("../src/agents");

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "skills");
/** Read from agents.ts, not composed from HOME: it resolves its targets at import time (see sync-trust.test.ts). */
const SKILLS_DIR = AGENTS.claude!.targets.global!.skills;
const guarded = (path: string): boolean => readFileSync(path, "utf8").includes("__browser-guard");

let priorConfigHome: string | undefined;

beforeEach(() => {
    priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    mkdirSync(SKILLS_DIR, { recursive: true });
    cpSync(join(ASSETS, "git-policy"), join(SKILLS_DIR, "git-policy"), { recursive: true });
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
});

afterEach(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
});

afterAll(() => {
    rmSync(join(SKILLS_DIR, "git-policy"), { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
});

test("a sync installs the browser guard into every claude account that has settings", () => {
    const withSettings = addAccount("claude", "work").dir;
    writeFileSync(join(withSettings, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    const fresh = addAccount("claude", "fresh").dir;

    syncDeployed(["claude"]);

    const settings = JSON.parse(readFileSync(join(withSettings, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(guarded(join(withSettings, "settings.json"))).toBe(true);
    // The account's own keys survive the write.
    expect(settings.theme).toBe("dark");
    // A dir with no settings.json yet is left for its first launch, which seeds it whole.
    expect(existsSync(join(fresh, "settings.json"))).toBe(false);

    // Idempotent: a second sync leaves the file byte-identical.
    const before = readFileSync(join(withSettings, "settings.json"), "utf8");
    syncDeployed(["claude"]);
    expect(readFileSync(join(withSettings, "settings.json"), "utf8")).toBe(before);
});
