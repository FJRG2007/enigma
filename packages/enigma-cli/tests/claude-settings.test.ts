/**
 * Claude-native settings knobs enigma manages: the "How is Claude doing?" survey
 * (settings.json env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, disabled by default), the
 * status bar, and workspace trust (`.claude.json` projects[...].hasTrustDialogAccepted,
 * pre-answered by default). Verifies each disable/read/set round-trip preserves
 * unrelated state, and that a managed account dir gets the same treatment (presence
 * AND absence). Runs against a temp HOME (set BEFORE import - claude.ts resolves the
 * global path via homedir()).
 */
import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, parse } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "enigma-claude-settings-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const {
    disableClaudeFeedbackSurvey, getClaudeFeedbackSurvey, setClaudeFeedbackSurvey, mirrorClaudeSettings,
    enableClaudeStatusline, disableClaudeStatusline, getClaudeStatusline, setClaudeStatusline, hasCustomClaudeStatusline,
    claudeWorkspaceKey, getClaudeTrust, trustClaudeWorkspaces, untrustClaudeWorkspaces, mirrorClaudeTrust,
} = await import("../src/claude");

const GLOBAL = join(HOME, ".claude", "settings.json");
/** Claude's user-global state file, where workspace trust lives (not settings.json). */
const STATE = join(HOME, ".claude.json");
/** The filesystem root enigma trusts to cover every path on the drive. */
const ROOT = normalize(parse(HOME).root).replaceAll("\\", "/");
const projectsIn = (path: string): Record<string, Record<string, unknown>> =>
    readJson(path).projects as Record<string, Record<string, unknown>>;
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
    // Trust state is per-test: every trust case starts from "never answered".
    rmSync(STATE, { force: true });
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
    // Without a timer the bar freezes for exactly as long as a pipeline blocks. Ten
    // seconds rather than the minimum of one: every refresh spawns a process, and on
    // Windows each spawn creates console hosts.
    expect(line?.refreshInterval).toBe(10);
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

test("the registry records intent in config and applies it to settings.json", async () => {
    const { ALL_SETTINGS } = await import("../src/settings-registry");
    const setting = ALL_SETTINGS.find((s) => s.key === "statusline");
    expect(setting).toBeDefined();

    // On by default, and the flag is what the surfaces read.
    expect(setting!.read("global")).toBe(true);

    expect(setting!.write(true, "global")).toMatchObject({ changed: true });
    expect(getClaudeStatusline("global")).toBe(true);

    // Turning it off must persist as intent, not only as an absent settings.json key -
    // otherwise the next sync cannot tell it apart from a fresh machine.
    expect(setting!.write(false, "global")).toMatchObject({ changed: true });
    expect(setting!.read("global")).toBe(false);
    expect(getClaudeStatusline("global")).toBe(false);

    writeJson(GLOBAL, { statusLine: { type: "command", command: "my-own-bar" } });
    const refused = setting!.write(true, "global");
    expect(refused.changed).toBe(false);
    expect(refused.error).toContain("already set");
});

test("the workspace key is the git repository root, forward-slashed like Claude writes it", () => {
    const repo = join(HOME, "repo");
    const nested = join(repo, "src", "deep");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    // A key the client would not compute is an entry it never reads, so this must be the
    // repo root even when the agent is launched several directories down.
    expect(claudeWorkspaceKey(nested)).toBe(normalize(repo).replaceAll("\\", "/"));
    expect(claudeWorkspaceKey(nested)).not.toContain("\\");

    // Outside a repository the directory itself is the workspace.
    const plain = join(HOME, "plain");
    mkdirSync(plain, { recursive: true });
    expect(claudeWorkspaceKey(plain)).toBe(normalize(plain).replaceAll("\\", "/"));
});

test("trust marks the filesystem root and the workspace, leaving the rest of the file alone", () => {
    const workspace = join(HOME, "workspace");
    mkdirSync(workspace, { recursive: true });
    const other = `${ROOT}other/repo`;
    writeJson(STATE, {
        oauthAccount: { emailAddress: "someone@example.com" },
        projects: { [other]: { hasTrustDialogAccepted: false, allowedTools: ["Bash"] } },
    });

    expect(getClaudeTrust()).toBe(false);
    expect(trustClaudeWorkspaces(STATE, workspace)).toBe(true);

    const projects = projectsIn(STATE);
    // The root covers every path on the drive; the workspace entry is what lets Claude
    // skip its permission-grant backstop for this project.
    expect(projects[ROOT].hasTrustDialogAccepted).toBe(true);
    expect(projects[claudeWorkspaceKey(workspace)].hasTrustDialogAccepted).toBe(true);
    // A new entry carries the shape the client writes itself.
    expect(projects[ROOT].allowedTools).toEqual([]);
    // The login and other projects survive untouched.
    expect((readJson(STATE).oauthAccount as Record<string, unknown>).emailAddress).toBe("someone@example.com");
    expect(projects[other].allowedTools).toEqual(["Bash"]);
    expect(projects[other].hasTrustDialogAccepted).toBe(false);

    // Idempotent: the launch path re-runs this on every start.
    expect(trustClaudeWorkspaces(STATE, workspace)).toBe(false);
});

test("turning trust off clears the blanket and keeps the workspaces already accepted", () => {
    const workspace = join(HOME, "workspace");
    mkdirSync(workspace, { recursive: true });
    trustClaudeWorkspaces(STATE, workspace);

    expect(untrustClaudeWorkspaces(STATE)).toBe(true);
    expect(projectsIn(STATE)[ROOT].hasTrustDialogAccepted).toBe(false);
    // A per-workspace entry is indistinguishable from one the user accepted by hand, so
    // switching the setting off must not re-ask for projects they already trusted.
    expect(projectsIn(STATE)[claudeWorkspaceKey(workspace)].hasTrustDialogAccepted).toBe(true);
    expect(untrustClaudeWorkspaces(STATE)).toBe(false);
});

test("a state file that cannot be parsed is never overwritten", () => {
    // It holds the login and every project's state: a bad parse must abort, not clobber.
    writeFileSync(STATE, "{ not json");
    expect(trustClaudeWorkspaces(STATE, HOME)).toBe(false);
    expect(readFileSync(STATE, "utf8")).toBe("{ not json");
});

test("the trust setting records intent in config and answers the prompt in Claude's state", async () => {
    const { ALL_SETTINGS } = await import("../src/settings-registry");
    const setting = ALL_SETTINGS.find((s) => s.key === "claude-trust");
    expect(setting).toBeDefined();
    // Claude's trust store is user-global; a project-local write would change nothing.
    expect(setting!.globalOnly).toBe(true);

    // On by default, and the flag is what the surfaces read.
    expect(setting!.read("global")).toBe(true);
    expect(setting!.write(true, "global")).toMatchObject({ changed: true });
    expect(getClaudeTrust()).toBe(true);

    // Off has to persist as intent, not only as absent trust - otherwise the next install
    // or sync cannot tell it apart from a machine that never had the setting.
    expect(setting!.write(false, "global")).toMatchObject({ changed: true });
    expect(setting!.read("global")).toBe(false);
    expect(getClaudeTrust()).toBe(false);
});

test("mirrorClaudeTrust propagates trust into a managed account, presence and absence", () => {
    const accountDir = join(HOME, ".enigma", "claude", "trusted");
    mkdirSync(accountDir, { recursive: true });
    const accountState = join(accountDir, ".claude.json");

    // An account has its own .claude.json, so without this it would meet the prompt the
    // default account no longer shows.
    trustClaudeWorkspaces(STATE, process.cwd());
    expect(mirrorClaudeTrust(accountDir)).toBe(true);
    expect(projectsIn(accountState)[ROOT].hasTrustDialogAccepted).toBe(true);

    untrustClaudeWorkspaces(STATE);
    expect(mirrorClaudeTrust(accountDir)).toBe(true);
    expect(projectsIn(accountState)[ROOT].hasTrustDialogAccepted).toBe(false);
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
