/**
 * Rendering for code-graph retrieval results.
 *
 * Kept apart from codegraph-query.ts so the queries stay pure data: the CLI prints these strings,
 * the MCP tools hand the same strings to an agent, and the dashboard consumes the JSON directly
 * without any of them re-deriving each other's wording.
 *
 * Every result ends with what it saved: the size of the files the answer replaced reading. It is
 * measured from sizes recorded at index time, so it costs nothing and is honest about the
 * alternative - and it is omitted rather than guessed when no file in the baseline has a size.
 */

import * as q from "./codegraph-query";

/** Rough tokens for a byte length (about 4 chars per token - an estimate, and labeled as one). */
function toTokens(chars: number): number {
    return Math.round(chars / 4);
}

function savingsLine(saved: q.Savings | undefined, outputChars: number): string {
    if (!saved) return "";
    const saved_ = Math.max(0, saved.baselineChars - outputChars);
    return `\n\n~${toTokens(saved_).toLocaleString("en-US")} tokens saved vs reading ${saved.files} file${saved.files === 1 ? "" : "s"} whole.`;
}

function withSavings(body: string, saved: q.Savings | undefined): string {
    return body + savingsLine(saved, body.length);
}

/**
 * What every surface says when the scan behind the graph hit a cap. An answer drawn from a partial
 * index still reads as complete, so the gap is stated wherever it can mislead.
 */
const INCOMPLETE_INDEX = "INCOMPLETE: the last scan hit a limit (too many files, or files too large), so some files were never indexed.";

export function formatAsk(r: q.AskResult): string {
    const head = `code graph - "${r.query}" (${r.mode})`;
    if (!r.hits.length) return `${head}\n\n${r.note ?? "No matches."}\n`;
    const lines = [head];
    if (r.note) lines.push("", r.note);
    lines.push("");
    for (const h of r.hits) {
        const where = h.symbolKind === "file" ? h.path : `${h.path}:${h.line}-${h.endLine}`;
        lines.push(`- ${h.name} - ${h.symbolKind} - ${where}${h.relation ? ` (${h.relation})` : ""}`);
        if (h.signature) lines.push(`    ${h.signature}`);
        if (h.code) lines.push("", "```", h.code, "```", "");
    }
    if (r.coverage !== undefined && r.coverage < 0.5) {
        lines.push("", `Only ${Math.round(r.coverage * 100)}% of the query matched anything indexed - try naming a symbol or file directly.`);
    }
    return `${withSavings(lines.join("\n"), r.saved)}\n`;
}

export function formatTrace(r: q.TraceResult): string {
    // Written from the reader's side in both directions: "Nothing depended on by it" is the empty
    // state read backwards, and `callees` on a leaf is exactly when it shows.
    const empty = r.direction === "in" ? "Nothing depends on it." : "It depends on nothing indexed.";
    const head = `${r.symbol} - ${r.direction === "in" ? "callers and references" : "outgoing dependencies"} (depth ${r.depth})`;
    if (!r.matched.length || !r.hits.length) return `${head}\n\n${r.note ?? empty}\n`;
    const lines = [head, ""];
    lines.push(`defined at: ${r.matched.map((m) => `${m.path}:${m.line}`).join(", ")}`, "");
    for (const h of r.hits) {
        lines.push(`- ${h.name} - ${h.kind} - ${h.path}:${h.line} - ${h.relation}${r.depth > 1 ? ` - depth ${h.depth}` : ""}`);
    }
    lines.push("", `${r.hits.length} node${r.hits.length === 1 ? "" : "s"}.`);
    return `${lines.join("\n")}\n`;
}

export function formatSkeleton(r: q.SkeletonResult): string {
    const head = `code graph skeleton - ${r.file}`;
    if (!r.entries.length) return `${head}\n\n${r.note ?? "No definitions."}\n`;
    const lines = r.entries.map((e) => `- ${e.line}-${e.endLine}  ${e.kind} ${e.name}${e.signature ? `  ${e.signature}` : ""}`);
    return `${withSavings([head, "", ...lines].join("\n"), r.saved)}\n`;
}

const DIR_COL_WIDTH = 22;

export function formatMap(r: q.RepoMap): string {
    const { totals } = r;
    const lines = [`repo map - ${totals.files} files - ${totals.symbols} symbols - ${totals.edges} edges - ${totals.languages.join(", ")}`, ""];
    for (const d of r.dirs) {
        const label = (d.isFile ? d.path : `${d.path}/`).padEnd(DIR_COL_WIDTH);
        const hubs = d.hubs.length ? `   hubs: ${d.hubs.map((h) => `${h.name} (${h.path.split("/").pop()}, ${h.inDegree} in)`).join(", ")}` : "";
        lines.push(`${label}${d.files} files - ${d.symbols} symbols${hubs}`);
    }
    if (r.dropped > 0) lines.push(`... +${r.dropped} more director${r.dropped === 1 ? "y" : "ies"} not shown (raise --max-dirs to see them)`);
    if (r.hotspots.length) {
        lines.push("", "hotspots:");
        for (const h of r.hotspots) lines.push(`  ${h.name} - ${h.kind} - ${h.path}:${h.line} - ${h.inDegree} in`);
    }
    if (r.truncated) lines.push("", INCOMPLETE_INDEX);
    return `${withSavings(lines.join("\n"), r.saved)}\n`;
}

export function formatGrep(r: q.GrepResult): string {
    const head = `"${r.pattern}" - ${r.totalHits} hit${r.totalHits === 1 ? "" : "s"} in ${r.groups.length} symbol${r.groups.length === 1 ? "" : "s"} (searched ${r.filesSearched} indexed files)`;
    // Dropped work is always named: a capped search that read as exhaustive would send an agent
    // away believing it had seen every occurrence. Files the index never covered are the same
    // failure one layer down, and no-hits is exactly when it misleads most, so it is said there too.
    const notes: string[] = [];
    if (r.truncated.hits > 0) notes.push(`+${r.truncated.hits} more hits past the cap (raise --max-hits).`);
    if (r.truncated.files > 0) notes.push(`${r.truncated.files} indexed file${r.truncated.files === 1 ? "" : "s"} could not be read.`);
    if (r.truncated.unindexedFiles) notes.push(INCOMPLETE_INDEX);
    if (!r.groups.length) return `${head}${notes.length ? `\n\n${notes.join("\n")}` : ""}\n`;
    const lines = [head, ""];
    for (const g of r.groups) {
        const where = g.symbol ? `${g.symbol.name} - ${g.symbol.kind} - ${g.path}:${g.symbol.line}-${g.symbol.endLine} - ${g.inDegree} in` : `${g.path} - module level`;
        lines.push(where);
        for (const h of g.hits) lines.push(`  ${h.line}: ${h.text}`);
        lines.push("");
    }
    lines.push(...notes);
    return `${withSavings(lines.join("\n").trimEnd(), r.saved)}\n`;
}

export function formatFreshness(r: q.FreshnessResult): string {
    const head = `${r.project} - indexed ${new Date(r.indexedAt).toISOString().replace("T", " ").slice(0, 16)}`;
    const incomplete = r.truncated ? `\n\n${INCOMPLETE_INDEX}` : "";
    if (r.stale === 0) return `${head}\n\nThe graph matches the working tree.${incomplete}\n`;
    const lines = [head, "", `${r.stale} file${r.stale === 1 ? "" : "s"} drifted since the last index:`];
    const show = (label: string, paths: string[]): void => {
        if (!paths.length) return;
        lines.push(`  ${label}: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` (+${paths.length - 10} more)` : ""}`);
    };
    show("changed", r.drift.changed);
    show("added", r.drift.added);
    show("removed", r.drift.removed);
    lines.push("", "Re-index with: enigma codegraph index");
    return `${lines.join("\n")}${incomplete}\n`;
}
