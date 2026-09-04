/**
 * The one post-edit hook: EOF trim, guardrails and the code graph's blast radius, in one process.
 *
 * They were three separate PostToolUse entries in settings.json, and on a host where starting a
 * process is expensive that is what the user feels as input lag. Measured on Windows 11 with
 * Defender real-time on: the ~99 MB Bun binary costs ~100 ms warm but 0.8-3.3 s cold, and hours of
 * memory churn evict the image from the standby cache - so in a long session "cold" is the common
 * case, not the outlier. Three entries paid that three times per edit for work whose own runtime is
 * milliseconds; a turn with five edits paid it fifteen times. One entry pays it once.
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
 * Every step fails soft. This hook rides along inside someone's turn and none of its three jobs is
 * a dependency of that turn succeeding, so a step that throws is dropped rather than surfaced. The
 * one thing that is never swallowed is a guardrails BLOCK, which is the whole point of the channel.
 */
export async function runPostEditHook(payload: string): Promise<number> {
    let config;
    try {
        const { readConfig } = await import("./config");
        config = readConfig().config;
    } catch {
        // No readable config means no toggle can be honoured, and running all three on a guess is
        // the wrong way to be wrong: it spends the process this module exists to save.
        return 0;
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
    if (config.codeGraph) {
        try {
            const { runCodeGraphHook } = await import("./codegraph-hook");
            await runCodeGraphHook("post-edit", payload);
        } catch { /* the graph is an accelerator, never a dependency */ }
    }
    return 0;
}
