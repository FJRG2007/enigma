/**
 * Deployment of the single Claude Code PostToolUse entry that runs every post-edit step.
 *
 * Four features write after an edit - auto-lint, the EOF trimmer, guardrails and the code graph -
 * and each used to wire its own entry under PostToolUse. Claude Code starts a fresh process per entry, so
 * that was three starts of the same ~99 MB binary per edit; see post-edit-hook.ts for the measured
 * cost and why it dominates the hook's own runtime. This module owns that one entry instead, which
 * means the three deploy modules no longer write to PostToolUse themselves: a group whose presence
 * depends on three independent toggles cannot have three independent writers without each of them
 * deleting the others' work.
 *
 * Presence is a pure function of the toggles - the entry exists when ANY of the four is on, and
 * the runtime gates each step on its own toggle. Every reconcile also strips the four legacy
 * entries, so an install that predates the merge is migrated the first moment any wiring is
 * re-asserted, with no upgrade step to remember and nothing left behind to double-spawn.
 *
 * Node builtins + config/claude-hooks only (no engine import), like the deploy modules it took the
 * work from: it must stay cheap to load and free of cycles.
 */

import { readConfig } from "./config";
import { applyClaudeHook, claudeGlobalSettings } from "./claude-hooks";

/** Edit tools whose writes run the post-edit steps. */
const HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

/** The command, and the marker that identifies its group so the write stays idempotent. */
const HOOK_MARKER = "__post-edit-hook";
const HOOK_COMMAND = `enigma ${HOOK_MARKER}`;

/**
 * Markers of the four entries this one replaces, removed on every reconcile.
 *
 * The code graph's marker carries its event argument because all four of its entries share a
 * command name - matching on the bare name would delete its SessionStart, UserPromptSubmit and Stop
 * entries too, which are separate events and still spawn separately because they have to.
 *
 * Auto-lint is matched by its RUNNER PATH (`lint-hook.mjs`), which is how lint.ts identified its
 * own entry: the command runs that script under node rather than naming an enigma subcommand. It
 * still exists and is still what opencode and Kimi invoke - only Claude's entry is gone, because
 * the merged hook lints there itself.
 */
const LEGACY_MARKERS = ["__guardrails-hook", "__trim-hook", "__codegraph-hook post-edit", "lint-hook.mjs"];

/**
 * The budget the merged entry answers in.
 *
 * Not the sum of the three it replaces, and not the max either. Each of those budgets was mostly
 * process start - the floor this module exists to pay once - but the steps now run in sequence
 * inside it, and the graph still has to parse the stored index before it can trace anything. The
 * measured worst case on a large monorepo with Defender scanning is ~4.5 s to start plus ~7.5 s to
 * load the graph. 45 s is sized for that worst case rather than the median, for the reason
 * codegraph-deploy.ts documents: a budget that only covers the happy path does not degrade
 * gracefully, because the host kills the hook, discards its output and prints a timeout warning
 * into the session - so the process cost is paid and buys nothing but noise.
 */
const HOOK_TIMEOUT = 45;

/** True when at least one post-edit step is enabled, so the entry has work to do. */
export function isPostEditHookOn(): boolean {
    const { config } = readConfig();
    return config.trim || config.guardrails || config.codeGraph || config.autoLint;
}

/**
 * Reconcile the merged PostToolUse entry in a Claude settings.json against the current toggles and
 * remove the three legacy entries, preserving every other hook and setting. Returns true when the
 * file changed.
 */
export function applyClaudePostEditHook(settingsPath: string): boolean {
    let changed = false;
    for (const marker of LEGACY_MARKERS) {
        if (applyClaudeHook(settingsPath, "PostToolUse", marker, { hooks: [] }, false) === "changed") changed = true;
    }
    const group = { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }] };
    if (applyClaudeHook(settingsPath, "PostToolUse", HOOK_MARKER, group, isPostEditHookOn()) === "changed") changed = true;
    return changed;
}

/**
 * Re-assert the merged entry in the default account's global Claude settings.
 *
 * The counterpart of applyVerifyWiring, and it exists for the same reason: this group is hook
 * WIRING, not a file the sync loop copies, so an EXISTING install only picks it up if something
 * re-writes it. `enigma update` reaches an install through syncDeployed and nothing else touches
 * this group, so without a call there a pre-merge install keeps its three separate entries - and
 * keeps paying three process starts per edit - until the user happens to run `enigma install` or
 * toggle one of the three features. That is exactly the upgrade step the migration is supposed to
 * remove, so leaving it out would make the whole change a no-op for everyone already installed.
 */
export function applyPostEditWiring(): boolean {
    return applyClaudePostEditHook(claudeGlobalSettings());
}
