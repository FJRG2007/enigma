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
 *   accumulates. Mirroring itself never deletes - pruning a user's transcripts is not something
 *   a launch does on its own. `unshareSessions` is that undo, and it is asked for explicitly.
 *
 * A transcript written in the last `LIVE_WINDOW_MS` is skipped on BOTH sides: as a source it
 * belongs to a session that is still running and copying it mid-append would publish a truncated
 * turn, and as a destination it is a file a client currently has open - replacing that one swaps
 * the file out from under the writer, which loses every turn it appends afterwards (POSIX keeps
 * the unlinked inode) or fails the rename outright (Windows holds the file). Either side being
 * live leaves the pair for the next run. A copy carries its origin's mtime, so a transcript this
 * module just wrote never reads as live in its new tree.
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_NAME, listAccounts } from "./accounts";
import { listJsonl, outranks } from "./claude-transcripts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync } from "node:fs";

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
 * The trees with each directory named once.
 *
 * Two roots resolving to the same dir would put every transcript into its group TWICE, as two
 * distinct records of one file - and a file is trivially a byte-for-byte prefix of itself, so the
 * prune would take the keeper's own copy as redundant and delete the only one there is. The
 * registry's `dir` is user-editable and `roots` is a parameter, so neither side is trusted to be
 * distinct; `resolve` settles a trailing separator or a different spelling of the same path.
 */
function distinctRoots(trees: SessionRoot[]): SessionRoot[] {
    const seen = new Set<string>();
    const out: SessionRoot[] = [];
    for (const tree of trees) {
        const key = resolve(tree.dir);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tree);
    }
    return out;
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
        // A destination inside the live window is a transcript a client has open right now, so the
        // rename would pull the file out from under it; the copy it is a stale prefix of waits for
        // the next run. The guard the source already gets, in the other direction.
        if (held && now - held.mtimeMs < LIVE_WINDOW_MS) continue;
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
    const trees = distinctRoots(roots ?? sessionRoots(toolName));
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

/** One tree's copy of a transcript, with the stamps that decide which copy is the one to keep. */
interface Held { writable: boolean; path: string; size: number; mtimeMs: number; birthtimeMs: number; }

/** A transcript several trees hold: the copy that outranks the rest, and the prunable ones beside it. */
interface Duplicate { keep: Held; copies: Held[]; }

/** Whether `dir` sits strictly INSIDE one of `roots` - a root itself, and anything above it, is out. */
function within(dir: string, roots: string[]): boolean {
    return roots.some((root) => {
        const rel = relative(root, dir);
        return rel !== "" && !isAbsolute(rel) && !rel.split(sep).includes("..");
    });
}

/**
 * Remove the directories a prune emptied, up to but never including a tree root. A session whose
 * transcript is gone leaves its `<session-id>/subagents/` shell behind, and a tree full of empty
 * session directories reads as one that still holds conversations.
 *
 * The boundary is structural rather than a string match against the roots: this loop deletes, and
 * a root spelled with a trailing separator, or in another case on a case-insensitive filesystem,
 * would compare unequal and let it climb straight out of the tree.
 */
function pruneEmpty(from: string, roots: string[]): void {
    let dir = from;
    while (within(dir, roots)) {
        try {
            if (readdirSync(dir).length) return;
            rmdirSync(dir);
        } catch { return; }
        const parent = dirname(dir);
        if (parent === dir) return;
        dir = parent;
    }
}

/**
 * Every transcript more than one tree holds, grouped by the path relative to the tree root - which
 * a mirrored copy preserves exactly, the same identity usage.ts dedupes on. No age bound: what a
 * prune has to reach is precisely the history the mirroring window let accumulate.
 *
 * Stat-only, deliberately. What it returns are CANDIDATES: same relative path, and a sibling that
 * outranks them. Proving one actually redundant means reading both files whole, which is the
 * expensive half and belongs to `plannedUnshare` rather than to anything that only wants a count.
 */
function duplicates(trees: SessionRoot[], now: number): Duplicate[] {
    const groups = new Map<string, Held[]>();
    for (const root of trees) {
        for (const path of listJsonl(root.dir)) {
            let st: import("node:fs").Stats;
            try { st = statSync(path); } catch { continue; }
            const rel = relative(root.dir, path);
            const held: Held = { writable: root.writable, path, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
            const group = groups.get(rel);
            if (group) group.push(held);
            else groups.set(rel, [held]);
        }
    }
    const out: Duplicate[] = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        let keep = group[0]!;
        for (const held of group) if (outranks(held, keep)) keep = held;
        // The user's own config dir is a source only, the same boundary mirroring holds, and a copy
        // inside the live window belongs to a running session - deleting that one takes the file out
        // from under the client writing it, so it waits for the next prune.
        const copies = group.filter((held) => held !== keep && held.writable && now - held.mtimeMs >= LIVE_WINDOW_MS);
        if (copies.length) out.push({ keep, copies });
    }
    return out;
}

/**
 * How many transcripts in the writable trees LOOK like copies another account holds. Stat-only, so
 * a listing can afford to mention them; the exact figure is what `enigma account unshare` previews,
 * since proving each one redundant reads both files to the end.
 */
export function mirroredCopies(toolName: string, roots?: SessionRoot[]): number {
    if (toolName !== SHARED_TOOL) return 0;
    const trees = distinctRoots(roots ?? sessionRoots(toolName));
    if (trees.length < 2) return 0;
    return duplicates(trees, Date.now()).reduce((n, dup) => n + dup.copies.length, 0);
}

/** A copy proved redundant, with the stamps that must still hold when it is actually deleted. */
interface Doomed { path: string; size: number; mtimeMs: number; }

/** A prune's plan: the copies proved redundant, what removing them reclaims, and the trees scanned. */
export interface UnsharePlan { removed: number; bytes: number; victims: Doomed[]; roots: string[]; }

/** What a prune removed, or would remove when previewing. */
export interface UnshareResult { removed: number; bytes: number; }

/**
 * Plan the undo of the mirroring: every transcript in a writable tree that is a COPY of one another
 * account still holds in full, so each conversation ends up listed by the account that recorded it.
 *
 * Turning sharing off only stops NEW copies: a tree already mirrored keeps listing the merged
 * superset in `/resume` forever, and the refresh that healed a copy taken mid-conversation stops
 * running too, leaving a truncated snapshot that resumes with turns missing. Both are the same
 * leftover file, and this is what finds it. The trees compared are the tool's ACCOUNTS - the shared
 * store (session-store.ts) is not one of them, so history the store absorbed is out of reach here.
 *
 * Deleting a transcript is not recoverable, so a copy is planned only when it is provably redundant:
 * the kept file contains it byte for byte, so a tree that diverged here keeps its own turns, and the
 * keeper itself is never touched - every conversation survives in exactly one place.
 *
 * Separated from `applyUnshare` so the CLI proves each copy ONCE and then deletes what it previewed
 * and confirmed, rather than paying the whole byte comparison twice.
 */
export function plannedUnshare(toolName: string, roots?: SessionRoot[]): UnsharePlan {
    const trees = toolName === SHARED_TOOL ? distinctRoots(roots ?? sessionRoots(toolName)) : [];
    const victims: Doomed[] = [];
    if (trees.length >= 2) {
        for (const dup of duplicates(trees, Date.now())) {
            for (const held of dup.copies) {
                if (!continues(dup.keep.path, held.path, held.size)) continue;
                victims.push({ path: held.path, size: held.size, mtimeMs: held.mtimeMs });
            }
        }
    }
    return { removed: victims.length, bytes: victims.reduce((n, v) => n + v.size, 0), victims, roots: trees.map((tree) => tree.dir) };
}

/**
 * Delete the copies in `plan`, then remove the directories that emptied.
 *
 * Each victim is re-stat'd first: the proof was taken before the confirmation prompt, and a
 * transcript that grew or was touched since is no longer the file that was proved redundant - it
 * keeps its turns and waits for the next run.
 */
export function applyUnshare(plan: UnsharePlan): UnshareResult {
    const result: UnshareResult = { removed: 0, bytes: 0 };
    const now = Date.now();
    const emptied = new Set<string>();
    for (const victim of plan.victims) {
        let st: import("node:fs").Stats;
        try { st = statSync(victim.path); } catch { continue; }
        if (st.size !== victim.size || st.mtimeMs !== victim.mtimeMs) continue;
        if (now - st.mtimeMs < LIVE_WINDOW_MS) continue;
        try { unlinkSync(victim.path); } catch { continue; }
        emptied.add(dirname(victim.path));
        result.removed++;
        result.bytes += victim.size;
    }
    for (const dir of emptied) pruneEmpty(dir, plan.roots);
    return result;
}

/** Plan and run the prune in one call. `dryRun` counts without writing. */
export function unshareSessions(toolName: string, roots?: SessionRoot[], opts: { dryRun?: boolean; } = {}): UnshareResult {
    const plan = plannedUnshare(toolName, roots);
    return opts.dryRun ? { removed: plan.removed, bytes: plan.bytes } : applyUnshare(plan);
}
