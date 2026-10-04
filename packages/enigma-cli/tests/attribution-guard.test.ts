/**
 * The attribution guard refuses an AI co-author trailer or a "Generated with Claude Code"
 * footer in a commit or PR command while attribution is off. The real case it was built for: a
 * subagent typed the trailer into `git commit -m`, and a heredoc body is invisible to a
 * permission deny rule, so both shapes are pinned here.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { attributionLine, messageFiles, parseGuardPayload, runAttributionGuardHook, applyAttributionGuard } from "@/attribution-guard";

const payload = (command: string, cwd = process.cwd(), tool = "Bash"): string => JSON.stringify({ tool_name: tool, tool_input: { command }, cwd });

// The hook reads the session's attribution setting at run time; these tests run with it off.
const configDir = mkdtempSync(join(tmpdir(), "enigma-attr-session-"));
const attributionSettings = (off: boolean): void => writeFileSync(join(configDir, "settings.json"), JSON.stringify(off ? { attribution: { commit: "", pr: "", sessionUrl: false }, includeCoAuthoredBy: false } : {}));
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => { process.env.CLAUDE_CONFIG_DIR = configDir; attributionSettings(true); });
afterEach(() => { if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir; });

test("finds the trailer and the footer in any casing", () => {
    expect(attributionLine("feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toContain("noreply@anthropic.com");
    expect(attributionLine("feat: x\n\nco-authored-by: Claude Opus <noreply@anthropic.com>")).not.toBe("");
    expect(attributionLine("body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).not.toBe("");
    expect(attributionLine("feat: x\n\nCo-authored-by: Jane <jane@example.invalid>")).toBe("");
    expect(attributionLine("docs: explain how Claude Code hooks work")).toBe("");
    expect(attributionLine("fix: block \"Generated with Claude Code\" footers")).toBe("");
    expect(attributionLine("feat: x\n\nCo-authored-by: Claude Monet <claude@example.invalid>")).toBe("");
    expect(attributionLine("git commit -m \"feat: x\" -m \"Generated with Claude Code\" && git push")).toBe("Generated with Claude Code");
});

test("denies the -m, multi-line and heredoc shapes", () => {
    for (const command of [
        "git commit -m \"feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\"",
        "cd repo && git commit -q -F - <<'EOF'\nfeat: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF",
        "gh pr create --title t --body \"x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\"",
    ]) expect(runAttributionGuardHook(payload(command))).toBe(2);
    expect(runAttributionGuardHook(payload("git commit -m \"feat: x\"", process.cwd(), "PowerShell"))).toBe(0);
});

test("reads a message passed by file", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-attr-"));
    writeFileSync(join(dir, "msg.txt"), "feat: z\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    writeFileSync(join(dir, "clean.txt"), "feat: z\n");
    expect(messageFiles("git commit -F msg.txt")).toEqual(["msg.txt"]);
    expect(messageFiles("git commit --file=\"a b.txt\" -F -")).toEqual(["a b.txt"]);
    expect(runAttributionGuardHook(payload("git commit -F msg.txt", dir))).toBe(2);
    expect(runAttributionGuardHook(payload("gh pr create --body-file msg.txt", dir))).toBe(2);
    expect(runAttributionGuardHook(payload("git commit -F clean.txt", dir))).toBe(0);
    expect(runAttributionGuardHook(payload("git commit -F missing.txt", dir))).toBe(0);
});

test("an unreadable or foreign payload never blocks", () => {
    expect(parseGuardPayload("not json")).toBeNull();
    expect(parseGuardPayload(JSON.stringify({ tool_name: "Edit", tool_input: { command: "x" } }))).toBeNull();
    expect(runAttributionGuardHook("")).toBe(0);
});

test("the guard is installed with an if filter per command, and removed cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-attr-settings-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node mine.js" }] }] } }));
    expect(applyAttributionGuard(file, true)).toBe("changed");
    expect(applyAttributionGuard(file, true)).toBe("unchanged");
    const on = JSON.parse(readFileSync(file, "utf8"));
    const ours = on.hooks.PreToolUse.find((g: { hooks: Array<{ command: string; }>; }) => g.hooks[0]!.command.includes("__attribution-guard"));
    expect(ours.hooks.map((h: { if: string; }) => h.if)).toContain("Bash(git commit*)");
    expect(ours.hooks.map((h: { if: string; }) => h.if)).toContain("PowerShell(gh pr merge*)");
    expect(on.hooks.PreToolUse).toHaveLength(2);
    expect(applyAttributionGuard(file, false)).toBe("changed");
    const off = JSON.parse(readFileSync(file, "utf8"));
    expect(off.model).toBe("x");
    expect(off.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "node mine.js" }] }]);
});

test("attributedCommits reads the trailer out of a git log", async () => {
    const { attributedCommits } = await import("@/attribution-guard");
    const log = "aaa111\x1efeat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\x1d\nbbb222\x1efix: y\n\x1d\n";
    expect(attributedCommits(log)).toEqual([["aaa111", "Co-Authored-By: Claude <noreply@anthropic.com>"]]);
});

test("attributionOff reads the session's own config dir", async () => {
    const { attributionOff } = await import("@/attribution-guard");
    const dir = mkdtempSync(join(tmpdir(), "enigma-attr-cfg-"));
    const before = process.env.CLAUDE_CONFIG_DIR;
    try {
        process.env.CLAUDE_CONFIG_DIR = dir;
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: false }, includeCoAuthoredBy: false }));
        expect(attributionOff()).toBe(true);
        writeFileSync(join(dir, "settings.json"), "{}");
        expect(attributionOff()).toBe(false);
    } finally {
        if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    }
});

// The same hook stops a commit or PR message that publishes this machine's home directory - and
// only the message: agents prefix `cd <home>/repo &&`, which is where the command runs.
test("a home path in the message is refused, a home path in the cd is not", async () => {
    const { messageText } = await import("@/attribution-guard");
    const prevWin = process.env.USERPROFILE, prevPosix = process.env.HOME;
    process.env.USERPROFILE = "C:\\Users\\fixture-op";
    process.env.HOME = "C:\\Users\\fixture-op";
    try {
        const cdOnly = "cd C:/Users/fixture-op/repo && git commit -q -m \"fix: tidy the loader\"";
        expect(messageText(cdOnly)).not.toContain("fixture-op");
        expect(runAttributionGuardHook(payload(cdOnly))).toBe(0);
        for (const leaking of [
            "cd C:/Users/fixture-op/repo && git commit -q -m \"test: evidence in C:\\Users\\fixture-op\\AppData\\Local\\Temp\\shot.png\"",
            "git commit -q -F - <<'EOF'\nfeat: x\n\nRan from /c/Users/fixture-op/repo\nEOF",
            "gh pr create --title t --body \"see C:/Users/fixture-op/notes.md\"",
        ]) expect(runAttributionGuardHook(payload(leaking))).toBe(2);
        const dir = mkdtempSync(join(tmpdir(), "enigma-attr-home-"));
        writeFileSync(join(dir, "msg.txt"), "fix: x\n\nlog at C:\\Users\\fixture-op\\tmp\\a.log\n");
        // The message file's own path is not what gets published; its content is.
        expect(runAttributionGuardHook(payload("git commit -F C:/Users/fixture-op/msg.txt", dir))).toBe(0);
        expect(runAttributionGuardHook(payload("git commit -F msg.txt", dir))).toBe(2);
        // A later command in the chain is not part of the message; a separator inside it is.
        for (const chained of [
            "git commit -m \"fix: x\"; ls C:/Users/fixture-op/repo",
            "git commit -m \"fix: x\" | tee C:/Users/fixture-op/log.txt",
            "git commit -m \"fix: x\"\nls C:/Users/fixture-op/repo",
            "git commit -m @'\nfix: x; y | z\n'@; ls C:/Users/fixture-op/repo",
        ]) expect(runAttributionGuardHook(payload(chained, process.cwd(), "PowerShell"))).toBe(0);
        for (const leaking of [
            "git commit -m \"fix: a; see C:/Users/fixture-op/notes.md\"",
            "git commit -m @'\nfix: x\n\nsee C:/Users/fixture-op/notes.md\n'@",
        ]) expect(runAttributionGuardHook(payload(leaking, process.cwd(), "PowerShell"))).toBe(2);
        // With attribution on, the trailer passes and the home path is still refused.
        attributionSettings(false);
        expect(runAttributionGuardHook(payload("git commit -m \"feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\""))).toBe(0);
        expect(runAttributionGuardHook(payload("gh pr create --title t --body \"see C:/Users/fixture-op/notes.md\""))).toBe(2);
    } finally {
        process.env.USERPROFILE = prevWin;
        process.env.HOME = prevPosix;
    }
});
