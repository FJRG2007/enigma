/** Human-readable report formatting for lint violations. */

import type { Violation } from "./types";

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (text: string, code: string): string => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Render violations grouped by file, with a trailing summary line. */
export function formatReport(violations: Violation[]): string {
    if (!violations.length) return paint("enigmax-lint: no problems found.", "32");

    const byFile = new Map<string, Violation[]>();
    for (const v of violations) {
        const list = byFile.get(v.file);
        if (list) list.push(v);
        else byFile.set(v.file, [v]);
    }

    const out: string[] = [];
    for (const [file, list] of byFile) {
        out.push(paint(file, "1"));
        for (const v of list.sort((a, b) => a.line - b.line || a.column - b.column)) {
            const severity = v.severity === "error" ? paint("error", "31") : paint("warn ", "33");
            out.push(`  ${v.line}:${v.column}  ${severity}  ${v.message}  ${paint(v.rule, "2")}`);
        }
    }

    const errors = violations.filter((v) => v.severity === "error").length;
    const warnings = violations.length - errors;
    out.push("", `${errors} error(s), ${warnings} warning(s)`);
    return out.join("\n");
}
