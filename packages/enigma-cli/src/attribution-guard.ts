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
 * The same hook refuses a message that contains this machine's home directory (account name, OS
 * layout, temp paths), since the commands it already watches are exactly where an agent
 * publishes text. Only the message is read, never the `cd <home>/repo &&` in front of it. That
 * check runs whatever the attribution setting, so the hook is installed either way and the
 * attribution check reads the session's setting at run time (`attributionOff`).
 *
 * Messages passed by file (`-F <file>`, `--file`, `--body-file`) are read from disk relative to
 * the payload's cwd. A message written by an editor cannot be seen here; the turn-end check
 * (`attributedCommits` in verify.ts) covers whatever reaches history anyway.
 */

import { join } from "node:path";
import { enigmaHome, readJson } from "./util";
import { applyClaudeHook } from "./claude-hooks";
import { readFileSync, statSync } from "node:fs";
import { operatorHomePathLeak } from "./guardrails";
import type { HookGroup, HookWrite } from "./claude-hooks";

/** Marker identifying enigma's handlers in settings.json (see applyClaudeHook). */
const MARKER = "__attribution-guard";

/**
 * The two lines that attribute work to an AI assistant, each matching a WHOLE line: an Anthropic
 * co-author trailer (any casing, any display name, an `@anthropic.com` address) and Claude Code's
 * "Generated with" footer, with or without its emoji and link. Prose that only mentions the
 * footer, or a human co-author who happens to be named Claude, is neither.
 */
const CO_AUTHOR = String.raw`[ \t>*-]*co-authored-by:[^\n]*@anthropic\.com\b[^\n]*`;
const FOOTER = String.raw`[ \t>*-]*(?:[^\sA-Za-z0-9]+[ \t]+)?generated with \[?claude code\]?(?:\([^)\n]*\))?[ \t.!]*`;

/**
 * An attribution line in a command or a message. Besides the start of a line, a line can open
 * a message argument (`-m "...`, `--body=...`) and end at its closing quote, which is how a
 * one-line `-m` carries it.
 */
const ATTRIBUTION_RE = new RegExp(String.raw`(?:^|(?:-m|--message|-b|--body)(?:=|[ \t]+)\$?["']?)(${CO_AUTHOR}|${FOOTER})(?:["'\x60][^\n]*)?$`, "im");

/** One message line that is an attribution line and nothing else. */
const ATTRIBUTION_LINE_RE = new RegExp(`^(?:${CO_AUTHOR}|${FOOTER})$`, "i");

/** A `git commit` (also `git -C <dir> commit`) or a `gh pr create|edit|merge` anywhere in a command. */
const COMMIT_OR_PR_RE = /\b(?:git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+commit|gh\s+pr\s+(?:create|edit|merge))\b/;

/** Commands the hook is spawned for, in Claude Code's permission-rule syntax. */
const COMMAND_PATTERNS = ["git commit*", "git -C * commit*", "gh pr create*", "gh pr edit*", "gh pr merge*"];

/** Largest message file read; a commit message beyond this is not a message. */
const MAX_MESSAGE_FILE = 1024 * 1024;

/** The first attribution line in `text`, or "" when there is none. */
export function attributionLine(text: string): string {
    const match = ATTRIBUTION_RE.exec(text);
    return match ? match[1]!.trim().replace(/["'`]+$/, "") : "";
}

/** Removes every attribution line from a message, then collapses the gaps they leave. */
export function stripAttributionLines(text: string): string {
    return text
        .split("\n")
        .filter((line) => !ATTRIBUTION_LINE_RE.test(line.replace(/\r$/, "")))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
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
    // The handlers' `if` filters spawn this only for commit and PR commands, but Claude Code runs a
    // hook whose filter it cannot evaluate - and a command with a heredoc is one of those - so any
    // `cat > x.mjs <<'EOF' ... EOF` naming a home path was refused as a "commit message". Judge
    // only what really commits or publishes a PR.
    if (!COMMIT_OR_PR_RE.test(payload.command)) return 0;
    const off = attributionOff();
    let found = off ? attributionLine(payload.command) : "";
    for (const file of found === "" && off ? messageFiles(payload.command) : []) {
        found = attributionLine(readMessageFile(payload.cwd, file));
        if (found !== "") break;
    }
    if (found !== "") {
        process.stderr.write(`enigma: AI attribution is turned off here, and this message carries "${found}". Remove that line and run the command again. (enigma config claude-attribution on allows it.)\n`);
        return 2;
    }
    // Same commands, same process, whatever the attribution setting: a commit or PR message must
    // not publish this machine's home directory (account name, OS layout, temp paths) - a real
    // report had agents pasting local evidence paths into every PR. Only the MESSAGE is read: the `cd C:/Users/.../repo &&` an
    // agent prefixes and the path of a message file are where the command runs, not what it says.
    const message = [messageText(payload.command), ...messageFiles(payload.command).map((f) => readMessageFile(payload.cwd, f))].join("\n");
    if (operatorHomePathLeak(message).length) {
        process.stderr.write("enigma: this commit or PR message contains a path inside your home directory, which publishes your account name and disk layout. Use a repo-relative path or a file name instead, then run the command again.\n");
        return 2;
    }
    return 0;
}

/**
 * The part of a commit/PR command that becomes the published text: the heredoc body when there
 * is one, else everything after the `git commit` / `gh pr` token up to the next command
 * separator, with message-FILE arguments removed (their content is read separately).
 */
export function messageText(command: string): string {
    const heredoc = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\s*(?:\n|$)/.exec(command);
    const head = COMMIT_OR_PR_RE.exec(command);
    // No commit or PR in the command: nothing it runs is published, a heredoc included.
    if (!head) return "";
    let tail = command.slice(head.index + head[0].length);
    // Cut at the heredoc marker (its body is added below), then at the next chained command.
    tail = tail.split(/<<-?\s*['"]?\w+/)[0] ?? "";
    tail = tail.slice(0, commandEnd(tail));
    tail = tail.replace(/(?:^|\s)(?:-F|--file|--body-file)(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)/g, " ");
    return heredoc ? `${tail}\n${heredoc[2]}` : tail;
}

/**
 * Where the first command in `text` ends: the first `;`, `&&`, `|`, `||` or line break outside a
 * quoted span. Quoted spans are bash/PowerShell single and double quotes and PowerShell
 * here-strings (`@'...'@`, `@"..."@`), so a separator inside the message does not cut it.
 */
function commandEnd(text: string): number {
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        const here = /^@(['"])\r?\n/.exec(text.slice(i, i + 4));
        if (here) {
            const close = text.indexOf(`\n${here[1]}@`, i);
            if (close === -1) return text.length;
            i = close + 2;
        } else if (c === "'" || c === "\"") {
            let j = i + 1;
            while (j < text.length && text[j] !== c) j += c === "\"" && (text[j] === "\\" || text[j] === "`") ? 2 : 1;
            i = j;
        } else if (c === "\\" || c === "`") {
            i++;
        } else if (c === ";" || c === "|" || c === "\n" || c === "\r" || (c === "&" && text[i + 1] === "&")) {
            return i;
        }
    }
    return text.length;
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
