/**
 * Blocks AI attribution in commits and PRs while Claude attribution is off (enigma's default).
 *
 * WHY A HOOK AND NOT THE SETTING ALONE: `attribution.commit: ""` only stops Claude Code's own
 * commit template. It does nothing when the model writes the trailer itself, and that is what
 * reached a real merge: a subagent typed `Co-Authored-By: Claude <noreply@anthropic.com>` into
 * `git commit -m "..."` with the setting off, GitHub's squash merge collected it from the branch
 * commits, and the merge showed "<user> and claude" as authors.
 *
 * WHY A HOOK AND NOT A PERMISSION DENY RULE: measured, `Bash(*noreply@anthropic.com*)` denies a
 * multi-line `-m` string, in the main agent and in subagents, but NOT the body of a heredoc
 * (`git commit -F - <<'EOF'`), which is the most common way agents pass a long message. A
 * PreToolUse hook receives the whole command, heredoc included.
 *
 * COST: the hook handlers carry an `if` filter in permission-rule syntax, so Claude Code spawns
 * this process only for `git commit`, `git -C <dir> commit` and `gh pr create|edit|merge` -
 * never for the other Bash calls of a session. Subagent tool calls fire the same hooks.
 *
 * Messages passed by file (`-F <file>`, `--file`, `--body-file`) are read from disk relative to
 * the payload's cwd. A message written by an editor cannot be seen here; the turn-end check
 * (`attributedCommits` in verify.ts) covers whatever reaches history anyway.
 */

import { join } from "node:path";
import { enigmaHome, readJson } from "./util";
import { applyClaudeHook } from "./claude-hooks";
import { readFileSync, statSync } from "node:fs";
import type { HookGroup, HookWrite } from "./claude-hooks";

/** Marker identifying enigma's handlers in settings.json (see applyClaudeHook). */
const MARKER = "__attribution-guard";

/**
 * Lines that attribute work to an AI assistant: an Anthropic co-author trailer (any casing,
 * any display name) and Claude Code's "Generated with" footer, with or without its link.
 */
const ATTRIBUTION_RE = /^[ \t>*-]*co-authored-by:[^\n]*(?:noreply@anthropic\.com|\bclaude\b)[^\n]*$|generated with \[?claude code\]?/im;

/** Commands the hook is spawned for, in Claude Code's permission-rule syntax. */
const COMMAND_PATTERNS = ["git commit*", "git -C * commit*", "gh pr create*", "gh pr edit*", "gh pr merge*"];

/** Largest message file read; a commit message beyond this is not a message. */
const MAX_MESSAGE_FILE = 1024 * 1024;

/** The first attribution line in `text`, or "" when there is none. */
export function attributionLine(text: string): string {
    const match = ATTRIBUTION_RE.exec(text);
    return match ? match[0].trim().replace(/["'`]+$/, "") : "";
}

/**
 * Paths named as a message source in `command`: `-F <f>`, `-F<f>`, `--file <f>`, `--file=<f>`,
 * `--body-file <f>`. `-` means stdin, whose text is already in the command (a heredoc), so it is
 * skipped.
 */
export function messageFiles(command: string): string[] {
    const files: string[] = [];
    const re = /(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+|(?=[^\s-]))("[^"]+"|'[^']+'|\S+)/g;
    for (let m = re.exec(command); m !== null; m = re.exec(command)) {
        const raw = m[1]!.replace(/^["']|["']$/g, "");
        if (raw !== "-") files.push(raw);
    }
    return files;
}

/** Reads a message file, or "" when it is missing, unreadable or too large to be one. */
function readMessageFile(cwd: string, file: string): string {
    const path = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(file) ? file : join(cwd, file);
    try {
        if (statSync(path).size > MAX_MESSAGE_FILE) return "";
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

/** The fields of a PreToolUse payload this hook reads, checked before use. */
interface GuardPayload { command: string; cwd: string; }

/** Validates the payload shape; null when it is not a Bash/PowerShell call with a command. */
export function parseGuardPayload(raw: string): GuardPayload | null {
    let data: unknown;
    try { data = JSON.parse(raw.replace(/^﻿/, "")); } catch { return null; }
    if (typeof data !== "object" || data === null) return null;
    const record = data as Record<string, unknown>;
    if (record.tool_name !== "Bash" && record.tool_name !== "PowerShell") return null;
    const input = record.tool_input;
    if (typeof input !== "object" || input === null) return null;
    const command = (input as Record<string, unknown>).command;
    if (typeof command !== "string" || command === "") return null;
    const cwd = typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : process.cwd();
    return { command, cwd };
}

/**
 * Hook entry. Exit 2 with the reason on stderr denies the call and feeds the reason back to
 * the model; anything that cannot be read lets the call through, since this hook only exists
 * to stop one specific line and must never break an unrelated command.
 */
export function runAttributionGuardHook(raw: string): number {
    const payload = parseGuardPayload(raw);
    if (payload === null) return 0;
    let found = attributionLine(payload.command);
    for (const file of found === "" ? messageFiles(payload.command) : []) {
        found = attributionLine(readMessageFile(payload.cwd, file));
        if (found !== "") break;
    }
    if (found === "") return 0;
    process.stderr.write(`enigma: AI attribution is turned off here, and this message carries "${found}". Remove that line and run the command again. (enigma config claude-attribution on allows it.)\n`);
    return 2;
}

/** The PreToolUse group: one filtered handler per command pattern and shell tool. */
function guardGroup(): HookGroup {
    const hooks = ["Bash", "PowerShell"].flatMap((tool) =>
        COMMAND_PATTERNS.map((pattern) => ({ type: "command", command: `enigma ${MARKER}`, timeout: 10, if: `${tool}(${pattern})` }))
    );
    return { matcher: "Bash|PowerShell", hooks };
}

/** Installs (on) or removes the guard in a Claude settings.json, leaving everything else. */
export function applyAttributionGuard(settingsPath: string, on: boolean): HookWrite {
    return applyClaudeHook(settingsPath, "PreToolUse", MARKER, guardGroup(), on);
}

/**
 * Whether attribution is off for the Claude session this process runs under. A hook inherits
 * the session's environment, so an account launched with CLAUDE_CONFIG_DIR is read from its own
 * settings.json, not the default account's.
 */
export function attributionOff(): boolean {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(enigmaHome(), ".claude");
    const settings = readJson<Record<string, unknown>>(join(dir, "settings.json")) || {};
    const attribution = settings.attribution as Record<string, unknown> | undefined;
    return Boolean(attribution) && attribution!.commit === "" && settings.includeCoAuthoredBy === false;
}

/**
 * Unpushed commits on HEAD whose message carries an AI attribution line, as `[sha, line]`.
 * `log` is the output of `git log --format=%H%x1e%B%x1d HEAD --not --remotes`, passed in so the
 * caller owns the git call (verify.ts shares one helper for every git read).
 */
export function attributedCommits(log: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const record of log.split("\x1d")) {
        const [sha = "", body = ""] = record.split("\x1e");
        const line = attributionLine(body);
        if (sha.trim() && line) out.push([sha.trim(), line]);
    }
    return out;
}
