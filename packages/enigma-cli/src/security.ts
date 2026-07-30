/**
 * Git security hooks (OS-agnostic). Installs a portable, self-contained commit
 * guard into a target repo: copies the built guard into <repo>/.githooks, writes
 * a cross-platform pre-commit shim and a toggle config, and points
 * core.hooksPath at it. Hooks fire for commits made via plain `git` AND via the
 * GitHub CLI (`gh`), since `gh` shells out to `git`.
 */

import { existsSync, mkdirSync, cpSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { findGitRoot, isOnPath } from "./util";
import { readConfig } from "./config";
import { clackReporter } from "./reporter";
import type { Reporter } from "./reporter";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The built, self-contained guard to copy into target repos. In the compiled binary
 * the launcher points ENIGMA_GUARD_PATH at the real dist/guard.js shipped in the main
 * npm package; in a plain install it sits next to the bundled CLI (dist/guard.js);
 * running from source via tsx it lives in ../dist after a build. First existing wins.
 */
function findGuardSrc(): string | null {
    const candidates = [
        ...(process.env.ENIGMA_GUARD_PATH ? [process.env.ENIGMA_GUARD_PATH] : []),
        join(__dirname, "guard.js"),
        join(__dirname, "..", "dist", "guard.js"),
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
}

/** The built, self-contained guardrails engine to copy into target repos as the commit/CI convention backstop. */
function findGuardrailsSrc(): string | null {
    const candidates = [
        ...(process.env.ENIGMA_GUARDRAILS_PATH ? [process.env.ENIGMA_GUARDRAILS_PATH] : []),
        join(__dirname, "guardrails.js"),
        join(__dirname, "..", "dist", "guardrails.js"),
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
}

// The protection metadata + global guard config live in the light guard-config module so
// the settings registry can surface them (TUI + dashboard) without importing this clack-heavy
// module. Imported for local use here and re-exported for the existing `enigma security` call sites.
import { GUARD_PROTECTIONS } from "./guard-config";
export { GUARD_PROTECTIONS, type GuardProtection } from "./guard-config";

export interface SecurityOptions {
    force?: boolean;
    protections?: string[];
    security?: boolean;
}

function currentHooksPath(root: string): string {
    try { return execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(); }
    catch { return ""; }
}

/**
 * Configure git security hooks in the current repo. Output is emitted through
 * `reporter` (clack for the CLI, or a buffering reporter when driven inline by
 * the TUI). `opts.force` overrides an existing core.hooksPath without prompting.
 * `opts.protections` limits what is enabled; omitted means all protections on.
 */
export async function setupGitHooks(opts: SecurityOptions, interactive: boolean, reporter: Reporter = clackReporter()): Promise<boolean> {
    const root = findGitRoot(process.cwd());
    if (!root) {
        reporter.error("Not inside a git repository (no .git found). Run this from your project root.");
        return false;
    }
    const guardSrc = findGuardSrc();
    if (!guardSrc) {
        reporter.error("Cannot find the built guard (dist/guard.js). Run 'npm run build' first.");
        return false;
    }

    const current = currentHooksPath(root);
    if (current && current !== ".githooks" && !opts.force) {
        reporter.warn(`core.hooksPath is already set to '${current}'.`);
        if (interactive) {
            const ok = await p.confirm({ message: `Override existing core.hooksPath '${current}' with '.githooks'?` });
            if (p.isCancel(ok) || !ok) { reporter.info("Left git hooks unchanged."); return false; }
        } else {
            reporter.info("Re-run with --force to override.");
            return false;
        }
    }

    // Which protections to enable (interactive multiselect, unless given/forced).
    let enabled = opts.protections;
    if (!enabled && interactive) {
        const r = await p.multiselect({
            message: "Which protections should the commit guard enforce?",
            options: GUARD_PROTECTIONS,
            initialValues: GUARD_PROTECTIONS.map((o) => o.value),
            required: true,
        });
        if (p.isCancel(r)) { reporter.info("Left git hooks unchanged."); return false; }
        enabled = r as string[];
    }
    const config: Record<string, boolean> = {};
    for (const o of GUARD_PROTECTIONS) config[o.value] = enabled ? enabled.includes(o.value) : true;

    const hooksDir = join(root, ".githooks");
    mkdirSync(hooksDir, { recursive: true });
    // Copy as guard.mjs so Node always treats it as ESM, regardless of the target
    // repo's package.json "type".
    cpSync(guardSrc, join(hooksDir, "guard.mjs"), { force: true });
    writeFileSync(join(hooksDir, "enigma-guard.json"), JSON.stringify(config, null, 2) + "\n");

    // Convention backstop (guardrails): copy the engine when the feature is on, remove it
    // when off. The pre-commit shim runs it only when the file is present, so a later toggle
    // that removes it cleanly disables the check without rewriting the shim.
    const guardrailsDest = join(hooksDir, "guardrails.mjs");
    const guardrailsSrc = readConfig().config.guardrails ? findGuardrailsSrc() : null;
    if (guardrailsSrc) cpSync(guardrailsSrc, guardrailsDest, { force: true });
    else if (existsSync(guardrailsDest)) rmSync(guardrailsDest, { force: true });

    const shimPath = join(hooksDir, "pre-commit");
    const shim = [
        "#!/bin/sh",
        "# Managed by enigma (enigma-cli) - blocks committed secrets/.env/dep dirs and enforces code conventions.",
        "# Toggle protections in .githooks/enigma-guard.json; conventions via 'enigma config guardrails'.",
        "# Bypass once: git commit --no-verify",
        'root="$(git rev-parse --show-toplevel)"',
        'node "$root/.githooks/guard.mjs" "$@" || exit 1',
        '[ -f "$root/.githooks/guardrails.mjs" ] && { node "$root/.githooks/guardrails.mjs" "$@" || exit 1; }',
        "exit 0",
        "",
    ].join("\n");
    writeFileSync(shimPath, shim);
    try { chmodSync(shimPath, 0o755); } catch { /* no-op on Windows */ }
    try { chmodSync(join(hooksDir, "guard.mjs"), 0o755); } catch { /* no-op on Windows */ }
    if (existsSync(guardrailsDest)) { try { chmodSync(guardrailsDest, 0o755); } catch { /* no-op on Windows */ } }

    try {
        execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
    } catch (err) {
        reporter.error(`Failed to set core.hooksPath: ${(err as Error).message}`);
        return false;
    }

    const on = Object.entries(config).filter(([, v]) => v).map(([k]) => k);
    reporter.success(`Git security hooks installed in ${relative(process.cwd(), hooksDir) || ".githooks"} (core.hooksPath set).`);
    reporter.info(`Enforcing: ${on.join(", ") || "nothing"}. Commit .githooks/ so your team inherits it.`);
    if (isOnPath("gh")) {
        reporter.info("GitHub CLI (gh) detected: these hooks also run for commits made via gh, since gh uses git underneath.");
    }
    return true;
}

/** In interactive skills installs, offer to set up git hooks in an unguarded repo. */
export async function maybeOfferGitHooks(interactive: boolean, opts: SecurityOptions): Promise<void> {
    if (!interactive || opts.security) return;
    const root = findGitRoot(process.cwd());
    if (!root) return;
    if (currentHooksPath(root) === ".githooks") return; // already guarded
    const ok = await p.confirm({ message: "Set up git security hooks here too (block committed secrets, .env, node_modules)? (recommended)", initialValue: true });
    if (!p.isCancel(ok) && ok) await setupGitHooks({ ...opts, protections: undefined }, interactive);
}
