/**
 * Account directories are decoupled from account names: a new account gets an opaque UUID
 * directory, so renaming is a metadata-only change that never moves files. Legacy name-based
 * directories (created before the change) keep working and are also never moved on rename.
 * Temp HOME (set BEFORE import) isolates the registry under ~/.enigma.
 */
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-accounts-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const REGISTRY = join(HOME, ".enigma", "accounts.json");
const accounts = await import("../src/accounts");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const legacyDir = join(HOME, ".enigma", "claude", "ByteHide");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(REGISTRY, `${JSON.stringify({
        tools: { claude: { active: null, accounts: [{ name: "ByteHide", dir: legacyDir, createdAt: "" }] } },
        profiles: { active: null, items: {} },
    }, null, 2)}\n`);

    const renamed = accounts.renameAccount("claude", "ByteHide", "personal");
    expect(renamed.dir).toBe(legacyDir); // untouched legacy path
    expect(basename(renamed.dir)).toBe("ByteHide"); // segment stays, name decoupled
    expect(existsSync(legacyDir)).toBe(true);
    expect(accounts.resolveConfigDir("claude", "personal")).toBe(legacyDir);
});
