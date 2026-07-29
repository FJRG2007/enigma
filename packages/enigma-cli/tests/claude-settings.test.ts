/**
 * Claude feedback-survey settings knob: enigma disables the "How is Claude doing?"
 * survey by default via settings.json env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, and
 * exposes a configurable on/off toggle. Verifies the disable/read/set round-trip
 * preserves unrelated settings, and that mirrorClaudeSettings propagates the
 * override (presence AND absence) into a managed account dir. Runs against a temp
 * HOME (set BEFORE import - claude.ts resolves the global path via homedir()).
 */
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-claude-settings-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const {
    disableClaudeFeedbackSurvey, getClaudeFeedbackSurvey, setClaudeFeedbackSurvey, mirrorClaudeSettings,
    enableClaudeStatusline, disableClaudeStatusline, getClaudeStatusline, setClaudeStatusline, hasCustomClaudeStatusline,
} = await import("../src/claude");

const GLOBAL = join(HOME, ".claude", "settings.json");
const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeJson = (path: string, obj: unknown): void =>
    writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
const ENIGMA_LINE = { type: "command", command: "enigma statusline", padding: 0 };

let priorConfigHome: string | undefined;

beforeEach(() => {
    // `bun test` shares one process across files, and ten of them point
    // ENIGMA_CONFIG_HOME at their own temp dir on import - whichever ran last wins.
    // claude.ts resolves the settings path through enigmaHome() on every call, which
    // prefers that variable, so without pinning it here the writes under test land in
    // a foreign temp dir and the assertions read an untouched file. Restored in
    // afterEach so this file does not do to the next one what was done to it.
    priorConfigHome = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = HOME;
    process.env.USERPROFILE = HOME;
    process.env.HOME = HOME;
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    // A pre-existing unrelated env var must survive every operation.
    writeFileSync(GLOBAL, JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n");
});

afterEach(() => {
    if (priorConfigHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorConfigHome;
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("survey is enabled by default, disable sets the env override without clobbering", () => {
    expect(getClaudeFeedbackSurvey("global")).toBe(true);

    expect(disableClaudeFeedbackSurvey("global")).toBe(true);
    const env = readJson(GLOBAL).env as Record<string, unknown>;
    expect(env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1");
    expect(env.FOO).toBe("bar");
    expect(getClaudeFeedbackSurvey("global")).toBe(false);

    // Idempotent: a second disable is a no-op.
    expect(disableClaudeFeedbackSurvey("global")).toBe(false);
});

test("enabling removes only enigma's override, leaving other env vars intact", () => {
    disableClaudeFeedbackSurvey("global");
    expect(setClaudeFeedbackSurvey("global", true)).toBe(true);

    const settings = readJson(GLOBAL);
    expect((settings.env as Record<string, unknown>).FOO).toBe("bar");
    expect((settings.env as Record<string, unknown>).CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBeUndefined();
    expect(getClaudeFeedbackSurvey("global")).toBe(true);

    // No-op when already enabled.
    expect(setClaudeFeedbackSurvey("global", false)).toBe(true);
    expect(setClaudeFeedbackSurvey("global", false)).toBe(false);
});

test("mirrorClaudeSettings propagates the survey override presence and absence", () => {
    const accountDir = join(HOME, ".enigma", "claude", "work");
    mkdirSync(accountDir, { recursive: true });

    // Present in global -> mirrored into the account.
    disableClaudeFeedbackSurvey("global");
    expect(mirrorClaudeSettings(accountDir)).toBe(true);
    expect((readJson(join(accountDir, "settings.json")).env as Record<string, unknown>)
        .CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY).toBe("1");

    // Removed from global -> removed from the account on the next mirror.
    setClaudeFeedbackSurvey("global", true);
    expect(mirrorClaudeSettings(accountDir)).toBe(true);
    expect(readJson(join(accountDir, "settings.json")).env).toBeUndefined();
});

test("statusline is installed on every platform, with the timer that drives the gate line", () => {
    expect(enableClaudeStatusline("global")).toBe(true);
    const line = readJson(GLOBAL).statusLine as Record<string, unknown> | undefined;
    expect(line?.command).toBe("enigma statusline");
    // Without a timer the bar freezes for exactly as long as a pipeline blocks.
    expect(line?.refreshInterval).toBe(1);
    // Unrelated settings survive.
    expect((readJson(GLOBAL).env as Record<string, unknown>).FOO).toBe("bar");
    // A user's own statusline is never replaced.
    writeJson(GLOBAL, { statusLine: { type: "command", command: "my-own-bar" } });
    expect(enableClaudeStatusline("global")).toBe(false);
    expect((readJson(GLOBAL).statusLine as Record<string, unknown>).command).toBe("my-own-bar");
});

test("disableClaudeStatusline removes only enigma's line, never a user's custom one", () => {
    // Enigma's own line is stripped.
    writeJson(GLOBAL, { env: { FOO: "bar" }, statusLine: ENIGMA_LINE });
    expect(disableClaudeStatusline("global")).toBe(true);
    expect(readJson(GLOBAL).statusLine).toBeUndefined();
    expect((readJson(GLOBAL).env as Record<string, unknown>).FOO).toBe("bar");
    // Idempotent, and a custom statusline is left untouched.
    expect(disableClaudeStatusline("global")).toBe(false);
    writeJson(GLOBAL, { statusLine: { type: "command", command: "my-own-bar" } });
    expect(disableClaudeStatusline("global")).toBe(false);
    expect((readJson(GLOBAL).statusLine as Record<string, unknown>).command).toBe("my-own-bar");
});

test("the statusline toggle reads, installs, removes, and refuses to touch a custom bar", () => {
    expect(getClaudeStatusline("global")).toBe(false);
    expect(hasCustomClaudeStatusline("global")).toBe(false);

    expect(setClaudeStatusline("global", true)).toBe(true);
    expect(getClaudeStatusline("global")).toBe(true);
    // Ours is not "custom" - otherwise the toggle would refuse to re-enable itself.
    expect(hasCustomClaudeStatusline("global")).toBe(false);

    expect(setClaudeStatusline("global", false)).toBe(true);
    expect(getClaudeStatusline("global")).toBe(false);
    expect((readJson(GLOBAL).env as Record<string, unknown>).FOO).toBe("bar");

    // A bar the user wrote is never reported as ours, and never replaced.
    writeJson(GLOBAL, { statusLine: { type: "command", command: "my-own-bar" } });
    expect(getClaudeStatusline("global")).toBe(false);
    expect(hasCustomClaudeStatusline("global")).toBe(true);
    expect(setClaudeStatusline("global", true)).toBe(false);
    expect((readJson(GLOBAL).statusLine as Record<string, unknown>).command).toBe("my-own-bar");
});

test("the registry surfaces an error instead of a silent no-op on a custom bar", async () => {
    const { ALL_SETTINGS } = await import("../src/settings-registry");
    const setting = ALL_SETTINGS.find((s) => s.key === "statusline");
    expect(setting).toBeDefined();

    expect(setting!.write(true, "global")).toMatchObject({ changed: true });
    expect(setting!.read("global")).toBe(true);
    expect(setting!.write(false, "global")).toMatchObject({ changed: true });
    expect(setting!.read("global")).toBe(false);
    // Already off: a no-op, and still not an error.
    expect(setting!.write(false, "global").error).toBeUndefined();

    writeJson(GLOBAL, { statusLine: { type: "command", command: "my-own-bar" } });
    const refused = setting!.write(true, "global");
    expect(refused.changed).toBe(false);
    expect(refused.error).toContain("already set");
});

test("mirror keeps the enigma statusline on an account that already has it", () => {
    const accountDir = join(HOME, ".enigma", "claude", "old");
    mkdirSync(accountDir, { recursive: true });
    writeJson(join(accountDir, "settings.json"), { statusLine: ENIGMA_LINE });
    writeJson(GLOBAL, { statusLine: ENIGMA_LINE });
    mirrorClaudeSettings(accountDir);
    const line = readJson(join(accountDir, "settings.json")).statusLine as Record<string, unknown> | undefined;
    expect(line?.command).toBe("enigma statusline");
});
