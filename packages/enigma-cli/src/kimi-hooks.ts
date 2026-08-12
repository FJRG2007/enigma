/**
 * One read-merge-write for enigma's hooks in a Kimi Code config.toml.
 *
 * Kimi keeps lifecycle hooks as a `[[hooks]]` array of tables inside its single user-level
 * config file, next to models, providers and permission rules - so a hook write has to edit
 * a file full of settings enigma does not own. There is no TOML dependency in this project
 * (config writers are hand-rolled by design, see permissions.ts), and a full parse/serialize
 * round-trip would reformat and reorder everything the user wrote. So this edits the text:
 * it locates our own `[[hooks]]` block by a marker in its `command`, drops it, and re-appends
 * the desired one at the end. Every other table, comment and blank line survives untouched.
 *
 * Kimi rejects a `[[hooks]]` entry carrying any field outside event/matcher/command/timeout
 * (the whole config fails to load), so the emitted block is restricted to those four.
 *
 * Node builtins only, so it stays as cheap to load as the deploy modules that use it.
 */

import { dirname } from "node:path";
import type { HookWrite } from "./claude-hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** One hook rule as Kimi's config.toml stores it. `timeout` is in seconds (1-600). */
export interface KimiHook {
    event: string;
    matcher?: string;
    command: string;
    timeout?: number;
}

/**
 * A TOML table header line (`[table]` or `[[array]]`), and not an array value that merely
 * starts with a bracket - so a multi-line array in the user's config is never mistaken for
 * the start of a new table.
 */
const TABLE_HEADER = /^\s*\[\[?[A-Za-z0-9_."'\- ]+\]\]?\s*(#.*)?$/;
const HOOKS_HEADER = /^\s*\[\[\s*hooks\s*\]\]\s*(#.*)?$/;
const COMMAND_LINE = /^\s*command\s*=\s*(.+?)\s*$/;

/** A TOML basic string: quotes and backslashes escaped, everything else verbatim. */
function tomlString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** Render one `[[hooks]]` block, emitting only the four fields Kimi accepts. */
function renderHook(hook: KimiHook): string {
    const lines = ["[[hooks]]", `event = ${tomlString(hook.event)}`];
    if (hook.matcher !== undefined) lines.push(`matcher = ${tomlString(hook.matcher)}`);
    lines.push(`command = ${tomlString(hook.command)}`);
    if (hook.timeout !== undefined) lines.push(`timeout = ${hook.timeout}`);
    return `${lines.join("\n")}\n`;
}

/**
 * Drop every `[[hooks]]` block whose `command` contains `marker`. A block runs from its
 * header to the line before the next table header (or the end of the file), which is where
 * the four scalar fields Kimi allows can live.
 */
function withoutOurHooks(content: string, marker: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length;) {
        if (!HOOKS_HEADER.test(lines[i]!)) {
            out.push(lines[i]!);
            i++;
            continue;
        }
        let end = i + 1;
        while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) end++;
        const block = lines.slice(i, end);
        const command = block.map((l) => COMMAND_LINE.exec(l)?.[1]).find((v) => v !== undefined);
        if (!(command && command.includes(marker))) out.push(...block);
        i = end;
    }
    return out.join("\n");
}

/**
 * Add (`on`) or remove enigma's `[[hooks]]` rule in a Kimi config.toml, identified by
 * `marker` appearing in its command so the operation is idempotent and never touches a hook
 * the user wrote. Rebuilt deterministically (strip ours, re-append with exactly one blank
 * line before it) so repeated syncs are a fixed point instead of toggling whitespace.
 *
 * Never creates a config file just to record the absence of a hook.
 */
export function applyKimiHook(configPath: string, marker: string, hook: KimiHook, on: boolean): HookWrite {
    const exists = existsSync(configPath);
    if (!exists && !on) return "unchanged";
    const before = exists ? readFileSync(configPath, "utf8") : "";
    const head = withoutOurHooks(before, marker).replace(/\s*$/, "");
    let after: string;
    if (on) after = head ? `${head}\n\n${renderHook(hook)}` : renderHook(hook);
    else after = head ? `${head}\n` : "";
    if (after === before) return "unchanged";
    if (!exists && after.trim() === "") return "unchanged";
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, after);
    return "changed";
}
