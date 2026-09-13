/**
 * ONE Claude session store shared by every account (opt-in, config `sharedStore`).
 *
 * Claude Code keys its entire state on the config dir `CLAUDE_CONFIG_DIR` points at, and that
 * includes `projects/` - the transcripts `/resume` lists. Giving each account its own dir
 * therefore splits the conversation history along account lines: a conversation started on one
 * login cannot be picked up on the next.
 *
 * There are two ways to close that gap and enigma ships both. `shareSessions` (session-share.ts)
 * COPIES what each tree is missing: nothing moves, every account keeps working as it is, and the
 * price is carrying the history twice. This module is the other trade: every account launches in
 * ONE dir, so switching accounts changes which login is SPENT and nothing else. Nothing is
 * duplicated per launch because nothing is split - at the price of a one-time seed, and of one
 * login at a time.
 *
 * SEEDING. A store that started empty would show an empty `/resume`, which is the failure this
 * whole area exists to prevent, so an account's existing history is moved in the first time it
 * enters. A managed account dir is enigma's own container, so its tree is RENAMED in (instant,
 * and it keeps working because the account now reads the store). The synthetic default is the
 * user's own `~/.claude` and is never mutated, so its tree is COPIED - which on a real history is
 * gigabytes and seconds, hence the notice and hence this being opt-in.
 *
 * OWNERSHIP. The dir of the account whose login the store holds is recorded in `OWNER_FILE`, and
 * it is load-bearing rather than bookkeeping: Anthropic invalidates the previous refresh token on
 * every refresh, so replacing the credential without first handing the rotated one back to the
 * account that owned the store would silently log THAT account out - the ping-pong
 * claude-oauth.ts documents. Every switch settles the outgoing account first.
 *
 * The owner is recorded as a PATH rather than an account name so this stays a leaf with no import
 * back into accounts.ts, and so a renamed account still gets its token back.
 *
 * LIMIT, deliberately not worked around: one store holds one login at a time, so two sessions
 * running CONCURRENTLY under DIFFERENT accounts would fight over the credential file. The same
 * account concurrently is fine, which is the ordinary case (an interactive session alongside a
 * gate run). Anyone who needs two logins at once keeps `shareSessions`, which is the default.
 */

import { enigmaHome } from "./util";
import { listJsonl } from "./claude-transcripts";
import { join, relative, dirname } from "node:path";
import { copyIfFresher, transferSession } from "./claude-oauth";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";

/**
 * The only tool with a shared store. Every rule here is Claude Code's: one config dir holding
 * both the login and the transcripts, and an OAuth refresh that invalidates its predecessor.
 * Another agent gets one when its credential and session layout are verified, not before.
 */
const SHARED_TOOL = "claude";

/** Records which account dir the store's current login came from, so it can be handed back. */
const OWNER_FILE = ".enigma-account";

/** Account dirs whose history has already been seeded in, one path per line. */
const SEEDED_FILE = ".enigma-seeded";

/** The shared store dir for `tool`, or null when the tool has none. Does not create it. */
export function sharedStoreFor(tool: string): string | null {
    return tool === SHARED_TOOL ? join(enigmaHome(), ".enigma", SHARED_TOOL, "store") : null;
}

/** One line per path, empty lines dropped. */
function readLines(file: string): string[] {
    try { return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); }
    catch { return []; }
}

/** The account dir whose login the store currently holds, or null when it holds none. */
function ownerOf(store: string): string | null {
    const owner = readLines(join(store, OWNER_FILE))[0];
    return owner && existsSync(owner) ? owner : null;
}

/**
 * Copy back whatever token the store holds now, if it is fresher than the account's own.
 *
 * This writes into the account dir, the synthetic "default" (the user's own `~/.claude`)
 * included, which is the one place enigma otherwise never puts credentials. It is correct here
 * and load-bearing: the store is running on a login BORROWED from that dir, and the refresh
 * Claude Code performs mid-session invalidates the copy left behind. Returning the rotated token
 * is what keeps a plain `claude` working; withholding it is what would log the user out.
 */
function handBack(store: string, accountDir: string): void {
    try { copyIfFresher(store, accountDir); } catch { /* best-effort: a stale copy, never a crash */ }
}

/** Copy one transcript into the store, preserving its mtime so `/resume` keeps its ordering. */
function copyInto(src: string, target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    try {
        const stamp = new Date(statSync(src).mtimeMs);
        utimesSync(target, stamp, stamp);
    } catch { /* the copy is what matters; an mtime is cosmetic */ }
}

/**
 * Move an account's history into the store the first time it enters, so `/resume` there is never
 * emptier than what the account already had. Returns what it did, for the caller to report.
 *
 * A managed dir is renamed (instant, and the account reads the store from now on anyway); the
 * user's own dir is copied file by file, skipping what the store already holds - the trees
 * overlap heavily when `shareSessions` has been mirroring them, so a re-seed is mostly stats.
 * Each account is seeded once, recorded in `SEEDED_FILE`.
 */
function seed(store: string, accountDir: string, managed: boolean): "renamed" | "copied" | null {
    const seededFile = join(store, SEEDED_FILE);
    const seeded = readLines(seededFile);
    if (seeded.includes(accountDir)) return null;
    const from = join(accountDir, "projects");
    const to = join(store, "projects");
    let did: "renamed" | "copied" | null = null;
    try {
        if (!existsSync(from)) did = null;
        else if (managed && !existsSync(to)) { renameSync(from, to); did = "renamed"; }
        else {
            for (const path of listJsonl(from)) {
                const target = join(to, relative(from, path));
                if (!existsSync(target)) { copyInto(path, target); did = "copied"; }
            }
        }
        writeFileSync(seededFile, `${[...seeded, accountDir].join("\n")}\n`);
    } catch {
        // A failed seed must not block the launch: the store still works, it is just missing
        // history, and the next launch retries because nothing was recorded as seeded.
        return did;
    }
    return did;
}

/** What `enterSharedStore` did, so the caller can tell the user why a launch paused. */
export interface StoreEntry { dir: string; seeded: "renamed" | "copied" | null; }

/**
 * Point `tool` at the shared store for a launch on `accountDir`'s login, and return the dir to
 * launch in (null when the tool has no shared store). Seeds the account's history on first
 * entry, settles the outgoing account, then moves the chosen login in.
 */
export function enterSharedStore(tool: string, accountDir: string, managed: boolean): StoreEntry | null {
    const store = sharedStoreFor(tool);
    if (!store) return null;
    let seeded: "renamed" | "copied" | null = null;
    try {
        mkdirSync(store, { recursive: true });
        seeded = seed(store, accountDir, managed);
        const owner = ownerOf(store);
        if (owner && owner !== accountDir) handBack(store, owner);
        // A switch must land even when the incoming token is OLDER - it is a different login, not
        // a staler copy of the same one. Re-entering on the same account only ever moves forward,
        // so a token the store refreshed is never overwritten by the account's older copy.
        if (owner === accountDir) copyIfFresher(accountDir, store);
        else transferSession(accountDir, store);
        writeFileSync(join(store, OWNER_FILE), `${accountDir}\n`);
    } catch { /* best-effort: fall through and launch in the store as it stands */ }
    return { dir: store, seeded };
}

/** After a session ends, return any token it refreshed to the account that lent the login. */
export function leaveSharedStore(tool: string, accountDir: string): void {
    const store = sharedStoreFor(tool);
    if (store) handBack(store, accountDir);
}
