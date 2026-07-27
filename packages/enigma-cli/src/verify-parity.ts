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
    const absent = modules.filter((m) => m.matched === 0).sort(worstFirst).slice(0, MAX_MODULES);
    const partial = modules
        .filter((m) => m.matched > 0 && (m.matched / m.symbols) * 100 < PARTIAL_THRESHOLD)
        .sort(worstFirst)
        .slice(0, MAX_MODULES);

    return {
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
        `symbol coverage: ${report.coverage}% (${report.matched}/${report.sourceSymbols} carried over)`,
    ];
    if (report.absent.length) {
        lines.push("", `NOT PORTED AT ALL - ${report.absent.length} module(s) with zero symbols carried over:`);
        for (const m of report.absent) lines.push(`  x ${m.module} (${m.symbols} symbols): ${m.missing.join(", ")}`);
    }
    if (report.partial.length) {
        lines.push("", `PARTIALLY PORTED - ${report.partial.length} module(s) below ${PARTIAL_THRESHOLD}% coverage:`);
        for (const m of report.partial) lines.push(`  ! ${m.module} (${m.matched}/${m.symbols}): missing ${m.missing.join(", ")}`);
    }
    if (!report.absent.length && !report.partial.length) lines.push("", "Every source module has a counterpart in the target.");
    lines.push("", "Coverage matches symbol NAMES: it proves a counterpart exists, not that its behaviour was ported faithfully.");
    return lines.join("\n");
}
