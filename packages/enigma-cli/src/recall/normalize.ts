/**
 * Text normalization for recall's cross-session dedupe and supersession. Pure and dependency-
 * free so both the schema migration (db.ts backfill) and the store can use it without a cycle.
 *
 * Deliberately exact, not fuzzy: two observations are "the same fact" only when their
 * normalized text is byte-identical. A fuzzy match here would silently merge distinct work into
 * one row, which is a worse failure than keeping a near-duplicate.
 */

import { createHash } from "node:crypto";

/** Leading prefixes a rendered memory line may carry that are not part of the fact itself. */
const PREFIXES = [/^\[recent\]\s*/i, /^\[\d{4}-\d{2}-\d{2}\]\s*/, /^\d{4}-\d{2}-\d{2}:\s*/];

/**
 * Normalize one fact for exact comparison: trim, strip "[recent]" / "[YYYY-MM-DD]" /
 * "YYYY-MM-DD:" prefixes (repeatedly, so stacked prefixes go too), collapse whitespace, lowercase.
 */
export function normalizeFact(text: string): string {
    let t = (text || "").trim();
    for (let changed = true; changed;) {
        changed = false;
        for (const p of PREFIXES) {
            const next = t.replace(p, "");
            if (next !== t) { t = next.trim(); changed = true; }
        }
    }
    return t.replace(/\s+/g, " ").toLowerCase();
}

/** Word tokens of a normalized string (for the supersession title-overlap check). */
export function factTokens(text: string): string[] {
    return normalizeFact(text).match(/[a-z0-9]+/g) || [];
}

/** A file path in comparable form: forward slashes, lowercase (Windows paths are case-insensitive). */
export function normalizePath(path: string): string {
    return path.trim().replace(/\\/g, "/").toLowerCase();
}

/** The fields an observation's dedupe key is built from. */
export interface NormKeyFields {
    type: string;
    title: string;
    narrative?: string | null;
    facts: string[];
    filesModified: string[];
}

/**
 * The exact-duplicate key stored in `observations.norm_hash`. It covers type, title, narrative,
 * facts and the modified-file set - everything that says WHAT was learned - and leaves out the
 * session, timestamps and read-only files, which differ between sessions that learned the same
 * thing. Concepts are derived from the files, so they add nothing.
 */
export function normKey(o: NormKeyFields): string {
    const files = [...new Set(o.filesModified.map(normalizePath))].sort();
    const parts = [o.type, normalizeFact(o.title), normalizeFact(o.narrative ?? ""), o.facts.map(normalizeFact).join("\n"), files.join("\n")];
    return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 32);
}
