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
 *
 * THE SAME RULE AT GIT'S OWN LEVEL (`runPrePushHook`, `applyGitPushGuard`, below): the hook above
 * only sees Claude Code's own shell calls, so a push from Codex, Kimi, OpenCode, an IDE or the
 * terminal never reaches it. A global git `pre-push` hook declared in config
 * (`hook.enigma-push-guard.*`, git 2.54+) does, additive to a repo's own hooks and
 * `core.hooksPath`, and reuses `judgeTarget` against the exact `<local ref> <local sha> <remote
 * ref> <remote sha>` lines git hands a pre-push hook instead of a command line to parse.
 */

import { homedir } from "node:os";
import { enigmaHome } from "./util";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyClaudeHook } from "./claude-hooks";
import { existsSync, readFileSync } from "node:fs";
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
    /** The remote named on the command line; "" when the branch's push configuration decides. */
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
    const plan: PushPlan = { cwd: dir, remote: positional[0] ?? "", targets: [], wholesale: "" };
    if (wholesale === "--mirror" || (wholesale && force)) { plan.wholesale = wholesale; return plan; }
    const specs = positional.slice(1);
    // No refspec: the branch's push configuration decides where it goes (defaultDestination).
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

/** Runs git with an argument array and resolves its trimmed stdout; rejects on a non-zero exit. */
export type GitRun = (args: string[]) => Promise<string>;

/** Runs git in a directory, optionally feeding stdin; rejects on a non-zero exit. */
type HookGit = (args: string[], input?: string) => Promise<string>;

/** Time every git call of one hook run shares: well under the hook's 60s timeout, which lets the call through when it fires. */
const BUDGET_MS = 45_000;

/** Ceiling of the scratch-ref cleanup, which runs even once the budget is spent. */
const CLEANUP_MS = 10_000;

/** SHAs per `git log --no-walk` call, so no command line outgrows the platform's limit. */
const LOG_CHUNK = 200;

/** More commits than this between the pushed side and the tip is refused rather than judged partly. */
const MAX_DROPPED = 5_000;

/** `git log --no-walk` over every sha in chunks, concatenated. */
async function logEach(run: GitRun, args: string[], shas: string[]): Promise<string> {
    const parts: string[] = [];
    for (let i = 0; i < shas.length; i += LOG_CHUNK) parts.push(await run(["log", "--no-walk=unsorted", "--no-show-signature", ...args, ...shas.slice(i, i + LOG_CHUNK)]));
    return parts.join("\n");
}

/** The other people's commits among `cherry` (`+ <sha>` lines), read through `run`; `ownEmail` is only read when there are any. */
export async function foreignCommitsAmong(run: GitRun, cherry: string, ownEmail: () => Promise<string>): Promise<LostCommit[]> {
    const shas = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim());
    if (!shas.length) return [];
    const log = await logEach(run, ["--format=%H%x1f%an%x1f%ae%x1f%s"], shas);
    return foreignLostCommits(cherry, log, await ownEmail());
}

/**
 * `+ <sha>` lines for every commit on `tip` that pushing `pushed` over it removes. A patch-equivalent
 * on the pushed side (`git cherry`, a rebase of the commit) proves a commit preserved ONLY when it is
 * an ordinary commit with a non-empty diff: every empty commit has the same patch-id, so a
 * teammate's empty commit would otherwise read as "kept" next to any empty commit of the user's, and
 * `git cherry` does not list merges at all. Measured: two empty commits, the teammate's was erased.
 */
export async function droppedCommits(run: GitRun, pushed: string, tip: string): Promise<string> {
    const all = (await run(["rev-list", `--max-count=${MAX_DROPPED + 1}`, `${pushed}..${tip}`])).split("\n").filter(Boolean);
    if (all.length > MAX_DROPPED) throw new Error(`the push drops more than ${MAX_DROPPED} commits`);
    if (!all.length) return "";
    const equivalent = new Set((await run(["cherry", pushed, tip])).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()));
    const candidates = all.filter((sha) => equivalent.has(sha));
    const preserved = new Set<string>();
    if (candidates.length) {
        const out = await logEach(run, ["--format=%x1e%H %P", "--name-only"], candidates);
        for (const record of out.split("\x1e")) {
            const [head = "", ...files] = record.trim().split("\n");
            const [sha = "", ...parents] = head.trim().split(/\s+/);
            if (sha && parents.length === 1 && files.some((f) => f.trim() !== "")) preserved.add(sha);
        }
    }
    return all.filter((sha) => !preserved.has(sha)).map((sha) => `+ ${sha}`).join("\n");
}

/** The other people's commits on `tip` that pushing `pushed` over it drops (see droppedCommits). */
export async function foreignCommitsDropped(run: GitRun, pushed: string, tip: string, ownEmail: () => Promise<string>): Promise<LostCommit[]> {
    return foreignCommitsAmong(run, await droppedCommits(run, pushed, tip), ownEmail);
}

/** One line per lost commit, capped at ten plus a count of the rest. */
export function lostCommitLines(lost: LostCommit[]): string[] {
    const lines = lost.slice(0, 10).map((c) => `${c.sha.slice(0, 10)} ${c.author} <${c.email}>: ${c.subject}`);
    if (lost.length > 10) lines.push(`...and ${lost.length - 10} more`);
    return lines;
}

/** A git runner in `cwd` whose every call stops at `deadline` (epoch ms), no shell. */
function gitIn(cwd: string, deadline: number): HookGit {
    return async (args, input) => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("ran out of time reading the remote");
        const r = spawnSync("git", args, { cwd, input, encoding: "utf8", timeout: left, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        if (r.status !== 0) throw new Error(r.error ? `git ${args[0]}: ${r.error.message}` : `git ${args[0]} exited ${r.status ?? "on a signal"}`);
        return r.stdout.trim();
    };
}

/**
 * Where a push without a refspec goes, as git decides it: the branch's push remote (pushRemote,
 * remote.pushDefault, its upstream's remote, else origin) unless `remote` names one, and the
 * configured push refspec, the upstream branch under push.default=upstream, or the namesake.
 */
async function defaultDestination(run: HookGit, remote: string): Promise<{ remote: string; branch: string; }> {
    const branch = await run(["symbolic-ref", "--short", "HEAD"]).catch(() => "");
    if (branch === "") throw new Error("HEAD is not on a branch");
    const [pushRemote = "", pushRef = ""] = (await run(["for-each-ref", "--format=%(push:remotename)%1f%(push:remoteref)", `refs/heads/${branch}`])).split("\x1f");
    const target = remote || pushRemote || "origin";
    if (pushRef !== "" && target === pushRemote) return { remote: target, branch: branchName(pushRef) };
    const mode = await run(["config", "push.default"]).catch(() => "simple");
    if (mode === "matching") throw new Error("push.default=matching pushes every matching branch");
    if (mode === "upstream" || mode === "tracking") {
        const merge = await run(["config", `branch.${branch}.merge`]).catch(() => "");
        if (merge === "") throw new Error(`${branch} has no upstream branch`);
        return { remote: target, branch: branchName(merge) };
    }
    return { remote: target, branch };
}

/** Whether any of `shas` is not in the local object store. */
async function anyMissing(run: HookGit, shas: string[]): Promise<boolean> {
    const out = await run(["cat-file", "--batch-check"], `${shas.join("\n")}\n`);
    return out.split("\n").some((l) => l.endsWith(" missing"));
}

/** Why `target` cannot be pushed, or "" when it loses nobody's work. Throws when it cannot tell. */
async function judgeTarget(plan: PushPlan, target: PushTarget, deadline: number): Promise<string> {
    const run = gitIn(plan.cwd, deadline);
    let { remote } = plan;
    let branch = target.branch;
    if (branch === "HEAD" || remote === "") ({ remote, branch } = await defaultDestination(run, remote));
    // A deletion is judged against every branch the remote holds right now, never against local
    // remote-tracking refs, which may still hold commits the server already dropped.
    const deleting = target.source === null;
    const listed = await run(["ls-remote", "--heads", remote, ...(deleting ? [] : [`refs/heads/${branch}`])]).catch((err: Error) => {
        throw new Error(`could not read ${branch} on ${remote}: ${err.message}`);
    });
    const heads = new Map<string, string>();
    for (const line of listed.split("\n")) {
        const [sha = "", ref = ""] = line.trim().split(/\s+/);
        if (sha && ref) heads.set(branchName(ref), sha);
    }
    const tip = heads.get(branch);
    if (tip === undefined) return "";
    const scratch = `refs/enigma/push-guard/${process.pid}`;
    try {
        if (await anyMissing(run, [...heads.values()])) {
            // An empty --refmap keeps the fetch from moving origin/<branch>, which a lease reads.
            const spec = deleting ? `+refs/heads/*:${scratch}/*` : `+refs/heads/${branch}:${scratch}/${branch}`;
            const fetched = await run(["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", remote, spec]).then(() => true, () => false);
            if (!fetched) throw new Error(`could not fetch ${branch} from ${remote}`);
            if (await anyMissing(run, [...heads.values()])) throw new Error(`${remote} changed while it was read`);
        }
        let cherry: string;
        if (deleting) {
            const others = [...heads].filter(([name]) => name !== branch).map(([, sha]) => `^${sha}`);
            cherry = await run(["log", "--format=+ %H", "--stdin"], `${[tip, ...others].join("\n")}\n`);
        } else {
            const pushed = await run(["rev-parse", "--verify", `${target.source}^{commit}`]).catch(() => "");
            if (pushed === "") throw new Error(`could not resolve ${target.source}`);
            cherry = await droppedCommits(run, pushed, tip);
        }
        const lost = await foreignCommitsAmong(run, cherry, () => run(["config", "user.email"]).catch(() => ""));
        if (!lost.length) return "";
        const list = lostCommitLines(lost).map((l) => `  ${l}`).join("\n");
        return `${deleting ? "deleting" : "force-pushing"} ${remote}/${branch} would erase ${lost.length} commit(s) other people pushed:\n${list}`;
    } finally {
        const cleanup = gitIn(plan.cwd, Date.now() + CLEANUP_MS);
        const refs = await cleanup(["for-each-ref", "--format=delete %(refname)", `${scratch}/`]).catch(() => "");
        if (refs !== "") await cleanup(["update-ref", "--stdin"], `${refs}\n`).catch(() => "");
    }
}

/** Why `command` would erase someone else's pushed work, or "" when it would not. */
export async function pushRefusal(command: string, cwd: string, deadline = Date.now() + BUDGET_MS): Promise<string> {
    let dir = cwd;
    for (const segment of commandSegments(command)) {
        const w = words(segment);
        const cd = programName(w[0] ?? "");
        if ((cd === "cd" || cd === "set-location" || cd === "pushd") && w[1]) { dir = resolve(dir, w[1]); continue; }
        // A command handed to another shell as text (`bash -c "git push -f"`, `powershell -Command
        // "..."`) is one quoted word holding spaces: judge it as the command it is.
        for (const inner of w.slice(1).filter((x) => /\s/.test(x) && /\bpush\b/.test(x))) {
            const reason = await pushRefusal(inner, dir, deadline);
            if (reason) return reason;
        }
        const plan = parsePush(segment, dir);
        if (plan === null) continue;
        const remote = plan.remote || "the remote";
        if (plan.wholesale) return `git push ${plan.wholesale} rewrites every branch on ${remote} at once, other people's included. Push the branches that are yours by name.`;
        for (const target of plan.targets) {
            let reason: string;
            try {
                reason = await judgeTarget(plan, target, deadline);
            } catch (err) {
                reason = `this push rewrites ${remote}/${target.branch} and enigma could not verify it erases nobody's work (${err instanceof Error ? err.message : String(err)}).`;
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
export async function runPushGuardHook(raw: string): Promise<number> {
    const payload = parseGuardPayload(raw);
    if (payload === null || !/\bpush\b/.test(payload.command)) return 0;
    const reason = await pushRefusal(payload.command, payload.cwd);
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

/**
 * THE SAME RULE AT GIT'S OWN LEVEL. The PreToolUse hook only sees Claude Code's shell calls; a
 * push from Codex, Kimi, OpenCode, an IDE or the user's terminal never reaches it. A `pre-push`
 * hook does, whatever started git, and it is handed the exact refs and SHAs instead of a command
 * line to parse. Git 2.54+ reads hooks from config (`hook.<name>.command` / `.event`), and a
 * global entry runs IN ADDITION to a repository's own hooks and `core.hooksPath`, so installing
 * it never displaces a repo's husky or .githooks. Older git ignores the keys. `--no-verify`
 * skips it, which is the deliberate escape a person can type; an agent's `--no-verify` push still
 * meets the PreToolUse hook in Claude Code.
 */
export const PRE_PUSH_MARKER = "__pre-push-guard";

/** Name of enigma's entry in the global git config (`hook.<name>.*`). */
const GIT_HOOK_NAME = "enigma-push-guard";

/**
 * The command the global config runs. Git runs it as `sh -c '<command> "$@"'` with the remote name
 * and URL, so the call sits in a function invoked LAST, where that `"$@"` lands. Exit 127 (no
 * `enigma` on the PATH of whatever started git, an IDE for instance) lets the push through: a
 * guard that cannot start must not stop every push on the machine. Measured on git 2.54.
 */
const GIT_HOOK_COMMAND = `f() { enigma ${PRE_PUSH_MARKER} "$@"; s=$?; [ $s -eq 127 ] && exit 0; exit $s; }; f`;

/** A SHA git uses for "no object": a new branch on the remote side, a deletion on the local side. */
function isZeroSha(sha: string): boolean {
    return /^0+$/.test(sha);
}

/**
 * Why the push git is about to make would erase someone else's commits, or "" when it would not.
 * `stdin` is what git hands a pre-push hook: one `<local ref> <local sha> <remote ref> <remote sha>`
 * line per ref. A fast-forward and a new branch return before any network call.
 */
export async function prePushRefusal(remote: string, stdin: string, cwd: string, deadline = Date.now() + BUDGET_MS): Promise<string> {
    const run = gitIn(cwd, deadline);
    for (const line of stdin.split("\n")) {
        const [, localSha = "", remoteRef = "", remoteSha = ""] = line.trim().split(/\s+/);
        if (!remoteRef.startsWith("refs/heads/") || remoteSha === "" || isZeroSha(remoteSha)) continue;
        const deleting = isZeroSha(localSha);
        if (!deleting && await run(["merge-base", "--is-ancestor", remoteSha, localSha]).then(() => true, () => false)) continue;
        const plan: PushPlan = { cwd, remote, targets: [], wholesale: "" };
        const target: PushTarget = { branch: branchName(remoteRef), source: deleting ? null : localSha };
        let reason: string;
        try {
            reason = await judgeTarget(plan, target, deadline);
        } catch (err) {
            reason = `this push rewrites ${remote}/${target.branch} and enigma could not verify it erases nobody's work (${err instanceof Error ? err.message : String(err)}).`;
        }
        if (reason) return reason;
    }
    return "";
}

/** pre-push entry: exit 1 with the reason on stderr stops the push; anything else lets it run. */
export async function runPrePushHook(args: string[], stdin: string, cwd = process.cwd()): Promise<number> {
    const remote = args[0] ?? "";
    if (remote === "") return 0;
    const reason = await prePushRefusal(remote, stdin, cwd);
    if (!reason) return 0;
    process.stderr.write(`enigma: push refused, ${reason}\nIntegrate their work instead: git pull --rebase (or merge), resolve conflicts keeping both sides, then push without --force. If those commits really must go, the person who owns that decision can push with --no-verify.\n`);
    return 1;
}

/**
 * The global config file, resolved the way git resolves it: GIT_CONFIG_GLOBAL, else `.gitconfig`
 * under $HOME (git honors HOME, also on Windows, where it can differ from USERPROFILE), else an
 * existing `$XDG_CONFIG_HOME/git/config` (default `~/.config/git/config`) when there is no
 * `.gitconfig`, which is where `git config --global` writes then. ENIGMA_CONFIG_HOME isolates it
 * under enigma's home (tests do). Written through `--file`, never `--global`, so the file read
 * and the file written can never differ.
 */
function globalGitConfigFile(): string {
    if (process.env.GIT_CONFIG_GLOBAL) return process.env.GIT_CONFIG_GLOBAL;
    if (process.env.ENIGMA_CONFIG_HOME) return join(enigmaHome(), ".gitconfig");
    const home = process.env.HOME || homedir();
    const primary = join(home, ".gitconfig");
    if (existsSync(primary)) return primary;
    const xdg = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config");
    return existsSync(xdg) ? xdg : primary;
}

/** Runs `git config --file <global file>` with an argument array; the trimmed stdout, or null on a non-zero exit. */
function globalGitConfig(args: string[]): string | null {
    const r = spawnSync("git", ["config", "--file", globalGitConfigFile(), ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Whether the global config file already carries the entry, read without starting git: this runs
 * on every sync, and a process launch costs seconds on some machines. A false "no" only costs the
 * `git config` calls below, which settle it.
 */
function gitHookPresent(): boolean {
    let text: string;
    try { text = readFileSync(globalGitConfigFile(), "utf8"); } catch { return false; }
    const section = text.split(/^\s*\[/m).find((s) => s.startsWith(`hook "${GIT_HOOK_NAME}"]`)) ?? "";
    // git writes the value quoted, its inner quotes escaped.
    return section.includes(`"${GIT_HOOK_COMMAND.replace(/"/g, "\\\"")}"`) && /^\s*event\s*=\s*pre-push\s*$/m.test(section);
}

/**
 * Installs (on) or removes the global pre-push entry. "refused" when a `git config` write failed
 * (locked, read-only or malformed file), so the caller never reports a guard that is not there.
 */
export function applyGitPushGuard(on: boolean): HookWrite {
    if (on && gitHookPresent()) return "unchanged";
    const command = globalGitConfig(["--get-all", `hook.${GIT_HOOK_NAME}.command`]);
    const event = globalGitConfig(["--get-all", `hook.${GIT_HOOK_NAME}.event`]);
    if (!on) {
        if (command === null && event === null) return "unchanged";
        return globalGitConfig(["--remove-section", `hook.${GIT_HOOK_NAME}`]) === null ? "refused" : "changed";
    }
    if (command === GIT_HOOK_COMMAND && event === "pre-push") return "unchanged";
    if (globalGitConfig(["--replace-all", `hook.${GIT_HOOK_NAME}.command`, GIT_HOOK_COMMAND]) === null) return "refused";
    if (globalGitConfig(["--replace-all", `hook.${GIT_HOOK_NAME}.event`, "pre-push"]) === null) return "refused";
    return "changed";
}
