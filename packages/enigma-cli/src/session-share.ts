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
 * A transcript is an append-only log that another process is still writing, so four rules
 * bound what the copying can damage:
 *
 * - The user's own config dir is a SOURCE, never a destination. Managed account dirs are
 *   enigma-created containers, but `~/.claude` is the user's own and other logins'
 *   conversations are not written into it - the boundary packs already hold.
 * - A copy is refreshed when its origin has genuinely CONTINUED it - the copy is byte-for-byte
 *   the head of the origin - instead of being left as the frozen snapshot it was taken as. Size
 *   and mtime cannot decide this on their own: a tree that diverged and happens to be longer
 *   looks exactly like one that appended, and taking it would drop the turns on the other side.
 *   So two trees that BOTH advanced are left alone, neither being a superset of the other.
 * - The copy lands through a temp file and a rename, so an interrupt cannot leave a
 *   half-written transcript that later runs would read as complete.
 * - Only transcripts touched within `MAX_AGE_MS` are mirrored, which bounds what each account
 *   accumulates. Existing copies are never deleted - pruning a user's transcripts is not
 *   something this does on its own.
 *
 * A transcript written in the last `LIVE_WINDOW_MS` is skipped: it belongs to a session that
 * is still running, and copying it mid-append would publish a truncated turn.
 */

import { randomUUID } from "node:crypto";
import { listJsonl } from "./claude-transcripts";
import { dirname, join, relative } from "node:path";
import { DEFAULT_NAME, listAccounts } from "./accounts";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";

/** A transcript touched this recently belongs to a live session; copying it would truncate a turn. */
const LIVE_WINDOW_MS = 60_000;

/**
 * How far back a transcript is worth mirroring. Sharing exists so a RECENT conversation can be
 * resumed from another account; without a bound, every account ends up holding every other
 * account's entire history, and the first launch copies that whole corpus.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The only tool this mirrors for. Every rule here is Claude Code transcript semantics - the
 * `projects/<slug>/` layout, the nested `subagents/` directory, append-only JSONL where a longer
 * file sharing a prefix means more turns, the live window - so another tool that grows a
 * `projects` directory is left alone until its format is verified, the bar claude-transcripts.ts
 * holds for the same reason.
 */
const SHARED_TOOL = "claude";

/** One account's transcript tree. `writable` is false for the tool's own (the user's) config dir. */
export interface SessionRoot { dir: string; writable: boolean; }

/** A transcript offered to the other trees, with the identity and stamps a copy is judged by. */
interface Transcript { path: string; rel: string; size: number; mtimeMs: number; }

/**
 * Every existing `projects` tree across a tool's accounts. The tool's own default dir is
 * included as a source but marked unwritable, so its history reaches the accounts the user
 * created without the reverse ever landing in `~/.claude`.
 */
function sessionRoots(toolName: string): SessionRoot[] {
    const roots: SessionRoot[] = [];
    for (const account of listAccounts(toolName)) {
        const dir = join(account.dir, "projects");
        if (existsSync(dir)) roots.push({ dir, writable: account.name !== DEFAULT_NAME });
    }
    return roots;
}

/**
 * The transcripts under `root` worth offering to another tree: neither live nor older than
 * `MAX_AGE_MS`, each carrying its path relative to the tree root so the workspace slug (and any
 * nested subagent directory) survives the move. One walk per tree, reused for every destination.
 */
function offered(root: string, now: number): Transcript[] {
    const out: Transcript[] = [];
    for (const path of listJsonl(root)) {
        let st: import("node:fs").Stats;
        try { st = statSync(path); } catch { continue; }
        const age = now - st.mtimeMs;
        if (age < LIVE_WINDOW_MS || age > MAX_AGE_MS) continue;
        out.push({ path, rel: relative(root, path), size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
}

/**
 * Copy a transcript to `target` through a temp file, then stamp it with the source's mtime so
 * the copy and its origin compare as the same content. The temp name does not end in `.jsonl`,
 * so neither the client nor the next walk can mistake a partial write for a transcript.
 */
function copyTranscript(src: Transcript, target: string): void {
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
        copyFileSync(src.path, tmp);
        const stamp = new Date(src.mtimeMs);
        utimesSync(tmp, stamp, stamp);
        renameSync(tmp, target);
    } catch (err) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* leftover temp is harmless */ }
        throw err;
    }
}

/**
 * How long a temp file must have sat untouched before it is taken for an interrupted copy rather
 * than one a concurrent run is still writing. Generous: deleting a live temp file would only fail
 * that copy, but the window costs nothing to keep wide.
 */
const TEMP_GRACE_MS = 5 * 60_000;

/**
 * Delete the temp files an interrupted copy left in `dir`. A process killed between the copy and
 * the rename cannot clean up after itself, and the name is deliberately not `.jsonl`, so nothing
 * else would ever surface them - they would sit in the user's tree at full transcript size.
 */
function sweepTemp(dir: string, now: number): void {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith(".") || !e.name.endsWith(".tmp")) continue;
        const path = join(dir, e.name);
        try { if (now - statSync(path).mtimeMs > TEMP_GRACE_MS) unlinkSync(path); } catch { /* vanished or held open */ }
    }
}

/** How much of two transcripts is compared at a time, so the check costs bounded memory. */
const COMPARE_CHUNK = 64 * 1024;

/**
 * Whether the first `length` bytes of `src` are exactly the contents of `target` - that is,
 * whether `src` is `target` with more turns appended. Compared in chunks so a large transcript
 * is never held in memory, and short-circuiting at the first difference. Unreadable either side
 * answers false, which leaves the destination untouched.
 */
function continues(src: string, target: string, length: number): boolean {
    let a: number | null = null;
    let b: number | null = null;
    try {
        a = openSync(src, "r");
        b = openSync(target, "r");
        const bufA = Buffer.alloc(COMPARE_CHUNK);
        const bufB = Buffer.alloc(COMPARE_CHUNK);
        for (let at = 0; at < length;) {
            const want = Math.min(COMPARE_CHUNK, length - at);
            if (readSync(a, bufA, 0, want, at) !== want) return false;
            if (readSync(b, bufB, 0, want, at) !== want) return false;
            if (!bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false;
            at += want;
        }
        return true;
    } catch { return false; }
    finally {
        for (const fd of [a, b]) if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
}

/**
 * Copy into `dst` every offered transcript it lacks, or holds only an earlier prefix of. Returns
 * how many files were written. A file that cannot be read is skipped, never fatal. Each directory
 * written into is swept once per run (`swept` carries that across calls), so a copy an earlier run
 * was interrupted mid-way through does not leave its temp file behind for good.
 */
function mirror(offers: Transcript[], dst: string, now: number, swept: Set<string>): number {
    let copied = 0;
    for (const src of offers) {
        const target = join(dst, src.rel);
        const dir = dirname(target);
        if (!swept.has(dir)) { swept.add(dir); sweepTemp(dir, now); }
        let held: import("node:fs").Stats | null = null;
        try { held = statSync(target); } catch { /* absent: copy it */ }
        // The byte comparison runs only when the source is longer, so the steady state stays one
        // stat per file: same size means the trees already agree, and shorter means this tree is
        // the one that is ahead (the other direction of the mirror carries it back).
        if (held && !(src.size > held.size && continues(src.path, target, held.size))) continue;
        try { copyTranscript(src, target); copied++; } catch { /* unreadable or vanished mid-walk: skip it */ }
    }
    return copied;
}

/**
 * Mirror transcripts from every one of the tool's account config dirs into the writable ones, so
 * a conversation started under one account can be listed and resumed from another. Returns the
 * number of transcripts copied; zero once the accounts agree.
 *
 * Only `SHARED_TOOL` is mirrored; any other tool is a no-op even if it grows a `projects` tree.
 *
 * `roots` defaults to the tool's accounts and exists so a caller (the test) can name the trees
 * outright: account discovery freezes its base paths at import, which a test sharing a process
 * with others cannot steer.
 */
export function syncSessions(toolName: string, roots?: SessionRoot[]): number {
    if (toolName !== SHARED_TOOL) return 0;
    const trees = roots ?? sessionRoots(toolName);
    const writable = trees.filter((root) => root.writable);
    if (trees.length < 2 || writable.length === 0) return 0;

    const now = Date.now();
    const swept = new Set<string>();
    let copied = 0;
    for (const src of trees) {
        const offers = offered(src.dir, now);
        if (!offers.length) continue;
        for (const dst of writable) {
            if (dst.dir !== src.dir) copied += mirror(offers, dst.dir, now, swept);
        }
    }
    return copied;
}
