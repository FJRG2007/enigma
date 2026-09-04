/**
 * The one post-edit hook: auto-lint, EOF trim, guardrails and the code graph's blast radius, in one
 * process - and, since the launcher runs it, in one process that is not the binary.
 *
 * They were four separate PostToolUse entries in settings.json, and on a host where starting a
 * process is expensive that is what the user feels as input lag. Measured on Windows 11 with
 * Defender real-time on: the ~99 MB Bun binary costs ~100 ms warm but 0.8-3.3 s cold, and hours of
 * memory churn evict the image from the standby cache - so in a long session "cold" is the common
 * case, not the outlier. Four entries paid that four times per edit for work whose own runtime is
 * milliseconds; a turn with five edits paid it twenty times. One entry pays it once.
 *
 * THE OTHER HALF OF THE SAVING IS WHICH RUNTIME PAYS IT. `enigma` is an npm launcher that spawns
 * the binary, so every hook cost a Node start AND a Bun start - measured here at 290-6109 ms for
 * `enigma --version`, against 109-1658 ms for the binary alone and 112-874 ms for `node -e 0`.
 * Every step this hook runs is already Node-compatible (the graph included - it is bundled to
 * `dist/post-edit.js` by tsup), so the launcher imports the bundle and answers the hook itself
 * instead of spawning the binary. What the model gets back is identical; the process count is one.
 *
 * Ordering is the second reason, and it was a latent race rather than a preference. As separate
 * entries the host is free to run them concurrently, so guardrails could scan the file either
 * before or after the trimmer rewrote it and nothing declared a winner. In one process the order is
 * stated: the step that writes runs first, then the steps that read.
 *
 * Each step is gated on its OWN toggle here rather than by being absent from settings.json, because
 * one entry cannot encode three toggles. That is also stricter than the wiring it replaces:
 * readConfig() layers the repo-local .enigma.json over the global one, so a project that turns trim
 * off now turns it off for the hook too - which three globally-wired entries never did.
 *
 * Exit codes: 2 when guardrails BLOCKs, because its stderr is the channel Claude Code feeds back to
 * the model, and 0 otherwise. A blocked edit skips the blast radius deliberately - the model is
 * about to redo the write, so the graph note would be describing an edit that is being taken back.
 */

/**
 * Run the enabled post-edit steps against one PostToolUse payload.
 *
 * Every step fails soft. This hook rides along inside someone's turn and none of its four jobs is
 * a dependency of that turn succeeding, so a step that throws is dropped rather than surfaced. The
 * two things never swallowed are a guardrails BLOCK and a lint finding, which are the whole point
 * of the channel.
 */
export async function runPostEditHook(payload: string): Promise<number> {
    let config;
    try {
        const { readConfig } = await import("./config");
        config = readConfig().config;
    } catch {
        // No readable config means no toggle can be honoured, and running all four on a guess is
        // the wrong way to be wrong: it spends the process this module exists to save.
        return 0;
    }
    // Auto-lint FIRST, because it rewrites the file: the formatter can leave or take a trailing
    // newline, and the trimmer is what settles the end of the file afterwards.
    let blocked = 0;
    if (config.autoLint) {
        try { blocked = await runLintStep(payload); }
        catch { /* a formatter failure must not deny an edit that broke no rule */ }
    }
    // The trimmer writes the file; guardrails and the graph read it. Order, not luck.
    if (config.trim) {
        try {
            const { runTrimHook } = await import("./trim");
            await runTrimHook(payload);
        } catch { /* a silent tidy never breaks the turn */ }
    }
    if (config.guardrails) {
        try {
            const { runGuardrailsHook } = await import("./guardrails");
            if (runGuardrailsHook(payload) === 2) return 2;
        } catch { /* a rule-engine failure must not deny an edit that broke no rule */ }
    }
    // A lint finding blocks like a guardrails BLOCK does, and for the same reason - the model is
    // about to redo the write - so the blast radius below would describe an edit being taken back.
    if (blocked === 2) return 2;
    if (config.codeGraph) {
        try {
            const { runCodeGraphHook } = await import("./codegraph-hook");
            await runCodeGraphHook("post-edit", payload);
        } catch { /* the graph is an accelerator, never a dependency */ }
    }
    return 0;
}

/** Files the linter has rules for. Anything else is not worth loading it to find out. */
const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rs|prisma|ipynb|astro|vue|svelte)$/i;

/** Findings printed before the rest are counted. Twenty is already more than anyone reads. */
const MAX_FINDINGS = 20;

/**
 * Fix the edited file with @enigmax/linter and report what it could not fix.
 *
 * THE STEP THAT ONLY RUNS UNDER NODE, and the asymmetry is deliberate rather than an oversight.
 * The linter is installed on demand into `~/.enigma/linter`, outside this package, so loading it
 * means resolving a path the build never saw - and a Bun-compiled binary cannot: both
 * `import(pathToFileURL(...))` and `createRequire(...)` fail there with "cannot find package",
 * because a standalone executable does not walk node_modules for a module it loads at runtime.
 * Node does, which is why this hook's real host is the launcher (`bin/enigma.mjs` imports
 * `dist/post-edit.js` and never spawns the binary for an edit). Reached through the binary the
 * step no-ops, and nothing else changes.
 *
 * Returns 2 when there are findings, which is the channel Claude Code feeds back to the model.
 */
async function runLintStep(payload: string): Promise<number> {
    let file: string | undefined;
    try { file = JSON.parse(payload)?.tool_input?.file_path; } catch { return 0; }
    if (!file || !LINTABLE.test(file)) return 0;

    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { createRequire } = await import("node:module");
    const { readFileSync, writeFileSync } = await import("node:fs");

    const dir = process.env.ENIGMA_LINT_DIR || join(homedir(), ".enigma", "linter");
    let linter: { fixText(file: string, text: string): string; lintText(file: string, text: string): LintViolation[]; };
    // Not installed yet, or a host that cannot resolve it: a no-op that self-heals the moment the
    // background install lands, rather than an error about a feature the user did not ask for now.
    try { linter = createRequire(join(dir, "noop.js"))("@enigmax/linter"); } catch { return 0; }

    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return 0; }
    const fixed = linter.fixText(file, text);
    if (fixed !== text) {
        try { writeFileSync(file, fixed); text = fixed; } catch { /* read-only, so report on what is there */ }
    }

    const violations = linter.lintText(file, text);
    // Clean file, no output, no tokens. Silence is what makes this affordable to run on every edit.
    if (!violations.length) return 0;

    const shown = violations.slice(0, MAX_FINDINGS).map((v) => `${v.line}:${v.column} ${v.severity === "error" ? "error" : "warn"} ${v.rule} - ${v.message}`);
    if (violations.length > MAX_FINDINGS) shown.push(`...and ${violations.length - MAX_FINDINGS} more`);
    process.stderr.write(`enigmax-lint ${file}\n${shown.join("\n")}\n`);
    return 2;
}

/** What the linter reports back. Declared here because the package is resolved at runtime. */
interface LintViolation {
    line: number;
    column: number;
    severity: string;
    rule: string;
    message: string;
}
