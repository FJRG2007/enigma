/**
 * The shared Claude session store: one config dir for every account, with the account deciding
 * only which login is spent. Pure file operations over temp dirs (ENIGMA_CONFIG_HOME points the
 * store at a scratch dir) - no HOME, no network, no spawn.
 * Run under Bun: bun test tests/session-store.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { enterSharedStore, leaveSharedStore, sharedStoreFor } from "../src/session-store";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-store-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ENIGMA_CONFIG_HOME is process-wide and bun runs every test file in ONE process, so it is set
// for the duration of a test and restored after it: held at module scope, this suite's scratch
// home leaked into whichever file ran next and its config assertions then read ours.
let prevHome: string | undefined;
beforeEach(() => { prevHome = process.env.ENIGMA_CONFIG_HOME; process.env.ENIGMA_CONFIG_HOME = ROOT; });
afterEach(() => {
    if (prevHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = prevHome;
});

/** The store dir under this suite's scratch home. Resolved per call, inside a test. */
function store(): string {
    return sharedStoreFor("claude")!;
}

let seq = 0;
/** A fresh account config dir holding a login for `email`. */
function account(email: string, refresh: string, expiresAt: number): string {
    const dir = join(ROOT, `acct${seq++}`);
    mkdirSync(dir, { recursive: true });
    creds(dir, refresh, expiresAt);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email }, hasCompletedOnboarding: true }));
    return dir;
}

function creds(dir: string, refresh: string, expiresAt: number): void {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: `a-${refresh}`, refreshToken: refresh, expiresAt },
    }));
}

/** Put a transcript at `projects/<slug>/<name>.jsonl` inside a config dir. */
function transcript(dir: string, slug: string, name: string): void {
    mkdirSync(join(dir, "projects", slug), { recursive: true });
    writeFileSync(join(dir, "projects", slug, `${name}.jsonl`), "{\"type\":\"user\"}\n");
}

/** The refresh token a config dir currently holds, or "" when it holds none. */
function refreshOf(dir: string): string {
    try { return JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken as string; }
    catch { return ""; }
}

const SOON = Date.now() + 3600_000;
const LATER = Date.now() + 7200_000;

test("a tool with no shared store gets none", () => {
    expect(sharedStoreFor("codex")).toBeNull();
    expect(enterSharedStore("codex", join(ROOT, "nowhere"), true)).toBeNull();
});

test("entering moves the account's login and history into the one store", () => {
    const a = account("a@x", "r-a", SOON);
    transcript(a, "slug-a", "s1");
    const entry = enterSharedStore("claude", a, true)!;

    expect(entry.dir).toBe(store());
    expect(entry.seeded).toBe("renamed");                                   // managed dir: instant rename
    expect(existsSync(join(store(), "projects", "slug-a", "s1.jsonl"))).toBe(true);
    expect(existsSync(join(a, "projects"))).toBe(false);                    // moved, not duplicated
    expect(refreshOf(store())).toBe("r-a");
    // The identity travels with the credential, or the store would be sent through onboarding.
    expect(JSON.parse(readFileSync(join(store(), ".claude.json"), "utf8")).oauthAccount.emailAddress).toBe("a@x");
});

test("the user's own dir is copied in, never emptied, and only once", () => {
    const own = account("own@x", "r-own", SOON);
    transcript(own, "slug-own", "s1");
    const first = enterSharedStore("claude", own, false)!;

    expect(first.seeded).toBe("copied");
    expect(existsSync(join(own, "projects", "slug-own", "s1.jsonl"))).toBe(true);   // left in place
    expect(existsSync(join(store(), "projects", "slug-own", "s1.jsonl"))).toBe(true);

    // A second entry is not a second seed: the account is recorded as done.
    transcript(own, "slug-own", "s2");
    expect(enterSharedStore("claude", own, false)!.seeded).toBeNull();
    expect(existsSync(join(store(), "projects", "slug-own", "s2.jsonl"))).toBe(false);
});

test("switching accounts hands the rotated token back before the next login lands", () => {
    const a = account("a@x", "r-a", SOON);
    const b = account("b@x", "r-b", SOON);
    enterSharedStore("claude", a, true);
    // Claude Code refreshes mid-session: the store now holds a token the account dir does not.
    creds(store(), "r-a2", LATER);

    enterSharedStore("claude", b, true);
    expect(refreshOf(a)).toBe("r-a2");   // settled before being replaced, so 'a' is not logged out
    expect(refreshOf(store())).toBe("r-b");
});

test("a switch lands even when the incoming token is older", () => {
    const a = account("a@x", "r-a", LATER);
    const b = account("b@x", "r-b", SOON);
    enterSharedStore("claude", a, true);
    enterSharedStore("claude", b, true);
    // Freshness decides between copies of ONE login; a different login always wins its own launch.
    expect(refreshOf(store())).toBe("r-b");
});

test("re-entering on the same account never rolls the store back", () => {
    const a = account("a@x", "r-a", SOON);
    enterSharedStore("claude", a, true);
    creds(store(), "r-a2", LATER);

    enterSharedStore("claude", a, true);
    expect(refreshOf(store())).toBe("r-a2");   // the account's older copy must not displace it
});

test("leaving returns the refreshed token to the account that lent the login", () => {
    const a = account("a@x", "r-a", SOON);
    enterSharedStore("claude", a, true);
    creds(store(), "r-a3", LATER);

    leaveSharedStore("claude", a);
    expect(refreshOf(a)).toBe("r-a3");
    expect(existsSync(join(store(), ".enigma-account"))).toBe(true);
});
