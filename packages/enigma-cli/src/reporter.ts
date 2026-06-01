/**
 * Output sink for the skill-install and git-hook actions. It decouples
 * installSkills/setupGitHooks from any single renderer so the same logic runs
 * two ways: as a clack CLI wizard (clackReporter, the default) and inside the
 * Ink TUI without writing to stdout (collectReporter, which buffers lines for a
 * native result panel - writing to stdout there would corrupt the live render).
 */

import * as p from "@clack/prompts";

/** A long-running step indicator; collapses to a single status line on stop. */
export interface ReporterSpinner {
    start(message: string): void;
    stop(message: string): void;
}

/** Renderer-agnostic surface for human-readable action output. */
export interface Reporter {
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    note(body: string, title?: string): void;
    spinner(): ReporterSpinner;
    /** Abort the action. The CLI reporter exits the process; the TUI one throws. */
    fatal(message: string): never;
}

/** Reporter backed by clack, used by the direct `enigma install` / `security` commands. */
export function clackReporter(): Reporter {
    return {
        info: (m) => p.log.info(m),
        success: (m) => p.log.success(m),
        warn: (m) => p.log.warn(m),
        error: (m) => p.log.error(m),
        note: (body, title) => p.note(body, title),
        spinner: () => {
            const s = p.spinner();
            return { start: (m) => s.start(m), stop: (m) => s.stop(m) };
        },
        fatal: (m) => { p.cancel(m); process.exit(1); },
    };
}

/** Reporter that buffers lines for the TUI result panel; never touches stdout. */
export function collectReporter(): Reporter & { readonly lines: string[] } {
    const lines: string[] = [];
    const push = (prefix: string, message: string): void => {
        for (const line of message.split("\n")) lines.push(prefix ? `${prefix} ${line}` : line);
    };
    return {
        lines,
        info: (m) => push("", m),
        success: (m) => push("", m),
        warn: (m) => push("!", m),
        error: (m) => push("x", m),
        note: (body, title) => { if (title) lines.push(title); push("  ", body); },
        spinner: () => ({ start: () => { /* transient: not shown in the result panel */ }, stop: (m) => push("", m) }),
        fatal: (m) => { throw new Error(m); },
    };
}
