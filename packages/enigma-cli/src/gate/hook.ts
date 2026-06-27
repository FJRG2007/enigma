/**
 * Faithful 1:1 port of upstream's `internal/git/hook.go`, rebranded for enigma
 * gate. Generates the bare repo's post-receive hook, installs/refreshes it, and
 * isolates the gate's hooks path from worktree config writes.
 *
 * Rebrand: the generated hook invokes the enigma binary's hidden `__gate-notify`
 * subcommand instead of upstream's `daemon notify-push`, and the managed-hook
 * marker is `# enigma gate post-receive hook`. The hook stays a POSIX sh script
 * (git runs hooks via sh even on Windows) and is written 0o755 (chmod is guarded
 * since Windows ignores it).
 */

import { run, GitError } from "./git";
import { randomBytes } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync, rmSync } from "node:fs";

/** Resolves the enigma executable path, mirroring Go's os.Executable fallback. */
function defaultEnigmaExe(): string {
    return process.execPath || "enigma";
}

/** Single-quotes a value for safe embedding in a POSIX sh script. */
function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * PostReceiveHookScript returns the POSIX sh post-receive hook. It notifies the
 * daemon via the enigma CLI's `__gate-notify` subcommand so it works across
 * platforms, and never blocks the push: notification failures are surfaced on
 * stderr and appended to notify-push.log inside the bare repo. When `exe` is
 * omitted the running executable path is used.
 */
export function postReceiveHookScript(exe?: string): string {
    const command = exe ?? defaultEnigmaExe();
    return `#!/bin/sh
# enigma gate post-receive hook
# Notifies the daemon of the push. Non-blocking: post-receive exit code is
# ignored by git, so we never reject the push here. Instead, failures are
# surfaced on stderr (so the pushing client sees them) and appended to
# notify-push.log inside the bare repo for later inspection.
ENIGMA_BIN=${shellSingleQuote(command)}
if [ ! -f "$ENIGMA_BIN" ]; then
  ENIGMA_BIN="$(command -v enigma 2>/dev/null || echo enigma)"
fi
LOG="$(pwd)/notify-push.log"
enigma_ts() { date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo unknown; }
notify_failed=0
while read oldrev newrev refname; do
  set -- --gate "$(pwd)" \\
    --ref "$refname" \\
    --old "$oldrev" \\
    --new "$newrev"
  i=0
  while [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do
    opt=$(printenv "GIT_PUSH_OPTION_$i" 2>/dev/null || :)
    set -- "$@" --push-option "$opt"
    i=$((i + 1))
  done
  out=$(ENIGMA_HOOK_HELPER=1 "$ENIGMA_BIN" __gate-notify "$@" 2>&1)
  status=$?
  if [ $status -ne 0 ]; then
    notify_failed=1
    {
      printf '[%s] notify-push failed for %s (exit %d)\\n' "$(enigma_ts)" "$refname" "$status"
      printf '%s\\n\\n' "$out"
    } >> "$LOG"
    {
      printf 'enigma gate: notify-push failed for %s (exit %d):\\n' "$refname" "$status"
      printf '%s\\n' "$out"
      printf 'See %s for full history.\\n' "$LOG"
    } >&2
  fi
done

if [ "$notify_failed" -eq 0 ]; then
  cat >&2 <<'BANNER'
  enigma gate

  * Pipeline started

  Run enigma to review.

BANNER
fi
exit 0
`;
}

/** Reports whether hook content is an enigma-gate-managed post-receive hook. */
export function isManagedPostReceiveHook(content: string): boolean {
    return content.includes("# enigma gate post-receive hook") && content.includes("__gate-notify");
}

/**
 * InstallPostReceiveHook writes the post-receive hook script into the hooks
 * directory of a bare repo at bareDir.
 */
export function installPostReceiveHook(bareDir: string): void {
    const hooksDir = join(bareDir, "hooks");
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    const hookPath = join(hooksDir, "post-receive");
    writeHookFileAtomic(hookPath, postReceiveHookScript());
}

/**
 * RefreshManagedPostReceiveHook updates an existing enigma-gate-owned hook.
 * Custom hooks are left untouched; missing hooks are installed for gate repos.
 * Returns true when the hook was written.
 */
export function refreshManagedPostReceiveHook(bareDir: string): boolean {
    const hooksDir = join(bareDir, "hooks");
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    const hookPath = join(hooksDir, "post-receive");
    const desired = postReceiveHookScript();
    let existing: string | null = null;
    try {
        existing = readFileSync(hookPath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existing !== null) {
        if (existing === desired) return false;
        if (!isManagedPostReceiveHook(existing)) return false;
    }
    writeHookFileAtomic(hookPath, desired);
    return true;
}

/** Writes content to path atomically via a temp file + rename, mode 0o755. */
function writeHookFileAtomic(path: string, content: string): void {
    const tmp = join(dirname(path), `.post-receive-${randomBytes(8).toString("hex")}`);
    try {
        writeFileSync(tmp, content, { mode: 0o755 });
        try {
            chmodSync(tmp, 0o755);
        } catch {
            // Windows ignores file mode bits; the rename below still succeeds.
        }
        renameSync(tmp, path);
    } catch (err) {
        try {
            rmSync(tmp, { force: true });
        } catch {
            // Best-effort cleanup of the temp file.
        }
        throw err;
    }
}

/** Reports whether a `git config --unset` failure is the benign "key not set" (exit 5). */
function isConfigKeyMissing(err: unknown): boolean {
    return err instanceof GitError && err.code === 5;
}

/** Reports whether an error means the installed git lacks per-worktree config. */
function isWorktreeConfigUnsupported(err: unknown): boolean {
    if (err instanceof GitError && err.notFound) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("unknown option") && msg.includes("worktree");
}

/**
 * IsolateHooksPath protects the gate's post-receive hook from being disabled
 * when a pipeline subprocess runs `git config core.hookspath` from inside a
 * linked worktree. It enables extensions.worktreeConfig on the bare and pins
 * core.hookspath in the bare's per-worktree config, then relocates core.bare to
 * per-worktree scope. Best-effort: a git without `--worktree` support is a
 * no-op. Idempotent.
 */
export async function isolateHooksPath(bareDir: string, signal?: AbortSignal): Promise<void> {
    try {
        await run(bareDir, ["config", "--worktree", "--get", "core.hookspath"], signal);
    } catch (err) {
        if (isWorktreeConfigUnsupported(err)) return;
    }
    try {
        await run(bareDir, ["config", "extensions.worktreeConfig", "true"], signal);
    } catch (err) {
        throw new Error(`enable worktree config: ${err instanceof Error ? err.message : String(err)}`);
    }
    const hooksDir = resolve(join(bareDir, "hooks"));
    try {
        await run(bareDir, ["config", "--worktree", "core.hookspath", hooksDir], signal);
    } catch (err) {
        if (isWorktreeConfigUnsupported(err)) return;
        throw new Error(`pin core.hookspath per-worktree: ${err instanceof Error ? err.message : String(err)}`);
    }
    return relocateCoreBareToWorktreeScope(bareDir, signal);
}

/**
 * relocateCoreBareToWorktreeScope moves core.bare out of shared local config
 * into the bare's per-worktree config. Required after enabling
 * extensions.worktreeConfig so core.bare=true does not leak into linked
 * worktrees and break rebase/merge and provider CLI repo resolution.
 */
async function relocateCoreBareToWorktreeScope(bareDir: string, signal?: AbortSignal): Promise<void> {
    try {
        await run(bareDir, ["config", "--worktree", "core.bare", "true"], signal);
    } catch (err) {
        if (isWorktreeConfigUnsupported(err)) return;
        throw new Error(`pin core.bare per-worktree: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        await run(bareDir, ["config", "--local", "--unset", "core.bare"], signal);
    } catch (err) {
        if (isConfigKeyMissing(err)) return;
        throw new Error(`unset shared core.bare: ${err instanceof Error ? err.message : String(err)}`);
    }
}
