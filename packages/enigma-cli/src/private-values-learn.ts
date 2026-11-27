/**
 * Learning private values at the end of a turn (private-values.ts has the why).
 *
 * Read from the turn's own material: the user's recent prompts INCLUDING what they pasted (a
 * pasted error is where a deployment URL usually arrives) for domains, IPs and emails, and the
 * agent's final reply for IPs only - an address it read from `nslookup` or `curl -v` and then
 * explained is exactly the one that ends up in a PR, while the hosts a reply names are mostly
 * public documentation. Runs inside the Stop hook, so it must be cheap and must never fail it:
 * one transcript tail read, and one `git grep` only when there is something new to classify.
 */

import { basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { lastHumanPrompts } from "./claude-transcripts";
import { type PrivateValueKind, extractValues, normalizeRoot, readPrivateRepos, readPrivateValues, rememberValues, repoRootOf, writePrivateRepos } from "./private-values";

/** Private repository names are re-read this often; a repository's visibility this often. */
const NAMES_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const VISIBILITY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most one detached sync attempt per this long, whatever its outcome. */
const ATTEMPT_EVERY_MS = 60 * 60 * 1000;

/** The values `git grep` finds in the repository at `root`, out of `values`. */
function presentInRepo(root: string, values: string[]): Set<string> {
    if (!values.length) return new Set();
    const args = ["-C", root, "grep", "-I", "-i", "-o", "-h", "-F", ...values.flatMap((v) => ["-e", v]), "--"];
    const res = spawnSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    // 1 is "no match"; anything else unreadable means "not known to be public", the safe answer.
    if (res.status !== 0 || typeof res.stdout !== "string") return new Set();
    return new Set(res.stdout.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
}

/** Learns from one finished turn. Returns how many values were new; never throws. */
export function learnPrivateValues(transcriptPath: string | undefined, reply: string, cwd: string): number {
    try {
        scheduleRepoSync(repoRootOf(cwd));
        const found = new Map<string, PrivateValueKind>();
        const prompts = transcriptPath ? lastHumanPrompts(transcriptPath, 6, true) : [];
        for (const v of extractValues(prompts.join("\n"))) found.set(v.value, v.kind);
        for (const v of extractValues(reply, ["ip"])) found.set(v.value, v.kind);
        if (!found.size) return 0;
        const known = new Map(readPrivateValues().map((v) => [v.value, v]));
        const root = repoRootOf(cwd);
        // Only a value not yet classified for this repository costs the git call.
        const unclassified = [...found.keys()].filter((v) => !known.has(v));
        const present = root ? presentInRepo(root, unclassified) : new Set<string>();
        return rememberValues([...found].map(([value, kind]) => ({ value, kind })), root ? { root, values: present } : undefined);
    } catch { return 0; }
}

/** `gh` with a timeout, as text, or null when it is missing, logged out or failed. */
function gh(args: string[], cwd?: string): string | null {
    const res = spawnSync("gh", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return res.status === 0 && typeof res.stdout === "string" ? res.stdout : null;
}

/**
 * Refreshes the private repository names (the user's and their organizations') and the
 * visibility of `root`. Run by `enigma private-values sync [root]`, detached from the Stop hook.
 * A failed read keeps what was known: an unreachable GitHub must not unblock anything.
 */
export function syncPrivateRepos(root: string | null, now = Date.now()): { names: number; public: boolean | null; } {
    const repos = readPrivateRepos();
    if (now - repos.syncedAt > NAMES_STALE_MS || !repos.names.length) {
        const owners = [gh(["api", "user", "-q", ".login"])?.trim(), ...(gh(["api", "user/orgs", "-q", ".[].login"]) ?? "").split("\n")].filter((o): o is string => !!o && /^[\w.-]+$/.test(o));
        const names = new Set<string>();
        let read = false;
        for (const owner of owners) {
            const out = gh(["repo", "list", owner, "--visibility", "private", "-L", "1000", "--json", "name", "-q", ".[].name"]);
            if (out === null) continue;
            read = true;
            for (const n of out.split("\n")) if (n.trim()) names.add(n.trim());
        }
        if (read) { repos.names = [...names].sort(); repos.syncedAt = now; }
    }
    let visibility: boolean | null = null;
    if (root) {
        const out = gh(["repo", "view", "--json", "visibility", "-q", ".visibility"], root);
        if (out !== null) {
            visibility = out.trim().toUpperCase() === "PUBLIC";
            repos.visibility[normalizeRoot(root)] = { public: visibility, at: now };
        }
    }
    writePrivateRepos(repos);
    return { names: repos.names.length, public: visibility };
}

/** Starts a detached `enigma private-values sync <root>` when the names or this repo's visibility are stale. */
function scheduleRepoSync(root: string | null): void {
    if (process.env.ENIGMA_NO_BACKGROUND_TIDY) return;
    const repos = readPrivateRepos();
    const now = Date.now();
    const entry = root ? repos.visibility[normalizeRoot(root)] : undefined;
    const stale = now - repos.syncedAt > NAMES_STALE_MS || (root !== null && (!entry || now - entry.at > VISIBILITY_STALE_MS));
    if (!stale || now - (repos.attemptAt ?? 0) < ATTEMPT_EVERY_MS) return;
    writePrivateRepos({ ...repos, attemptAt: now });
    try {
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = ["private-values", "sync", ...(root ? [root] : [])];
        const child = spawn(process.execPath, dev ? [process.argv[1]!, ...args] : args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => { /* retried after ATTEMPT_EVERY_MS */ });
        child.unref();
    } catch { /* a protection refresh; the hook must never fail the turn over it */ }
}
