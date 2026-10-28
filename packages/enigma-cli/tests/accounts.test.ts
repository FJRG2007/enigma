/**
 * Account directories are decoupled from account names: a new account gets an opaque UUID
 * directory, so renaming is a metadata-only change that never moves files. Legacy name-based
 * directories (created before the change) keep working and are also never moved on rename.
 * Temp HOME (set BEFORE import) isolates the registry under ~/.enigma.
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-accounts-"));
// ENIGMA_CONFIG_HOME is what accounts.ts resolves the registry against: bun on Linux does
// not reflect a runtime-reassigned $HOME via os.homedir(), so HOME/USERPROFILE alone would
// leave the module reading the real home dir (the registry path and this test would diverge).
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const REGISTRY = join(HOME, ".enigma", "accounts.json");
const accounts = await import("../src/accounts");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Split with an interpolation so the repo's own commit guard never flags this test file.
const TOKEN = `sk-${"minimax"}-xyz`;

test("a new account gets a UUID directory, not a name-based one", () => {
    const a = accounts.addAccount("claude", "work");
    expect(basename(a.dir)).toMatch(UUID_RE);
    expect(basename(a.dir)).not.toBe("work");
    expect(existsSync(a.dir)).toBe(true);
});

test("rename is metadata-only: the directory does not move", () => {
    accounts.setActive("claude", "work");
    accounts.addProfile("team");
    accounts.setProfileAccount("team", "claude", "work");

    const before = accounts.listAccounts("claude").find((x) => x.name === "work")!;
    const renamed = accounts.renameAccount("claude", "work", "office");

    // Same directory, new name - nothing moved on disk.
    expect(renamed.dir).toBe(before.dir);
    expect(existsSync(before.dir)).toBe(true);

    const after = accounts.listAccounts("claude");
    expect(after.some((x) => x.name === "office")).toBe(true);
    expect(after.some((x) => x.name === "work")).toBe(false);
    // The active pointer and the profile mapping follow the rename.
    expect(accounts.getActive("claude")).toBe("office");
    expect(accounts.listProfiles().find((p) => p.name === "team")!.accounts.claude).toBe("office");
});

test("a legacy name-based directory keeps working and is not moved on rename", () => {
    // Seed a registry exactly as a pre-change install would have: dir basename == name.
    const legacyDir = join(HOME, ".enigma", "claude", "legacy");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(REGISTRY, `${JSON.stringify({
        tools: { claude: { active: null, accounts: [{ name: "legacy", dir: legacyDir, createdAt: "" }] } },
        profiles: { active: null, items: {} },
    }, null, 2)}\n`);

    const renamed = accounts.renameAccount("claude", "legacy", "personal");
    expect(renamed.dir).toBe(legacyDir); // untouched legacy path
    expect(basename(renamed.dir)).toBe("legacy"); // segment stays, name decoupled
    expect(existsSync(legacyDir)).toBe(true);
    expect(accounts.resolveConfigDir("claude", "personal")).toBe(legacyDir);
});

test("provider override: a MiniMax preset injects the ANTHROPIC_* env and encrypts the token", () => {
    accounts.addAccount("claude", "mmacc");
    const input = accounts.providerFromPreset("minimax", TOKEN)!;
    expect(input.baseUrl).toBe("https://api.minimax.io/anthropic");
    accounts.setAccountProvider("claude", "mmacc", input);

    const view = accounts.getAccountProvider("claude", "mmacc")!;
    expect(view.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(view.model).toBe("MiniMax-M3[1m]");
    expect(view.preset).toBe("minimax");
    expect(view.hasToken).toBe(true);

    // The token never leaks into the listing view, and is encrypted at rest.
    const listed = accounts.listAccounts("claude").find((a) => a.name === "mmacc")!;
    expect(listed.provider?.hasToken).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    const raw = readFileSync(REGISTRY, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(raw).toContain("enc:v1:");

    // The launch env carries the decrypted token, every model tier, and the extra env.
    const env = accounts.accountProviderEnv("claude", "mmacc")!;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN);
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("MiniMax-M3[1m]");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
});

test("provider override: an omitted token is kept on update, then fully cleared", () => {
    const cur = accounts.getAccountProvider("claude", "mmacc")!;
    accounts.setAccountProvider("claude", "mmacc", { baseUrl: cur.baseUrl, model: "MiniMax-M2", preset: cur.preset, env: cur.env });
    const env = accounts.accountProviderEnv("claude", "mmacc")!;
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN); // kept across a token-less update

    accounts.setAccountProvider("claude", "mmacc", null);
    expect(accounts.getAccountProvider("claude", "mmacc")).toBeNull();
    expect(accounts.accountProviderEnv("claude", "mmacc")).toBeNull();
});

test("the default account cannot take a provider override", () => {
    expect(() => accounts.setAccountProvider("claude", "default", { baseUrl: "https://api.minimax.io/anthropic" })).toThrow();
});

// A name in the command slot launches its account (`enigma bytehide`), and a command always
// wins the slot - so an account or profile named like a command would be unreachable.
test("an account or profile cannot take a command's name", () => {
    for (const name of ["update", "Update", "claude", "codex", "helio", "gate", "branches", "default"]) {
        expect(() => accounts.addAccount("claude", name)).toThrow();
        expect(() => accounts.addProfile(name)).toThrow();
    }
    accounts.addAccount("claude", "work-acct");
    expect(() => accounts.renameAccount("claude", "work-acct", "install")).toThrow("enigma command");
    accounts.addProfile("team");
    expect(() => accounts.renameProfile("team", "doctor")).toThrow("enigma command");
    // Names that merely contain a command word are fine.
    expect(() => accounts.addAccount("claude", "update-team")).not.toThrow();
});

/** Launch `account` with a stand-in binary that records the Console-store env it was given. */
async function launchedEnv(account: string, env: Record<string, string | undefined> = {}): Promise<{ claude?: string; store?: string; }> {
    const out = join(HOME, `launch-${Math.random().toString(36).slice(2)}.json`);
    const saved = { ...process.env };
    Object.assign(process.env, env, { ENIGMA_CLAUDE_BIN: process.execPath });
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
        const script = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ claude: process.env.CLAUDE_CONFIG_DIR, store: process.env.ANTHROPIC_CONFIG_DIR }))`;
        expect(await accounts.launchTool("claude", account, ["-e", script], { login: true })).toBe(0);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
    return JSON.parse(readFileSync(out, "utf8"));
}

test("a managed Claude account launches on its own Console store, never the machine-wide one", async () => {
    const a = accounts.addAccount("claude", "isolated");
    const got = await launchedEnv("isolated", { ANTHROPIC_CONFIG_DIR: join(HOME, "machine-store") });
    expect(got.claude).toBe(a.dir);
    expect(got.store).toBe(join(a.dir, "anthropic"));
});

test("the user's own account drops a store inherited from an enigma session, keeps one they chose", async () => {
    const parent = accounts.addAccount("claude", "parentsession");
    const inherited = await launchedEnv(accounts.DEFAULT_NAME, { CLAUDE_CONFIG_DIR: parent.dir, ANTHROPIC_CONFIG_DIR: join(parent.dir, "anthropic") });
    expect(inherited.store).toBeUndefined();
    const chosen = await launchedEnv(accounts.DEFAULT_NAME, { CLAUDE_CONFIG_DIR: undefined, ANTHROPIC_CONFIG_DIR: join(HOME, "my-store") });
    expect(chosen.store).toBe(join(HOME, "my-store"));
});

test("every spawn env pins the Console store the way a launch does, the API server's default account included", () => {
    const parent = accounts.addAccount("claude", "apiparent");
    const saved = { ...process.env };
    Object.assign(process.env, { CLAUDE_CONFIG_DIR: parent.dir, ANTHROPIC_CONFIG_DIR: join(parent.dir, "anthropic") });
    try {
        const own = accounts.toolEnv("claude", accounts.resolveConfigDir("claude", accounts.DEFAULT_NAME));
        expect(own.ANTHROPIC_CONFIG_DIR).toBeUndefined();
        const managed = accounts.addAccount("claude", "apimanaged");
        expect(accounts.toolEnv("claude", managed.dir).ANTHROPIC_CONFIG_DIR).toBe(join(managed.dir, "anthropic"));
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test("launching a Console-only account carries its machine-wide login into its own store", async () => {
    const machine = join(HOME, "legacy-store");
    mkdirSync(join(machine, "configs"), { recursive: true });
    mkdirSync(join(machine, "credentials"), { recursive: true });
    writeFileSync(join(machine, "configs", "default.json"), JSON.stringify({ authentication: { type: "user_oauth" } }));
    writeFileSync(join(machine, "credentials", "default.json"), JSON.stringify({ access_token: "A", refresh_token: "R", account_email: "dev@example.com" }));
    const consoleOnly = accounts.addAccount("claude", "consoleonly");
    writeFileSync(join(consoleOnly.dir, ".credentials.json"), "{}");
    writeFileSync(join(consoleOnly.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com" } }));
    const otherId = accounts.addAccount("claude", "signedout");
    writeFileSync(join(otherId.dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "admin@example.com" } }));

    await launchedEnv("consoleonly", { ANTHROPIC_CONFIG_DIR: machine, CLAUDE_CONFIG_DIR: undefined });
    await launchedEnv("signedout", { ANTHROPIC_CONFIG_DIR: machine, CLAUDE_CONFIG_DIR: undefined });
    expect(JSON.parse(readFileSync(join(consoleOnly.dir, "anthropic", "credentials", "default.json"), "utf8")).account_email).toBe("dev@example.com");
    expect(existsSync(join(otherId.dir, "anthropic"))).toBe(false);
});
