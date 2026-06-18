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
} = await import("../src/claude");

const GLOBAL = join(HOME, ".claude", "settings.json");
const readJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

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
