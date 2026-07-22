/**
 * Claude feedback-survey settings knob: enigma disables the "How is Claude doing?"
 * survey by default via settings.json env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, and
 * exposes a configurable on/off toggle. Verifies the disable/read/set round-trip
 * preserves unrelated settings, and that mirrorClaudeSettings propagates the
 * override (presence AND absence) into a managed account dir. Runs against a temp
 * HOME (set BEFORE import - claude.ts resolves the global path via homedir()).
 */
import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-claude-settings-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const {
    disableClaudeFeedbackSurvey, getClaudeFeedbackSurvey, setClaudeFeedbackSurvey, mirrorClaudeSettings,
    enableClaudeStatusline, disableClaudeStatusline,
} = await import("../src/claude");

const GLOBAL = join(HOME, ".claude", "settings.json");
const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeJson = (path: string, obj: unknown): void =>
    writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
const ENIGMA_LINE = { type: "command", command: "enigma statusline", padding: 0 };

beforeEach(() => {
    mkdirSync(join(HOME, ".claude"), { recursive: true });
    // A pre-existing unrelated env var must survive every operation.
    writeFileSync(GLOBAL, JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n");
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

const isWin = process.platform === "win32";

test("statusline is never installed on Windows (console-flash bug #54590), installed elsewhere", () => {
    const written = enableClaudeStatusline("global");
    const line = readJson(GLOBAL).statusLine as Record<string, unknown> | undefined;
    if (isWin) {
        expect(written).toBe(false);
        expect(line).toBeUndefined();
    } else {
        expect(written).toBe(true);
        expect(line?.command).toBe("enigma statusline");
    }
    // Unrelated settings survive either way.
    expect((readJson(GLOBAL).env as Record<string, unknown>).FOO).toBe("bar");
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

test("on Windows, mirror strips an enigma statusline an older install left in the account", () => {
    const accountDir = join(HOME, ".enigma", "claude", "old");
    mkdirSync(accountDir, { recursive: true });
    writeJson(join(accountDir, "settings.json"), { statusLine: ENIGMA_LINE });
    // Global carries the enigma statusline too (as an older install would have written).
    writeJson(GLOBAL, { statusLine: ENIGMA_LINE });
    mirrorClaudeSettings(accountDir);
    const line = readJson(join(accountDir, "settings.json")).statusLine as Record<string, unknown> | undefined;
    if (isWin) expect(line).toBeUndefined();
    else expect(line?.command).toBe("enigma statusline");
});
