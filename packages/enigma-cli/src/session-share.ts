/**
 * Cross-account session sharing.
 *
 * Claude Code resolves a conversation only from a real transcript file under
 * `<config-dir>/projects/<workspace-slug>/`, and each account has its own config dir,
 * so a session recorded under one account is invisible to the others: `/resume` does
 * not list it and `--resume <id>` reports no conversation found.
 *
 * Neither of the cheap filesystem tricks substitutes for the file. The client skips
 * reparse points, so a junction to another account's tree lists nothing, and it refuses
 * a transcript whose link count is above one, so a hardlink is found and then rejected.
 * A plain copy is the only mechanism that works, which is what this module does.
 *
 * The mirror runs in both directions between every config dir of a tool and copies only
 * what is missing, so the steady state is a directory walk rather than a copy. A
 * transcript written in the last `LIVE_WINDOW_MS` is skipped: it belongs to a session
 * that is still running, and copying it mid-append would publish a truncated turn.
 */

import { listAccounts } from "./accounts";
import { join, relative } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";

/** A transcript touched this recently belongs to a live session; copying it would truncate a turn. */
const LIVE_WINDOW_MS = 60_000;

/** Transcript extension Claude Code writes, including the nested subagent ones. */
const TRANSCRIPT_EXT = ".jsonl";

/** Every existing `projects` tree across a tool's accounts, the tool's own default dir included. */
function sessionRoots(toolName: string): string[] {
    const roots: string[] = [];
    for (const account of listAccounts(toolName)) {
        const root = join(account.dir, "projects");
        if (existsSync(root)) roots.push(root);
    }
    return roots;
}

/** Absolute paths of every transcript under `root`, nested subagent directories included. */
function transcripts(root: string, out: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) transcripts(path, out);
        else if (entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXT)) out.push(path);
    }
    return out;
}

/**
 * Copy the transcripts `src` has and `dst` lacks, preserving their path relative to the
 * tree root so the workspace slug (and any subagent directory) survives the move. Returns
 * how many files were copied. A file that cannot be read is skipped, never fatal.
 */
function mirror(src: string, dst: string): number {
    const now = Date.now();
    let copied = 0;
    for (const path of transcripts(src)) {
        const target = join(dst, relative(src, path));
        if (existsSync(target)) continue;
        try {
            if (now - statSync(path).mtimeMs < LIVE_WINDOW_MS) continue;
            mkdirSync(join(target, ".."), { recursive: true });
            copyFileSync(path, target);
            copied++;
        } catch { /* unreadable or vanished mid-walk: skip it */ }
    }
    return copied;
}

/**
 * Mirror missing transcripts between every pair of the tool's account config dirs, so a
 * conversation started under one account can be listed and resumed from any other.
 * Returns the number of transcripts copied; zero once the accounts agree.
 *
 * `roots` defaults to the tool's accounts and exists so a caller (the test) can name the
 * trees outright: account discovery freezes its base paths at import, which a test sharing
 * a process with others cannot steer.
 */
export function syncSessions(toolName: string, roots: string[] = sessionRoots(toolName)): number {
    if (roots.length < 2) return 0;

    let copied = 0;
    for (const src of roots) {
        for (const dst of roots) {
            if (src !== dst) copied += mirror(src, dst);
        }
    }
    return copied;
}
