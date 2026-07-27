/**
 * Port/clone parity: a mechanical answer to "is the port actually complete?".
 *
 * The turn-end gate (verify.ts) catches an agent that left a marker behind, but the worse
 * failure it cannot see is silent omission - a module the port never touched at all, or
 * one where a handful of easy symbols were carried over and the hard ones quietly dropped.
 * Nothing in the produced code says so; only comparing it against the original does.
 *
 * So this compares two codebases by SYMBOL, reusing the code graph's existing multi-language
 * extraction (codegraph.ts scanFiles) rather than a second parser. Names are normalised
 * before matching, because a port legitimately renames `parse_config` to `parseConfig`, and
 * coverage is reported per source module so a module at 0% - the "this was never written"
 * case - is impossible to miss.
 *
 * It is a coverage signal, not a proof of correctness: a matched name says a symbol of that
 * name exists in the target, never that its behaviour was ported faithfully. Reported as
 * such, since overstating it would recreate the exact problem this feature exists to fix.
 */

import { scanFiles } from "./codegraph";
import type { CodeFile } from "./codegraph";

/** Coverage of one source module (file) in the target codebase. */
export interface ModuleParity {
    module: string;
    symbols: number;
    matched: number;
    /** Source symbol names with no counterpart in the target (capped for reporting). */
    missing: string[];
}

export interface ParityReport {
    source: string;
    target: string;
    sourceFiles: number;
    targetFiles: number;
    sourceSymbols: number;
    targetSymbols: number;
    matched: number;
    /** Percentage of source symbols with a counterpart in the target (0-100). */
    coverage: number;
    /** Source modules where nothing at all was carried over - the headline signal. */
    absent: ModuleParity[];
    /** Source modules only partially carried over (coverage below PARTIAL_THRESHOLD). */
    partial: ModuleParity[];
    /** How many absent/partial modules exist in total, when the lists above were capped. */
    absentTotal: number;
    partialTotal: number;
    /** The source yielded no comparable symbols, so there was nothing to check. */
    empty: boolean;
}

/** Names shorter than this collide too easily to match reliably (mirrors codegraph). */
const MIN_NAME = 3;

/** Below this coverage a module counts as only partially ported. */
const PARTIAL_THRESHOLD = 60;

/** Cap the reported detail so a large port produces an actionable report, not a dump. */
const MAX_MODULES = 40;
const MAX_MISSING_PER_MODULE = 12;

/**
 * Normalise a symbol name for cross-language matching: case and word separators change
 * across languages (`parse_config` / `parseConfig` / `ParseConfig` are the same symbol),
 * everything else must still match exactly so unrelated names never collide.
 */
function normalise(name: string): string {
    return name.toLowerCase().replace(/[_\-\s]/g, "");
}

/** Every matchable symbol name in a set of files, normalised. */
function symbolNames(files: CodeFile[]): Set<string> {
    const out = new Set<string>();
    for (const file of files) for (const symbol of file.symbols) {
        if (symbol.name.length < MIN_NAME) continue;
        out.add(normalise(symbol.name));
    }
    return out;
}

/**
 * Compare a source codebase against a port/clone of it and report symbol coverage per
 * source module. Directories are scanned read-only; neither project is indexed or stored.
 */
export function parityReport(sourceDir: string, targetDir: string): ParityReport {
    const source = scanFiles(sourceDir);
    const target = scanFiles(targetDir);
    const targetNames = symbolNames(target.files);

    const modules: ModuleParity[] = [];
    let sourceSymbols = 0;
    let matchedTotal = 0;
    for (const file of source.files) {
        const names = file.symbols.map((s) => s.name).filter((n) => n.length >= MIN_NAME);
        if (!names.length) continue;
        const missing = names.filter((n) => !targetNames.has(normalise(n)));
        const matched = names.length - missing.length;
        sourceSymbols += names.length;
        matchedTotal += matched;
        modules.push({ module: file.path, symbols: names.length, matched, missing: missing.slice(0, MAX_MISSING_PER_MODULE) });
    }

    const worstFirst = (a: ModuleParity, b: ModuleParity): number => (b.symbols - b.matched) - (a.symbols - a.matched);
    const allAbsent = modules.filter((m) => m.matched === 0).sort(worstFirst);
    const allPartial = modules.filter((m) => m.matched > 0 && (m.matched / m.symbols) * 100 < PARTIAL_THRESHOLD).sort(worstFirst);
    const absent = allAbsent.slice(0, MAX_MODULES);
    const partial = allPartial.slice(0, MAX_MODULES);

    return {
        absentTotal: allAbsent.length,
        partialTotal: allPartial.length,
        // No symbols on the source side means the comparison never happened - a mistyped path,
        // an unsupported language, an empty tree. Reporting that as 100% would turn a completion
        // check into a rubber stamp, which is the one thing it must never be.
        empty: sourceSymbols === 0,
        source: source.root,
        target: target.root,
        sourceFiles: source.files.length,
        targetFiles: target.files.length,
        sourceSymbols,
        targetSymbols: target.files.reduce((n, f) => n + f.symbols.length, 0),
        matched: matchedTotal,
        coverage: sourceSymbols ? Math.round((matchedTotal / sourceSymbols) * 1000) / 10 : 100,
        absent,
        partial,
    };
}

/** Render a parity report as a compact, actionable block. */
export function formatParity(report: ParityReport): string {
    const lines: string[] = [
        `source: ${report.source} (${report.sourceFiles} files, ${report.sourceSymbols} symbols)`,
        `target: ${report.target} (${report.targetFiles} files, ${report.targetSymbols} symbols)`,
    ];
    if (report.empty) {
        lines.push("", "NOTHING TO COMPARE: no symbols were found in the source, so this proves nothing.",
            "Check the path, and that the source is in a language the scanner reads.");
        return lines.join("\n");
    }
    lines.push(`symbol coverage: ${report.coverage}% (${report.matched}/${report.sourceSymbols} carried over)`);
    if (report.absentTotal) {
        lines.push("", `NOT PORTED AT ALL - ${report.absentTotal} module(s) with zero symbols carried over${listed(report.absent.length, report.absentTotal)}:`);
        for (const m of report.absent) lines.push(`  x ${m.module} (${m.symbols} symbols): ${m.missing.join(", ")}`);
    }
    if (report.partialTotal) {
        lines.push("", `PARTIALLY PORTED - ${report.partialTotal} module(s) below ${PARTIAL_THRESHOLD}% coverage${listed(report.partial.length, report.partialTotal)}:`);
        for (const m of report.partial) lines.push(`  ! ${m.module} (${m.matched}/${m.symbols}): missing ${m.missing.join(", ")}`);
    }
    if (!report.absentTotal && !report.partialTotal) lines.push("", "Every source module has a counterpart in the target.");
    lines.push("", "Coverage matches symbol NAMES: it proves a counterpart exists, not that its behaviour was ported faithfully.");
    return lines.join("\n");
}

/** Say so when a list was capped, rather than letting the shown count read as the total. */
function listed(shown: number, total: number): string {
    return shown < total ? `, showing the worst ${shown}` : "";
}
