/**
 * Refuses a `git push` that would erase commits someone else pushed.
 *
 * WHY A HOOK: git-policy already says "a rejected push means the remote has work you do not; the
 * answer is `git pull --rebase`, never `--force`", and the exact-match deny rules in claude.ts
 * cover only `git push --force origin main|master`. A real incident got past both: an agent
 * force-pushed a shared `develop` branch and a teammate's commit vanished from the remote. A rule
 * in a skill persuades; a PreToolUse hook sees the command before it runs.
 *
 * What it judges is the outcome, not the flag: for every branch a rewriting push touches
 * (`--force`, `-f`, `--force-with-lease`, a `+` refspec, `--delete`, `:branch`), it reads the
 * remote tip and lists the commits that would leave the branch. A commit with a patch-equivalent
 * on the pushed side (a rebase of it) is not lost; a commit authored by this repo's own
 * `user.email` is the user's to rewrite. Anything else belongs to someone else and the push is
 * refused, naming each commit and its author. `--mirror` and a forced `--all` are refused
 * outright: they rewrite every branch at once.
 *
 * A force push it cannot verify (remote unreachable, a source it cannot resolve) is refused too:
 * the cost of a wrong refusal is one more command, the cost of a wrong pass is someone's work.
 * The user can still run it themselves; a command the user types is not an agent tool call.
 *
 * COST: the handlers carry an `if` filter, so Claude Code spawns this only for a command naming
 * `push`; a push that rewrites nothing returns before any git call.
 */

import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyClaudeHook } from "./claude-hooks";
import { parseGuardPayload } from "./attribution-guard";
import type { HookGroup, HookWrite } from "./claude-hooks";
import { commandSegments, programName, words } from "./browser-guard";

/** Marker identifying enigma's handlers in settings.json (see applyClaudeHook), and the hidden command itself. */
export const PUSH_GUARD_MARKER = "__push-guard";

/** Commands the hook is spawned for, in Claude Code's permission-rule syntax: one broad pattern, so a push nested in `bash -c "..."`, a chain or a wrapper spawns it too. */
const COMMAND_PATTERNS = ["*push*"];

/** `git push` options that take their value as the next word. */
const VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** One destination branch a push rewrites: what is pushed there (`null` deletes it). */
export interface PushTarget { branch: string; source: string | null; }

/** What a single `git push` segment asks for. */
export interface PushPlan {
    /** Directory the push runs in, after `cd` and `-C`. */
    cwd: string;
    remote: string;
    /** Rewritten destinations; empty when the push is a plain fast-forward. */
    targets: PushTarget[];
    /** Set when the push rewrites every branch at once (`--mirror`, forced `--all`). */
    wholesale: string;
}

/** A commit the push would remove from the remote. */
export interface LostCommit { sha: string; author: string; email: string; subject: string; }

/** The branch name in a ref: `refs/heads/x` and `x` are both `x`. */
function branchName(ref: string): string {
    return ref.replace(/^refs\/heads\//, "");
}

/**
 * Parses one segment as `git [-C dir] [-c k=v] push ...`, or returns null when it is not a push.
 * Only a rewriting push yields targets; everything else is an empty plan.
 */
export function parsePush(segment: string, cwd: string): PushPlan | null {
    const all = words(segment);
    let i = all.findIndex((w) => programName(w) === "git");
    if (i === -1) return null;
    let dir = cwd;
    for (i++; i < all.length; i++) {
        const w = all[i]!;
        if (w === "-C") dir = resolve(dir, all[++i] ?? ".");
        else if (w === "-c") i++;
        else if (!w.startsWith("-")) break;
    }
    if (all[i] !== "push") return null;
    let force = false;
    let remove = false;
    let wholesale = "";
    const positional: string[] = [];
    for (i++; i < all.length; i++) {
        const w = all[i]!;
        if (w === "--") { positional.push(...all.slice(i + 1)); break; }
        if (VALUE_OPTIONS.has(w)) { i++; continue; }
        if (w === "--force" || w.startsWith("--force-with-lease") || (/^-[a-z]+$/i.test(w) && w.includes("f"))) force = true;
        else if (w === "--delete" || (/^-[a-z]+$/i.test(w) && w.includes("d"))) remove = true;
        else if (w === "--mirror") wholesale = "--mirror";
        else if (w === "--all" || w === "--branches") wholesale ||= w;
        else if (!w.startsWith("-")) positional.push(w);
    }
    const plan: PushPlan = { cwd: dir, remote: positional[0] ?? "origin", targets: [], wholesale: "" };
    if (wholesale === "--mirror" || (wholesale && force)) { plan.wholesale = wholesale; return plan; }
    const specs = positional.slice(1);
    // No refspec: push.default sends the current branch to its namesake.
    if (!specs.length && force) plan.targets.push({ branch: "HEAD", source: "HEAD" });
    for (const raw of specs) {
        const plus = raw.startsWith("+");
        const spec = plus ? raw.slice(1) : raw;
        const colon = spec.indexOf(":");
        const src = colon === -1 ? spec : spec.slice(0, colon);
        const dst = colon === -1 ? spec : spec.slice(colon + 1);
        if (remove) plan.targets.push({ branch: branchName(spec), source: null });
        else if (colon !== -1 && src === "") plan.targets.push({ branch: branchName(dst), source: null });
        else if (force || plus) plan.targets.push({ branch: branchName(dst), source: src });
    }
    return plan;
}

/**
 * The commits a rewrite would drop that belong to someone else. `cherry` is
 * `git cherry <pushed> <remoteTip>` (a `+` line has no equivalent on the pushed side), `log` is
 * `%H%x1f%an%x1f%ae%x1f%s` per line for those commits, `ownEmail` the repo's `user.email`.
 */
export function foreignLostCommits(cherry: string, log: string, ownEmail: string): LostCommit[] {
    const missing = new Set(cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim()));
    const own = ownEmail.trim().toLowerCase();
    const out: LostCommit[] = [];
    for (const line of log.split("\n")) {
        const [sha = "", author = "", email = "", subject = ""] = line.split("\x1f");
        if (!missing.has(sha.trim())) continue;
        if (own !== "" && email.trim().toLowerCase() === own) continue;
        out.push({ sha: sha.trim(), author, email, subject });
    }
    return out;
}

/** Runs git in `cwd` with an argument array, no shell; null on a non-zero exit. */
function git(cwd: string, args: string[]): string | null {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return r.status === 0 ? r.stdout.trim() : null;
}

/** Why `target` cannot be pushed, or "" when it loses nobody's work. Throws when it cannot tell. */
function judgeTarget(plan: PushPlan, target: PushTarget): string {
    let branch = target.branch;
    if (branch === "HEAD") {
        branch = git(plan.cwd, ["symbolic-ref", "--short", "HEAD"]) ?? "";
        if (branch === "") throw new Error("HEAD is not on a branch");
    }
    const listed = git(plan.cwd, ["ls-remote", "--heads", plan.remote, `refs/heads/${branch}`]);
    if (listed === null) throw new Error(`could not read ${branch} on ${plan.remote}`);
    const tip = listed.split(/\s+/)[0] ?? "";
    if (tip === "") return "";
    if (git(plan.cwd, ["cat-file", "-e", `${tip}^{commit}`]) === null) {
        // An empty --refmap keeps the fetch from moving origin/<branch>, which a lease reads.
        const scratch = `refs/enigma/push-guard/${process.pid}`;
        const fetched = git(plan.cwd, ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", plan.remote, `+refs/heads/${branch}:${scratch}`]);
        git(plan.cwd, ["update-ref", "-d", scratch]);
        if (fetched === null) throw new Error(`could not fetch ${branch} from ${plan.remote}`);
    }
    let cherry: string | null;
    if (target.source === null) {
        // Deleting: what survives is what the remote's other branches still hold. Its HEAD is
        // excluded too, since it usually points at the very branch being deleted.
        cherry = git(plan.cwd, ["log", "--format=+ %H", tip, "--not", `--exclude=${plan.remote}/${branch}`, `--exclude=${plan.remote}/HEAD`, `--remotes=${plan.remote}`]);
    } else {
        const pushed = git(plan.cwd, ["rev-parse", "--verify", `${target.source}^{commit}`]) ?? "";
        if (pushed === "") throw new Error(`could not resolve ${target.source}`);
        cherry = git(plan.cwd, ["cherry", pushed, tip]);
    }
    if (cherry === null) throw new Error(`could not compare ${branch} with what is pushed`);
    const shas = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim());
    if (!shas.length) return "";
    const log = git(plan.cwd, ["log", "--no-walk=unsorted", "--format=%H%x1f%an%x1f%ae%x1f%s", ...shas.slice(0, 200)]) ?? "";
    const lost = foreignLostCommits(cherry, log, git(plan.cwd, ["config", "user.email"]) ?? "");
    if (!lost.length) return "";
    const list = lost.slice(0, 10).map((c) => `  ${c.sha.slice(0, 10)} ${c.author} <${c.email}>: ${c.subject}`).join("\n");
    const more = lost.length > 10 ? `\n  ...and ${lost.length - 10} more` : "";
    return `${target.source === null ? "deleting" : "force-pushing"} ${plan.remote}/${branch} would erase ${lost.length} commit(s) other people pushed:\n${list}${more}`;
}

/** Why `command` would erase someone else's pushed work, or "" when it would not. */
export function pushRefusal(command: string, cwd: string): string {
    let dir = cwd;
    for (const segment of commandSegments(command)) {
        const w = words(segment);
        const cd = programName(w[0] ?? "");
        if ((cd === "cd" || cd === "set-location" || cd === "pushd") && w[1]) { dir = resolve(dir, w[1]); continue; }
        // A command handed to another shell as text (`bash -c "git push -f"`, `powershell -Command
        // "..."`) is one quoted word holding spaces: judge it as the command it is.
        for (const inner of w.slice(1).filter((x) => /\s/.test(x) && /\bpush\b/.test(x))) {
            const reason = pushRefusal(inner, dir);
            if (reason) return reason;
        }
        const plan = parsePush(segment, dir);
        if (plan === null) continue;
        if (plan.wholesale) return `git push ${plan.wholesale} rewrites every branch on ${plan.remote} at once, other people's included. Push the branches that are yours by name.`;
        for (const target of plan.targets) {
            let reason: string;
            try {
                reason = judgeTarget(plan, target);
            } catch (err) {
                reason = `this push rewrites ${plan.remote}/${target.branch} and enigma could not verify it erases nobody's work (${err instanceof Error ? err.message : String(err)}).`;
            }
            if (reason) return reason;
        }
    }
    return "";
}

/**
 * Hook entry. Exit 2 with the reason on stderr denies the call and feeds it back to the model;
 * an unreadable payload or a push that rewrites nothing lets the call through.
 */
export function runPushGuardHook(raw: string): number {
    const payload = parseGuardPayload(raw);
    if (payload === null || !/\bpush\b/.test(payload.command)) return 0;
    const reason = pushRefusal(payload.command, payload.cwd);
    if (!reason) return 0;
    process.stderr.write(`enigma: refused, ${reason}\nIntegrate their work instead: git pull --rebase (or merge), resolve conflicts hunk by hunk keeping both sides, then push without --force. If those commits really must go, stop and ask the user, naming each one; only the user can run that push.\n`);
    return 2;
}

/** The PreToolUse group: one filtered handler per command pattern and shell tool. */
function guardGroup(): HookGroup {
    const hooks = ["Bash", "PowerShell"].flatMap((tool) =>
        COMMAND_PATTERNS.map((pattern) => ({ type: "command", command: `enigma ${PUSH_GUARD_MARKER}`, timeout: 60, if: `${tool}(${pattern})` }))
    );
    return { matcher: "Bash|PowerShell", hooks };
}

/** Installs (on) or removes the guard in a Claude settings.json, leaving everything else. */
export function applyPushGuard(settingsPath: string, on: boolean): HookWrite {
    return applyClaudeHook(settingsPath, "PreToolUse", PUSH_GUARD_MARKER, guardGroup(), on);
}
